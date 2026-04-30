import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../../config/db.js';
import * as service from '../../../../domain/customer-users/service.js';
import { hashPassword, verifyPassword } from '../../../../lib/crypto/hash.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customer-users/service.changePassword', () => {
  let db;
  const tag = `cu_pw_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;
  const okHibp = vi.fn(async () => false);
  const badHibp = vi.fn(async () => true);

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  async function seedUser(suffix, currentPassword = 'old-passphrase-92834756') {
    const customerId = uuidv7();
    const userId = uuidv7();
    const passwordHash = await hashPassword(currentPassword);
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (
        ${customerId}::uuid,
        ${tag + ' ' + suffix + ' S.L.'},
        ${Buffer.alloc(32)}::bytea, ${Buffer.alloc(12)}::bytea, ${Buffer.alloc(16)}::bytea
      )
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name, password_hash)
      VALUES (
        ${userId}::uuid, ${customerId}::uuid, ${tagEmail(suffix)},
        ${'Cust ' + suffix}, ${passwordHash}
      )
    `.execute(db);
    return { customerId, userId, currentPassword };
  }

  async function seedSession(userId, sidPrefix = 'sess_') {
    const sid = sidPrefix + Math.random().toString(36).slice(2);
    await sql`
      INSERT INTO sessions (id, user_type, user_id, absolute_expires_at, step_up_at)
      VALUES (${sid}, 'customer', ${userId}::uuid, now() + interval '12 hours', now())
    `.execute(db);
    return sid;
  }

  function ctx(extra = {}) {
    return {
      ip: '198.51.100.7',
      userAgentHash: 'uahash',
      audit: { tag },
      hibpHasBeenPwned: okHibp,
      ...extra,
    };
  }

  it('hashes + persists the new password, audits visible_to_customer, revokes OTHER sessions but keeps current', async () => {
    const u = await seedUser('a');
    const currentSid = await seedSession(u.userId);
    const otherSid = await seedSession(u.userId);

    await service.changePassword(
      db,
      {
        customerUserId: u.userId,
        currentPassword: u.currentPassword,
        newPassword: 'fresh-different-passphrase-29348',
        currentSessionId: currentSid,
      },
      ctx(),
    );

    const userRow = await sql`SELECT password_hash FROM customer_users WHERE id = ${u.userId}::uuid`.execute(db);
    expect(await verifyPassword(userRow.rows[0].password_hash, 'fresh-different-passphrase-29348')).toBe(true);
    expect(await verifyPassword(userRow.rows[0].password_hash, u.currentPassword)).toBe(false);

    const sess = await sql`SELECT id, revoked_at FROM sessions WHERE user_id = ${u.userId}::uuid ORDER BY id`.execute(db);
    const cur = sess.rows.find((r) => r.id === currentSid);
    const other = sess.rows.find((r) => r.id === otherSid);
    expect(cur.revoked_at).toBeNull();
    expect(other.revoked_at).not.toBeNull();

    const audits = await sql`SELECT action, visible_to_customer, metadata FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    expect(audits.rows.map((a) => a.action)).toContain('customer_user.password_changed');
    const a = audits.rows.find((r) => r.action === 'customer_user.password_changed');
    expect(a.visible_to_customer).toBe(true);
    expect(a.metadata.customerId).toBe(u.customerId);
  });

  it('rejects a wrong current password (constant-time still ok), no DB mutation', async () => {
    const u = await seedUser('b');
    await expect(
      service.changePassword(
        db,
        {
          customerUserId: u.userId,
          currentPassword: 'wrong-passphrase-29348',
          newPassword: 'whatever-fresh-passphrase-19283',
          currentSessionId: 'sess_x',
        },
        ctx(),
      ),
    ).rejects.toThrow(/current password/i);
    const audits = await sql`SELECT action FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    expect(audits.rows.map((a) => a.action)).toContain('customer_user.password_change_failed');
  });

  it('rejects a HIBP-pwned new password and writes a denial audit', async () => {
    const u = await seedUser('c');
    await expect(
      service.changePassword(
        db,
        {
          customerUserId: u.userId,
          currentPassword: u.currentPassword,
          newPassword: 'super-easy-known-password-12345',
          currentSessionId: 'sess_x',
        },
        ctx({ hibpHasBeenPwned: badHibp }),
      ),
    ).rejects.toThrow(/breach|compromised|pwned/i);
    const userRow = await sql`SELECT password_hash FROM customer_users WHERE id = ${u.userId}::uuid`.execute(db);
    expect(await verifyPassword(userRow.rows[0].password_hash, u.currentPassword)).toBe(true);
  });

  it('rejects a too-short new password (< 12 chars)', async () => {
    const u = await seedUser('d');
    await expect(
      service.changePassword(
        db,
        {
          customerUserId: u.userId,
          currentPassword: u.currentPassword,
          newPassword: 'short',
          currentSessionId: 'sess_x',
        },
        ctx(),
      ),
    ).rejects.toThrow(/12/);
  });

  it('rejects re-using the same password as current', async () => {
    const u = await seedUser('e');
    await expect(
      service.changePassword(
        db,
        {
          customerUserId: u.userId,
          currentPassword: u.currentPassword,
          newPassword: u.currentPassword,
          currentSessionId: 'sess_x',
        },
        ctx(),
      ),
    ).rejects.toThrow(/different/i);
  });
});
