'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const phrases = require('../src/phrases');
const { merge } = require('../src/config');

test('sanitize: strips quotes and newlines, collapses spaces', () => {
  assert.equal(phrases.sanitize('  "hello\n\nworld"  ', 'en'), 'hello world');
  assert.equal(phrases.sanitize('“中文\n鼓励”', 'zh'), '中文 鼓励');
  assert.equal(phrases.sanitize('$$literal', 'en'), '$$literal'); // untouched content
});

test('sanitize: clamps overlong replies with an ellipsis', () => {
  const out = phrases.sanitize('a'.repeat(80), 'en');
  assert.ok(out.length <= 61, 'clamped to the 60-char limit plus the ellipsis');
  assert.ok(out.endsWith('…'));
  assert.equal(phrases.sanitize('   ', 'en'), null);
  assert.equal(phrases.sanitize(null, 'en'), null);
});

test('fallback lines exist for every trigger, in both languages', () => {
  for (const [key, spec] of Object.entries(phrases.TRIGGERS)) {
    assert.ok(spec.zh, `${key} is missing a zh fallback`);
    assert.ok(spec.en, `${key} is missing an en fallback`);
    assert.ok(spec.prompt, `${key} is missing its generation prompt`);
  }
});

test('trigger order and supersede rules only reference known triggers', () => {
  // A typo in either list would silently disable a trigger, and nothing else
  // would catch it.
  const known = new Set(Object.keys(phrases.TRIGGERS));
  assert.deepEqual(
    Object.keys(phrases.TRIGGERS).sort(),
    ['compacted', 'danger90', 'freshStart', 'half50', 'warn70']
  );
  const supersedeTargets = Object.values(phrases.SUPERSEDES || {}).flat();
  for (const key of [...supersedeTargets]) {
    assert.ok(known.has(key), `SUPERSEDES references unknown trigger "${key}"`);
  }
});

test('config merge: a local override replaces one key without clobbering siblings', () => {
  const base = { limitOverride: null, phrases: { enabled: true, language: 'zh', sendConversationTitle: false } };
  const merged = merge(base, { phrases: { sendConversationTitle: true } });
  assert.equal(merged.phrases.sendConversationTitle, true);
  assert.equal(merged.phrases.enabled, true, 'shallow merge would have lost this');
  assert.equal(merged.phrases.language, 'zh', 'shallow merge would have lost this');
  assert.equal(merged.limitOverride, null);
  assert.equal(merged.a, undefined);
});
