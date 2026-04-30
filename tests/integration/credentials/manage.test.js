import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import * as credentialsRepo from '../../../domain/credentials/repo.js';
import { unwrapDek, decrypt } from '../../../lib/crypto/envelope.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_manage_${Date.now()}`;

// Both admin AND customer can edit/delete a credential. Every admin
// edit/delete is audited visible_to_customer (trust contract: spec §2.8).
// Admin edit additionally requires step-up — they're overwriting a
// known-good payload and the customer should have assurance the change
// was intentional and recent-2FA-confirmed.
describe.skipIf(skip)('credentials/service edit + admin-delete (both actors)', () => {
  let db;
  let kek;
  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.40',
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
      { token: created.inviteToken, newPassword: 'admin-pw-shouldnt-matter-7283' },
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

  async function makeAdminSession(adminId, { stepped = true } = {}) {
    const sid = await createSession(db, { userType: 'admin', userId: adminId, ip: '198.51.100.40' });
    if (stepped) await stepUp(db, sid);
    return sid;
  }

  async function makeCredential({ customerId, customerUserId, payload, label = 'Test cred', provider = 'github' }) {
    return await credentialsService.createByCustomer(db, {
      customerId, customerUserId, provider, label, payload,
    }, baseCtx());
  }

  async function decryptCredentialPayload(db, customerId, credentialId) {
    const c = await sql`SELECT dek_ciphertext, dek_iv, dek_tag FROM customers WHERE id = ${customerId}::uuid`.execute(db);
    const cred = await credentialsRepo.findCredentialById(db, credentialId);
    const dek = unwrapDek({
      ciphertext: c.rows[0].dek_ciphertext,
      iv: c.rows[0].dek_iv,
      tag: c.rows[0].dek_tag,
    }, kek);
    const plaintext = decrypt({
      ciphertext: cred.payload_ciphertext,
      iv: cred.payload_iv,
      tag: cred.payload_tag,
    }, dek);
    return JSON.parse(plaintext.toString('utf8'));
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

  describe('updateByCustomer (label + payload, customer)', () => {
    it('re-encrypts payload with the customer DEK, updates label, audits visible_to_customer', async () => {
      const { customerId, primaryUserId } = await makeCustomer('upd-cust-happy');
      const cred = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'Original', payload: { token: 'old-token' },
      });

      await credentialsService.updateByCustomer(db, {
        customerUserId: primaryUserId,
        credentialId: cred.credentialId,
        label: 'Renamed',
        payload: { token: 'new-token', extra: 'note' },
      }, baseCtx());

      const row = await credentialsRepo.findCredentialById(db, cred.credentialId);
      expect(row.label).toBe('Renamed');
      expect(row.needs_update).toBe(false);

      // Roundtrip via the customer's DEK confirms the new payload is in.
      const decrypted = await decryptCredentialPayload(db, customerId, cred.credentialId);
      expect(decrypted).toEqual({ token: 'new-token', extra: 'note' });

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, target_id::text AS target_id, visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'credential.updated' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      const a = audit.rows[0];
      expect(a.actor_type).toBe('customer');
      expect(a.actor_id).toBe(primaryUserId);
      expect(a.target_id).toBe(cred.credentialId);
      expect(a.visible_to_customer).toBe(true);
      expect(a.metadata.label).toBe('Renamed');
      expect(a.metadata.previousLabel).toBe('Original');
      expect(a.metadata.payloadChanged).toBe(true);
      // No plaintext leakage.
      expect(JSON.stringify(a.metadata)).not.toContain('new-token');
      expect(JSON.stringify(a.metadata)).not.toContain('old-token');
    });

    it('label-only edit does not require payload, sets payloadChanged=false', async () => {
      const { customerId, primaryUserId } = await makeCustomer('upd-cust-label');
      const cred = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'Before', payload: { token: 'keep' },
      });

      await credentialsService.updateByCustomer(db, {
        customerUserId: primaryUserId,
        credentialId: cred.credentialId,
        label: 'After',
      }, baseCtx());

      const row = await credentialsRepo.findCredentialById(db, cred.credentialId);
      expect(row.label).toBe('After');

      // Payload unchanged: original ciphertext bytes intact, DEK roundtrip stable.
      const decrypted = await decryptCredentialPayload(db, customerId, cred.credentialId);
      expect(decrypted).toEqual({ token: 'keep' });

      const audit = await sql`
        SELECT metadata FROM audit_log
         WHERE action = 'credential.updated' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].metadata.payloadChanged).toBe(false);
    });

    it('payload-only edit clears needs_update flag (the customer fulfilled the admin\'s ask)', async () => {
      const { customerId, primaryUserId } = await makeCustomer('upd-cust-clearnu');
      const cred = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'Stale', payload: { token: 'old' },
      });
      // Simulate an admin earlier flagging this for re-entry.
      await sql`UPDATE credentials SET needs_update = TRUE WHERE id = ${cred.credentialId}::uuid`.execute(db);

      await credentialsService.updateByCustomer(db, {
        customerUserId: primaryUserId,
        credentialId: cred.credentialId,
        payload: { token: 'fresh' },
      }, baseCtx());

      const row = await credentialsRepo.findCredentialById(db, cred.credentialId);
      expect(row.needs_update).toBe(false);
    });

    it('refuses no-op (neither label nor payload supplied)', async () => {
      const { customerId, primaryUserId } = await makeCustomer('upd-cust-noop');
      const cred = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'x', payload: { token: 'x' },
      });

      await expect(
        credentialsService.updateByCustomer(db, {
          customerUserId: primaryUserId,
          credentialId: cred.credentialId,
        }, baseCtx()),
      ).rejects.toThrow(/label|payload|nothing/i);
    });

    it('refuses cross-customer edit (Bob cannot edit Alice\'s credential)', async () => {
      const a = await makeCustomer('alice');
      const b = await makeCustomer('bob');
      const aliceCred = await credentialsService.createByCustomer(db, {
        customerId: a.customerId, customerUserId: a.primaryUserId,
        provider: 'github', label: 'Alice', payload: { token: 'a' },
      }, baseCtx());

      await expect(
        credentialsService.updateByCustomer(db, {
          customerUserId: b.primaryUserId,
          credentialId: aliceCred.credentialId,
          label: 'pwned',
        }, baseCtx()),
      ).rejects.toThrow();

      const row = await credentialsRepo.findCredentialById(db, aliceCred.credentialId);
      expect(row.label).toBe('Alice');
    });

    it('refuses unknown credentialId', async () => {
      const { primaryUserId } = await makeCustomer('upd-cust-missing');
      await expect(
        credentialsService.updateByCustomer(db, {
          customerUserId: primaryUserId,
          credentialId: '00000000-0000-7000-8000-000000000000',
          label: 'x',
        }, baseCtx()),
      ).rejects.toThrow(/not found|credential/i);
    });
  });

  describe('updateByAdmin (label + payload, admin, step-up required)', () => {
    it('re-encrypts payload with the customer DEK, updates label, clears needs_update, audits visible_to_customer', async () => {
      const adminId = await makeAdmin('upd-admin-happy');
      const sid = await makeAdminSession(adminId);
      const { customerId, primaryUserId } = await makeCustomer('upd-admin-happy-co');
      const cred = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'AWS', label: 'Stale prod', payload: { secret_access_key: 'old-secret' },
      });
      await sql`UPDATE credentials SET needs_update = TRUE WHERE id = ${cred.credentialId}::uuid`.execute(db);

      await credentialsService.updateByAdmin(db, {
        adminId,
        sessionId: sid,
        credentialId: cred.credentialId,
        label: 'Fresh prod',
        payload: { secret_access_key: 'rotated-secret' },
      }, baseCtx());

      const row = await credentialsRepo.findCredentialById(db, cred.credentialId);
      expect(row.label).toBe('Fresh prod');
      expect(row.needs_update).toBe(false);

      const decrypted = await decryptCredentialPayload(db, customerId, cred.credentialId);
      expect(decrypted).toEqual({ secret_access_key: 'rotated-secret' });

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'credential.updated' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      const a = audit.rows[0];
      expect(a.actor_type).toBe('admin');
      expect(a.actor_id).toBe(adminId);
      expect(a.visible_to_customer).toBe(true);
      expect(a.metadata.label).toBe('Fresh prod');
      expect(a.metadata.previousLabel).toBe('Stale prod');
      expect(a.metadata.payloadChanged).toBe(true);
      expect(JSON.stringify(a.metadata)).not.toContain('rotated-secret');
      expect(JSON.stringify(a.metadata)).not.toContain('old-secret');
    });

    it('refuses without step-up — no write, no audit', async () => {
      const adminId = await makeAdmin('upd-admin-nostep');
      const sid = await makeAdminSession(adminId, { stepped: false });
      const { customerId, primaryUserId } = await makeCustomer('upd-admin-nostep-co');
      const cred = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'Original', payload: { token: 't' },
      });

      await expect(
        credentialsService.updateByAdmin(db, {
          adminId, sessionId: sid,
          credentialId: cred.credentialId,
          label: 'pwned', payload: { token: 'gotcha' },
        }, baseCtx()),
      ).rejects.toThrow(/step.?up/i);

      const row = await credentialsRepo.findCredentialById(db, cred.credentialId);
      expect(row.label).toBe('Original');
      const audit = await sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE action = 'credential.updated' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows[0].c).toBe(0);
    });

    it('refuses no-op (neither label nor payload supplied)', async () => {
      const adminId = await makeAdmin('upd-admin-noop');
      const sid = await makeAdminSession(adminId);
      const { customerId, primaryUserId } = await makeCustomer('upd-admin-noop-co');
      const cred = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'x', payload: { token: 'x' },
      });

      await expect(
        credentialsService.updateByAdmin(db, {
          adminId, sessionId: sid, credentialId: cred.credentialId,
        }, baseCtx()),
      ).rejects.toThrow(/label|payload|nothing/i);
    });

    it('refuses unknown credentialId', async () => {
      const adminId = await makeAdmin('upd-admin-missing');
      const sid = await makeAdminSession(adminId);
      await expect(
        credentialsService.updateByAdmin(db, {
          adminId, sessionId: sid,
          credentialId: '00000000-0000-7000-8000-000000000000',
          label: 'x',
        }, baseCtx()),
      ).rejects.toThrow(/not found|credential/i);
    });
  });

  describe('deleteByAdmin', () => {
    it('removes the credential, audits visible_to_customer (trust contract), no step-up required for delete', async () => {
      const adminId = await makeAdmin('del-admin-happy');
      const { customerId, primaryUserId } = await makeCustomer('del-admin-happy-co');
      const cred = await makeCredential({
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'Killable', payload: { token: 't' },
      });

      await credentialsService.deleteByAdmin(db, {
        adminId,
        credentialId: cred.credentialId,
      }, baseCtx());

      const row = await credentialsRepo.findCredentialById(db, cred.credentialId);
      expect(row).toBeNull();

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, target_id::text AS target_id, visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'credential.deleted' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      const a = audit.rows[0];
      expect(a.actor_type).toBe('admin');
      expect(a.actor_id).toBe(adminId);
      expect(a.target_id).toBe(cred.credentialId);
      expect(a.visible_to_customer).toBe(true);
      expect(a.metadata.provider).toBe('github');
      expect(a.metadata.label).toBe('Killable');
    });

    it('refuses unknown credentialId', async () => {
      const adminId = await makeAdmin('del-admin-missing');
      await expect(
        credentialsService.deleteByAdmin(db, {
          adminId,
          credentialId: '00000000-0000-7000-8000-000000000000',
        }, baseCtx()),
      ).rejects.toThrow(/not found|credential/i);
    });
  });
});
