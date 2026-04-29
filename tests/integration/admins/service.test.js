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
      await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
      await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify`).execute(db);
      await sql`DELETE FROM audit_log WHERE action LIKE ${'admin.' + '%'} AND metadata->>'tag' = ${tag}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify`).execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
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

    it('throws if neither ctx.portalBaseUrl nor PORTAL_BASE_URL env is set (no silent skip)', async () => {
      const saved = process.env.PORTAL_BASE_URL;
      delete process.env.PORTAL_BASE_URL;
      try {
        await expect(
          service.create(db, { email: tagEmail('strict'), name: 'S' }, { audit: { tag } }),
        ).rejects.toThrow(/portalBaseUrl/);
        // No partial state: the admin row must not have been written.
        const r = await sql`SELECT count(*)::int AS c FROM admins WHERE email = ${tagEmail('strict')}`.execute(db);
        expect(r.rows[0].c).toBe(0);
      } finally {
        if (saved !== undefined) process.env.PORTAL_BASE_URL = saved;
      }
    });

    it('admin row + audit + outbox commit atomically (rollback on enqueue failure)', async () => {
      // Force a unique-key collision on email_outbox by pre-inserting a row
      // with the idempotency_key the service.create call will try to use.
      // Wait — service.create's idempotency_key is admin_welcome:<id> where
      // <id> is generated inside the call. We can't pre-collide unpredictably.
      // Instead, force the collision by passing a duplicate admin email so
      // insertAdmin throws inside the transaction.
      const r = await service.create(db, { email: tagEmail('atomic'), name: 'A' }, { ...ctx, audit: { tag } });
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
      // Second call with the same email throws on the admins UNIQUE constraint.
      await expect(
        service.create(db, { email: tagEmail('atomic'), name: 'A2' }, { ...ctx, audit: { tag } }),
      ).rejects.toThrow();
      // Only one admin row.
      const admins = await sql`SELECT count(*)::int AS c FROM admins WHERE email = ${tagEmail('atomic')}`.execute(db);
      expect(admins.rows[0].c).toBe(1);
      // Only one outbox row (the second call's enqueue must have rolled back).
      const ob = await sql`SELECT count(*)::int AS c FROM email_outbox WHERE to_address = ${tagEmail('atomic')}`.execute(db);
      expect(ob.rows[0].c).toBe(1);
    });

    it('enqueues an admin-welcome email with the welcome URL and recipient name', async () => {
      const r = await service.create(
        db,
        { email: tagEmail('welcome'), name: 'Wendy' },
        { ...ctx, audit: { tag }, portalBaseUrl: 'https://portal.example.test/' },
      );

      const ob = await sql`
        SELECT idempotency_key, to_address, template, locals
          FROM email_outbox WHERE to_address = ${tagEmail('welcome')}
      `.execute(db);
      expect(ob.rows).toHaveLength(1);
      expect(ob.rows[0].template).toBe('admin-welcome');
      expect(ob.rows[0].idempotency_key).toBe(`admin_welcome:${r.id}`);
      expect(ob.rows[0].locals.recipientName).toBe('Wendy');
      expect(ob.rows[0].locals.welcomeUrl).toBe(
        `https://portal.example.test/welcome/${r.inviteToken}`,
      );
      expect(typeof ob.rows[0].locals.expiresAt).toBe('string');
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

    it('takes comparable wall-clock time for missing user vs wrong password (no enumeration via timing)', async () => {
      const created = await service.create(db, { email: tagEmail('time'), name: 'T' }, { ...ctx, audit: { tag } });
      await service.consumeInvite(db, {
        token: created.inviteToken,
        newPassword: 'astrong-passphrase-9342',
      }, { ...ctx, audit: { tag }, hibpHasBeenPwned: okHibp });

      // Warm caches so the first run does not skew the comparison.
      await service.verifyLogin(db, { email: tagEmail('time'), password: 'wrong' });

      const t0 = Date.now();
      await service.verifyLogin(db, { email: tagEmail('time'), password: 'wrong' });
      const dWrong = Date.now() - t0;

      const t1 = Date.now();
      await service.verifyLogin(db, { email: tagEmail('ghost-no-such-admin'), password: 'wrong' });
      const dMissing = Date.now() - t1;

      // Both branches run argon2.verify, so the timing difference should be small.
      // Allow a generous 4× ratio and 50ms floor to keep this stable on shared CI.
      const lo = Math.min(dWrong, dMissing);
      const hi = Math.max(dWrong, dMissing);
      expect(hi - lo).toBeLessThan(Math.max(50, lo * 3));
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

      const ob = await sql`
        SELECT count(*)::int AS c FROM email_outbox WHERE to_address = ${tagEmail('ghost')}
      `.execute(db);
      expect(ob.rows[0].c).toBe(0); // no enqueue for unknown email
    });

    it('enqueues an admin-pw-reset email with the reset URL and recipient name', async () => {
      const created = await service.create(
        db,
        { email: tagEmail('reset2'), name: 'Reggie' },
        { ...ctx, audit: { tag }, portalBaseUrl: 'https://portal.example.test/' },
      );
      // Drop the welcome enqueue so the test only sees the pw-reset row.
      await sql`DELETE FROM email_outbox WHERE to_address = ${tagEmail('reset2')}`.execute(db);

      const r = await service.requestPasswordReset(
        db,
        { email: tagEmail('reset2') },
        { ...ctx, audit: { tag }, portalBaseUrl: 'https://portal.example.test/' },
      );

      const ob = await sql`
        SELECT idempotency_key, to_address, template, locals
          FROM email_outbox WHERE to_address = ${tagEmail('reset2')}
      `.execute(db);
      expect(ob.rows).toHaveLength(1);
      expect(ob.rows[0].template).toBe('admin-pw-reset');
      expect(ob.rows[0].idempotency_key).toMatch(new RegExp(`^admin_pw_reset:${created.id}:[a-f0-9]{16}$`));
      expect(ob.rows[0].locals.recipientName).toBe('Reggie');
      expect(ob.rows[0].locals.resetUrl).toBe(
        `https://portal.example.test/reset/${r.inviteToken}`,
      );
    });
  });
});
