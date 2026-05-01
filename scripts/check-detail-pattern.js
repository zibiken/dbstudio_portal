#!/usr/bin/env node
// Phase F: advisory linter that scans every views/admin/**/*.ejs and
// views/customer/**/*.ejs for the _page-header include and warns when:
//   - eyebrow is not all-caps + ' · ' separators (rule 10)
//   - title is a template-literal interpolating an instance field (rule 1)
//
// Exit code is always 0 — warnings only for v1. Promote to blocking in
// a future phase once the codebase is fully aligned.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const VIEW_ROOTS = ['views/admin', 'views/customer'];

async function* walk(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && p.endsWith('.ejs')) yield p;
  }
}

const HEADER_RE = /_page-header['"]\s*,\s*\{([\s\S]*?)\}\s*\)/m;
const EYEBROW_LITERAL_RE  = /eyebrow:\s*'([^']+)'/;
const EYEBROW_TEMPLATE_RE = /eyebrow:\s*('[^']*'\s*\+\s*\S+|\S+\s*\+\s*'[^']*')/;
const TITLE_LITERAL_RE    = /title:\s*'([^']+)'/;
const TITLE_TEMPLATE_RE   = /title:\s*([^,}\n]+)/;
const EYEBROW_OK = /^[A-Z][A-Z0-9 ·\-]+$/;

let warnings = 0;
for (const root of VIEW_ROOTS) {
  for await (const file of walk(path.join(ROOT, root))) {
    const src = await fs.readFile(file, 'utf8');
    const block = HEADER_RE.exec(src);
    if (!block) continue;
    const body = block[1];
    const rel = path.relative(ROOT, file);

    const ebLiteral  = EYEBROW_LITERAL_RE.exec(body);
    const ebTemplate = EYEBROW_TEMPLATE_RE.exec(body);
    if (ebLiteral && !EYEBROW_OK.test(ebLiteral[1])) {
      console.warn(`WARN ${rel}: eyebrow '${ebLiteral[1]}' fails caps + ' · ' check (rule 10)`);
      warnings++;
    } else if (ebTemplate && !ebLiteral) {
      console.warn(`WARN ${rel}: eyebrow uses concatenation (${ebTemplate[1].trim().slice(0, 60)}...); rule 10 forbids interpolating an instance field`);
      warnings++;
    }

    if (!TITLE_LITERAL_RE.test(body)) {
      const t = TITLE_TEMPLATE_RE.exec(body);
      if (t) {
        const tv = t[1].trim();
        // Heuristic: looks like an instance field if it dereferences an
        // identifier (e.g. credential.label, customer.razon_social).
        if (/\w+\.\w+/.test(tv) && !tv.includes("'")) {
          console.warn(`WARN ${rel}: title '${tv}' looks like an instance field; rule 1 says title must be the resource type`);
          warnings++;
        }
      }
    }
  }
}
process.stdout.write(`check-detail-pattern: ${warnings} advisory warning${warnings === 1 ? '' : 's'}\n`);
process.exit(0);
