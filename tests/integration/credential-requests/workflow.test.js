import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as crService from '../../../domain/credential-requests/service.js';
import * as crRepo from '../../../domain/credential-requests/repo.js';
import * as credentialsRepo from '../../../domain/credentials/repo.js';
import { unwrapDek, decrypt } from '../../../lib/crypto/envelope.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cr_workflow_${Date.now()}`;

describe.skipIf(skip)('credential-requests/service workflow (Task 7.4)', () => {
  let db;
  let kek;
  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.60',
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

  async function cleanup() {
    await sql`DELETE FROM credential_requests WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
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

  describe('createByAdmin', () => {
    it('persists an open request with custom fields, audits visible_to_customer', async () => {
      const adminId = await makeAdmin('create-happy');
      const { customerId } = await makeCustomer('create-happy-co');

      const r = await crService.createByAdmin(db, {
        adminId,
        customerId,
        provider: 'AWS production',
        fields: [
          { name: 'access_key_id', label: 'Access Key ID', type: 'text', required: true },
          { name: 'secret_access_key', label: 'Secret Access Key', type: 'secret', required: true },
        ],
      }, baseCtx());

      expect(r.requestId).toMatch(/^[0-9a-f-]{36}$/);

      const row = await crRepo.findCredentialRequestById(db, r.requestId);
      expect(row).not.toBeNull();
      expect(row.customer_id).toBe(customerId);
      expect(row.requested_by_admin_id).toBe(adminId);
      expect(row.provider).toBe('AWS production');
      expect(row.status).toBe('open');
      expect(row.fields).toEqual([
        { name: 'access_key_id', label: 'Access Key ID', type: 'text', required: true },
        { name: 'secret_access_key', label: 'Secret Access Key', type: 'secret', required: true },
      ]);
      expect(row.fulfilled_credential_id).toBeNull();
      expect(row.not_applicable_reason).toBeNull();

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, target_type, target_id::text AS target_id,
               metadata, visible_to_customer
          FROM audit_log
         WHERE action = 'credential_request.created' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      const a = audit.rows[0];
      expect(a.actor_type).toBe('admin');
      expect(a.actor_id).toBe(adminId);
      expect(a.target_type).toBe('credential_request');
      expect(a.target_id).toBe(r.requestId);
      expect(a.visible_to_customer).toBe(true);
      expect(a.metadata.customerId).toBe(customerId);
      expect(a.metadata.provider).toBe('AWS production');
      expect(a.metadata.fieldCount).toBe(2);
    });

    it('rejects empty provider, empty fields array, malformed field shape', async () => {
      const adminId = await makeAdmin('create-validation');
      const { customerId } = await makeCustomer('create-validation-co');

      await expect(
        crService.createByAdmin(db, {
          adminId, customerId, provider: '   ',
          fields: [{ name: 'x', label: 'X', type: 'text', required: true }],
        }, baseCtx()),
      ).rejects.toThrow(/provider/i);

      await expect(
        crService.createByAdmin(db, {
          adminId, customerId, provider: 'github', fields: [],
        }, baseCtx()),
      ).rejects.toThrow(/field/i);

      // Bad type.
      await expect(
        crService.createByAdmin(db, {
          adminId, customerId, provider: 'github',
          fields: [{ name: 'x', label: 'X', type: 'binary', required: true }],
        }, baseCtx()),
      ).rejects.toThrow(/type|field/i);

      // Missing required keys.
      await expect(
        crService.createByAdmin(db, {
          adminId, customerId, provider: 'github',
          fields: [{ label: 'No name', type: 'text', required: true }],
        }, baseCtx()),
      ).rejects.toThrow(/name|field/i);

      // Duplicate field names.
      await expect(
        crService.createByAdmin(db, {
          adminId, customerId, provider: 'github',
          fields: [
            { name: 'token', label: 'A', type: 'secret', required: true },
            { name: 'token', label: 'B', type: 'secret', required: true },
          ],
        }, baseCtx()),
      ).rejects.toThrow(/duplicate|unique|field/i);

      const c = await sql`SELECT count(*)::int AS c FROM credential_requests WHERE customer_id = ${customerId}::uuid`.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('refuses if customer is not active', async () => {
      const adminId = await makeAdmin('create-suspended');
      const { customerId } = await makeCustomer('create-suspended-co');
      await customersService.suspendCustomer(db, { customerId }, baseCtx());

      await expect(
        crService.createByAdmin(db, {
          adminId, customerId, provider: 'github',
          fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
        }, baseCtx()),
      ).rejects.toThrow(/active|suspended/i);
    });
  });

  describe('fulfilByCustomer (customer fills the request with their own values)', () => {
    it('encrypts payload with customer DEK, creates credential, flips status=fulfilled, links credential, double audit visible_to_customer', async () => {
      const adminId = await makeAdmin('fulfil-happy');
      const { customerId, primaryUserId } = await makeCustomer('fulfil-happy-co');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'github',
        fields: [
          { name: 'username', label: 'Username', type: 'text', required: true },
          { name: 'token', label: 'Token', type: 'secret', required: true },
        ],
      }, baseCtx());

      const r = await crService.fulfilByCustomer(db, {
        customerUserId: primaryUserId,
        requestId,
        payload: { username: 'alice', token: 'gh_xyz_payload' },
        label: 'GitHub CI',
      }, baseCtx());

      expect(r.requestId).toBe(requestId);
      expect(r.credentialId).toMatch(/^[0-9a-f-]{36}$/);

      // Request: status=fulfilled, fulfilled_credential_id linked.
      const row = await crRepo.findCredentialRequestById(db, requestId);
      expect(row.status).toBe('fulfilled');
      expect(row.fulfilled_credential_id).toBe(r.credentialId);

      // Credential: created_by='customer', encrypted with customer DEK.
      const cred = await credentialsRepo.findCredentialById(db, r.credentialId);
      expect(cred.created_by).toBe('customer');
      expect(cred.label).toBe('GitHub CI');
      expect(cred.provider).toBe('github');

      const c = await sql`SELECT dek_ciphertext, dek_iv, dek_tag FROM customers WHERE id = ${customerId}::uuid`.execute(db);
      const dek = unwrapDek({
        ciphertext: c.rows[0].dek_ciphertext, iv: c.rows[0].dek_iv, tag: c.rows[0].dek_tag,
      }, kek);
      const plaintext = decrypt({
        ciphertext: cred.payload_ciphertext, iv: cred.payload_iv, tag: cred.payload_tag,
      }, dek);
      expect(JSON.parse(plaintext.toString('utf8'))).toEqual({
        username: 'alice', token: 'gh_xyz_payload',
      });

      // Two audits, both customer-actor, both visible.
      const audCreated = await sql`
        SELECT actor_type, actor_id::text AS actor_id, visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'credential.created' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audCreated.rows).toHaveLength(1);
      expect(audCreated.rows[0].actor_type).toBe('customer');
      expect(audCreated.rows[0].actor_id).toBe(primaryUserId);
      expect(audCreated.rows[0].visible_to_customer).toBe(true);
      expect(audCreated.rows[0].metadata.requestId).toBe(requestId);
      expect(audCreated.rows[0].metadata.createdBy).toBe('customer');

      const audFulfilled = await sql`
        SELECT actor_type, actor_id::text AS actor_id, visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'credential_request.fulfilled' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audFulfilled.rows).toHaveLength(1);
      expect(audFulfilled.rows[0].actor_type).toBe('customer');
      expect(audFulfilled.rows[0].actor_id).toBe(primaryUserId);
      expect(audFulfilled.rows[0].visible_to_customer).toBe(true);
      expect(audFulfilled.rows[0].metadata.credentialId).toBe(r.credentialId);

      // Plaintext leakage check.
      const allMeta = JSON.stringify([
        audCreated.rows[0].metadata, audFulfilled.rows[0].metadata,
      ]);
      expect(allMeta).not.toContain('gh_xyz_payload');
    });

    it('rejects fulfilment if request is not open', async () => {
      const adminId = await makeAdmin('fulfil-closed');
      const { customerId, primaryUserId } = await makeCustomer('fulfil-closed-co');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'github',
        fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
      }, baseCtx());
      await sql`UPDATE credential_requests SET status = 'cancelled' WHERE id = ${requestId}::uuid`.execute(db);

      await expect(
        crService.fulfilByCustomer(db, {
          customerUserId: primaryUserId, requestId,
          payload: { token: 't' }, label: 'x',
        }, baseCtx()),
      ).rejects.toThrow(/open|status/i);
    });

    it('rejects cross-customer fulfilment (Bob cannot fulfil Alice\'s request)', async () => {
      const adminId = await makeAdmin('fulfil-cross');
      const a = await makeCustomer('alice');
      const b = await makeCustomer('bob');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId: a.customerId, provider: 'github',
        fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
      }, baseCtx());

      await expect(
        crService.fulfilByCustomer(db, {
          customerUserId: b.primaryUserId, requestId,
          payload: { token: 't' }, label: 'x',
        }, baseCtx()),
      ).rejects.toThrow();

      const row = await crRepo.findCredentialRequestById(db, requestId);
      expect(row.status).toBe('open');
    });

    it('rejects payload that does not satisfy the request\'s required fields', async () => {
      const adminId = await makeAdmin('fulfil-missing-required');
      const { customerId, primaryUserId } = await makeCustomer('fulfil-missing-required-co');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'github',
        fields: [
          { name: 'username', label: 'Username', type: 'text', required: true },
          { name: 'token', label: 'Token', type: 'secret', required: true },
        ],
      }, baseCtx());

      await expect(
        crService.fulfilByCustomer(db, {
          customerUserId: primaryUserId, requestId,
          payload: { username: 'alice' }, // token missing
          label: 'incomplete',
        }, baseCtx()),
      ).rejects.toThrow(/token|required|field/i);

      const row = await crRepo.findCredentialRequestById(db, requestId);
      expect(row.status).toBe('open');
    });
  });

  describe('markNotApplicableByCustomer', () => {
    it('flips status=not_applicable, stores reason, audits visible_to_customer, no credential created', async () => {
      const adminId = await makeAdmin('na-happy');
      const { customerId, primaryUserId } = await makeCustomer('na-happy-co');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'wp-engine',
        fields: [{ name: 'site_id', label: 'Site ID', type: 'text', required: true }],
      }, baseCtx());

      await crService.markNotApplicableByCustomer(db, {
        customerUserId: primaryUserId,
        requestId,
        reason: 'We migrated off WP Engine in March; no account exists anymore.',
      }, baseCtx());

      const row = await crRepo.findCredentialRequestById(db, requestId);
      expect(row.status).toBe('not_applicable');
      expect(row.not_applicable_reason).toBe('We migrated off WP Engine in March; no account exists anymore.');
      expect(row.fulfilled_credential_id).toBeNull();

      // No credential row was created.
      const c = await sql`SELECT count(*)::int AS c FROM credentials WHERE customer_id = ${customerId}::uuid`.execute(db);
      expect(c.rows[0].c).toBe(0);

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'credential_request.marked_not_applicable' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      const a = audit.rows[0];
      expect(a.actor_type).toBe('customer');
      expect(a.actor_id).toBe(primaryUserId);
      expect(a.visible_to_customer).toBe(true);
      expect(a.metadata.reason).toBe('We migrated off WP Engine in March; no account exists anymore.');
    });

    it('rejects empty reason — operator wants a reason on file for every NA transition', async () => {
      const adminId = await makeAdmin('na-noreason');
      const { customerId, primaryUserId } = await makeCustomer('na-noreason-co');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'github',
        fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
      }, baseCtx());

      await expect(
        crService.markNotApplicableByCustomer(db, {
          customerUserId: primaryUserId, requestId, reason: '   ',
        }, baseCtx()),
      ).rejects.toThrow(/reason/i);
    });

    it('rejects when request is not open', async () => {
      const adminId = await makeAdmin('na-closed');
      const { customerId, primaryUserId } = await makeCustomer('na-closed-co');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'github',
        fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
      }, baseCtx());
      await sql`UPDATE credential_requests SET status = 'fulfilled' WHERE id = ${requestId}::uuid`.execute(db);

      await expect(
        crService.markNotApplicableByCustomer(db, {
          customerUserId: primaryUserId, requestId, reason: 'too late',
        }, baseCtx()),
      ).rejects.toThrow(/open|status/i);
    });

    it('rejects cross-customer NA mark', async () => {
      const adminId = await makeAdmin('na-cross');
      const a = await makeCustomer('alice');
      const b = await makeCustomer('bob');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId: a.customerId, provider: 'github',
        fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
      }, baseCtx());

      await expect(
        crService.markNotApplicableByCustomer(db, {
          customerUserId: b.primaryUserId, requestId, reason: 'pwn',
        }, baseCtx()),
      ).rejects.toThrow();

      const row = await crRepo.findCredentialRequestById(db, requestId);
      expect(row.status).toBe('open');
    });
  });

  describe('cancelByAdmin', () => {
    it('flips status=cancelled and audits visible_to_customer', async () => {
      const adminId = await makeAdmin('cancel-happy');
      const { customerId } = await makeCustomer('cancel-happy-co');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'github',
        fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
      }, baseCtx());

      await crService.cancelByAdmin(db, { adminId, requestId }, baseCtx());

      const row = await crRepo.findCredentialRequestById(db, requestId);
      expect(row.status).toBe('cancelled');

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, visible_to_customer
          FROM audit_log
         WHERE action = 'credential_request.cancelled' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_type).toBe('admin');
      expect(audit.rows[0].actor_id).toBe(adminId);
      expect(audit.rows[0].visible_to_customer).toBe(true);
    });

    it('rejects cancelling a non-open request', async () => {
      const adminId = await makeAdmin('cancel-closed');
      const { customerId } = await makeCustomer('cancel-closed-co');
      const { requestId } = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'github',
        fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
      }, baseCtx());
      await sql`UPDATE credential_requests SET status = 'fulfilled' WHERE id = ${requestId}::uuid`.execute(db);

      await expect(
        crService.cancelByAdmin(db, { adminId, requestId }, baseCtx()),
      ).rejects.toThrow(/open|status/i);
    });
  });

  describe('list helpers', () => {
    it('listForCustomer returns the customer\'s requests with safe-to-render fields, no payload values', async () => {
      const adminId = await makeAdmin('list-cust');
      const { customerId, primaryUserId } = await makeCustomer('list-cust-co');
      const r1 = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'github',
        fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
      }, baseCtx());
      const r2 = await crService.createByAdmin(db, {
        adminId, customerId, provider: 'aws',
        fields: [{ name: 'access_key_id', label: 'AKID', type: 'text', required: true }],
      }, baseCtx());

      const list = await crRepo.listForCustomer(db, customerId);
      expect(list).toHaveLength(2);
      const ids = list.map((r) => r.id).sort();
      expect(ids).toEqual([r1.requestId, r2.requestId].sort());
      // Each entry includes provider + status + fields + created_at.
      for (const row of list) {
        expect(typeof row.provider).toBe('string');
        expect(['open', 'fulfilled', 'not_applicable', 'cancelled']).toContain(row.status);
        expect(Array.isArray(row.fields)).toBe(true);
        expect(row.created_at).toBeDefined();
      }
    });
  });
});
