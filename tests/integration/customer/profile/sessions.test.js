import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../../config/db.js';
import * as service from '../../../../domain/customer-users/service.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customer-users/service sessions', () => {
  let db;
  const tag = `cu_sess_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;

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

  async function seedUser(suffix) {
    const customerId = uuidv7();
    const userId = uuidv7();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (
        ${customerId}::uuid, ${tag + ' ' + suffix + ' S.L.'},
        ${Buffer.alloc(32)}::bytea, ${Buffer.alloc(12)}::bytea, ${Buffer.alloc(16)}::bytea
      )
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (
        ${userId}::uuid, ${customerId}::uuid, ${tagEmail(suffix)}, ${'Cust ' + suffix}
      )
    `.execute(db);
    return { customerId, userId };
  }

  async function seedSession(userId, opts = {}) {
    const sid = 'sess_' + Math.random().toString(36).slice(2);
    const ip = opts.ip ?? '198.51.100.7';
    const fp = opts.fingerprint ?? null;
    const revokedAt = opts.revokedAt ?? null;
    await sql`
      INSERT INTO sessions (id, user_type, user_id, ip, device_fingerprint, absolute_expires_at, step_up_at, last_seen_at, revoked_at)
      VALUES (
        ${sid}, 'customer', ${userId}::uuid, ${ip}::inet, ${fp},
        now() + interval '12 hours', now(), now() - interval '5 minutes', ${revokedAt}::timestamptz
      )
    `.execute(db);
    return sid;
  }

  function ctx() {
    return { ip: '198.51.100.7', userAgentHash: 'uahash', audit: { tag } };
  }

  describe('listSessions', () => {
    it('returns active sessions only, newest-first by last_seen_at, with current marker', async () => {
      const u = await seedUser('a');
      const a = await seedSession(u.userId, { ip: '198.51.100.1', fingerprint: 'fpA' });
      const b = await seedSession(u.userId, { ip: '198.51.100.2', fingerprint: 'fpB' });
      // One revoked — must NOT show up.
      await seedSession(u.userId, { revokedAt: new Date().toISOString() });

      const list = await service.listSessions(db, { customerUserId: u.userId, currentSessionId: a });
      expect(list.length).toBe(2);
      // ip is masked / projected, no raw secrets
      for (const row of list) {
        expect(typeof row.id).toBe('string');
        expect(typeof row.ip_prefix === 'string' || row.ip_prefix === null).toBe(true);
        expect(typeof row.is_current).toBe('boolean');
      }
      const cur = list.find((r) => r.id === a);
      const other = list.find((r) => r.id === b);
      expect(cur.is_current).toBe(true);
      expect(other.is_current).toBe(false);
    });
  });

  describe('revokeSession', () => {
    it('revokes one specific session if it belongs to the user; audits visible_to_customer', async () => {
      const u = await seedUser('b');
      const a = await seedSession(u.userId);
      const b = await seedSession(u.userId);

      await service.revokeSession(db, { customerUserId: u.userId, sessionId: a }, ctx());

      const r = await sql`SELECT id, revoked_at FROM sessions WHERE user_id = ${u.userId}::uuid ORDER BY id`.execute(db);
      const aRow = r.rows.find((row) => row.id === a);
      const bRow = r.rows.find((row) => row.id === b);
      expect(aRow.revoked_at).not.toBeNull();
      expect(bRow.revoked_at).toBeNull();

      const audits = await sql`SELECT action, visible_to_customer FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
      expect(audits.rows.map((aud) => aud.action)).toContain('customer_user.session_revoked');
      expect(audits.rows.find((x) => x.action === 'customer_user.session_revoked').visible_to_customer).toBe(true);
    });

    it('rejects revoke of a session belonging to another user', async () => {
      const a = await seedUser('crossA');
      const b = await seedUser('crossB');
      const sidB = await seedSession(b.userId);
      await expect(
        service.revokeSession(db, { customerUserId: a.userId, sessionId: sidB }, ctx()),
      ).rejects.toThrow(/not found/i);
      const r = await sql`SELECT revoked_at FROM sessions WHERE id = ${sidB}`.execute(db);
      expect(r.rows[0].revoked_at).toBeNull();
    });
  });

  describe('revokeAllSessions', () => {
    it('revokes every session for the user EXCEPT the current one (if given)', async () => {
      const u = await seedUser('c');
      const a = await seedSession(u.userId);
      const b = await seedSession(u.userId);
      const c = await seedSession(u.userId);

      await service.revokeAllSessions(
        db,
        { customerUserId: u.userId, exceptSessionId: a },
        ctx(),
      );

      const r = await sql`SELECT id, revoked_at FROM sessions WHERE user_id = ${u.userId}::uuid`.execute(db);
      const aRow = r.rows.find((row) => row.id === a);
      const bRow = r.rows.find((row) => row.id === b);
      const cRow = r.rows.find((row) => row.id === c);
      expect(aRow.revoked_at).toBeNull();
      expect(bRow.revoked_at).not.toBeNull();
      expect(cRow.revoked_at).not.toBeNull();

      const audits = await sql`SELECT action, visible_to_customer FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
      expect(audits.rows.map((aud) => aud.action)).toContain('customer_user.logged_out_everywhere');
    });

    it('with no exceptSessionId revokes every session including the caller', async () => {
      const u = await seedUser('d');
      const a = await seedSession(u.userId);
      const b = await seedSession(u.userId);
      await service.revokeAllSessions(db, { customerUserId: u.userId }, ctx());
      const r = await sql`SELECT revoked_at FROM sessions WHERE user_id = ${u.userId}::uuid`.execute(db);
      expect(r.rows.every((row) => row.revoked_at !== null)).toBe(true);
    });
  });
});
