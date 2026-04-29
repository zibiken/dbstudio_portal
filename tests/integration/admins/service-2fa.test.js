import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import * as service from '../../../domain/admins/service.js';
import { findById } from '../../../domain/admins/repo.js';
import { decrypt } from '../../../lib/crypto/envelope.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('admins/service — 2FA + backup codes', () => {
  let db;
  const tag = `2fa_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;
  const ctx = { ip: '198.51.100.7', userAgentHash: 'uahash', audit: { tag } };
  const okHibp = vi.fn(async () => false);

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify`).execute(db);
      await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify`).execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
  });

  async function makeAdmin(suffix) {
    const c = await service.create(db, { email: tagEmail(suffix), name: suffix }, ctx);
    await service.consumeInvite(db, { token: c.inviteToken, newPassword: 'astrong-passphrase-9342' },
      { ...ctx, hibpHasBeenPwned: okHibp });
    return c.id;
  }

  describe('enroll2faTotp', () => {
    it('encrypts the secret with the KEK and stores ciphertext / iv / tag', async () => {
      const id = await makeAdmin('totp');
      const kek = randomBytes(32);
      const secret = 'JBSWY3DPEHPK3PXP';

      await service.enroll2faTotp(db, { adminId: id, secret, kek }, ctx);

      const admin = await findById(db, id);
      expect(admin.totp_secret_enc).toBeInstanceOf(Buffer);
      expect(admin.totp_iv?.length).toBe(12);
      expect(admin.totp_tag?.length).toBe(16);

      const round = decrypt({ ciphertext: admin.totp_secret_enc, iv: admin.totp_iv, tag: admin.totp_tag }, kek);
      expect(round.toString('utf8')).toBe(secret);
    });
  });

  describe('enroll2faWebauthn', () => {
    it('appends a credential to webauthn_creds JSONB', async () => {
      const id = await makeAdmin('wa');

      await service.enroll2faWebauthn(db, {
        adminId: id,
        registrationInfo: { credentialID: 'CRED1', credentialPublicKey: 'pk1', counter: 0 },
      }, ctx);

      let admin = await findById(db, id);
      expect(admin.webauthn_creds).toHaveLength(1);
      expect(admin.webauthn_creds[0].id).toBe('CRED1');

      await service.enroll2faWebauthn(db, {
        adminId: id,
        registrationInfo: { credentialID: 'CRED2', credentialPublicKey: 'pk2', counter: 0 },
      }, ctx);

      admin = await findById(db, id);
      expect(admin.webauthn_creds).toHaveLength(2);
      expect(admin.webauthn_creds.map(c => c.id).sort()).toEqual(['CRED1', 'CRED2']);
    });
  });

  describe('enroll2faEmailOtp', () => {
    it('sets email_otp_enabled to true', async () => {
      const id = await makeAdmin('eotp');
      await service.enroll2faEmailOtp(db, { adminId: id }, ctx);
      const admin = await findById(db, id);
      expect(admin.email_otp_enabled).toBe(true);
    });
  });

  describe('regenBackupCodes', () => {
    it('returns 8 plaintext codes and stores 8 hashed entries; old codes no longer verify', async () => {
      const id = await makeAdmin('bc');

      const first = await service.regenBackupCodes(db, { adminId: id }, ctx);
      expect(first.codes).toHaveLength(8);

      let admin = await findById(db, id);
      expect(admin.backup_codes).toHaveLength(8);
      expect(admin.backup_codes[0].hash.startsWith('$argon2id$')).toBe(true);

      // Regenerate; previously stored hashes should be wholly replaced.
      const second = await service.regenBackupCodes(db, { adminId: id }, ctx);
      expect(second.codes).toHaveLength(8);
      expect(second.codes).not.toEqual(first.codes);

      admin = await findById(db, id);
      const newHashes = admin.backup_codes.map(s => s.hash);
      const oldHashes = first.codes.map(() => true); // just count
      expect(admin.backup_codes).toHaveLength(8);
      // Old plaintexts should not match the new stored hashes.
      const r = await service.consumeBackupCode(db, { adminId: id, code: first.codes[0] }, ctx);
      expect(r.ok).toBe(false);
    });

    it('consumeBackupCode marks the matching code consumed and rejects re-use', async () => {
      const id = await makeAdmin('bc2');
      const { codes } = await service.regenBackupCodes(db, { adminId: id }, ctx);

      const r1 = await service.consumeBackupCode(db, { adminId: id, code: codes[0] }, ctx);
      expect(r1.ok).toBe(true);

      const r2 = await service.consumeBackupCode(db, { adminId: id, code: codes[0] }, ctx);
      expect(r2.ok).toBe(false);

      // Other codes still valid
      const r3 = await service.consumeBackupCode(db, { adminId: id, code: codes[1] }, ctx);
      expect(r3.ok).toBe(true);
    });
  });

  describe('completeWelcome (atomic)', () => {
    const kek = randomBytes(32);

    it('sets password, TOTP secret, and backup codes in a single transaction', async () => {
      const c = await service.create(db, { email: tagEmail('cw'), name: 'CW' }, ctx);

      const r = await service.completeWelcome(db, {
        token: c.inviteToken,
        newPassword: 'a-strong-passphrase-29384',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        kek,
      }, { ...ctx, hibpHasBeenPwned: okHibp });

      expect(r.adminId).toBe(c.id);
      expect(r.codes).toHaveLength(8);

      const admin = await findById(db, c.id);
      expect(admin.password_hash?.startsWith('$argon2id$')).toBe(true);
      expect(admin.invite_consumed_at).not.toBeNull();
      expect(admin.totp_secret_enc).not.toBeNull();
      expect(admin.backup_codes).toHaveLength(8);

      const decrypted = decrypt(
        { ciphertext: admin.totp_secret_enc, iv: admin.totp_iv, tag: admin.totp_tag },
        kek,
      ).toString('utf8');
      expect(decrypted).toBe('JBSWY3DPEHPK3PXP');
    });

    it('rolls back the entire flow if the invite is invalid — no partial state', async () => {
      const c = await service.create(db, { email: tagEmail('rb'), name: 'RB' }, ctx);
      // Pre-consume the invite so completeWelcome's lockInviteRow throws.
      await service.consumeInvite(db, { token: c.inviteToken, newPassword: 'first-password-29384' },
        { ...ctx, hibpHasBeenPwned: okHibp });

      await expect(
        service.completeWelcome(db, {
          token: c.inviteToken,
          newPassword: 'second-attempt-29384',
          totpSecret: 'JBSWY3DPEHPK3PXP',
          kek,
        }, { ...ctx, hibpHasBeenPwned: okHibp })
      ).rejects.toThrow(/consumed/i);

      const admin = await findById(db, c.id);
      // The first password from consumeInvite remains; nothing partial-applied.
      expect(admin.totp_secret_enc).toBeNull();
      expect(admin.backup_codes ?? []).toHaveLength(0);
    });
  });
});
