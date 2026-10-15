'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readVarint, readMessage, getPath } = require('../src/pb');
const { varintBytes, varField, lenField } = require('./helpers');

test('readVarint: single and multi byte values', () => {
  assert.equal(readVarint(Buffer.from([0x00]), 0)[0], 0);
  assert.equal(readVarint(Buffer.from([0x05]), 0)[0], 5);
  assert.equal(readVarint(Buffer.from([0xac, 0x02]), 0)[0], 300);
  assert.equal(readVarint(varintBytes(256000), 0)[0], 256000);
  // A 32-bit sentinel Antigravity actually sends (seen in gen_metadata field 1.9.2).
  assert.equal(readVarint(varintBytes(0xffffffff >>> 0), 0)[0], 0xffffffff);
});

test('readVarint: reports the offset after the value', () => {
  const buf = Buffer.concat([varintBytes(300), Buffer.from([0x7f])]);
  const [value, next] = readVarint(buf, 0);
  assert.equal(value, 300);
  assert.equal(next, 2);
  assert.equal(buf[next], 0x7f);
});

test('readMessage: separates varint and length-delimited fields', () => {
  const msg = Buffer.concat([
    varField(1, 11),
    lenField(2, 'hello'),
    varField(3, 300),
    lenField(2, 'again'),
  ]);
  const { vars, lens } = readMessage(msg);
  assert.equal(vars[1], 11);
  assert.equal(vars[3], 300);
  assert.equal(lens[2].length, 2);
  assert.equal(lens[2][0].toString(), 'hello');
  assert.equal(lens[2][1].toString(), 'again');
});

test('readMessage: survives garbage that is not protobuf', () => {
  // Random bytes must not throw - the parser walks the app's blobs and has to
  // degrade rather than crash on a region it cannot interpret.
  const garbage = Buffer.from([0x0a, 0xff, 0xff, 0xff, 0x07, 0x12, 0x00, 0x08]);
  assert.doesNotThrow(() => readMessage(garbage));
});

test('getPath: descends nested length-delimited fields', () => {
  const inner = varField(2, 500);
  const middle = lenField(9, inner);
  const outer = lenField(5, middle);
  const found = getPath(outer, [5, 9]);
  assert.equal(found.length, 1);
  assert.deepEqual(readMessage(found[0]).vars, { 2: 500 });
  assert.deepEqual(getPath(outer, [5, 9, 7]), []);
});
