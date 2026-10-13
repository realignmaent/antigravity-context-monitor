'use strict';

const { estimateTokens, estimateTokensFromBytes, estimateImageTokens } = require('./estimate');

// The app assembles the prompt as: [declarative header sections] followed by
// [the live conversation body]. In the blob the header is small and named; the
// body is the bulk and starts at `</user_information>` (or at the compaction
// summary when one exists). Order within the header is resolved from the blob.
// Taken from the app's own section registry (found in the request metadata), so
// every section it can emit has a home instead of bleeding into a neighbour.
const HEADER_SECTIONS = [
  'identity',
  'terminal_sandbox',
  'artifacts',
  'conversation_transcript',
  'guidelines',
  'communication_style',
  'slash_commands',
  'messaging',
  'mcp_servers',
  'subagents',
  'user_rules',
  'skills',
  'user_information',
  'subagent_reminder',
];

const BODY_MARKERS = ['</user_information>', '<CONTEXT_SUMMARY>'];

// Antigravity section -> panel category. Sections we never see are simply absent.
const SECTION_CATEGORY = {
  identity: 'systemPrompt',
  guidelines: 'systemPrompt',
  communication_style: 'systemPrompt',
  user_information: 'systemPrompt',
  artifacts: 'systemPrompt',
  terminal_sandbox: 'systemPrompt',
  subagent_reminder: 'customAgents',
  mcp_servers: 'mcpTools',
  skills: 'skills',
  subagents: 'customAgents',
  user_rules: 'memoryFiles',
  slash_commands: 'memoryFiles',
  messaging: 'memoryFiles',
  conversation_transcript: 'systemPrompt',
};

const CATEGORIES = [
  { key: 'messages', label: 'Messages', color: '#4f7cff' },
  { key: 'mcpTools', label: 'MCP tools', color: '#f2a33c' },
  { key: 'systemPrompt', label: 'System prompt', color: '#3f8f6f' },
  { key: 'skills', label: 'Skills', color: '#8b6cf0' },
  { key: 'customAgents', label: 'Custom agents', color: '#e5679a' },
  { key: 'memoryFiles', label: 'Memory files', color: '#37b3c4' },
  { key: 'attachments', label: 'Attachments', color: '#c98a3a' },
  { key: 'fixedOverhead', label: 'Fixed overhead', color: '#9aa4b2' },
];

function findAll(haystack, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

// The assembled prompt is stored contiguously; when the blob carries it twice we
// keep only the first copy (delimited by the second `<identity>`).
// Returns { sections: {name -> text}, body: messagesText }.
function splitSections(prompt) {
  if (!prompt) return { sections: {}, body: '' };
  const starts = findAll(prompt, '<identity>');
  if (starts.length === 0) return { sections: {}, body: '' };

  const begin = starts[0];
  const marker = BODY_MARKERS.map((m) => prompt.indexOf(m, begin)).filter((i) => i !== -1);
  let bodyStart = marker.length ? Math.min(...marker) : prompt.length;
  if (prompt.startsWith('</user_information>', bodyStart)) bodyStart += '</user_information>'.length;

  const header = prompt.slice(begin, bodyStart);

  // The blob ends with a verbatim repeat of the header, and the body runs until
  // it begins. Match that whole header rather than just the `<identity>` tag:
  // a body that merely *mentions* "<identity>" (e.g. when discussing Antigravity's
  // own prompt) used to be cut off at the mention, collapsing Messages to nothing.
  let bodyEnd = header ? prompt.indexOf(header, bodyStart) : -1;
  if (bodyEnd === -1) {
    const last = prompt.lastIndexOf('<identity>');
    bodyEnd = last > bodyStart ? last : prompt.length;
  }
  const body = prompt.slice(bodyStart, bodyEnd);

  const hits = [];
  for (const name of HEADER_SECTIONS) {
    const at = header.indexOf(`<${name}>`);
    if (at !== -1) hits.push({ name, at });
  }
  hits.sort((a, b) => a.at - b.at);

  const sections = {};
  hits.forEach((hit, i) => {
    const stop = i + 1 < hits.length ? hits[i + 1].at : header.length;
    sections[hit.name] = header.slice(hit.at, stop);
  });
  return { sections, body };
}

function findCompactions(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].contextTotal;
    const cur = samples[i].contextTotal;
    if (cur < prev * 0.5) out.push({ step: samples[i].idx, from: prev, to: cur });
  }
  return out;
}

