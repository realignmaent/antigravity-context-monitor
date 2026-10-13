'use strict';

const models = require('./models');
const config = require('./config');

// Decides when to say something encouraging, and where the words come from.
//
// Two rules shape this: never nag, and never fail loudly into the UI. Each
// trigger fires at most once per conversation, and every failure path - no
// models.json, unresolvable key, timeout, empty reply - falls back to the
// built-in lines below.

const TRIGGERS = {
  danger95: {
    zh: '上下文很满了，收个尾吧',
    en: 'Nearly full - time to wrap up',
    prompt: '上下文已经超过 95%，随时可能被自动压缩',
  },
  compacted: {
    zh: '刚整理过，轻装上阵',
    en: 'Freshly compacted - clean slate',
    prompt: '上下文刚刚被自动压缩过，早期的对话细节已经被摘要替代',
  },
  warn85: {
    zh: '已经用掉大半了，稳住',
    en: 'Past three quarters - steady on',
    prompt: '上下文刚超过 85%，开始进入紧张区间',
  },
  freshStart: {
    zh: '新会话，开始吧',
    en: 'New conversation - off we go',
    prompt: '这是一段全新会话的第一轮',
  },
};

// Priority order matters when several are pending at once, e.g. the panel first
// sees a conversation that is already at 96%.
const ORDER = ['danger95', 'compacted', 'warn85', 'freshStart'];

const FALLBACK_LANGUAGES = { zh: 'zh', en: 'en' };

function settingsOf() {
  const all = config.load();
  const raw = all.phrases || {};
  return {
    enabled: raw.enabled !== false,
    language: FALLBACK_LANGUAGES[raw.language] || 'zh',
    // Off unless switched on explicitly: the title names what the user is working
    // on, and it is the only thing that leaves the machine beyond plain numbers.
    sendTitle: raw.sendConversationTitle === true,
    preferredModel: all.phraseModel || '',
  };
}

// conversationId -> { seen, generations, compactionCount, percent, ready }
const conversations = new Map();

function stateFor(id) {
  let state = conversations.get(id);
  if (!state) {
    state = {
      seen: {},
      percent: null,
      compactionCount: null,
      generations: null,
      wanted: null,     // trigger currently being resolved
      ready: null,      // { text, trigger } waiting to be collected
      failureLogged: false,
    };
    conversations.set(id, state);
    // Keep the map from growing without bound across a long session.
    if (conversations.size > 50) conversations.delete(conversations.keys().next().value);
  }
  return state;
}

function nextTrigger(state, payload) {
  const percent = payload.percent;
  const pending = {};

  if (percent != null && percent >= 95) pending.danger95 = true;
  if (percent != null && percent >= 85) pending.warn85 = true;
  if (
    state.compactionCount != null &&
    payload.compactionCount > state.compactionCount
  ) {
    pending.compacted = true;
  }
  if (payload.generations === 1) pending.freshStart = true;

  for (const trigger of ORDER) {
    if (pending[trigger] && !state.seen[trigger]) return trigger;
  }
  return null;
}

function sanitize(text, language) {
  if (typeof text !== 'string') return null;
  let out = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!out) return null;
  const limit = language === 'en' ? 60 : 30;
  if (out.length > limit) out = out.slice(0, limit).trim() + '…';
  return out;
}

function fallbackFor(trigger, language) {
  return (TRIGGERS[trigger] || {})[language] || TRIGGERS[trigger]?.en || '';
}

async function generate(trigger, payload, settings) {
  const model = models.pick(settings.preferredModel);
  if (!model) throw new Error('no model in models.json');

  const lines = [`场景：${TRIGGERS[trigger].prompt}`];
  if (payload.percent != null) {
    lines.push(`当前上下文：已用 ${payload.total} / ${payload.limit}（${payload.percent.toFixed(1)}%）`);
  }
  if (payload.model) lines.push(`模型：${payload.model}`);
  if (payload.categories?.length) {
    const top = payload.categories
      .slice(0, 3)
      .map((c) => `${c.label} ${c.percent.toFixed(0)}%`)
      .join('、');
    lines.push(`占比最高的几项：${top}`);
  }
  // The only field beyond plain numbers, and opt-in - see settingsOf().
  if (settings.sendTitle && payload.title) lines.push(`会话主题：${payload.title}`);

  const language = settings.language === 'en' ? 'English' : '简体中文';
  const system = [
    `你是一个安静的编程搭子，只在关键时刻说一句鼓励。`,
    `只输出这一句话本身：用${language}，不超过 ${settings.language === 'en' ? 12 : 20} 个字，`,
    `不要引号、不要换行、不要解释、不要称呼用户。最多用 1 个 emoji。`,
  ].join('');

  const text = await models.complete({
    model,
    system,
    prompt: lines.join('\n'),
    // Generous by default: a reasoning model spends a few hundred tokens thinking
    // before it emits a single word, and a tight budget yields an empty answer.
    // A model that does not reason stops on its own, so the extra headroom is free.
    // models.json can override this per model, as pi's schema allows.
    maxTokens: model.maxTokens || 1024,
    timeoutMs: 15000,
  });
  return sanitize(text, settings.language);
}

// Detects a trigger and starts resolving it in the background. Never awaits, so
// the injector's poll loop is not held up by a slow provider.
function pick(conversationId, payload) {
  if (!conversationId) return null;
  const settings = settingsOf();
  const state = stateFor(conversationId);

  if (!settings.enabled) {
    state.percent = payload.percent;
    state.compactionCount = payload.compactionCount;
    state.generations = payload.generations;
    return null;
  }

  const forced = process.env.AGCM_FAKE_TRIGGER;
  const trigger = forced && TRIGGERS[forced] && !state.seen[forced] ? forced : nextTrigger(state, payload);

  state.percent = payload.percent;
  state.compactionCount = payload.compactionCount;
  state.generations = payload.generations;

  if (!trigger) return null;
  // danger95 already says everything warn85 would; don't queue both.
  if (trigger === 'danger95') state.seen.warn85 = true;
  state.seen[trigger] = true;
  state.wanted = trigger;

  generate(trigger, payload, settings)
    .then((text) => {
      state.ready = { text: text || fallbackFor(trigger, settings.language), trigger };
    })
    .catch((err) => {
      if (!state.failureLogged) {
        state.failureLogged = true;
        console.error(`[phrases] falling back to built-in lines: ${err.message}`);
      }
      state.ready = { text: fallbackFor(trigger, settings.language), trigger };
    });

  return trigger;
}

// Hands over a resolved phrase exactly once.
function take(conversationId) {
  const state = conversations.get(conversationId);
  if (!state || !state.ready) return null;
  const phrase = state.ready;
  state.ready = null;
  state.wanted = null;
  return phrase;
}

function reset() {
  conversations.clear();
}

module.exports = { pick, take, reset, sanitize, fallbackFor, TRIGGERS };
