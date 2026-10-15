'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSections, findCompactions, buildBreakdown } = require('../src/analyzer');
const { estimateTokens, estimateImageTokens } = require('../src/estimate');

// Mirrors the real blob layout: header (identity .. user_information), then the
// body, then a verbatim repeat of the header at the end.
function buildPrompt(body, { tailRepeat = true } = {}) {
  const header = '<identity>\nYou are Antigravity.\n<guidelines>\ng</guidelines>\n<user_information>\nenv\n</user_information>';
  const bodyText = '<CONTEXT_SUMMARY>' + body + '</CONTEXT_SUMMARY>';
  return header + bodyText + (tailRepeat ? header : '');
}

test('splitSections: separates the header sections from the body', () => {
  const { sections, body } = splitSections(buildPrompt('hello world'));
  assert.ok(sections.identity.includes('You are Antigravity.'));
  assert.ok(sections.guidelines.includes('<guidelines>'));
  assert.ok(sections.user_information.includes('env'));
  assert.equal(body, '<CONTEXT_SUMMARY>hello world</CONTEXT_SUMMARY>');
});

test('splitSections: a body that mentions <identity> is not truncated', () => {
  // The original bug: the second <identity> occurrence was treated as the end of
  // the prompt, so a body that merely discussed the tag collapsed Messages to
  // almost nothing and the difference piled into fixed overhead.
  const body = '讨论 <identity> 标签的用法，' + 'x'.repeat(300);
  const { body: body1 } = splitSections(buildPrompt(body, { tailRepeat: true }));
  assert.ok(body1.includes('讨论 <identity> 标签'), 'mention survives with a tail repeat');
  assert.ok(body1.length > 300, 'body keeps its full length');

  const { body: body2 } = splitSections(buildPrompt(body, { tailRepeat: false }));
  assert.ok(body2.includes('讨论 <identity> 标签'), 'mention survives without a tail repeat');
  assert.ok(body2.length > 300);
});

test('splitSections: prompt without <identity> yields nothing, not a crash', () => {
  assert.deepEqual(splitSections(''), { sections: {}, body: '' });
  assert.deepEqual(splitSections('no tags here'), { sections: {}, body: '' });
});

test('splitSections: every known section is captured even when reordered', () => {
  // user_information ends the header in every real blob, so it stays last here;
  // the other sections are shuffled relative to the declaration order in
  // HEADER_SECTIONS to prove slicing follows position, not the list.
  const prompt =
    '<identity>i</identity><skills>s</skills><guidelines>g</guidelines><user_information>u</user_information>';
  const { sections, body } = splitSections(prompt);
  assert.equal(sections.identity, '<identity>i</identity>');
  assert.equal(sections.skills, '<skills>s</skills>');
  assert.equal(sections.guidelines, '<guidelines>g</guidelines>');
  assert.equal(sections.user_information, '<user_information>u</user_information>');
  assert.equal(body, '');
});

test('findCompactions: flags only the drops, with their from/to values', () => {
  const samples = [
    { idx: 1, contextTotal: 100 },
    { idx: 2, contextTotal: 150 },
    { idx: 3, contextTotal: 40 },
    { idx: 4, contextTotal: 45 },
    { idx: 5, contextTotal: 20 },
  ];
  assert.deepEqual(findCompactions(samples), [
    { step: 3, from: 150, to: 40 },
    { step: 5, from: 45, to: 20 },
  ]);
  assert.deepEqual(findCompactions([{ idx: 1, contextTotal: 10 }, { idx: 2, contextTotal: 20 }]), []);
});

function traj(contextTotals, extras = {}) {
  return {
    id: 'test',
    samples: contextTotals.map((contextTotal, i) => ({ idx: i + 1, contextTotal })),
    model: 'test-model',
    limit: 256000,
    latestPrompt: extras.prompt || '',
    ...extras.fields,
  };
}

test('buildBreakdown: parts sum to the measured total, overhead equals the floor', () => {
  const b = buildBreakdown(traj([22073, 50000]), []);
  assert.equal(b.empty, false);
  const sum = b.categories.reduce((a, c) => a + c.tokens, 0);
  assert.equal(sum, 50000, 'sum check - the invariant the panel guarantees');
  assert.equal(b.categories.find((c) => c.key === 'fixedOverhead').tokens, 22073);
  assert.equal(b.categories.find((c) => c.key === 'messages').tokens, 27927);
  assert.equal(b.freeSpace, 206000);
  assert.equal(b.overBy, 0);
});

test('buildBreakdown: an image attachment is charged by tiles, not bytes', () => {
  // A 250KB PNG at 800x600 is 2 tiles -> 516 tokens. Charging bytes used to
  // claim ~62k tokens for the same file.
  const attachments = [{ name: 'pic.png', size: 250000, image: { width: 800, height: 600 } }];
  const b = buildBreakdown(traj([22073, 100000]), attachments);
  assert.equal(b.categories.find((c) => c.key === 'attachments').tokens, 516);
  const sum = b.categories.reduce((a, c) => a + c.tokens, 0);
  assert.equal(sum, 100000);
});

test('buildBreakdown: uses floorHint for conversations that never compacted', () => {
  const b = buildBreakdown(traj([30000]), [], { floorHint: 19383 });
  const sum = b.categories.reduce((a, c) => a + c.tokens, 0);
  assert.equal(sum, 30000);
  assert.ok(b.categories.find((c) => c.key === 'fixedOverhead').tokens > 0);
});

test('buildBreakdown: a one-sample conversation still sums to its total', () => {
  const b = buildBreakdown(traj([50000]), []);
  const sum = b.categories.reduce((a, c) => a + c.tokens, 0);
  assert.equal(sum, 50000);
});

test('buildBreakdown: over the window reports the overshoot, free space clamps to zero', () => {
  const b = buildBreakdown(traj([22073, 260000]), []);
  assert.equal(b.overBy, 4000);
  assert.equal(b.freeSpace, 0);
  assert.ok(b.percent > 100);
});

test('buildBreakdown: no generations means an empty breakdown, not a throw', () => {
  const b = buildBreakdown(traj([]), []);
  assert.equal(b.empty, true);
  assert.equal(b.reason, 'no-generations');
});

test('estimateTokens: CJK weighs about one token per glyph, ASCII about four per token', () => {
  const ascii = 'abcdefgh'; // 8 chars -> 2 tokens
  assert.equal(estimateTokens(ascii), 2);
  const cjk = '四个汉字'; // 4 glyphs -> 4 tokens
  assert.equal(estimateTokens(cjk), 4);
  assert.equal(estimateTokens(''), 0);
});

test('estimateImageTokens: 768x768 tiles at 258 tokens each', () => {
  assert.equal(estimateImageTokens(768, 768), 258);
  assert.equal(estimateImageTokens(800, 600), 516); // 2 tiles
  assert.equal(estimateImageTokens(1536, 1536), 1032); // 4 tiles
  assert.equal(estimateImageTokens(null, null), 258); // unknown dims: one tile
});
