#!/usr/bin/env node
// Build pipeline: compile Tailwind CSS, then pre-compile email templates.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import { buildEmailTemplates } from './email-build.js';

const css = spawnSync(
  './node_modules/.bin/tailwindcss',
  ['-c', 'tailwind.config.js', '-i', 'public/styles/app.src.css', '-o', 'public/styles/app.css', '--minify'],
  { stdio: 'inherit' }
);
if (css.status !== 0) process.exit(css.status ?? 1);

const here = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'emails');
const outFile = path.join(srcDir, '_compiled.js');
const { templates } = await buildEmailTemplates({ srcDir, outFile });
const slugCount = Object.keys(templates).length;
process.stdout.write(
  `email-build: wrote ${path.relative(process.cwd(), outFile)} (${slugCount} template${slugCount === 1 ? '' : 's'})\n`,
);
