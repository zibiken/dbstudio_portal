#!/usr/bin/env node
// CLI wrapper around lib/safety-check.js. Used by scripts/smoke.sh and ad-hoc checks.
import { runSafetyCheck } from '../lib/safety-check.js';
import { loadEnv } from '../config/env.js';
import { createDb } from '../config/db.js';
import { sql } from 'kysely';
import * as fs from 'node:fs';
import * as os from 'node:os';

const env = loadEnv();
const kysely = createDb({ connectionString: env.DATABASE_URL });

const dbAdapter = {
  async fetchCurrent() {
    const r = await sql`SELECT current_database() as current_database, current_user as current_user`.execute(kysely);
    return r.rows[0];
  }
};

try {
  await runSafetyCheck({ fs, userInfo: os.userInfo, db: dbAdapter, env });
  console.log('OK');
  await kysely.destroy();
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.message);
  await kysely.destroy().catch(() => {});
  process.exit(1);
}
