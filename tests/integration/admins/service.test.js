import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import * as service from '../../../domain/admins/service.js';
import { findById, findByEmail } from '../../../domain/admins/repo.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('admins/service', () => {
  let db;
  const tag = `svc_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;
  const ctx = { ip: '198.51.100.7', userAgentHash: 'uahash' };

  // Skip the HIBP network call in the unit-level path.
  const okHibp = vi.fn(async () => false);

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify`).execute(db);
      await sql`DELETE FROM audit_log WHERE action LIKE ${'admin.' + '%'} AND metadata->>'tag' = ${tag}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify`).execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
  });

  describe('create', () => {
    it('persists an admin with no password and a hashed invite token; returns plaintext token', async () => {
      const r = await service.create(db, { email: tagEmail('a'), name: 'A' }, { ...ctx, audit: { tag } });
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.inviteToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

      const admin = await findById(db, r.id);
      expect(admin.password_hash).toBeNull();
      expect(admin.invite_token_hash).not.toBeNull();
      expect(admin.invite_token_hash).not.toBe(r.inviteToken); // hashed
      expect(admin.invite_consumed_at).toBeNull();
      expect(new Date(admin.invite_expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects duplicate email', async () => {
      await service.create(db, { email: tagEmail('dup'), name: 'A' }, { ...ctx, audit: { tag } });
      await expect(
        service.create(db, { email: tagEmail('dup'), name: 'A' }, { ...ctx, audit: { tag } })
      ).rejects.toThrow();
    });
  });

  describe('consumeInvite', () => {
    it('sets the password and marks the invite consumed; the same token cannot be reused', async () => {
      const created = await service.create(db, { email: tagEmail('w'), name: 'W' }, { ...ctx, audit: { tag } });

      const r = await service.consumeInvite(db, {
        token: created.inviteToken,
        newPassword: 'astrong-passphrase-9342',
      }, { ...ctx, audit: { tag }, hibpHasBeenPwned: okHibp });

      expect(r.adminId).toBe(created.id);

      const admin = await findById(db, created.id);
      expect(admin.password_hash?.startsWith('$argon2id$')).toBe(true);
      expect(admin.invite_consumed_at).not.toBeNull();

      // Re-use rejected
      await expect(
        service.consumeInvite(db, { token: created.inviteToken, newPassword: 'another-pw-asd92348' },
          { ...ctx, audit: { tag }, hibpHasBeenPwned: okHibp })
      ).rejects.toThrow(/invalid|consumed|expired/i);
    });

    it('rejects an expired token', async () => {
      const created = await service.create(db, { email: tagEmail('exp'), name: 'E' }, { ...ctx, audit: { tag } });
      await sql`UPDATE admins SET invite_expires_at = now() - INTERVAL '1 minute' WHERE id = ${created.id}::uuid`.execute(db);

      await expect(
        service.consumeInvite(db, { token: created.inviteToken, newPassword: 'astrong-passphrase-9342' },
          { ...ctx, audit: { tag }, hibpHasBeenPwned: okHibp })
      ).rejects.toThrow(/expired/i);
    });

    it('rejects a HIBP-pwned password', async () => {
      const created = await service.create(db, { email: tagEmail('hibp'), name: 'H' }, { ...ctx, audit: { tag } });
      const pwnedHibp = vi.fn(async () => true);

      await expect(
        service.consumeInvite(db, { token: created.inviteToken, newPassword: 'password' },
          { ...ctx, audit: { tag }, hibpHasBeenPwned: pwnedHibp })
      ).rejects.toThrow(/breach|pwned|compromised/i);

      const admin = await findById(db, created.id);
      expect(admin.password_hash).toBeNull();
      expect(admin.invite_consumed_at).toBeNull();
    });
  });

  describe('verifyLogin', () => {
    it('returns the admin row for the right password', async () => {
      const created = await service.create(db, { email: tagEmail('login'), name: 'L' }, { ...ctx, audit: { tag } });
      await service.consumeInvite(db, {
        token: created.inviteToken,
        newPassword: 'astrong-passphrase-9342',
      }, { ...ctx, audit: { tag }, hibpHasBeenPwned: okHibp });

      const r = await service.verifyLogin(db, { email: tagEmail('login'), password: 'astrong-passphrase-9342' });
      expect(r?.id).toBe(created.id);
    });

    it('returns null for the wrong password', async () => {
      const created = await service.create(db, { email: tagEmail('wrongpw'), name: 'W' }, { ...ctx, audit: { tag } });
      await service.consumeInvite(db, {
        token: created.inviteToken,
        newPassword: 'astrong-passphrase-9342',
      }, { ...ctx, audit: { tag }, hibpHasBeenPwned: okHibp });

      expect(await service.verifyLogin(db, { email: tagEmail('wrongpw'), password: 'wrong' })).toBeNull();
    });

    it('returns null for a missing user', async () => {
      expect(await service.verifyLogin(db, { email: tagEmail('absent'), password: 'x' })).toBeNull();
    });

    it('returns null when password not yet set (admin still pre-welcome)', async () => {
      await service.create(db, { email: tagEmail('preset'), name: 'P' }, { ...ctx, audit: { tag } });
      expect(await service.verifyLogin(db, { email: tagEmail('preset'), password: 'anything' })).toBeNull();
    });
  });

  describe('requestPasswordReset', () => {
    it('issues a fresh invite token, invalidating any prior one', async () => {
      const created = await service.create(db, { email: tagEmail('reset'), name: 'R' }, { ...ctx, audit: { tag } });
      const r = await service.requestPasswordReset(db, { email: tagEmail('reset') }, { ...ctx, audit: { tag } });
      expect(r.inviteToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(r.inviteToken).not.toBe(created.inviteToken);

      // Old token no longer works
      await expect(
        service.consumeInvite(db, { token: created.inviteToken, newPassword: 'astrong-passphrase-9342' },
          { ...ctx, audit: { tag }, hibpHasBeenPwned: okHibp })
      ).rejects.toThrow();
      // New token works
      const ok = await service.consumeInvite(db, { token: r.inviteToken, newPassword: 'astrong-passphrase-9342' },
        { ...ctx, audit: { tag }, hibpHasBeenPwned: okHibp });
      expect(ok.adminId).toBe(created.id);
    });

    it('returns the same generic shape for an unknown email (no enumeration)', async () => {
      const r = await service.requestPasswordReset(db, { email: tagEmail('ghost') }, { ...ctx, audit: { tag } });
      expect(r).toEqual({ inviteToken: null });
    });
  });
});
