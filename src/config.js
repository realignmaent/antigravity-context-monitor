'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'config.json');
// Optional per-machine overrides. Git-ignored, so personal settings (a provider,
// an account-specific window size) never end up in the repository or collide
// with a `git pull`.
const LOCAL_FILE = path.join(__dirname, '..', 'config.local.json');

let cached = null;
let cachedKey = '';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Merges recursively: a local `{"phrases": {"sendConversationTitle": true}}` has
// to override just that key rather than replace the whole phrases block, which a
// shallow spread would do.
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

// Re-read on change so editing either file takes effect without a restart.
function load() {
  const key = `${mtimeOf(FILE)}:${mtimeOf(LOCAL_FILE)}`;
  if (cached && key === cachedKey) return cached;
  cached = merge(readJson(FILE) || {}, readJson(LOCAL_FILE) || {});
  cachedKey = key;
  return cached;
}

// AGCM_LIMIT wins over the file so a one-off run can override without editing.
function limitOverride() {
  const fromEnv = Number(process.env.AGCM_LIMIT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const value = Number(load().limitOverride);
  return Number.isFinite(value) && value > 0 ? value : null;
}

module.exports = { FILE, LOCAL_FILE, load, limitOverride, merge };
