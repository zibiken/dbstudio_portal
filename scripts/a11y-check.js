#!/usr/bin/env node
// Static a11y audit for EJS views (M9 Task 9.6, extended T20 with six
// M11 pattern checks + a reduced-motion CSS partner check).
//
// Catches the common-and-cheap accessibility regressions WITHOUT
// running a full browser/axe-core (axe-core would be the right tool but
// requires jsdom + a render harness; a static check is enough to gate
// CI on the worst regressions and document the rest in follow-ups).
//
// Checks (M9 baseline):
//   1. <img> without alt= attribute
//   2. heading-order skip (e.g., h1 → h3 with no h2 between)
//   3. <input> / <select> / <textarea> without an associated <label for=>
//      or aria-label / aria-labelledby
//
// Checks (M11 additions, T20):
//   4. <nav> missing aria-label or aria-labelledby
//   5. .top-bar__hamburger button missing aria-expanded or aria-controls
//   6. inline <svg role="img"> aria-label leaking the otpauth:// URI
//   7. .card--modal missing aria-modal="true" + aria-labelledby
//   8. .sidebar__item--active <a> missing aria-current="page"
//   9. CSS partner: any file with `transition:` rules must contain at
//      least one @media (prefers-reduced-motion: reduce) block
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
  // Strip EJS expressions before scanning so a `>` inside <%= … %> doesn't
  // truncate the attrs capture for self-closing-style tags. Preserve
  // newlines + length so line numbers stay accurate. The stripped form is
  // used for BOTH the input-tag scan AND the label-target collection so
  // that dynamic ids like `for="phase-label-<%= p.id %>"` /
  // `id="phase-label-<%= p.id %>"` reconcile (both reduce to the same
  // post-strip token).
  const stripped = src.replace(/<%[-=]?[\s\S]*?%>/g, (s) =>
    s.replace(/[<>]/g, '_'),
  );

  // Collect every for= target referenced anywhere in the file.
  const labelTargets = new Set();
  const labelRe = /<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi;
  let lm;
  labelRe.lastIndex = 0;
  while ((lm = labelRe.exec(stripped))) labelTargets.add(lm[1]);

  // Track ranges where we are inside a <label>…</label>; inputs nested
  // inside such ranges have an implicit label association and pass.
  const labelRanges = [];
  const openRe = /<label\b[^>]*>/gi;
  const closeRe = /<\/label\s*>/gi;
  const opens = [];
  let mm;
  openRe.lastIndex = 0;
  while ((mm = openRe.exec(stripped))) opens.push(mm.index);
  const closes = [];
  closeRe.lastIndex = 0;
  while ((mm = closeRe.exec(stripped))) closes.push(mm.index);
  // Pair them naively (works for non-nested labels — which is the EJS
  // norm here; nested labels are an HTML error anyway).
  for (let i = 0; i < Math.min(opens.length, closes.length); i++) {
    labelRanges.push([opens[i], closes[i]]);
  }
  function insideLabel(offset) {
    for (const [a, b] of labelRanges) if (offset >= a && offset <= b) return true;
    return false;
  }

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

function checkNavAriaLabel(file, src) {
  const lines = src.split('\n');
  const re = /<nav\b([^>]*)>/gi;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i]))) {
      const attrs = m[1];
      if (!/\baria-label(ledby)?\s*=/.test(attrs)) {
        flag(file, i + 1, `<nav> missing aria-label or aria-labelledby`);
      }
    }
  }
}

function checkHamburgerAria(file, src) {
  const lines = src.split('\n');
  const re = /<button\b([^>]*\btop-bar__hamburger[^>]*)>/gi;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i]))) {
      const attrs = m[1];
      if (!/\baria-expanded\s*=/.test(attrs)) {
        flag(file, i + 1, `.top-bar__hamburger button missing aria-expanded`);
      }
      if (!/\baria-controls\s*=/.test(attrs)) {
        flag(file, i + 1, `.top-bar__hamburger button missing aria-controls`);
      }
    }
  }
}

