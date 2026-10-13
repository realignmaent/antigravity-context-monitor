'use strict';

// Minimal protobuf wire-format reader. Antigravity stores its trajectory as
// schema-less protobuf blobs, so everything here works purely on field numbers.

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, i];
    shift += 7;
    if (shift > 63) throw new RangeError('varint too long');
  }
  throw new RangeError('varint truncated');
}

// Walks one message level. Returns { vars, lens } where vars maps field number
// to the last varint seen and lens maps field number to an array of Buffers.
function readMessage(buf) {
  const vars = {};
  const lens = {};
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = key >>> 3;
    const wire = key & 0x7;
    if (wire === 0) {
      let value;
      [value, i] = readVarint(buf, i);
      vars[field] = value;
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      if (i + len > buf.length) break;
      (lens[field] ||= []).push(buf.subarray(i, i + len));
      i += len;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return { vars, lens };
}

function getVar(buf, field) {
  return readMessage(buf).vars[field];
}

function getLens(buf, field) {
  return readMessage(buf).lens[field] || [];
}

// Convenience: descend a chain of LEN fields, e.g. getPath(buf, [5, 9]).
function getPath(buf, path) {
  let current = [buf];
  for (const field of path) {
    const next = [];
    for (const b of current) next.push(...getLens(b, field));
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

module.exports = { readVarint, readMessage, getVar, getLens, getPath };
