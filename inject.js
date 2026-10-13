'use strict';

// Embeds the context meter inside Antigravity's own composer, the way Claude
// Code shows its panel in-place. Talks to the app's DevTools endpoint (which
// Antigravity already exposes) and pushes the reading into the renderer.
//
//   node inject.js            # attach, then keep it updated
//   node inject.js --remove   # take the meter out
//
// Zero dependencies: uses the built-in WebSocket and node:sqlite.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  conversationTitle,
  readTrajectory,
  learnFloor,
  brainAttachments,
  trajectoryPath,
} = require('./src/reader');
const { buildBreakdown } = require('./src/analyzer');
const phrases = require('./src/phrases');

// Measured: one tick is a single Runtime.evaluate of ~0.4ms, so this costs about
// 0.1% of a core. Parsing a trajectory is skipped unless the file actually
// changed, so the poll rate does not multiply the expensive work. Was 2000, which
// made switching conversations feel laggy.
const POLL_MS = Number(process.env.AGCM_POLL) || 150;

// How long an encouragement stays up. Kept here rather than in the page because
// the page's own timers are throttled while Antigravity is in the background.
const SAY_HOLD_MS = 3500;
const RECONNECT_MS = 3000;
const UI_SRC = fs.readFileSync(path.join(__dirname, 'src', 'inject-ui.js'), 'utf8');

const CONV_RE = /\/c\/([0-9a-fA-F-]{36})/;

// ---------------------------------------------------------------- CDP plumbing

