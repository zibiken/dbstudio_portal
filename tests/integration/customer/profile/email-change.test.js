import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../../config/db.js';
import * as service from '../../../../domain/customer-users/service.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customer-users/service email-change', () => {
  let db;
  const tag = `cu_email_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;
  const portalBaseUrl = 'https://portal.example.test';

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM email_change_requests WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM email_change_requests WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  async function seedUser(suffix) {
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
        ${userId}::uuid, ${customerId}::uuid, ${tagEmail(suffix)}, ${'Cust ' + suffix}
      )
    `.execute(db);
    return { customerId, userId, email: tagEmail(suffix) };
  }

  function ctx() {
    return {
      ip: '198.51.100.7',
      userAgentHash: 'uahash',
      portalBaseUrl,
      audit: { tag },
    };
  }

  async function seedSession(userId) {
    const sid = 'sess_' + Math.random().toString(36).slice(2);
    await sql`
      INSERT INTO sessions (id, user_type, user_id, absolute_expires_at, step_up_at)
      VALUES (${sid}, 'customer', ${userId}::uuid, now() + interval '12 hours', now())
    `.execute(db);
    return sid;
  }

  describe('requestEmailChange', () => {
    it('inserts request row, enqueues verification email to NEW addr, audits visible_to_customer', async () => {
      const u = await seedUser('a');
      const newEmail = tagEmail('a-new');
      const { token, expiresAt } = await service.requestEmailChange(
        db, { customerUserId: u.userId, newEmail }, ctx(),
      );
      expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(expiresAt).toBeInstanceOf(Date);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);

      const reqs = await sql`
        SELECT old_email, new_email, verify_token_hash, verified_at, cancelled_at
          FROM email_change_requests WHERE user_id = ${u.userId}::uuid
      `.execute(db);
      expect(reqs.rows).toHaveLength(1);
      const r = reqs.rows[0];
      expect(r.old_email).toBe(u.email);
      expect(r.new_email).toBe(newEmail);
      expect(r.verify_token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(r.verified_at).toBeNull();
      expect(r.cancelled_at).toBeNull();

      const o = await sql`
        SELECT to_address, template, locals
          FROM email_outbox WHERE to_address = ${newEmail}
      `.execute(db);
      expect(o.rows).toHaveLength(1);
      expect(o.rows[0].template).toBe('email-change-verification');
      expect(o.rows[0].locals.newEmail).toBe(newEmail);
      expect(o.rows[0].locals.verifyUrl).toContain(token);
      expect(o.rows[0].locals.verifyUrl).toContain(portalBaseUrl);

      const audits = await sql`
        SELECT action, visible_to_customer, metadata
          FROM audit_log WHERE metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audits.rows).toHaveLength(1);
      expect(audits.rows[0].action).toBe('customer_user.email_change_requested');
      expect(audits.rows[0].visible_to_customer).toBe(true);
      expect(audits.rows[0].metadata.newEmail).toBe(newEmail);
      expect(audits.rows[0].metadata.oldEmail).toBe(u.email);
      expect(audits.rows[0].metadata.customerId).toBe(u.customerId);
    });

    it('rejects an email already in use by another user', async () => {
      const a = await seedUser('coll-a');
      await seedUser('coll-b');
      await expect(
        service.requestEmailChange(db, { customerUserId: a.userId, newEmail: tagEmail('coll-b') }, ctx()),
      ).rejects.toThrow(/already in use/i);
    });

    it('rejects request to keep the same email', async () => {
      const u = await seedUser('same');
      await expect(
        service.requestEmailChange(db, { customerUserId: u.userId, newEmail: u.email }, ctx()),
      ).rejects.toThrow(/same/i);
    });

    it('rejects an obviously malformed email', async () => {
      const u = await seedUser('bad');
      await expect(
        service.requestEmailChange(db, { customerUserId: u.userId, newEmail: 'not-an-email' }, ctx()),
      ).rejects.toThrow(/email/i);
    });

    it('cancels prior in-flight request when a new one is opened', async () => {
      const u = await seedUser('multi');
      const first = await service.requestEmailChange(
        db, { customerUserId: u.userId, newEmail: tagEmail('multi-1') }, ctx(),
      );
      const second = await service.requestEmailChange(
        db, { customerUserId: u.userId, newEmail: tagEmail('multi-2') }, ctx(),
      );
      expect(second.token).not.toBe(first.token);

      const r = await sql`
        SELECT new_email, verified_at, cancelled_at, verify_token_hash
          FROM email_change_requests WHERE user_id = ${u.userId}::uuid
         ORDER BY created_at ASC
      `.execute(db);
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0].new_email).toBe(tagEmail('multi-1'));
      expect(r.rows[0].cancelled_at).not.toBeNull();
      expect(r.rows[0].verify_token_hash).toBeNull();
      expect(r.rows[1].new_email).toBe(tagEmail('multi-2'));
      expect(r.rows[1].cancelled_at).toBeNull();
    });
  });

  describe('verifyEmailChange', () => {
    it('swaps the email, marks request verified, mints a revert token, enqueues notification to OLD addr, audits', async () => {
      const u = await seedUser('v');
      const newEmail = tagEmail('v-new');
      const { token } = await service.requestEmailChange(
        db, { customerUserId: u.userId, newEmail }, ctx(),
      );
      await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);

      const r = await service.verifyEmailChange(db, { token }, ctx());
      expect(r.customerUserId).toBe(u.userId);
      expect(r.oldEmail).toBe(u.email);
      expect(r.newEmail).toBe(newEmail);
      expect(r.revertToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

      const userRow = await sql`SELECT email FROM customer_users WHERE id = ${u.userId}::uuid`.execute(db);
      expect(userRow.rows[0].email).toBe(newEmail);

      const reqRow = await sql`
        SELECT verified_at, revert_token_hash, revert_expires_at
          FROM email_change_requests WHERE user_id = ${u.userId}::uuid
      `.execute(db);
      expect(reqRow.rows[0].verified_at).not.toBeNull();
      expect(reqRow.rows[0].revert_token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(new Date(reqRow.rows[0].revert_expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);

      const o = await sql`
        SELECT to_address, template, locals FROM email_outbox WHERE to_address = ${u.email}
      `.execute(db);
      expect(o.rows).toHaveLength(1);
      expect(o.rows[0].template).toBe('email-change-notification-old');
      expect(o.rows[0].locals.oldEmail).toBe(u.email);
      expect(o.rows[0].locals.newEmail).toBe(newEmail);
      expect(o.rows[0].locals.revertUrl).toContain(r.revertToken);

      const audits = await sql`
        SELECT action, visible_to_customer FROM audit_log WHERE metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audits.rows.map((a) => a.action)).toContain('customer_user.email_change_verified');
      expect(audits.rows.find((a) => a.action === 'customer_user.email_change_verified').visible_to_customer).toBe(true);
    });

    it('rejects a wrong / cancelled token', async () => {
      await expect(
        service.verifyEmailChange(db, { token: 'definitely_not_a_real_token' }, ctx()),
      ).rejects.toThrow(/token/i);
    });

    it('rejects an expired token', async () => {
      const u = await seedUser('exp');
      const newEmail = tagEmail('exp-new');
      const { token } = await service.requestEmailChange(
        db, { customerUserId: u.userId, newEmail }, ctx(),
      );
      await sql`
        UPDATE email_change_requests
           SET verify_expires_at = now() - interval '1 minute'
         WHERE user_id = ${u.userId}::uuid
      `.execute(db);
      await expect(
        service.verifyEmailChange(db, { token }, ctx()),
      ).rejects.toThrow(/expired/i);
    });

    it('rejects re-using an already-verified token', async () => {
      const u = await seedUser('reuse');
      const newEmail = tagEmail('reuse-new');
      const { token } = await service.requestEmailChange(
        db, { customerUserId: u.userId, newEmail }, ctx(),
      );
      await service.verifyEmailChange(db, { token }, ctx());
      await expect(
        service.verifyEmailChange(db, { token }, ctx()),
      ).rejects.toThrow(/token/i);
    });
  });

  describe('revertEmailChange', () => {
    it('swaps the email back, revokes all sessions, marks reverted, audits visible_to_customer', async () => {
      const u = await seedUser('r');
      const sid = await seedSession(u.userId);
      const newEmail = tagEmail('r-new');
      const { token: vtoken } = await service.requestEmailChange(
        db, { customerUserId: u.userId, newEmail }, ctx(),
      );
      const { revertToken } = await service.verifyEmailChange(db, { token: vtoken }, ctx());
      await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);

      const r = await service.revertEmailChange(db, { token: revertToken }, ctx());
      expect(r.customerUserId).toBe(u.userId);

      const userRow = await sql`SELECT email FROM customer_users WHERE id = ${u.userId}::uuid`.execute(db);
      expect(userRow.rows[0].email).toBe(u.email);

      const reqRow = await sql`
        SELECT reverted_at, revert_token_hash FROM email_change_requests WHERE user_id = ${u.userId}::uuid
      `.execute(db);
      expect(reqRow.rows[0].reverted_at).not.toBeNull();
      expect(reqRow.rows[0].revert_token_hash).toBeNull();

      const sessRow = await sql`SELECT revoked_at FROM sessions WHERE id = ${sid}`.execute(db);
      expect(sessRow.rows[0].revoked_at).not.toBeNull();

      const audits = await sql`
        SELECT action, visible_to_customer FROM audit_log WHERE metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audits.rows.map((a) => a.action)).toContain('customer_user.email_change_reverted');
      const ev = audits.rows.find((a) => a.action === 'customer_user.email_change_reverted');
      expect(ev.visible_to_customer).toBe(true);
    });

    it('rejects an expired revert token', async () => {
      const u = await seedUser('rexp');
      const newEmail = tagEmail('rexp-new');
      const { token: vtoken } = await service.requestEmailChange(
        db, { customerUserId: u.userId, newEmail }, ctx(),
      );
      const { revertToken } = await service.verifyEmailChange(db, { token: vtoken }, ctx());
      await sql`
        UPDATE email_change_requests
           SET revert_expires_at = now() - interval '1 minute'
         WHERE user_id = ${u.userId}::uuid
      `.execute(db);
      await expect(
        service.revertEmailChange(db, { token: revertToken }, ctx()),
      ).rejects.toThrow(/expired/i);
    });

    it('refuses a wrong / unverified token', async () => {
      await expect(
        service.revertEmailChange(db, { token: 'not_a_revert_token' }, ctx()),
      ).rejects.toThrow(/token/i);
    });
  });
});
