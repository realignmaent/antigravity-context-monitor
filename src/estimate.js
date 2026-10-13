'use strict';

// Rough token estimate for mixed CJK / ASCII text.
// CJK glyphs are close to one token each; ASCII runs average ~4 chars per token.
// Good to roughly +/-10%, which is fine because callers scale the result to the
// exact total the app itself reported.

const CJK = /[⺀-鿿　-〿＀-￯]/;
const ASCII_PER_TOKEN = 4;

function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk + other / ASCII_PER_TOKEN);
}

function estimateTokensFromBytes(bytes) {
  return Math.round(bytes / ASCII_PER_TOKEN);
}

// Gemini crops images into 768x768 tiles and charges ~258 tokens per tile.
// Byte size is meaningless for images (a 250KB PNG is a few hundred tokens).
function estimateImageTokens(width, height) {
  if (!width || !height) return 258;
  const tiles = Math.ceil(width / 768) * Math.ceil(height / 768);
  return tiles * 258;
}

module.exports = { estimateTokens, estimateTokensFromBytes, estimateImageTokens };
