'use strict';

const models = require('./models');
const config = require('./config');

// Decides when to say something encouraging, and where the words come from.
//
// Two rules shape this: never nag, and never fail loudly into the UI. Each
// trigger fires at most once per conversation, and every failure path - no
// models.json, unresolvable key, timeout, empty reply - falls back to the
// built-in lines below.

// Threshold stages, highest first. The user asked for 50/70/90 rather than only
// the top of the range: a phrase this early is a rhythm marker, and it also means
// the few seconds a reasoning model spends thinking never feels late.
const THRESHOLDS = [
  {
    key: 'danger90',
    at: 90,
    zh: '快到上限了，收个尾吧',
    en: 'Near the limit - start wrapping up',
    prompt: '上下文已经超过 90%，随时可能触发自动压缩',
  },
  {
    key: 'warn70',
    at: 70,
    zh: '过半不少了，稳住节奏',
    en: 'Well past halfway - hold the pace',
    prompt: '上下文超过 70%，中段，还能从容地推进',
  },
  {
    key: 'half50',
    at: 50,
    zh: '一半了，节奏不错',
    en: 'Halfway - good rhythm',
    prompt: '上下文刚过 50%，正是状态最好的时候',
  },
];

const EVENTS = {
  compacted: {
    zh: '刚整理过，轻装上阵',
    en: 'Freshly compacted - clean slate',
    prompt: '上下文刚刚被自动压缩过，早期的对话细节已经被摘要替代',
  },
  freshStart: {
    zh: '新会话，开始吧',
    en: 'New conversation - off we go',
    prompt: '这是一段全新会话的第一轮',
  },
};

const TRIGGERS = { ...EVENTS };
for (const stage of THRESHOLDS) TRIGGERS[stage.key] = stage;

// Priority order matters when several are pending at once - e.g. the panel first
// sees a conversation that is already at 92%. "compacted" outranks the lower
// thresholds so a compaction is never missed in favour of a percentage.
const ORDER = ['danger90', 'compacted', 'warn70', 'half50', 'freshStart'];

// Which percentage stages a given trigger makes redundant. When 90% fires first,
// catch-up calls for 70% and 50% would arrive seconds apart and read as nagging.
const SUPERSEDES = {
  danger90: ['warn70', 'half50'],
  warn70: ['half50'],
};

const FALLBACK_LANGUAGES = { zh: 'zh', en: 'en' };

// The whole persona. Everything here exists to stop a specific failure: models
// default to cheerleader mode ("加油！你最棒！"), which is the opposite of what
// lands well while someone is mid-task. Constraints are spelled out because a
// small model reading them as prose will ignore them.
const SYSTEM_PROMPTS = {
  zh: [
    '你是一个安静的编程搭子，坐在用户旁边看他写代码。',
    '在上下文窗口进入新阶段时，你说一句恰到好处的话——不多不少。',
    '',
    '只输出这句话本身。规则：',
    '- 12 到 20 个字。最多一个 emoji，也可以没有。',
    '- 不要引号、不要换行、不要解释、不要称呼用户、不要复述任何数字或百分比。',
    '- 平静、具体，像同事随口说的一句，不是系统通知。',
    '- 不喊口号、不夸奖用户（"太厉害了""完美"一律不要）、不拍马屁。',
    '- 语气跟着阶段走：刚到一半是肯定节奏；过半是稳住；接近上限是提醒收尾；压缩之后是重新开始。',
    '- 如果会话主题能看出在做什么，可以让这句话和那件事沾点边，但不要复述主题、不要暴露它。',
  ].join('\n'),
  en: [
    'You are a quiet pair-programmer sitting next to someone while they work.',
    'When the context window enters a new stage you say one well-judged thing - no more.',
    '',
    'Output that sentence and nothing else. Rules:',
    '- 8 to 14 words. At most one emoji, or none.',
    '- No quotes, no line breaks, no explanation, no addressing the user, no restating numbers.',
    '- Calm and concrete - something a colleague would say, not a system notification.',
    '- No rallying cries, no praise ("amazing", "perfect"), no flattery.',
    '- Match the stage: at halfway affirm the pace; past two thirds steady them; near the limit suggest wrapping up; after a compaction, a clean restart.',
    '- If the topic hints at what they are working on, you may allude to it, but never restate or expose it.',
  ].join('\n'),
};

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

  for (const stage of THRESHOLDS) {
    if (percent != null && percent >= stage.at) pending[stage.key] = true;
  }
  if (state.compactionCount != null && payload.compactionCount > state.compactionCount) {
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

  const system = SYSTEM_PROMPTS[settings.language] || SYSTEM_PROMPTS.zh;

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
  for (const redundant of SUPERSEDES[trigger] || []) state.seen[redundant] = true;
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

module.exports = { pick, take, reset, sanitize, fallbackFor, TRIGGERS, SUPERSEDES };
