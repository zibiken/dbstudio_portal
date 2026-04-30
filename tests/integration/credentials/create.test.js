import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import * as credentialsRepo from '../../../domain/credentials/repo.js';
import { unwrapDek, decrypt } from '../../../lib/crypto/envelope.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_create_${Date.now()}`;

describe.skipIf(skip)('credentials/service create + delete (customer-side)', () => {
  let db;
  let kek;
  let createdCustomerIds = [];

  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.10',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  async function makeCustomer(suffix) {
    const r = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, baseCtx());
    createdCustomerIds.push(r.customerId);
    return r;
  }

  async function cleanup() {
    await sql`DELETE FROM credentials WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
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
    createdCustomerIds = [];
    await cleanup();
  });

  describe('createByCustomer', () => {
    it('encrypts payload with the customer DEK, persists, returns id, audits visible_to_customer', async () => {
      const { customerId, primaryUserId } = await makeCustomer('happy');

      const r = await credentialsService.createByCustomer(db, {
        customerId,
        customerUserId: primaryUserId,
        provider: 'Combell',
        label: 'Hosting control panel',
        payload: { username: 'me@example.com', password: 'p@ssw0rd!', notes: 'shared with ops' },
      }, baseCtx());

      expect(r.credentialId).toMatch(/^[0-9a-f-]{36}$/);

      const row = await credentialsRepo.findCredentialById(db, r.credentialId);
      expect(row).not.toBeNull();
      expect(row.customer_id).toBe(customerId);
      expect(row.provider).toBe('Combell');
      expect(row.label).toBe('Hosting control panel');
      expect(row.created_by).toBe('customer');
      expect(row.needs_update).toBe(false);
      expect(Buffer.isBuffer(row.payload_ciphertext)).toBe(true);
      expect(Buffer.isBuffer(row.payload_iv)).toBe(true);
      expect(row.payload_iv.length).toBe(12);
      expect(Buffer.isBuffer(row.payload_tag)).toBe(true);
      expect(row.payload_tag.length).toBe(16);

      // Plaintext password is NOT in the ciphertext bytes (sanity).
      expect(row.payload_ciphertext.includes(Buffer.from('p@ssw0rd!'))).toBe(false);

      // Roundtrip via the customer's DEK proves the envelope is the spec's
      // two-tier (KEK → DEK → payload) and that the right DEK is used.
      const c = await sql`
        SELECT dek_ciphertext, dek_iv, dek_tag FROM customers WHERE id = ${customerId}::uuid
      `.execute(db);
      const dek = unwrapDek({
        ciphertext: c.rows[0].dek_ciphertext,
        iv: c.rows[0].dek_iv,
        tag: c.rows[0].dek_tag,
      }, kek);
      const plaintext = decrypt({
        ciphertext: row.payload_ciphertext,
        iv: row.payload_iv,
        tag: row.payload_tag,
      }, dek);
      expect(JSON.parse(plaintext.toString('utf8'))).toEqual({
        username: 'me@example.com',
        password: 'p@ssw0rd!',
        notes: 'shared with ops',
      });

      // Audit: customer-attributed, visible_to_customer=true, label + provider in metadata.
      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, action, target_type, target_id::text AS target_id,
               metadata, visible_to_customer
          FROM audit_log
         WHERE action = 'credential.created' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      const a = audit.rows[0];
      expect(a.actor_type).toBe('customer');
      expect(a.actor_id).toBe(primaryUserId);
      expect(a.target_type).toBe('credential');
      expect(a.target_id).toBe(r.credentialId);
      expect(a.visible_to_customer).toBe(true);
      expect(a.metadata.provider).toBe('Combell');
      expect(a.metadata.label).toBe('Hosting control panel');
      // Trust contract: payload values MUST NOT leak into audit metadata.
      expect(JSON.stringify(a.metadata)).not.toContain('p@ssw0rd!');
    });

    it('rejects when ctx.kek is missing or wrong length, no row inserted', async () => {
      const { customerId, primaryUserId } = await makeCustomer('nokek');
      const ctx = baseCtx();
      delete ctx.kek;
      await expect(
        credentialsService.createByCustomer(db, {
          customerId,
          customerUserId: primaryUserId,
          provider: 'github',
          label: 'CI access',
          payload: { token: 'gh_xyz' },
        }, ctx),
      ).rejects.toThrow(/kek/i);

      const c = await sql`SELECT count(*)::int AS c FROM credentials WHERE customer_id = ${customerId}::uuid`.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('rejects empty provider, empty label, non-object payload, array payload', async () => {
      const { customerId, primaryUserId } = await makeCustomer('validation');

      await expect(
        credentialsService.createByCustomer(db, {
          customerId, customerUserId: primaryUserId,
          provider: '   ', label: 'x', payload: { k: 'v' },
        }, baseCtx()),
      ).rejects.toThrow(/provider/i);

      await expect(
        credentialsService.createByCustomer(db, {
          customerId, customerUserId: primaryUserId,
          provider: 'github', label: '', payload: { k: 'v' },
        }, baseCtx()),
      ).rejects.toThrow(/label/i);

      await expect(
        credentialsService.createByCustomer(db, {
          customerId, customerUserId: primaryUserId,
          provider: 'github', label: 'x', payload: 'not-an-object',
        }, baseCtx()),
      ).rejects.toThrow(/payload/i);

      await expect(
        credentialsService.createByCustomer(db, {
          customerId, customerUserId: primaryUserId,
          provider: 'github', label: 'x', payload: ['a', 'b'],
        }, baseCtx()),
      ).rejects.toThrow(/payload/i);

      await expect(
        credentialsService.createByCustomer(db, {
          customerId, customerUserId: primaryUserId,
          provider: 'github', label: 'x', payload: null,
        }, baseCtx()),
      ).rejects.toThrow(/payload/i);

      const c = await sql`SELECT count(*)::int AS c FROM credentials WHERE customer_id = ${customerId}::uuid`.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('rejects when the customer is not active (suspended / archived / missing)', async () => {
      const { customerId, primaryUserId } = await makeCustomer('suspended');
      await customersService.suspendCustomer(db, { customerId }, baseCtx());

      await expect(
        credentialsService.createByCustomer(db, {
          customerId, customerUserId: primaryUserId,
          provider: 'github', label: 'x', payload: { k: 'v' },
        }, baseCtx()),
      ).rejects.toThrow(/suspended|active/i);

      // Missing customer.
      await expect(
        credentialsService.createByCustomer(db, {
          customerId: '00000000-0000-7000-8000-000000000000',
          customerUserId: primaryUserId,
          provider: 'github', label: 'x', payload: { k: 'v' },
        }, baseCtx()),
      ).rejects.toThrow(/not found|customer/i);
    });

    it('rejects when customerUserId does not belong to the customer (cross-tenant trap)', async () => {
      const a = await makeCustomer('alice');
      const b = await makeCustomer('bob');

      // Bob's primary user trying to write under Alice's customer_id.
      await expect(
        credentialsService.createByCustomer(db, {
          customerId: a.customerId,
          customerUserId: b.primaryUserId,
          provider: 'github', label: 'x', payload: { k: 'v' },
        }, baseCtx()),
      ).rejects.toThrow(/customer/i);

      const c = await sql`SELECT count(*)::int AS c FROM credentials WHERE customer_id = ${a.customerId}::uuid`.execute(db);
      expect(c.rows[0].c).toBe(0);
    });
  });

  describe('delete (customer-initiated)', () => {
    it('removes the credential row and audits visible_to_customer', async () => {
      const { customerId, primaryUserId } = await makeCustomer('del-happy');
      const created = await credentialsService.createByCustomer(db, {
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: 'CI access', payload: { token: 'gh_xyz' },
      }, baseCtx());

      await credentialsService.deleteByCustomer(db, {
        customerUserId: primaryUserId,
        credentialId: created.credentialId,
      }, baseCtx());

      const row = await credentialsRepo.findCredentialById(db, created.credentialId);
      expect(row).toBeNull();

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, target_type, target_id::text AS target_id,
               visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'credential.deleted' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_type).toBe('customer');
      expect(audit.rows[0].actor_id).toBe(primaryUserId);
      expect(audit.rows[0].target_id).toBe(created.credentialId);
      expect(audit.rows[0].visible_to_customer).toBe(true);
      expect(audit.rows[0].metadata.provider).toBe('github');
      expect(audit.rows[0].metadata.label).toBe('CI access');
    });

    it('refuses cross-customer delete (Bob tries to delete Alice\'s credential)', async () => {
      const a = await makeCustomer('alice2');
      const b = await makeCustomer('bob2');

      const aliceCred = await credentialsService.createByCustomer(db, {
        customerId: a.customerId, customerUserId: a.primaryUserId,
        provider: 'github', label: 'Alice CI', payload: { token: 'a' },
      }, baseCtx());

      await expect(
        credentialsService.deleteByCustomer(db, {
          customerUserId: b.primaryUserId,
          credentialId: aliceCred.credentialId,
        }, baseCtx()),
      ).rejects.toThrow();

      const row = await credentialsRepo.findCredentialById(db, aliceCred.credentialId);
      expect(row).not.toBeNull();
    });

    it('throws on unknown credentialId', async () => {
      const { primaryUserId } = await makeCustomer('del-missing');
      await expect(
        credentialsService.deleteByCustomer(db, {
          customerUserId: primaryUserId,
          credentialId: '00000000-0000-7000-8000-000000000000',
        }, baseCtx()),
      ).rejects.toThrow(/not found|credential/i);
    });
  });
});