function buildBreakdown(traj, attachments, options = {}) {
  const samples = traj.samples || [];
  const last = samples.at(-1);
  if (!last) {
    return { empty: true, reason: 'no-generations', model: traj.model, limit: traj.limit };
  }

  const total = last.contextTotal;
  const limit = traj.limit || null;

  const { sections, body } = splitSections(traj.latestPrompt);

  const headerRaw = {};
  for (const key of new Set(Object.values(SECTION_CATEGORY))) headerRaw[key] = 0;
  for (const [name, text] of Object.entries(sections)) {
    const cat = SECTION_CATEGORY[name];
    if (cat) headerRaw[cat] += estimateTokens(text);
  }

  const attachmentTokens = attachments.reduce(
    (sum, a) =>
      sum + (a.image ? estimateImageTokens(a.image.width, a.image.height) : estimateTokensFromBytes(a.size)),
    0
  );

  // The conversation is re-sent whole on every turn, so the prompt floor — the
  // context total right after a compaction — is what the fixed part costs. That
  // measured floor beats any estimate of it, and everything above the floor is
  // conversation. Text estimates are used only to divide the fixed part.
  const ownFloor = Math.min(...samples.map((s) => s.contextTotal));
  const observed = samples.length >= 2 && ownFloor < total * 0.9;
  const floor = observed ? ownFloor : options.floorHint && options.floorHint < total ? options.floorHint : null;

  const headerSum = Object.values(headerRaw).reduce((a, b) => a + b, 0);
  const bodyEst = estimateTokens(body);

  const tokens = {};
  let scale = 1;

  if (floor != null) {
    scale = headerSum > 0 ? Math.min(1, floor / headerSum) : 0;
    for (const key of Object.keys(headerRaw)) tokens[key] = Math.round(headerRaw[key] * scale);

    // Attached media travels inside the conversation, so it is carved out of the
    // growth rather than added on top of it.
    const growth = Math.max(0, total - floor);
    tokens.attachments = Math.round(Math.min(attachmentTokens, growth));
    tokens.messages = Math.round(growth - tokens.attachments);

    const headerTokens = Object.entries(tokens)
      .filter(([k]) => !['messages', 'attachments', 'fixedOverhead'].includes(k))
      .reduce((sum, [, v]) => sum + v, 0);
    tokens.fixedOverhead = Math.max(0, floor - headerTokens);
  } else {
    // No floor observed or learned: split the total by the text proportions and
    // let the remainder land in fixed overhead.
    const est = headerSum + bodyEst;
    scale = est > 0 ? total / est : 0;
    for (const key of Object.keys(headerRaw)) tokens[key] = Math.round(headerRaw[key] * scale);
    tokens.attachments = Math.round(attachmentTokens);
    tokens.messages = Math.round(bodyEst * scale);
    tokens.fixedOverhead = 0;
  }

  const categories = CATEGORIES.map((c) => ({ ...c, tokens: tokens[c.key] || 0 })).filter(
    (c) => c.tokens > 0
  );

  // Rounding, and the clamp on fixed overhead, can leave a few tokens unassigned.
  // Conversation growth is the right place for them.
  const drift = total - categories.reduce((sum, c) => sum + c.tokens, 0);
  if (drift !== 0) {
    let messages = categories.find((c) => c.key === 'messages');
    if (!messages) {
      messages = { ...CATEGORIES.find((c) => c.key === 'messages'), tokens: 0, percent: 0 };
      categories.push(messages);
    }
    messages.tokens = Math.max(0, messages.tokens + drift);
  }

  for (const c of categories) {
    c.percent = total > 0 ? (c.tokens / total) * 100 : 0;
  }
  categories.sort((a, b) => b.tokens - a.tokens);

  const compactions = findCompactions(samples);
  const cycleStart = compactions.length ? compactions.at(-1).step : 0;
  const series = samples.filter((s) => s.idx >= cycleStart).map((s) => s.contextTotal);

  return {
    empty: false,
    model: traj.model,
    limit,
    total,
    freeSpace: limit ? Math.max(0, limit - total) : null,
    // Compaction fires a little past the nominal window, so a reading can sit
    // above 100%. Surfacing the overshoot beats showing a confusing "0 free".
    overBy: limit && total > limit ? total - limit : 0,
    percent: limit ? (total / limit) * 100 : null,
    categories,
    series,
    compactions,
    compactionCount: compactions.length,
    scaled: scale !== 1,
  };
}

module.exports = { buildBreakdown, splitSections, findCompactions, CATEGORIES };
