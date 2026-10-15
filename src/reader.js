'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { getPath, readMessage } = require('./pb');
const { limitOverride } = require('./config');

// AGCM_ROOT points the monitor at a different Antigravity data directory —
// useful for a second profile, and for testing against a copy.
const ROOT = process.env.AGCM_ROOT || path.join(os.homedir(), '.gemini', 'antigravity');
const CONVERSATIONS = path.join(ROOT, 'conversations');
const SUMMARIES_DB = path.join(ROOT, 'conversation_summaries.db');
const PRESENCE = path.join(ROOT, 'presence');
const BRAIN = path.join(ROOT, 'brain');

// Observed context-window constants, used only when detection from the blob fails.
const LIMIT_FALLBACKS = [
  { match: /^claude-/, limit: 200000 },
  { match: /^gemini-3/, limit: 256000 },
];

const STEP_TYPE = { USER: 14, GENERATION: 15, TOOL: 132 };

function openReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function listConversations() {
  if (!fs.existsSync(SUMMARIES_DB)) return [];
  const db = openReadOnly(SUMMARIES_DB);
  try {
    return db
      .prepare(
        `select conversation_id, title, step_count, last_modified_time, status
         from conversation_summaries
         order by last_modified_time desc`
      )
      .all();
  } finally {
    db.close();
  }
}

function conversationTitle(id) {
  if (!fs.existsSync(SUMMARIES_DB)) return '';
  const db = openReadOnly(SUMMARIES_DB);
  try {
    const row = db.prepare('select title from conversation_summaries where conversation_id = ?').get(id);
    return row ? row.title || '' : '';
  } finally {
    db.close();
  }
}

function presenceMtime(id) {
  try {
    return fs.statSync(path.join(PRESENCE, `${id}.lock`)).mtimeMs;
  } catch {
    return 0;
  }
}

function trajectoryPath(id) {
  return path.join(CONVERSATIONS, `${id}.db`);
}

// The conversation Antigravity is currently writing to: the one whose trajectory
// file was touched most recently, cross-checked against its presence lock.
function findActiveConversation() {
  const rows = listConversations();
  const scored = rows
    .map((row) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(trajectoryPath(row.conversation_id)).mtimeMs;
      } catch {
        mtime = 0;
      }
      const lock = presenceMtime(row.conversation_id);
      return { ...row, mtime, lock, rank: Math.max(mtime, lock) };
    })
    .filter((row) => row.mtime > 0);

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.rank - a.rank);
  return scored[0];
}

// step_payload -> field 5 -> field 9 -> {2: delta, 3: output, 5: cumulative context}
function readGenerationStats(payload) {
  const outer = getPath(payload, [5])[0];
  if (!outer) return null;
  const inner = getPath(outer, [9])[0];
  if (!inner) return null;
  const { vars } = readMessage(inner);
  return {
    contextTotal: vars[5],
    delta: vars[2],
    output: vars[3],
  };
}

// The window the app is actually working against sits at
// `1 -> 9 -> 10 -> 4` inside each generation's metadata. Reading that exact
// path is far more reliable than guessing from constants floating in the blob:
// it is 256000 for every one of this conversation's 361 generations, and
// differs per model (160000 for the claude-sonnet-4-6 conversation).
function limitFromMeta(buf) {
  const level1 = readMessage(buf).lens[1]?.[0];
  if (!level1) return null;
  const level9 = readMessage(level1).lens[9]?.[0];
  if (!level9) return null;
  const level10 = readMessage(level9).lens[10]?.[0];
  if (!level10) return null;
  const value = readMessage(level10).vars[4];
  return Number.isFinite(value) && value > 0 ? value : null;
}

// The model name lives at `1 -> 19` of each generation's metadata. It must be
// read from the field, NOT by scanning the blob for model-looking text: the blob
// can carry the whole assembled prompt (seen at 869KB), whose contents mention
// model names and skill names like "gpt-taste". A regex over the blob picked
// those up and reported a model the conversation never used.
function modelFromMeta(buf) {
  const level1 = readMessage(buf).lens[1]?.[0];
  if (!level1) return null;
  for (const candidate of readMessage(level1).lens[19] || []) {
    const text = candidate.toString('utf8');
    if (/^[a-z0-9][a-z0-9.\-]{2,40}$/i.test(text)) return text;
  }
  return null;
}

