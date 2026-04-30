import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../../config/db.js';
import * as service from '../../../../domain/customer-users/service.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customer-users/service.updateName', () => {
  let db;
  const tag = `cu_name_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  async function seedUser(suffix, name = 'Original Name') {
    const customerId = uuidv7();
    const userId = uuidv7();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (
        ${customerId}::uuid,
        ${tag + ' ' + suffix + ' S.L.'},
        ${Buffer.alloc(32)}::bytea,
        ${Buffer.alloc(12)}::bytea,
        ${Buffer.alloc(16)}::bytea
      )
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (
        ${userId}::uuid,
        ${customerId}::uuid,
        ${tagEmail(suffix)},
        ${name}
      )
    `.execute(db);
    return { customerId, userId };
  }

  function ctx() {
    return {
      ip: '198.51.100.7',
      userAgentHash: 'uahash',
      audit: { tag },
    };
  }

  it('persists the new name and writes a customer-visible audit', async () => {
    const { userId, customerId } = await seedUser('a');

    await service.updateName(db, { customerUserId: userId, name: '  New Display Name  ' }, ctx());

    const r = await sql`SELECT name FROM customer_users WHERE id = ${userId}::uuid`.execute(db);
    expect(r.rows[0].name).toBe('New Display Name');

    const audits = await sql`
      SELECT actor_type, actor_id::text AS actor_id, action, target_type, target_id::text AS target_id,
             visible_to_customer, metadata
        FROM audit_log
       WHERE metadata->>'tag' = ${tag}
       ORDER BY ts ASC
    `.execute(db);
    expect(audits.rows).toHaveLength(1);
    const a = audits.rows[0];
    expect(a.actor_type).toBe('customer');
    expect(a.actor_id).toBe(userId);
    expect(a.action).toBe('customer_user.name_changed');
    expect(a.target_type).toBe('customer_user');
    expect(a.target_id).toBe(userId);
    expect(a.visible_to_customer).toBe(true);
    expect(a.metadata.customerId).toBe(customerId);
    expect(a.metadata.previousName).toBe('Original Name');
    expect(a.metadata.newName).toBe('New Display Name');
  });

  it('rejects empty / whitespace-only name', async () => {
    const { userId } = await seedUser('b');
    await expect(
      service.updateName(db, { customerUserId: userId, name: '   ' }, ctx()),
    ).rejects.toThrow(/name/i);
  });

  it('rejects non-string name', async () => {
    const { userId } = await seedUser('c');
    await expect(
      service.updateName(db, { customerUserId: userId, name: 123 }, ctx()),
    ).rejects.toThrow(/name/i);
  });

  it('rejects unknown user (does not write audit)', async () => {
    const phantom = uuidv7();
    await expect(
      service.updateName(db, { customerUserId: phantom, name: 'Whoever' }, ctx()),
    ).rejects.toThrow(/not found/i);
    const audits = await sql`
      SELECT 1 FROM audit_log WHERE metadata->>'tag' = ${tag}
    `.execute(db);
    expect(audits.rows).toHaveLength(0);
  });

  it('caps name length to a reasonable upper bound (256 chars)', async () => {
    const { userId } = await seedUser('d');
    const huge = 'A'.repeat(257);
    await expect(
      service.updateName(db, { customerUserId: userId, name: huge }, ctx()),
    ).rejects.toThrow(/name/i);
  });

  it('is a no-op (no audit) when the trimmed name matches the existing name', async () => {
    const { userId } = await seedUser('e', 'Same Name');
    await service.updateName(db, { customerUserId: userId, name: '  Same Name  ' }, ctx());
    const audits = await sql`
      SELECT 1 FROM audit_log WHERE metadata->>'tag' = ${tag}
    `.execute(db);
    expect(audits.rows).toHaveLength(0);
  });
});