function httpJson(port, routePath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: routePath, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// Antigravity writes its DevTools port to this file when remote debugging is on.
function discoverPort() {
  if (process.env.AGCM_CDP_PORT) return Number(process.env.AGCM_CDP_PORT);
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [
    process.env.AGCM_USER_DATA,
    path.join(roaming, 'Antigravity', 'DevToolsActivePort'),
    path.join(roaming, 'Antigravity IDE', 'DevToolsActivePort'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0].trim());
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

async function findConversationPage(port) {
  const pages = (await httpJson(port, '/json/list')).filter((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!pages.length) return null;
  return pages.find((p) => CONV_RE.test(p.url)) || pages[0];
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const onError = () => reject(new Error('could not open DevTools socket'));
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener(
        'open',
        () => {
          ws.removeEventListener('error', onError);
          resolve(new Cdp(ws));
        },
        { once: true }
      );
    });
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 5000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'page error');
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ------------------------------------------------------------------ data side

let lastSignature = '';
let lastPayload = null;

// `conversationId` comes from the page URL. There is deliberately NO fallback to
// "the most recently active conversation": on a new-conversation screen that
// would show another conversation's numbers, which is worse than showing none.
function payloadFor(conversationId) {
  if (!conversationId) return null;

  const file = trajectoryPath(conversationId);
  let signature;
  try {
    const stat = fs.statSync(file);
    signature = `${conversationId}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  if (signature === lastSignature && lastPayload) return lastPayload;

  const traj = readTrajectory(conversationId);
  if (!traj || traj.samples.length === 0) return null;

  const breakdown = buildBreakdown(traj, brainAttachments(traj.id), { floorHint });
  if (breakdown.empty) return null;

  const observed = Math.min(...traj.samples.map((s) => s.contextTotal));
  if (traj.samples.length >= 2 && observed < breakdown.total && (floorHint == null || observed < floorHint)) {
    floorHint = observed;
  }

  lastSignature = signature;
  lastPayload = {
    title: conversationTitle(conversationId),
    model: breakdown.model,
    limit: breakdown.limit,
    total: breakdown.total,
    freeSpace: breakdown.freeSpace,
    overBy: breakdown.overBy,
    percent: breakdown.percent,
    categories: breakdown.categories,
    // Consumed by the phrases trigger logic: a compaction is a jump in the count,
    // and exactly one generation means the conversation just started.
    compactionCount: breakdown.compactionCount,
    generations: traj.samples.length,
    updatedAt: Date.now(),
  };
  return lastPayload;
}

let floorHint = null;

function learnFloorOnce() {
  try {
    floorHint = learnFloor();
  } catch {
    floorHint = null;
  }
}

// ---------------------------------------------------------------------- loop

const READ_CONV = `(() => { const m = location.pathname.match(/\\/c\\/([0-9a-fA-F-]{36})/); return m ? m[1] : null; })()`;

// Single source of truth for the page-side build id lives in inject-ui.js.
const UI_VERSION = (/const VERSION = '([^']+)'/.exec(UI_SRC) || [])[1] || 'none';
const HAS_UI = `!!(window.__agcm && window.__agcm.version === ${JSON.stringify(UI_VERSION)})`;

// Repeats every few seconds while Antigravity starts up, so failures are
// reported once per distinct reason instead of spamming.
let lastAttachNote = '';
function noteAttach(message) {
  if (message === lastAttachNote) return;
  lastAttachNote = message;
  if (message) console.error(message);
}

async function attach() {
  const port = discoverPort();
  if (!port) {
    noteAttach('等待 Antigravity 暴露调试端口（DevToolsActivePort）…');
    return null;
  }
  const page = await findConversationPage(port);
  if (!page) {
    noteAttach(`端口 ${port} 上暂时没有可用页面，等待中…`);
    return null;
  }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  return { cdp, pageId: page.id, port };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const removeOnly = process.argv.includes('--remove');
  // How long to keep waiting after Antigravity disappears. Long enough to cover
  // a restart, short enough that it does not linger after you are done.
  // `|| 30` (not `?? 30`): Number(undefined) is NaN, which `??` does not catch.
  // Set to 0 to keep waiting forever instead of exiting.
  const idleExitMin = Number(process.env.AGCM_IDLE_EXIT_MIN || 30);
  const idleExitMs = (Number.isFinite(idleExitMin) ? idleExitMin : 30) * 60_000;

  let session = null;
  let uiReady = false;
  let absentSince = null;
  let lastPushedKey = '';
  let lastBeatAt = 0;
  let sayTimer = null;

  const teardown = async () => {
    if (sayTimer) clearTimeout(sayTimer);
    sayTimer = null;
    if (session) session.cdp.close();
    session = null;
    uiReady = false;
  };

  for (;;) {
    if (!session) {
      // "Antigravity is up" means "its debug endpoint answers", not "a process
      // named Antigravity.exe exists" -- the sidecar host keeps that name alive
      // forever, which made a process-based check always true and silently
      // disabled the idle exit below.
      const attached = await attach();
      if (!attached) {
        if (removeOnly) {
          console.log('Antigravity 未运行，无需移除。');
          return;
        }
        absentSince ??= Date.now();
        if (idleExitMs > 0 && Date.now() - absentSince > idleExitMs) {
          const mins = idleExitMs / 60000;
          const label = mins >= 1 ? `${Math.round(mins)} 分钟` : `${Math.round(idleExitMs / 1000)} 秒`;
          console.log(`Antigravity 已停用超过 ${label}，退出。`);
          return;
        }
        await sleep(RECONNECT_MS);
        continue;
      }
      session = attached;
      absentSince = null;
      lastAttachNote = '';
      console.log(`已连接 Antigravity（端口 ${session.port}）`);
    }

    try {

      if (removeOnly) {
        await session.cdp.eval('window.__agcm && window.__agcm.remove()');
        console.log('已移除嵌入的上下文面板。');
        teardown();
        return;
      }

      if (!uiReady) {
        await session.cdp.eval(UI_SRC);
        uiReady = true;
        lastPushedKey = '';   // a fresh UI has nothing rendered yet
      } else if (!(await session.cdp.eval(HAS_UI))) {
        // The page reloaded (Antigravity restart, Ctrl+R): the old element and
        // its state are gone, so re-inject and force the next push.
        await session.cdp.eval(UI_SRC);
        lastPushedKey = '';
      }

      const convId = await session.cdp.eval(READ_CONV);
      const payload = payloadFor(convId);
      const key = payload ? `${convId}:${payload.updatedAt}` : `none:${convId || ''}`;

      // Only touch the DOM when the conversation or the numbers actually changed;
      // this runs several times a second and needless writes make the host app
      // re-layout for no reason.
      if (key !== lastPushedKey) {
        lastPushedKey = key;
        if (payload) {
          await session.cdp.eval(`window.__agcm.set(${JSON.stringify(payload)})`);
        } else {
          // New-conversation screen, or a conversation with nothing in it yet.
          await session.cdp.eval('window.__agcm.hide()');
        }
        lastBeatAt = Date.now();
      } else if (payload && Date.now() - lastBeatAt > 1000) {
        // Nothing changed. Say so anyway, once a second, so the panel can tell
        // "idle" apart from "the injector died and the numbers are frozen".
        lastBeatAt = Date.now();
        await session.cdp.eval('window.__agcm.beat()');
      }

      // Encouragement rides its own channel rather than the data payload: it
      // arrives asynchronously (a provider call), and folding it into `set()`
      // would mean re-pushing identical numbers just to carry a sentence.
      if (payload) {
        phrases.pick(convId, payload);
        const phrase = phrases.take(convId);
        if (phrase) {
          await session.cdp.eval(`window.__agcm.say(${JSON.stringify(phrase)})`);
          // The revert is scheduled here, not in the page: Chromium throttles
          // timers in hidden pages, so a page-side timer can leave a sentence
          // covering the numbers for a minute or more.
          if (sayTimer) clearTimeout(sayTimer);
          sayTimer = setTimeout(() => {
            sayTimer = null;
            session?.cdp.eval('window.__agcm.sayEnd()').catch(() => {});
          }, SAY_HOLD_MS);
        }
      }
    } catch (err) {
      console.error('注入中断，重试中：' + err.message);
      await teardown();
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
      continue;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

learnFloorOnce();
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
