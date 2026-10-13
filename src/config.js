'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'config.json');

let cached = null;
let cachedMtime = 0;

// Re-read on change so editing config.json takes effect without a restart.
function load() {
  let mtime = 0;
  try {
    mtime = fs.statSync(FILE).mtimeMs;
  } catch {
    return {};
  }
  if (cached && mtime === cachedMtime) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cachedMtime = mtime;
  } catch {
    cached = cached || {};
  }
  return cached;
}

// AGCM_LIMIT wins over the file so a one-off run can override without editing.
function limitOverride() {
  const fromEnv = Number(process.env.AGCM_LIMIT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const value = Number(load().limitOverride);
  return Number.isFinite(value) && value > 0 ? value : null;
}

module.exports = { load, limitOverride, FILE };
