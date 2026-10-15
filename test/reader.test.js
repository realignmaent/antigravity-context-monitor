'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readGenerationStats, limitFromMeta } = require('../src/reader');
const { varField, lenField } = require('./helpers');
const concat = (...parts) => Buffer.concat(parts);

// The real values live at step_payload -> 5 -> 9 -> {2,3,5}. These fixtures pin
// those reverse-engineered paths: if Antigravity moves a field number, these
// tests are what tell us, in CI, before anyone wonders why the panel shows
// nothing.
test('readGenerationStats: extracts the context total at 5.9.5', () => {
  const payload = lenField(5, lenField(9, concat(varField(2, 500), varField(3, 700), varField(5, 123456))));
  assert.deepEqual(readGenerationStats(payload), { contextTotal: 123456, delta: 500, output: 700 });
});

test('readGenerationStats: returns null when the path is absent', () => {
  assert.equal(readGenerationStats(lenField(5, varField(1, 1))), null);
  assert.equal(readGenerationStats(Buffer.alloc(0)), null);
});

test('limitFromMeta: reads the window at 1.9.10.4', () => {
  const buf = lenField(1, lenField(9, lenField(10, concat(varField(4, 256000), varField(1, 999)))));
  assert.equal(limitFromMeta(buf), 256000);
});

test('limitFromMeta: null on any missing level, and rejects zero', () => {
  assert.equal(limitFromMeta(lenField(1, lenField(9, lenField(10, varField(1, 1))))), null);
  assert.equal(limitFromMeta(lenField(1, varField(4, 256000))), null);
  assert.equal(limitFromMeta(varField(4, 256000)), null);
  assert.equal(limitFromMeta(lenField(1, lenField(9, lenField(10, varField(4, 0))))), null);
});
