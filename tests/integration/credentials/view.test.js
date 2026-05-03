import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import * as credentialsRepo from '../../../domain/credentials/repo.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_view_${Date.now()}`;

describe.skipIf(skip)('credentials/service view + markNeedsUpdate (admin-side)', () => {
  let db;
  let kek;
  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.20',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  async function makeAdmin(suffix) {
    const created = await adminsService.create(
      db,
      { email: `${tag}+${suffix}@example.com`, name: `Admin ${suffix}` },
      { actorType: 'system', audit: { tag } },
    );
    await adminsService.consumeInvite(
      db,
      { token: created.inviteToken, newPassword: 'admin-pw-shouldnt-matter-here-7283' },
      { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) },
    );
    return created.id;
  }

  async function makeCustomer(suffix) {
    return await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}-user@example.com` },
    }, baseCtx());
  }

  async function makeCredential({ customerId, customerUserId, payload, label = 'Test cred', provider = 'github' }) {
    return await credentialsService.createByCustomer(db, {
      customerId, customerUserId, provider, label, payload,
    }, baseCtx());
  }

  async function makeAdminSession(adminId, { stepped = true } = {}) {
    const sid = await createSession(db, { userType: 'admin', userId: adminId, ip: '198.51.100.20' });
    if (stepped) await stepUp(db, sid);
    return sid;
  }

  async function cleanup() {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  }

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.destroy();
  });

  beforeEach(async () => {
    await cleanup();
  });

  describe('view (admin, step-up required)', () => {
    it('returns the decrypted payload AND writes credential.viewed audit visible_to_customer (trust contract)', async () => {
      const adminId = await makeAdmin('viewer');
      const sid = await makeAdminSession(adminId);
      const { customerId, primaryUserId } = await makeCustomer('view-1');
      const created = await makeCredential({
        customerId,
        customerUserId: primaryUserId,
        provider: 'AWS production',
        label: 'Read-only IAM',
        payload: { access_key_id: 'AKIA-FOO', secret_access_key: 'verysecretvalue', region: 'eu-west-1' },
      });

      const r = await credentialsService.view(db, {
        adminId,
        sessionId: sid,
        credentialId: created.credentialId,
      }, baseCtx());

      expect(r.credentialId).toBe(created.credentialId);
      expect(r.provider).toBe('AWS production');
      expect(r.label).toBe('Read-only IAM');
      expect(r.payload).toEqual({
        access_key_id: 'AKIA-FOO',
        secret_access_key: 'verysecretvalue',
        region: 'eu-west-1',
      });

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, action, target_type, target_id::text AS target_id,
               metadata, visible_to_customer
          FROM audit_log
         WHERE action = 'credential.viewed' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      const a = audit.rows[0];
      expect(a.actor_type).toBe('admin');
      expect(a.actor_id).toBe(adminId);
      expect(a.target_type).toBe('credential');
      expect(a.target_id).toBe(created.credentialId);
      // The trust contract spelled out at spec §2.8: every admin view of a
      // customer credential is timestamped, attributed, and visible to that
      // customer in their activity feed. We persist it visible_to_customer.
      expect(a.visible_to_customer).toBe(true);
      expect(a.metadata.provider).toBe('AWS production');
      expect(a.metadata.label).toBe('Read-only IAM');
      // Plaintext payload values MUST NOT leak into audit metadata.
      expect(JSON.stringify(a.metadata)).not.toContain('verysecretvalue');
      expect(JSON.stringify(a.metadata)).not.toContain('AKIA-FOO');
    });

    it('refuses when session is not stepped up — no decrypt, no audit', async () => {
      const adminId = await makeAdmin('nostep');
      const sid = await makeAdminSession(adminId, { stepped: false });
      const { customerId, primaryUserId } = await makeCustomer('view-2');
      const created = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'CI', payload: { token: 'gh_xyz' },
      });

      await expect(
        credentialsService.view(db, {
          adminId, sessionId: sid, credentialId: created.credentialId,
        }, baseCtx()),
      ).rejects.toThrow(/step.?up/i);

      const audit = await sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE action = 'credential.viewed' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows[0].c).toBe(0);
    });

    it('refuses when vault-lock window has expired (>5 min idle since last credential touch)', async () => {
      const adminId = await makeAdmin('expired');
      const sid = await makeAdminSession(adminId);
      // The view gate is now vault-lock, not bare step-up: backdate the
      // vault timer beyond its 5-min sliding-idle window.
      await sql`UPDATE sessions SET vault_unlocked_at = now() - INTERVAL '6 minutes' WHERE id = ${sid}`.execute(db);

      const { customerId, primaryUserId } = await makeCustomer('view-3');
      const created = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'CI', payload: { token: 't' },
      });

      await expect(
        credentialsService.view(db, {
          adminId, sessionId: sid, credentialId: created.credentialId,
        }, baseCtx()),
      ).rejects.toThrow(/step.?up/i);
    });

    it('refuses unknown credential', async () => {
      const adminId = await makeAdmin('missing');
      const sid = await makeAdminSession(adminId);
      await expect(
        credentialsService.view(db, {
          adminId, sessionId: sid,
          credentialId: '00000000-0000-7000-8000-000000000000',
        }, baseCtx()),
      ).rejects.toThrow(/not found|credential/i);
    });

    it('writes a credential.decrypt_failure operator-forensic audit on corrupt ciphertext, throws DecryptFailureError, no credential.viewed audit', async () => {
      // Mirrors the M6 documents file_integrity_failure pattern (review I1):
      // tampered/corrupt ciphertext → forensic audit visible_to_customer=FALSE
      // → throw, so plaintext (or garbled bytes) NEVER reaches the client.
      const adminId = await makeAdmin('decrypt-fail');
      const sid = await makeAdminSession(adminId);
      const { customerId, primaryUserId } = await makeCustomer('decrypt-fail-co');
      const created = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'corruptable',
        payload: { token: 'original' },
      });

      // Tamper with the ciphertext at the column level. AES-GCM auth tag
      // verification will fail on read; we want to verify the service
      // (a) does not return plaintext, (b) writes the forensic audit,
      // (c) throws a typed DecryptFailureError.
      await sql`
        UPDATE credentials SET payload_ciphertext = ${Buffer.from('tamperedbytes-not-real-ciphertext')}
         WHERE id = ${created.credentialId}::uuid
      `.execute(db);

      await expect(
        credentialsService.view(db, {
          adminId, sessionId: sid, credentialId: created.credentialId,
        }, baseCtx()),
      ).rejects.toThrow(/decrypt|integrity/i);

      // Forensic audit IS written (operator-side stream, not customer-visible).
      const forensic = await sql`
        SELECT actor_type, actor_id::text AS actor_id, target_type, target_id::text AS target_id,
               metadata, visible_to_customer
          FROM audit_log
         WHERE action = 'credential.decrypt_failure' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(forensic.rows).toHaveLength(1);
      const f = forensic.rows[0];
      expect(f.actor_type).toBe('admin');
      expect(f.actor_id).toBe(adminId);
      expect(f.target_type).toBe('credential');
      expect(f.target_id).toBe(created.credentialId);
      // Operator-forensic: NOT visible to the customer activity feed.
      expect(f.visible_to_customer).toBe(false);
      expect(f.metadata.customerId).toBe(customerId);

      // No credential.viewed audit was written (the corrupt-vault view
      // path MUST NOT count toward the audit-visible-to-customer trust
      // contract — the customer was never shown anything).
      const viewed = await sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE action = 'credential.viewed' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(viewed.rows[0].c).toBe(0);
    });

    it('still requires kek (envelope encryption is enforced even if other guards pass)', async () => {
      const adminId = await makeAdmin('nokek');
      const sid = await makeAdminSession(adminId);
      const { customerId, primaryUserId } = await makeCustomer('view-4');
      const created = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'CI', payload: { token: 't' },
      });

      const ctx = baseCtx();
      delete ctx.kek;
      await expect(
        credentialsService.view(db, {
          adminId, sessionId: sid, credentialId: created.credentialId,
        }, ctx),
      ).rejects.toThrow(/kek/i);
    });
  });

  describe('markNeedsUpdate (admin)', () => {
    it('flips needs_update=TRUE and audits visible_to_customer', async () => {
      const adminId = await makeAdmin('needs');
      const { customerId, primaryUserId } = await makeCustomer('needs-1');
      const created = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'CI', payload: { token: 't' },
      });

      await credentialsService.markNeedsUpdate(db, {
        adminId,
        customerId,
        credentialId: created.credentialId,
      }, baseCtx());

      const row = await credentialsRepo.findCredentialById(db, created.credentialId);
      expect(row.needs_update).toBe(true);

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, action, target_id::text AS target_id, visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'credential.needs_update_marked' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      const a = audit.rows[0];
      expect(a.actor_type).toBe('admin');
      expect(a.actor_id).toBe(adminId);
      expect(a.target_id).toBe(created.credentialId);
      expect(a.visible_to_customer).toBe(true);
      expect(a.metadata.provider).toBe('github');
      expect(a.metadata.label).toBe('CI');
    });

    it('refuses unknown credential', async () => {
      const adminId = await makeAdmin('needs-missing');
      await expect(
        credentialsService.markNeedsUpdate(db, {
          adminId,
          credentialId: '00000000-0000-7000-8000-000000000000',
        }, baseCtx()),
      ).rejects.toThrow(/not found|credential/i);
    });

    it('rejects when customerId does not match the credential', async () => {
      const adminId = await makeAdmin('needs-cross');
      const a = await makeCustomer('needs-cross-a');
      const b = await makeCustomer('needs-cross-b');
      const created = await makeCredential({
        customerId: a.customerId, customerUserId: a.primaryUserId,
        provider: 'github', label: 'CI-cross', payload: { token: 't' },
      });

      await expect(
        credentialsService.markNeedsUpdate(db, {
          adminId,
          customerId: b.customerId,
          credentialId: created.credentialId,
        }, baseCtx()),
      ).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });

      const row = await credentialsRepo.findCredentialById(db, created.credentialId);
      expect(row.needs_update).toBe(false);
    });
  });
});