function checkQrAriaLabel(file, src) {
  // The server-rendered TOTP QR carries role="img" + aria-label. The
  // aria-label must describe the QR's purpose (e.g. "TOTP enrolment for
  // <email>") and MUST NOT contain the otpauth:// URI itself —
  // leaking it to assistive tech defeats the purpose of an out-of-band
  // factor. lib/qr.js enforces this server-side; this static check is
  // defence-in-depth for any inline override.
  const lines = src.split('\n');
  const re = /<svg\b[^>]*\brole\s*=\s*["']img["'][^>]*\baria-label\s*=\s*["']([^"']*)["']/gi;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i]))) {
      if (/otpauth:/i.test(m[1])) {
        flag(file, i + 1, `<svg role="img"> aria-label leaks the otpauth:// URI`);
      }
    }
  }
}

// Helper: a class= attribute is "dynamic" if its value contains an EJS
// expression. Conditional classes built via `<%= cond ? 'foo' : '' %>`
// can't be reliably analysed without an EJS evaluator; the checks
// below skip dynamic class attributes and rely on the EJS-side `<% if
// (cond) { %> aria-current=page <% } %>` pattern (which the runtime
// emits in lockstep with the conditional class).
function classIsDynamic(classValue) {
  return /<%[-=#]?[\s\S]*?%>/.test(classValue);
}

function checkModalAriaModal(file, src) {
  const lines = src.split('\n');
  const re = /<(article|div)\b([^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*)>/gi;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i]))) {
      const attrs = m[2];
      const classValue = m[3];
      if (!/\bcard--modal\b/.test(classValue)) continue;
      if (classIsDynamic(classValue)) continue;
      if (!/\baria-modal\s*=\s*["']true["']/.test(attrs)) {
        flag(file, i + 1, `.card--modal missing aria-modal="true"`);
      }
      if (!/\baria-labelledby\s*=/.test(attrs)) {
        flag(file, i + 1, `.card--modal missing aria-labelledby`);
      }
    }
  }
}

function checkSidebarActiveAriaCurrent(file, src) {
  // Walk every <li ... class="..."> open tag. If the class attribute is
  // a static string containing `sidebar__item--active`, the inner <a>
  // must carry aria-current="page". Conditional / EJS-driven class
  // attributes are skipped because the runtime emits the
  // aria-current="page" attribute via a parallel <% if (...) { %>
  // block — that branch's output is not derivable from the source
  // alone, so this static check cannot fairly assert on it.
  const liRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let m;
  liRe.lastIndex = 0;
  while ((m = liRe.exec(src))) {
    const liAttrs = m[1];
    const classMatch = /\bclass\s*=\s*["']([^"']*)["']/.exec(liAttrs);
    if (!classMatch) continue;
    const classValue = classMatch[1];
    if (!/\bsidebar__item--active\b/.test(classValue)) continue;
    if (classIsDynamic(classValue)) continue;
    const inner = m[2];
    const aMatch = /<a\b([^>]*)>/.exec(inner);
    if (!aMatch) continue;
    if (!/\baria-current\s*=\s*["']page["']/.test(aMatch[1])) {
      const lineNum = src.slice(0, m.index).split('\n').length;
      flag(file, lineNum, `.sidebar__item--active <a> missing aria-current="page"`);
    }
  }
}

// Bundle 5 a11y pass: forbid native confirm() in destructive forms.
// confirm() loses keyboard focus in some browsers, has no aria-live
// announcement, is blocked on iOS Safari when triggered from a
// non-user-gesture context, and gives no way to add explanatory text.
// Replace with a `<details>`/`<summary>` disclosure or a button + dialog
// pattern (see views/admin/projects/detail.ejs phase delete for an
// example).
function checkNoConfirm(file, src) {
  const lines = src.split('\n');
  const re = /onsubmit\s*=\s*['"]\s*return\s+confirm\s*\(/i;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      flag(file, i + 1, 'destructive form uses native confirm() — replace with <details>/<summary> disclosure');
    }
  }
}

function checkReducedMotionPartner(file, src) {
  // CSS-only check. If a file declares any `transition:` rule, it must
  // also carry at least one @media (prefers-reduced-motion: reduce)
  // block. We don't enforce that the partner disables the same
  // selector — a CSS parser is overkill for this; the file-level
  // presence catches the common regression of forgetting the partner
  // block entirely.
  if (!/transition\s*:/.test(src)) return;
  if (!/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce/.test(src)) {
    flag(file, 1, `CSS uses transition: but lacks any @media (prefers-reduced-motion: reduce) block`);
  }
}

