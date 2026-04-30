#!/usr/bin/env node
// Static a11y audit for EJS views (M9 Task 9.6).
//
// Catches the common-and-cheap accessibility regressions WITHOUT
// running a full browser/axe-core (axe-core would be the right tool but
// requires jsdom + a render harness; a static check is enough to gate
// CI on the worst regressions and document the rest in follow-ups).
//
// Checks:
//   1. <img> without alt= attribute
//   2. heading-order skip (e.g., h1 → h3 with no h2 between)
//   3. <input> / <select> / <textarea> without an associated <label for=>
//      or aria-label / aria-labelledby
//
// EJS-aware: ignores `<%= … %>`/`<%- … %>` substitutions when reading
// attribute values.
//
// Output: line per offender, then a summary. Exit code 0 (informational).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const VIEWS = join(ROOT, 'views');

const offenders = [];
function flag(file, line, msg) {
  offenders.push({ file: relative(ROOT, file), line, msg });
}

function* walk(dir) {
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (full.endsWith('.ejs')) yield full;
  }
}

function checkImgAlt(file, src) {
  const lines = src.split('\n');
  const re = /<img\b([^>]*)>/gi;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i]))) {
      const attrs = m[1];
      if (!/\balt\s*=/.test(attrs)) {
        flag(file, i + 1, `<img> missing alt attribute`);
      }
    }
  }
}

function checkHeadingOrder(file, src) {
  const lines = src.split('\n');
  const re = /<h([1-6])\b[^>]*>/gi;
  let prev = 0;
  let firstSeen = false;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i]))) {
      const level = Number(m[1]);
      if (!firstSeen) {
        firstSeen = true;
      } else if (level > prev + 1) {
        flag(file, i + 1, `heading skip: h${prev} → h${level} (missing h${prev + 1})`);
      }
      prev = level;
    }
  }
}

function checkInputLabels(file, src) {
  // Collect every for= target referenced anywhere in the file.
  const labelTargets = new Set();
  const labelRe = /<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi;
  let lm;
  labelRe.lastIndex = 0;
  while ((lm = labelRe.exec(src))) labelTargets.add(lm[1]);

  // Track ranges where we are inside a <label>…</label>; inputs nested
  // inside such ranges have an implicit label association and pass.
  const labelRanges = [];
  const openRe = /<label\b[^>]*>/gi;
  const closeRe = /<\/label\s*>/gi;
  const opens = [];
  let mm;
  openRe.lastIndex = 0;
  while ((mm = openRe.exec(src))) opens.push(mm.index);
  const closes = [];
  closeRe.lastIndex = 0;
  while ((mm = closeRe.exec(src))) closes.push(mm.index);
  // Pair them naively (works for non-nested labels — which is the EJS
  // norm here; nested labels are an HTML error anyway).
  for (let i = 0; i < Math.min(opens.length, closes.length); i++) {
    labelRanges.push([opens[i], closes[i]]);
  }
  function insideLabel(offset) {
    for (const [a, b] of labelRanges) if (offset >= a && offset <= b) return true;
    return false;
  }

  // Strip EJS expressions before scanning so a `>` inside <%= … %> doesn't
  // truncate the attrs capture for self-closing-style tags. Preserve
  // newlines + length so line numbers stay accurate.
  const stripped = src.replace(/<%[-=]?[\s\S]*?%>/g, (s) =>
    s.replace(/[<>]/g, '_'),
  );
  const re = /<(input|select|textarea)\b([^>]*)>/gi;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(stripped))) {
    const tag = m[1];
    const attrs = m[2];
    const offset = m.index;
    // Skip type=hidden and type=submit/button - they don't need a label.
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/);
    const t = typeMatch ? typeMatch[1].toLowerCase() : (tag === 'input' ? 'text' : '');
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(t)) continue;
    if (/\baria-label(ledby)?\s*=/.test(attrs)) continue;
    if (/\bplaceholder\s*=\s*["'][^"']+["']/.test(attrs) && /\baria-label\s*=/.test(attrs)) continue;
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/);
    if (idMatch && labelTargets.has(idMatch[1])) continue;
    if (insideLabel(offset)) continue;

    // Resolve line number from offset (stripped src has same line layout
    // as src because we replaced EJS spans in place with a fixed string).
    const line = stripped.slice(0, offset).split('\n').length;
    flag(file, line, `<${tag}${idMatch ? ` id=${idMatch[1]}` : ''}> has no associated <label> or aria-label`);
  }
}

for (const file of walk(VIEWS)) {
  const src = readFileSync(file, 'utf8');
  checkImgAlt(file, src);
  checkHeadingOrder(file, src);
  checkInputLabels(file, src);
}

const byFile = new Map();
for (const o of offenders) {
  if (!byFile.has(o.file)) byFile.set(o.file, []);
  byFile.get(o.file).push(o);
}

for (const f of [...byFile.keys()].sort()) {
  const list = byFile.get(f);
  process.stdout.write(`# ${f} (${list.length})\n`);
  for (const o of list) process.stdout.write(`  ${o.line}: ${o.msg}\n`);
}

process.stdout.write(
  `\n${offenders.length} a11y candidate offenders across ${byFile.size} files.\n`,
);
process.exit(0);
