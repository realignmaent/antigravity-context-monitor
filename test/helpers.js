'use strict';

// Helpers to synthesize protobuf wire-format bytes for the tests. The parser
// under test (src/pb.js) is schema-less, so the fixtures are built by hand using
// the same encoding rules it reads.

function varintBytes(n) {
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varintBytes((field << 3) | wire);
}

function varField(field, value) {
  return Buffer.concat([tag(field, 0), varintBytes(value)]);
}

function lenField(field, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([tag(field, 2), varintBytes(buf.length), buf]);
}

module.exports = { varintBytes, tag, varField, lenField };
