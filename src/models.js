'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

// Reads ./models.json, which uses the same schema as pi's ~/.pi/agent/models.json
// (https://github.com/earendil-works/pi). Keeping the format identical means a
// config can be copied between the two without editing.
//
// Only Node built-ins are used - `fetch` and `child_process` - so the project
// stays free of npm dependencies even when this feature is switched on.

const FILE = path.join(__dirname, '..', 'models.json');

let cached = null;
let cachedMtime = -1;

function load() {
  let mtime = -1;
  try {
    mtime = fs.statSync(FILE).mtimeMs;
  } catch {
    cached = null;
    cachedMtime = -1;
    return null;
  }
  if (cached && mtime === cachedMtime) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cachedMtime = mtime;
  } catch (err) {
    console.error(`[phrases] models.json is not valid JSON: ${err.message}`);
    cached = null;
  }
  return cached;
}

// pi's value resolution: "!cmd" runs a command, "$VAR"/"${VAR}" interpolate the
// environment, "$$"/"$!" escape, anything else is a literal. A missing variable
// leaves the value unresolved (null) rather than silently becoming empty.
function runShell(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

async function resolveValue(raw) {
  if (typeof raw !== 'string') return raw == null ? null : String(raw);
  if (raw.startsWith('!')) return runShell(raw.slice(1));

  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '$') {
      out += raw[i];
      continue;
    }
    const next = raw[i + 1];
    if (next === '$' || next === '!') {
      out += next;
      i++;
      continue;
    }
    if (next === '{') {
      const end = raw.indexOf('}', i + 2);
      if (end !== -1) {
        const value = process.env[raw.slice(i + 2, end)];
        if (value === undefined) return null;
        out += value;
        i = end;
        continue;
      }
    }
    const named = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(raw.slice(i));
    if (named) {
      const value = process.env[named[1]];
      if (value === undefined) return null;
      out += value;
      i += named[0].length - 1;
      continue;
    }
    out += raw[i];
  }
  return out;
}

function joinUrl(baseUrl, suffix) {
  return String(baseUrl || '').replace(/\/+$/, '') + suffix;
}

function listModels() {
  const config = load();
  if (!config || !config.providers) return [];
  const out = [];
  for (const [provider, spec] of Object.entries(config.providers)) {
    if (!spec || !Array.isArray(spec.models)) continue;
    for (const model of spec.models) {
      if (!model || !model.id) continue;
      out.push({
        provider,
        id: model.id,
        name: model.name || model.id,
        api: model.api || spec.api,
        baseUrl: model.baseUrl || spec.baseUrl,
        keySource: model.apiKey !== undefined ? model.apiKey : spec.apiKey,
        authHeader: model.authHeader !== undefined ? model.authHeader : spec.authHeader,
        maxTokens: model.maxTokens,
        headers: { ...(spec.headers || {}), ...(model.headers || {}) },
      });
    }
  }
  return out;
}

// `preferred` is "<provider>/<model-id>", or empty for the first usable model.
function pick(preferred) {
  const models = listModels();
  if (!models.length) return null;
  if (!preferred) return models[0];
  const [provider, ...rest] = String(preferred).split('/');
  const id = rest.join('/');
  return (
    models.find((m) => m.provider === provider && m.id === id) ||
    models.find((m) => m.id === preferred) ||
    null
  );
}

function buildRequest(model, apiKey, system, prompt, maxTokens) {
  const headers = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(model.headers || {})) {
    headers[name] = value; // headers are resolved by the caller
  }

  if (model.api === 'openai-completions') {
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    return {
      url: joinUrl(model.baseUrl, '/chat/completions'),
      headers,
      body: {
        model: model.id,
        max_tokens: maxTokens,
        temperature: 1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      },
      extract: (json) => json?.choices?.[0]?.message?.content,
    };
  }

  if (model.api === 'anthropic-messages') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return {
      url: joinUrl(model.baseUrl, '/messages'),
      headers,
      body: {
        model: model.id,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      },
      extract: (json) => json?.content?.[0]?.text,
    };
  }

  if (model.api === 'google-generative-ai') {
    const url = joinUrl(model.baseUrl, `/models/${model.id}:generateContent`);
    return {
      url: apiKey ? `${url}?key=${encodeURIComponent(apiKey)}` : url,
      headers,
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 1 },
      },
      extract: (json) => json?.candidates?.[0]?.content?.parts?.[0]?.text,
    };
  }

  throw new Error(
    `unsupported api "${model.api}" - models.json supports openai-completions, anthropic-messages and google-generative-ai`
  );
}

async function complete({ model, system, prompt, maxTokens = 60, timeoutMs = 4000 }) {
  if (!model) throw new Error('no model configured');
  if (!model.baseUrl) throw new Error(`provider "${model.provider}" has no baseUrl`);

  const apiKey = await resolveValue(model.keySource);
  if (model.keySource !== undefined && apiKey === null) {
    throw new Error(`could not resolve apiKey for provider "${model.provider}"`);
  }

  const headers = {};
  for (const [name, value] of Object.entries(model.headers || {})) {
    const resolved = await resolveValue(value);
    if (resolved !== null) headers[name] = resolved;
  }
  const request = buildRequest({ ...model, headers }, apiKey, system, prompt, maxTokens);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`HTTP ${response.status}${detail ? ': ' + detail : ''}`);
    }
    const json = await response.json();
    const text = request.extract(json);
    if (typeof text !== 'string' || !text.trim()) {
      // Reasoning models spend max_tokens on thinking before emitting anything:
      // a budget that is too small yields finish_reason "length" and an empty
      // content field, which looks exactly like a broken reply. Say so.
      const finish = json?.choices?.[0]?.finish_reason;
      throw new Error(
        finish === 'length'
          ? `empty completion (finish_reason "length" - max_tokens ${maxTokens} was consumed before any answer; reasoning models need a larger budget)`
          : 'empty completion'
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { FILE, load, listModels, pick, resolveValue, complete };
