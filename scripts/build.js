#!/usr/bin/env node
// Build pipeline: compile Tailwind CSS to public/styles/app.css.
// Future M4 step adds email-template precompilation.
import { spawnSync } from 'node:child_process';

const r = spawnSync(
  './node_modules/.bin/tailwindcss',
  ['-c', 'tailwind.config.js', '-i', 'public/styles/app.src.css', '-o', 'public/styles/app.css', '--minify'],
  { stdio: 'inherit' }
);
process.exit(r.status ?? 1);
