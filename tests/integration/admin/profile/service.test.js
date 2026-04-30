import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../../config/db.js';
import * as service from '../../../../domain/admins/service.js';
import { hashPassword, verifyPassword } from '../../../../lib/crypto/hash.js';
import { encrypt, decrypt } from '../../../../lib/crypto/envelope.js';
import { generateSecret, generateToken } from '../../../../lib/auth/totp.js';
import { generateBackupCodes, verifyAndConsume } from '../../../../lib/auth/backup-codes.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('admins/service profile management', () => {
  let db;
  let kek;
  const tag = `admin_prof_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;
  const portalBaseUrl = 'https://portal.example.test';
  const okHibp = vi.fn(async () => false);
  const badHibp = vi.fn(async () => true);

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM email_change_requests WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM email_change_requests WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  async function seedAdmin(suffix, opts = {}) {
    const id = uuidv7();
    const password = opts.password ?? 'old-admin-pass-29384756';
    const passwordHash = await hashPassword(password);
    const totpSecret = generateSecret();
    const totpEnv = encrypt(Buffer.from(totpSecret, 'utf8'), kek);
    const { codes, stored } = await generateBackupCodes();
    await sql`
      INSERT INTO admins (id, email, name, password_hash, totp_secret_enc, totp_iv, totp_tag, backup_codes)
      VALUES (
        ${id}::uuid, ${tagEmail(suffix)}, ${'Admin ' + suffix}, ${passwordHash},
        ${totpEnv.ciphertext}::bytea, ${totpEnv.iv}::bytea, ${totpEnv.tag}::bytea,
        ${JSON.stringify(stored)}::jsonb
      )
    `.execute(db);
    return { id, email: tagEmail(suffix), password, totpSecret, oldCodes: codes };
  }

  async function seedSession(adminId, opts = {}) {
    const sid = 'sess_' + Math.random().toString(36).slice(2);
    await sql`
      INSERT INTO sessions (id, user_type, user_id, absolute_expires_at, step_up_at, last_seen_at, revoked_at)
      VALUES (
        ${sid}, 'admin', ${adminId}::uuid, now() + interval '12 hours',
        now(), now() - interval '5 minutes', ${opts.revokedAt ?? null}::timestamptz
      )
    `.execute(db);
    return sid;
  }

  function ctx(extra = {}) {
    return {
      ip: '198.51.100.7',
      userAgentHash: 'uahash',
      audit: { tag },
      portalBaseUrl,
      kek,
      hibpHasBeenPwned: okHibp,
      ...extra,
    };
  }

  describe('updateAdminName', () => {
    it('persists trimmed name + audit', async () => {
      const a = await seedAdmin('a');
      await service.updateAdminName(db, { adminId: a.id, name: '  New Admin Name  ' }, ctx());
      const row = await sql`SELECT name FROM admins WHERE id = ${a.id}::uuid`.execute(db);
      expect(row.rows[0].name).toBe('New Admin Name');
      const audits = await sql`SELECT action FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
      expect(audits.rows.map((x) => x.action)).toContain('admin.name_changed');
    });

    it('rejects blank name', async () => {
      const a = await seedAdmin('b');
      await expect(
        service.updateAdminName(db, { adminId: a.id, name: '   ' }, ctx()),
      ).rejects.toThrow(/name/i);
    });
  });

  describe('changeAdminPassword', () => {
    it('happy path: verify current, HIBP screen, swap hash, revoke other sessions', async () => {
      const a = await seedAdmin('c');
      const cur = await seedSession(a.id);
      const other = await seedSession(a.id);
      await service.changeAdminPassword(
        db,
        {
          adminId: a.id,
          currentPassword: a.password,
          newPassword: 'fresh-admin-pass-29384756',
          currentSessionId: cur,
        },
        ctx(),
      );
      const row = await sql`SELECT password_hash FROM admins WHERE id = ${a.id}::uuid`.execute(db);
      expect(await verifyPassword(row.rows[0].password_hash, 'fresh-admin-pass-29384756')).toBe(true);
      const sess = await sql`SELECT id, revoked_at FROM sessions WHERE user_id = ${a.id}::uuid`.execute(db);
      expect(sess.rows.find((r) => r.id === cur).revoked_at).toBeNull();
      expect(sess.rows.find((r) => r.id === other).revoked_at).not.toBeNull();
      const audits = await sql`SELECT action FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
      expect(audits.rows.map((x) => x.action)).toContain('admin.password_changed');
    });

    it('rejects wrong current password', async () => {
      const a = await seedAdmin('d');
      await expect(
        service.changeAdminPassword(
          db,
          { adminId: a.id, currentPassword: 'nope', newPassword: 'fresh-admin-pass-29384756', currentSessionId: 'x' },
          ctx(),
        ),
      ).rejects.toThrow(/current password/i);
    });

    it('rejects HIBP-pwned new password', async () => {
      const a = await seedAdmin('e');
      await expect(
        service.changeAdminPassword(
          db,
          { adminId: a.id, currentPassword: a.password, newPassword: 'fresh-admin-pass-29384756', currentSessionId: 'x' },
          ctx({ hibpHasBeenPwned: badHibp }),
        ),
      ).rejects.toThrow(/breach|compromised|pwned/i);
    });
  });

  describe('requestAdminEmailChange + verify + revert', () => {
    it('full lifecycle works against email_change_requests with user_type=admin', async () => {
      const a = await seedAdmin('em');
      const newEmail = tagEmail('em-new');
      const sid = await seedSession(a.id);

      const reqR = await service.requestAdminEmailChange(db, { adminId: a.id, newEmail }, ctx());
      expect(reqR.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

      const o1 = await sql`SELECT template, locals FROM email_outbox WHERE to_address = ${newEmail}`.execute(db);
      expect(o1.rows[0].template).toBe('email-change-verification');
      expect(o1.rows[0].locals.verifyUrl).toContain(reqR.token);
      expect(o1.rows[0].locals.verifyUrl).toContain('/admin/profile/email/verify/');

      const verifyR = await service.verifyAdminEmailChange(db, { token: reqR.token }, ctx());
      const ar = await sql`SELECT email FROM admins WHERE id = ${a.id}::uuid`.execute(db);
      expect(ar.rows[0].email).toBe(newEmail);

      const o2 = await sql`SELECT template, locals FROM email_outbox WHERE to_address = ${a.email}`.execute(db);
      expect(o2.rows[0].template).toBe('email-change-notification-old');
      expect(o2.rows[0].locals.revertUrl).toContain(verifyR.revertToken);
      expect(o2.rows[0].locals.revertUrl).toContain('/admin/profile/email/revert/');

      await service.revertAdminEmailChange(db, { token: verifyR.revertToken }, ctx());
      const ar2 = await sql`SELECT email FROM admins WHERE id = ${a.id}::uuid`.execute(db);
      expect(ar2.rows[0].email).toBe(a.email);
      const ses = await sql`SELECT revoked_at FROM sessions WHERE id = ${sid}`.execute(db);
      expect(ses.rows[0].revoked_at).not.toBeNull();
    });
  });

  describe('regenAdminTotpSelf', () => {
    it('verifies current code, swaps secret encrypted under KEK directly, audits', async () => {
      const a = await seedAdmin('totp');
      const newSecret = generateSecret();
      const cur = generateToken(a.totpSecret);
      const fresh = generateToken(newSecret);
      await service.regenAdminTotpSelf(
        db,
        { adminId: a.id, currentCode: cur, newSecret, newCode: fresh },
        ctx(),
      );
      const row = await sql`SELECT totp_secret_enc, totp_iv, totp_tag FROM admins WHERE id = ${a.id}::uuid`.execute(db);
      const recovered = decrypt({
        ciphertext: row.rows[0].totp_secret_enc,
        iv: row.rows[0].totp_iv,
        tag: row.rows[0].totp_tag,
      }, kek).toString('utf8');
      expect(recovered).toBe(newSecret);
      expect(recovered).not.toBe(a.totpSecret);
    });

    it('rejects wrong current code', async () => {
      const a = await seedAdmin('totp2');
      const newSecret = generateSecret();
      const fresh = generateToken(newSecret);
      await expect(
        service.regenAdminTotpSelf(
          db,
          { adminId: a.id, currentCode: '000000', newSecret, newCode: fresh },
          ctx(),
        ),
      ).rejects.toThrow(/code|verify/i);
    });
  });

  describe('regenAdminBackupCodesSelf', () => {
    it('verifies current TOTP, replaces all 8 codes, returns plaintext', async () => {
      const a = await seedAdmin('bc');
      const r = await service.regenAdminBackupCodesSelf(
        db,
        { adminId: a.id, currentCode: generateToken(a.totpSecret) },
        ctx(),
      );
      expect(r.codes).toHaveLength(8);
      expect(r.codes.some((c) => a.oldCodes.includes(c))).toBe(false);
      const row = await sql`SELECT backup_codes FROM admins WHERE id = ${a.id}::uuid`.execute(db);
      const stored = row.rows[0].backup_codes;
      for (const c of r.codes) {
        const v = await verifyAndConsume(stored, c);
        expect(v.ok).toBe(true);
      }
    });

    it('also accepts a backup code as proof', async () => {
      const a = await seedAdmin('bc2');
      const r = await service.regenAdminBackupCodesSelf(
        db,
        { adminId: a.id, backupCode: a.oldCodes[0] },
        ctx(),
      );
      expect(r.codes).toHaveLength(8);
    });
  });

  describe('listAdminSessions / revokeAdminSession / revokeAllAdminSessions', () => {
    it('list returns active sessions; revoke + revokeAll behave as customer counterparts', async () => {
      const a = await seedAdmin('s');
      const cur = await seedSession(a.id);
      const other = await seedSession(a.id);
      const list = await service.listAdminSessions(db, { adminId: a.id, currentSessionId: cur });
      expect(list).toHaveLength(2);
      expect(list.find((r) => r.id === cur).is_current).toBe(true);

      await service.revokeAdminSession(db, { adminId: a.id, sessionId: other }, ctx());
      const r = await sql`SELECT id, revoked_at FROM sessions WHERE user_id = ${a.id}::uuid`.execute(db);
      expect(r.rows.find((row) => row.id === other).revoked_at).not.toBeNull();
      expect(r.rows.find((row) => row.id === cur).revoked_at).toBeNull();

      const more = await seedSession(a.id);
      await service.revokeAllAdminSessions(db, { adminId: a.id, exceptSessionId: cur }, ctx());
      const r2 = await sql`SELECT id, revoked_at FROM sessions WHERE user_id = ${a.id}::uuid`.execute(db);
      expect(r2.rows.find((row) => row.id === cur).revoked_at).toBeNull();
      expect(r2.rows.find((row) => row.id === more).revoked_at).not.toBeNull();
    });
  });
});
