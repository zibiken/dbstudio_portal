#!/usr/bin/env node
// i18n audit (M9 §19 / Task 9.5).
//
// Greps every .ejs view and every routes/**/*.js file for user-facing
// strings that bypass t() — the spec §2.11 requires every rendered
// string to flow through i18next.
//
// HEURISTIC, not a parser:
//   - For .ejs files, anything between '>' and '<' that contains a
//     letter run of length ≥ 3 (case-insensitive) and isn't an EJS tag
//     <%, <%=, <%- ...%> body and isn't already wrapped in t(...) is
//     flagged.
//   - For .js routes, hand-flagged: any string literal passed as a
//     reply.code(...) message, render*({ title: '…' }), reply.send('…'),
//     or thrown Error('…') containing ≥ 3 letters.
//
// False positives are accepted: this script's job is to pinpoint a
// punch-list, not to gatekeep CI in v1.
//
// Output:
//   <relative path>:<line>: <quoted string>
//
// Exit code: 0 (always — see CI gate decision in the M9 review notes).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SKIP_DIRS = new Set([
  'node_modules', '.node', '.git', 'public', 'docs', 'tests', 'migrations',
  'emails', 'templates',
]);

function* walk(dir) {
  for (const ent of readdirSync(dir)) {
    if (SKIP_DIRS.has(ent)) continue;
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const offenders = [];
function flag(file, lineNo, raw) {
  offenders.push({ file: relative(ROOT, file), line: lineNo, text: raw.trim() });
}

const EJS_TEXT_RE = />([^<>]{3,})</g;
const ALPHA_RE = /[A-Za-z]{3,}/;

function looksLocalisable(s) {
  if (!ALPHA_RE.test(s)) return false;
  if (s.includes('<%')) return false;            // EJS body, not literal
  if (/^[\s.&;:,\-—·]+$/.test(s)) return false;  // punctuation noise
  return true;
}

function auditEjs(file) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    EJS_TEXT_RE.lastIndex = 0;
    while ((m = EJS_TEXT_RE.exec(line))) {
      const inner = m[1];
      if (looksLocalisable(inner)) flag(file, i + 1, inner);
    }
  }
}

// The original pattern included a bare backtick in the prefix alternation,
// which matched every `${...}` template literal as if it were a user-facing
// string and inflated the offender count by hundreds (M9 review M9). The
// alternation now lists only real call-site contexts; backtick-delimited
// strings still match via the closing `['"`]` character class when one of
// the listed contexts is on the same line.
const JS_LITERAL_RE = /(?:title:|reply\.send\(|throw new Error\()\s*['"`]([^'"`\n]{3,})['"`]/g;
function auditJs(file) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    JS_LITERAL_RE.lastIndex = 0;
    while ((m = JS_LITERAL_RE.exec(line))) {
      const inner = m[1];
      if (looksLocalisable(inner)) flag(file, i + 1, inner);
    }
  }
}

const TARGETS = ['views', 'routes', 'lib'];
for (const top of TARGETS) {
  const dir = join(ROOT, top);
  try {
    statSync(dir);
  } catch {
    continue;
  }
  for (const file of walk(dir)) {
    if (file.endsWith('.ejs')) auditEjs(file);
    else if (file.endsWith('.js')) auditJs(file);
  }
}

const byFile = new Map();
for (const o of offenders) {
  if (!byFile.has(o.file)) byFile.set(o.file, []);
  byFile.get(o.file).push(o);
}

const sortedFiles = [...byFile.keys()].sort();
let total = 0;
for (const f of sortedFiles) {
  const list = byFile.get(f);
  total += list.length;
  process.stdout.write(`# ${f} (${list.length})\n`);
  for (const o of list) {
    process.stdout.write(`  ${o.line}: ${JSON.stringify(o.text)}\n`);
  }
}
process.stdout.write(`\n${total} candidate offenders across ${sortedFiles.length} files.\n`);
process.exit(0);
