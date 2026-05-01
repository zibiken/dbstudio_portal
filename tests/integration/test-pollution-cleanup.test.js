import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { createDb } from '../../config/db.js';
import { pruneTestPollution } from '../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `pollution_cleanup_test_${Date.now()}`;

describe.skipIf(skip)('pruneTestPollution', () => {
  let db;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'} OR to_address LIKE ${'e2e_' + tag + '%'}`.execute(db);
    await sql`DELETE FROM pending_digest_items WHERE recipient_id IN (
      SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await db.destroy();
  });

  it('deletes email_outbox rows by exact to_address', async () => {
    const addr = `${tag}+a@example.com`;
    await sql`
      INSERT INTO email_outbox (id, idempotency_key, to_address, template, locals)
      VALUES (${randomUUID()}::uuid, ${tag + '_a'}, ${addr}, 'customer-invitation', '{}'::jsonb)
    `.execute(db);

    await pruneTestPollution(db, { emailAddresses: [addr] });

    const r = await sql`SELECT COUNT(*)::int AS n FROM email_outbox WHERE to_address = ${addr}`.execute(db);
    expect(r.rows[0].n).toBe(0);
  });

  it('deletes email_outbox rows matching the e2e suffix pattern', async () => {
    const addr = `e2e_${tag}_x_e2e@example.com`;
    await sql`
      INSERT INTO email_outbox (id, idempotency_key, to_address, template, locals)
      VALUES (${randomUUID()}::uuid, ${tag + '_e2e'}, ${addr}, 'customer-invitation', '{}'::jsonb)
    `.execute(db);

    await pruneTestPollution(db, { e2eEmailPattern: true });

    const r = await sql`SELECT COUNT(*)::int AS n FROM email_outbox WHERE to_address = ${addr}`.execute(db);
    expect(r.rows[0].n).toBe(0);
  });

  it('deletes pending_digest_items by recipient_id', async () => {
    const customerId = randomUUID();
    const userId = randomUUID();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (${customerId}::uuid, ${tag + '_c'}, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea)
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (${userId}::uuid, ${customerId}::uuid, ${tag + '+u@example.com'}, 'T')
    `.execute(db);
    await sql`
      INSERT INTO pending_digest_items
        (id, recipient_type, recipient_id, customer_id, bucket, event_type, title)
      VALUES
        (${randomUUID()}::uuid, 'customer_user', ${userId}::uuid, ${customerId}::uuid, 'fyi', 'test.event', 'Test event')
    `.execute(db);

    await pruneTestPollution(db, { recipientIds: [userId] });

    const r = await sql`SELECT COUNT(*)::int AS n FROM pending_digest_items WHERE recipient_id = ${userId}::uuid`.execute(db);
    expect(r.rows[0].n).toBe(0);
  });

  it('is a no-op when given empty inputs', async () => {
    await expect(pruneTestPollution(db, {})).resolves.toBeUndefined();
  });
});
