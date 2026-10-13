#!/usr/bin/env node
'use strict';

// Invariants that have actually bitten this project. Run by CI, and locally via
// `npm run selfcheck`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const problems = [];

// 1. Windows Script Host parses .vbs as ANSI. A UTF-8 Chinese string therefore
//    breaks the file at *parse* time, before any of it runs - and it only shows
//    up on the machine that has the file, so it survived two rounds of testing.
//    (PowerShell .ps1 files have the same hazard and need a UTF-8 BOM instead.)
for (const name of fs.readdirSync(root).filter((f) => f.endsWith('.vbs'))) {
  const buf = fs.readFileSync(path.join(root, name));
  const at = buf.findIndex((byte) => byte > 0x7f);
  if (at !== -1) {
    problems.push(`${name}: non-ASCII byte at offset ${at} - Windows Script Host will fail to parse it`);
  }
}

for (const name of fs.readdirSync(root).filter((f) => f.endsWith('.ps1'))) {
  const buf = fs.readFileSync(path.join(root, name));
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const nonAscii = buf.findIndex((byte) => byte > 0x7f);
  if (nonAscii !== -1 && !hasBom) {
    problems.push(`${name}: contains non-ASCII text but no UTF-8 BOM - Windows PowerShell 5.1 reads it as ANSI and breaks`);
  }
}

// 2. inject.js derives the page-side build id out of inject-ui.js by regex, so
//    a stale panel left in the page gets replaced instead of silently kept.
//    If either side of that contract changes shape, updates stop applying.
const uiSource = fs.readFileSync(path.join(root, 'src', 'inject-ui.js'), 'utf8');
const injectorSource = fs.readFileSync(path.join(root, 'inject.js'), 'utf8');

const declared = /const VERSION = '([^']+)'/.exec(uiSource);
if (!declared) {
  problems.push('src/inject-ui.js has no `const VERSION = \'...\'` declaration');
} else if (!injectorSource.includes(`/const VERSION = '([^']+)'/`)) {
  problems.push('inject.js no longer contains the regex that reads the UI version');
}

// 3. Files that can hold an API key or personal settings must never be tracked.
//    models.json accepts a literal key, and config.local.json is where a user
//    puts their own overrides - committing either leaks them to everyone.
for (const name of ['models.json', 'config.local.json']) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', name], { cwd: root, stdio: 'pipe' });
    problems.push(`${name} is tracked by git - it may contain an API key or personal settings`);
  } catch {
    // Not tracked (or not a git checkout) - which is the point.
  }
}

// 4. Every source file parses.
const sources = ['inject.js', ...fs.readdirSync(path.join(root, 'src')).map((f) => path.join('src', f))].filter(
  (f) => f.endsWith('.js')
);
for (const file of sources) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`${file}: does not parse\n${err.stderr ? err.stderr.toString().trim() : err.message}`);
  }
}

if (problems.length) {
  console.error('check failed:\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('');
  process.exit(1);
}

console.log(`ok - ${sources.length} sources parse, .vbs/.ps1 encodings intact, UI version contract holds`);
