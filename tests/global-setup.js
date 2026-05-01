import * as path from 'node:path';
import * as url from 'node:url';
import { sql } from 'kysely';
import { buildEmailTemplates } from '../scripts/email-build.js';
import { createDb } from '../config/db.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'emails');
const outFile = path.join(srcDir, '_compiled.js');

export async function setup() {
  await buildEmailTemplates({ srcDir, outFile });
}

// Global teardown: scrub orphan digest + outbox rows that survived per-test
// cleanup. Tests delete their tagged customers/admins, but
// pending_digest_items / digest_schedules / email_outbox don't all CASCADE
// from those parents, so fixture rows can outlive their owners and get
// processed by the live worker (real incident: 2026-04-30 customer-
// invitation soft-bounce on `nda_gen_*_e2e@example.com`).
//
// We delete:
//   - pending_digest_items / digest_schedules whose recipient_id no longer
//     matches any customer_users.id or admins.id
//   - email_outbox rows tagged by either of the test scaffolding patterns
//     (`%_e2e@example.com` or `%_test_%`)
// The query runs on RUN_DB_TESTS only — when the integration suite ran.
export async function teardown() {
  if (!process.env.RUN_DB_TESTS) return;
  const db = createDb({ connectionString: process.env.DATABASE_URL });
  try {
    await sql`
      DELETE FROM pending_digest_items
      WHERE recipient_id NOT IN (
        SELECT id FROM customer_users
        UNION ALL
        SELECT id FROM admins
      )
    `.execute(db);
    await sql`
      DELETE FROM digest_schedules
      WHERE recipient_id NOT IN (
        SELECT id FROM customer_users
        UNION ALL
        SELECT id FROM admins
      )
    `.execute(db);
    await sql`
      DELETE FROM email_outbox
      WHERE to_address ILIKE ${'%\\_e2e@example.com'} ESCAPE '\\'
         OR to_address ILIKE ${'%\\_test\\_%'} ESCAPE '\\'
    `.execute(db);
  } finally {
    await db.destroy();
  }
}
