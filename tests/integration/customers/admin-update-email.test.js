// Admin-driven email change for a customer_user. Validates that the
// existing welcome link survives an email correction and a copy is
// resent to the new address — the operator's stated requirement when
// they fat-finger the email at create time.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import * as service from '../../../domain/customers/service.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customers/service.adminUpdateCustomerUserEmail', () => {
  let db;
  let kek;
  const tag = `email_change_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;

  const baseCtx = () => ({
    actorType: 'admin',
    actorId: '00000000-0000-0000-0000-000000000001',
    ip: '198.51.100.7',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
  });

  async function makeCustomer(suffix) {
    const r = await service.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: 'Original Name', email: tagEmail(suffix) },
    }, baseCtx());
    return r;
  }

  it('updates the email and preserves the original invite token + expires_at', async () => {
    const created = await makeCustomer('a');
    const before = await sql`
      SELECT email::text AS email, invite_token_hash, invite_expires_at
        FROM customer_users WHERE id = ${created.primaryUserId}::uuid
    `.execute(db);
    const beforeRow = before.rows[0];

    const result = await service.adminUpdateCustomerUserEmail(db, {
      customerId: created.customerId,
      customerUserId: created.primaryUserId,
      newEmail: tagEmail('a-new'),
      adminId: baseCtx().actorId,
    }, baseCtx());

    expect(result.oldEmail).toBe(tagEmail('a'));
    expect(result.newEmail).toBe(tagEmail('a-new'));
    expect(result.resentInvite).toBe(true);

    const after = await sql`
      SELECT email::text AS email, invite_token_hash, invite_expires_at
        FROM customer_users WHERE id = ${created.primaryUserId}::uuid
    `.execute(db);
    const afterRow = after.rows[0];
    expect(afterRow.email).toBe(tagEmail('a-new'));
    // Token hash + expiry must match the pre-update values byte-for-byte.
    expect(afterRow.invite_token_hash).toBe(beforeRow.invite_token_hash);
    expect(new Date(afterRow.invite_expires_at).getTime())
      .toBe(new Date(beforeRow.invite_expires_at).getTime());
  });

  it('resends the original welcome email body (same inviteUrl) to the new address', async () => {
    const created = await makeCustomer('b');
    const original = await sql`
      SELECT locals->>'inviteUrl' AS invite_url
        FROM email_outbox
       WHERE idempotency_key = ${'customer_welcome:' + created.customerId}
    `.execute(db);
    const originalUrl = original.rows[0].invite_url;
    expect(originalUrl).toContain(created.inviteToken);

    await service.adminUpdateCustomerUserEmail(db, {
      customerId: created.customerId,
      customerUserId: created.primaryUserId,
      newEmail: tagEmail('b-new'),
      adminId: baseCtx().actorId,
    }, baseCtx());

    const resent = await sql`
      SELECT to_address::text AS to_addr, locals->>'inviteUrl' AS invite_url, template
        FROM email_outbox
       WHERE idempotency_key LIKE ${'customer_email_change_resend:' + created.primaryUserId + ':%'}
    `.execute(db);
    expect(resent.rows).toHaveLength(1);
    expect(resent.rows[0].to_addr).toBe(tagEmail('b-new'));
    expect(resent.rows[0].invite_url).toBe(originalUrl);
    expect(resent.rows[0].template).toBe('customer-invitation');
  });

  it('does NOT resend when the invite is already consumed (admin override case)', async () => {
    const created = await makeCustomer('c');
    // Simulate consumed invite.
    await sql`
      UPDATE customer_users SET invite_consumed_at = now()
       WHERE id = ${created.primaryUserId}::uuid
    `.execute(db);

    const result = await service.adminUpdateCustomerUserEmail(db, {
      customerId: created.customerId,
      customerUserId: created.primaryUserId,
      newEmail: tagEmail('c-new'),
      adminId: baseCtx().actorId,
    }, baseCtx());
    expect(result.resentInvite).toBe(false);

    const resent = await sql`
      SELECT 1 FROM email_outbox WHERE to_address = ${tagEmail('c-new')}::citext
    `.execute(db);
    expect(resent.rows).toHaveLength(0);
  });

  it('rejects invalid email format with a typed error and leaves the row unchanged', async () => {
    const created = await makeCustomer('d');
    await expect(service.adminUpdateCustomerUserEmail(db, {
      customerId: created.customerId,
      customerUserId: created.primaryUserId,
      newEmail: 'not-an-email',
      adminId: baseCtx().actorId,
    }, baseCtx())).rejects.toThrow(/invalid format/);

    const after = await sql`
      SELECT email::text AS email FROM customer_users WHERE id = ${created.primaryUserId}::uuid
    `.execute(db);
    expect(after.rows[0].email).toBe(tagEmail('d'));
  });

  it('rejects collision with another customer_user (citext UNIQUE) with a friendly error', async () => {
    const a = await makeCustomer('e1');
    const b = await makeCustomer('e2');
    await expect(service.adminUpdateCustomerUserEmail(db, {
      customerId: a.customerId,
      customerUserId: a.primaryUserId,
      newEmail: tagEmail('e2'),
      adminId: baseCtx().actorId,
    }, baseCtx())).rejects.toThrow(/already in use/);
    void b;
  });

  it('writes a customer-visible audit row on success', async () => {
    const created = await makeCustomer('f');
    await service.adminUpdateCustomerUserEmail(db, {
      customerId: created.customerId,
      customerUserId: created.primaryUserId,
      newEmail: tagEmail('f-new'),
      adminId: baseCtx().actorId,
    }, baseCtx());

    const audit = await sql`
      SELECT action, visible_to_customer, metadata
        FROM audit_log
       WHERE target_id = ${created.primaryUserId}::uuid
         AND action = 'customer.email_changed_by_admin'
         AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].visible_to_customer).toBe(true);
    expect(audit.rows[0].metadata.oldEmail).toBe(tagEmail('f'));
    expect(audit.rows[0].metadata.newEmail).toBe(tagEmail('f-new'));
    expect(audit.rows[0].metadata.resentInvite).toBe(true);
  });

  it('is a no-op when newEmail equals oldEmail (case-insensitive); no audit row, no resend', async () => {
    const created = await makeCustomer('g');
    const result = await service.adminUpdateCustomerUserEmail(db, {
      customerId: created.customerId,
      customerUserId: created.primaryUserId,
      newEmail: tagEmail('g').toUpperCase(), // citext: same address
      adminId: baseCtx().actorId,
    }, baseCtx());
    expect(result.resentInvite).toBe(false);

    const audit = await sql`
      SELECT 1 FROM audit_log
       WHERE target_id = ${created.primaryUserId}::uuid
         AND action = 'customer.email_changed_by_admin'
         AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(audit.rows).toHaveLength(0);
  });

  it('rejects when customer_user belongs to a different customer (cross-customer 4xx surface)', async () => {
    const a = await makeCustomer('h1');
    const b = await makeCustomer('h2');
    await expect(service.adminUpdateCustomerUserEmail(db, {
      customerId: a.customerId,
      customerUserId: b.primaryUserId, // mismatched
      newEmail: tagEmail('h-cross'),
      adminId: baseCtx().actorId,
    }, baseCtx())).rejects.toThrow(/not found/);
  });
});
