#!/usr/bin/env node
// One-time recovery: deletes test-fixture-flavoured rows that survived
// previous test runs and are sitting in the live DB. Patterns target the
// 2026-04-30 incident shape:
//   - email_outbox.to_address ILIKE '%_e2e@example.com' or '%_test_%'
//   - pending_digest_items / digest_schedules whose recipient_id matches
//     a customer_users / admins row tagged '%_e2e@%' or '%_test_%' (or
//     no longer matches any real recipient at all — orphans)
//
// Default mode is dry-run (counts printed). Pass --apply to actually
// delete inside a single transaction with rollback on error.
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { createDb } from '../config/db.js';

const apply = process.argv.includes('--apply');

// Read DATABASE_URL from env first, then fall back to .env on disk so the
// script works for an operator running it directly without exporting envs.
let dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  try {
    const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = envFile.match(/^DATABASE_URL=(.+)$/m);
    if (m) dbUrl = m[1].trim();
  } catch {}
}
if (!dbUrl) {
  console.error('DATABASE_URL not found in env or .env. Aborting.');
  process.exit(1);
}
const db = createDb({ connectionString: dbUrl });

const E2E_PATTERN = '%\\_e2e@example.com';
const TEST_PATTERN = '%\\_test\\_%';

async function reportCounts() {
  const outboxR = await sql`
    SELECT COUNT(*)::int AS n FROM email_outbox
    WHERE to_address ILIKE ${E2E_PATTERN} ESCAPE '\\'
       OR to_address ILIKE ${TEST_PATTERN} ESCAPE '\\'
  `.execute(db);
  const digestOrphanR = await sql`
    SELECT COUNT(*)::int AS n FROM pending_digest_items
    WHERE recipient_id NOT IN (
      SELECT id FROM customer_users UNION ALL SELECT id FROM admins
    )
  `.execute(db);
  const schedOrphanR = await sql`
    SELECT COUNT(*)::int AS n FROM digest_schedules
    WHERE recipient_id NOT IN (
      SELECT id FROM customer_users UNION ALL SELECT id FROM admins
    )
  `.execute(db);
  console.log('Stale row counts:');
  console.log('  email_outbox (e2e/test patterns): ', outboxR.rows[0].n);
  console.log('  pending_digest_items (orphans):   ', digestOrphanR.rows[0].n);
  console.log('  digest_schedules (orphans):       ', schedOrphanR.rows[0].n);
}

async function applyDeletes() {
  await db.transaction().execute(async (tx) => {
    const o = await sql`
      DELETE FROM email_outbox
      WHERE to_address ILIKE ${E2E_PATTERN} ESCAPE '\\'
         OR to_address ILIKE ${TEST_PATTERN} ESCAPE '\\'
      RETURNING id
    `.execute(tx);
    console.log(`deleted email_outbox: ${o.rows.length}`);

    const d = await sql`
      DELETE FROM pending_digest_items
      WHERE recipient_id NOT IN (
        SELECT id FROM customer_users UNION ALL SELECT id FROM admins
      )
      RETURNING id
    `.execute(tx);
    console.log(`deleted pending_digest_items: ${d.rows.length}`);

    const s = await sql`
      DELETE FROM digest_schedules
      WHERE recipient_id NOT IN (
        SELECT id FROM customer_users UNION ALL SELECT id FROM admins
      )
      RETURNING recipient_id
    `.execute(tx);
    console.log(`deleted digest_schedules: ${s.rows.length}`);
  });
}

await reportCounts();
if (apply) {
  console.log('--apply set; performing deletes inside a single transaction');
  await applyDeletes();
  console.log('Done. Re-running counts:');
  await reportCounts();
} else {
  console.log('Dry run only. Re-run with --apply to perform deletes.');
}
await db.destroy();