function detectModelAndLimit(genBuffers) {
  // The LAST generation wins, not the first and not the majority: the user can
  // switch models partway through a conversation (every recent conversation here
  // does -- gemini-3.8-flash-n early, gemini-3.8-flash-high later), and these two
  // values must describe the model in force *now*. Taking the first match showed a
  // stale model name, and taking the majority kept the old window until the new
  // model outnumbered the old.
  let model = null;
  let lastLimit = null;
  const counts = new Map();

  for (const buf of genBuffers) {
    const name = modelFromMeta(buf);
    if (name) model = name;

    const limit = limitFromMeta(buf);
    if (limit) {
      counts.set(limit, (counts.get(limit) || 0) + 1);
      lastLimit = limit;
    }
  }

  let limit = lastLimit;
  if (limit === null) {
    // Only fall back when no generation carried one.
    let best = 0;
    for (const [value, hits] of counts) {
      if (hits > best) {
        best = hits;
        limit = value;
      }
    }
  }
  if (!limit && model) {
    const fb = LIMIT_FALLBACKS.find((f) => f.match.test(model));
    if (fb) limit = fb.limit;
  }

  return { model, limit };
}

// Full read of one conversation: the context-total series plus model and window.
function readTrajectory(id) {
  const file = trajectoryPath(id);
  if (!fs.existsSync(file)) return null;
  const db = openReadOnly(file);
  try {
    const samples = [];
    for (const row of db
      .prepare('select idx, step_payload from steps where step_type = ? order by idx asc')
      .all(STEP_TYPE.GENERATION)) {
      if (!row.step_payload) continue;
      const stats = readGenerationStats(Buffer.from(row.step_payload));
      if (stats && stats.contextTotal) samples.push({ idx: row.idx, ...stats });
    }

    const genRows = db
      .prepare('select data from gen_metadata order by idx asc')
      .all()
      .map((r) => (r.data ? Buffer.from(r.data) : null))
      .filter(Boolean);

    const { model, limit } = detectModelAndLimit(genRows);
    const latestPrompt = genRows.length ? genRows[genRows.length - 1].toString('utf8') : '';

    return { id, samples, model, limit: limitOverride() || limit, detectedLimit: limit, latestPrompt };
  } finally {
    db.close();
  }
}

// Reads pixel dimensions for the formats Antigravity stores uploads in, so
// images can be charged by resolution rather than by byte size.
function imageSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(32);
    const read = fs.readSync(fd, head, 0, 32, 0);

    if (read >= 24 && head.readUInt32BE(0) === 0x89504e47) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }

    if (read >= 4 && head[0] === 0xff && head[1] === 0xd8) {
      return jpegSize(fd);
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

function jpegSize(fd) {
  const buf = Buffer.alloc(4);
  let offset = 2;
  for (let guard = 0; guard < 4096; guard++) {
    if (fs.readSync(fd, buf, 0, 4, offset) < 4) return null;
    if (buf[0] !== 0xff) return null;
    const marker = buf[1];
    const length = buf.readUInt16BE(2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const sof = Buffer.alloc(5);
      if (fs.readSync(fd, sof, 0, 5, offset + 4) < 5) return null;
      return { height: sof.readUInt16BE(1), width: sof.readUInt16BE(3) };
    }
    offset += 2 + length;
  }
  return null;
}

// Files the user actually attached live under `.user_uploaded`. Generated
// artifacts and scratch output are excluded — their contents already show up in
// the conversation body, so counting them here would double-count.
// The fixed floor (system prompt + tool declarations) only becomes directly
// observable once a conversation compacts. A fresh conversation never shows it,
// so we learn it from recent conversations that did compact and reuse it.
function learnFloor(limit = 8) {
  const rows = listConversations()
    .map((row) => {
      try {
        return { id: row.conversation_id, mtime: fs.statSync(trajectoryPath(row.conversation_id)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  const floors = [];
  for (const row of rows) {
    const traj = readTrajectory(row.id);
    if (!traj || traj.samples.length < 2) continue;
    const totals = traj.samples.map((s) => s.contextTotal);
    const dropped = totals.some((t, i) => i > 0 && t < totals[i - 1] * 0.5);
    if (dropped) floors.push(Math.min(...totals));
  }
  return floors.length ? Math.min(...floors) : null;
}

function brainAttachments(id) {
  const dir = path.join(BRAIN, id, '.user_uploaded');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const size = fs.statSync(full).size;
        out.push({ name: entry.name, size, image: imageSize(full) });
      } catch {
        /* unreadable entry: skip */
      }
    }
  };
  walk(dir);
  return out;
}

module.exports = {
  ROOT,
  STEP_TYPE,
  listConversations,
  conversationTitle,
  findActiveConversation,
  readTrajectory,
  readGenerationStats,
  limitFromMeta,
  learnFloor,
  brainAttachments,
  trajectoryPath,
};