for (const file of walk(VIEWS)) {
  const src = readFileSync(file, 'utf8');
  checkImgAlt(file, src);
  checkHeadingOrder(file, src);
  checkInputLabels(file, src);
  checkNavAriaLabel(file, src);
  checkHamburgerAria(file, src);
  checkQrAriaLabel(file, src);
  checkModalAriaModal(file, src);
  checkSidebarActiveAriaCurrent(file, src);
  checkNoConfirm(file, src);
}

// CSS-side partner check.
const STYLES_DIR = join(ROOT, 'public', 'styles');
function* walkCss(dir) {
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkCss(full);
    else if (full.endsWith('.css')) yield full;
  }
}
for (const cssFile of walkCss(STYLES_DIR)) {
  // Skip the generated app.css output (the source is app.src.css).
  if (cssFile.endsWith('app.css')) continue;
  const src = readFileSync(cssFile, 'utf8');
  checkReducedMotionPartner(cssFile, src);
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

// Static-check blocking gate. Set A11Y_STATIC_ADVISORY=1 to keep the
// historical advisory behaviour (exit 0 even with offenders). Default is
// blocking now that the codebase reports 0 offenders; any regression
// should fail the test wrapper.
const staticAdvisory = process.env.A11Y_STATIC_ADVISORY === '1';
let staticFailed = !staticAdvisory && offenders.length > 0;

// Optional axe-core JSDOM mode (RUN_A11Y_AXE=1). Renders a small set of
// public pages via app.inject(), parses the HTML through JSDOM, and runs
// axe-core to surface impact >= 'serious' violations. Advisory by
// default; only fails the script if RUN_A11Y_AXE_BLOCKING=1.
//
// Authenticated-view axe coverage lives in
// tests/integration/a11y/authenticated-routes.test.js — that file
// reuses the existing fixture-login machinery (admin /login + /login/2fa
// and customer completeCustomerWelcome) instead of duplicating it here.
// Add new view families to that test as they land.
if (process.env.RUN_A11Y_AXE === '1') {
  const { build } = await import('../server.js');
  const { JSDOM } = await import('jsdom');
  const axeMod = await import('axe-core');
  const axe = axeMod.default ?? axeMod;
  const { randomBytes } = await import('node:crypto');

  const blocking = process.env.RUN_A11Y_AXE_BLOCKING === '1';
  const ROUTES = ['/login', '/reset'];
  // Pass a synthetic KEK so this opt-in audit doesn't read prod secrets
  // — server.js:73 accepts a kek override. The pages we hit are public
  // and don't decrypt anything.
  const app = await build({ skipSafetyCheck: true, kek: randomBytes(32) });
  const violations = [];
  const harnessErrors = [];

  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url });
    if (res.statusCode !== 200 || !/text\/html/.test(res.headers['content-type'] ?? '')) {
      const msg = `axe: ${url} render failure (status ${res.statusCode})`;
      process.stdout.write(`${msg}\n`);
      harnessErrors.push(msg);
      continue;
    }
    const dom = new JSDOM(res.body, {
      url: 'http://localhost/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    // axe-core ships a self-registering bundle that exposes `axe` on the
    // global. JSDOM's `runScripts: 'outside-only'` lets us eval directly.
    dom.window.eval(axe.source);
    if (!dom.window.axe) {
      const msg = `axe: failed to attach axe-core to JSDOM on ${url}`;
      process.stdout.write(`${msg}\n`);
      harnessErrors.push(msg);
      continue;
    }
    const result = await dom.window.axe.run(dom.window.document, {
      resultTypes: ['violations'],
    });
    for (const v of result.violations) {
      if (v.impact !== 'serious' && v.impact !== 'critical') continue;
      violations.push({ url, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length });
    }
  }
  await app.close();

  if (violations.length === 0) {
    process.stdout.write('axe: no serious/critical violations on scaffolded routes\n');
  } else {
    process.stdout.write(`\naxe: ${violations.length} serious/critical violations:\n`);
    for (const v of violations) {
      process.stdout.write(`  [${v.impact}] ${v.url}  ${v.id} (${v.nodes} node${v.nodes === 1 ? '' : 's'}) — ${v.help}\n`);
    }
  }
  if (blocking && (violations.length > 0 || harnessErrors.length > 0)) {
    // Treat harness errors (every route skipped, axe failed to attach)
    // as fatal under blocking mode — otherwise the gate silently passes
    // when the audit didn't actually execute.
    process.exit(1);
  }
}

if (staticFailed) {
  process.exit(1);
}
process.exit(0);
