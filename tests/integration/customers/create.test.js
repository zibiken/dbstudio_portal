import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import * as service from '../../../domain/customers/service.js';
import { findCustomerById } from '../../../domain/customers/repo.js';
import { unwrapDek } from '../../../lib/crypto/envelope.js';

const skip = !process.env.RUN_DB_TESTS;
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;

describe.skipIf(skip)('customers/service', () => {
  let db;
  let kek;
  const tag = `cust_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;
  const baseCtx = () => ({
    ip: '198.51.100.7',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE action LIKE 'customer.%' AND metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    // Clearing tagged audit rows lets the atomicity test count exactly the
    // rows produced by its own create calls instead of accumulating them
    // across the file. audit_log has an append-only trigger; cycle it.
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE action LIKE 'customer.%' AND metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
  });

  describe('create', () => {
    it('persists a customer with wrapped DEK + first user with hashed invite token; returns plaintext token', async () => {
      const r = await service.create(db, {
        razonSocial: `${tag} S.L.`,
        nif: 'B12345678',
        domicilio: 'Calle Falsa 123, 38001 Santa Cruz de Tenerife',
        primaryUser: { name: 'Customer One', email: tagEmail('a') },
      }, baseCtx());

      expect(r.customerId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.primaryUserId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.inviteToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

      const customer = await findCustomerById(db, r.customerId);
      expect(customer).not.toBeNull();
      expect(customer.status).toBe('active');
      expect(customer.razon_social).toBe(`${tag} S.L.`);
      expect(customer.nif).toBe('B12345678');
      expect(customer.domicilio).toBe('Calle Falsa 123, 38001 Santa Cruz de Tenerife');

      // Wrapped DEK is AES-256-GCM: 32-byte plaintext → 32-byte ciphertext +
      // 12-byte IV + 16-byte tag. unwrap with the same KEK gives back 32B.
      expect(Buffer.isBuffer(customer.dek_ciphertext)).toBe(true);
      expect(Buffer.isBuffer(customer.dek_iv)).toBe(true);
      expect(Buffer.isBuffer(customer.dek_tag)).toBe(true);
      expect(customer.dek_ciphertext.length).toBe(32);
      expect(customer.dek_iv.length).toBe(12);
      expect(customer.dek_tag.length).toBe(16);

      const dek = unwrapDek({
        ciphertext: customer.dek_ciphertext,
        iv: customer.dek_iv,
        tag: customer.dek_tag,
      }, kek);
      expect(dek.length).toBe(32);

      // customer_users: invite plumbing matches admins shape.
      const userRows = await sql`
        SELECT id, email, name, password_hash, invite_token_hash,
               invite_consumed_at, invite_expires_at
          FROM customer_users WHERE customer_id = ${r.customerId}::uuid
      `.execute(db);
      expect(userRows.rows).toHaveLength(1);
      const user = userRows.rows[0];
      expect(user.id).toBe(r.primaryUserId);
      expect(user.email).toBe(tagEmail('a'));
      expect(user.name).toBe('Customer One');
      expect(user.password_hash).toBeNull();
      expect(user.invite_token_hash).not.toBeNull();
      expect(user.invite_token_hash).not.toBe(r.inviteToken);
      expect(user.invite_consumed_at).toBeNull();
      const expiresMs = new Date(user.invite_expires_at).getTime();
      const drift = Math.abs(expiresMs - (Date.now() + SEVEN_DAYS_MS));
      expect(drift).toBeLessThan(60_000);

      // Audit row attributes the create to the customer (target_type='customer').
      const audit = await sql`
        SELECT action, target_type, target_id, metadata
          FROM audit_log
         WHERE action = 'customer.created' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].target_type).toBe('customer');
      expect(audit.rows[0].target_id).toBe(r.customerId);

      // Outbox: customer-invitation with the plaintext invite URL in locals.
      const ob = await sql`
        SELECT idempotency_key, to_address, template, locals
          FROM email_outbox WHERE to_address = ${tagEmail('a')}
      `.execute(db);
      expect(ob.rows).toHaveLength(1);
      expect(ob.rows[0].template).toBe('customer-invitation');
      expect(ob.rows[0].idempotency_key).toBe(`customer_welcome:${r.customerId}`);
      expect(ob.rows[0].locals.recipientName).toBe('Customer One');
      expect(ob.rows[0].locals.inviteUrl).toBe(
        `https://portal.example.test/customer/welcome/${r.inviteToken}`,
      );
      expect(typeof ob.rows[0].locals.expiresAt).toBe('string');
    });

    it('throws if ctx.kek is missing or not a 32-byte Buffer (no silent skip, no partial state)', async () => {
      const ctx = baseCtx();
      delete ctx.kek;
      await expect(
        service.create(db, {
          razonSocial: `${tag} no-kek S.L.`,
          primaryUser: { name: 'K', email: tagEmail('nokek') },
        }, ctx),
      ).rejects.toThrow(/kek/i);

      // Wrong-length buffer is also rejected — guards against accidental
      // 16-byte / 64-byte / hex-string KEKs at boot wiring time.
      const tooShort = baseCtx();
      tooShort.kek = randomBytes(16);
      await expect(
        service.create(db, {
          razonSocial: `${tag} short-kek S.L.`,
          primaryUser: { name: 'K', email: tagEmail('shortkek') },
        }, tooShort),
      ).rejects.toThrow(/kek/i);

      const c = await sql`
        SELECT count(*)::int AS c FROM customers WHERE razon_social LIKE ${tag + '%kek%'}
      `.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('throws if neither ctx.portalBaseUrl nor PORTAL_BASE_URL env is set (no silent skip, no partial state)', async () => {
      const saved = process.env.PORTAL_BASE_URL;
      delete process.env.PORTAL_BASE_URL;
      try {
        const ctx = baseCtx();
        delete ctx.portalBaseUrl;
        await expect(
          service.create(db, {
            razonSocial: `${tag} strict S.L.`,
            primaryUser: { name: 'S', email: tagEmail('strict') },
          }, ctx),
        ).rejects.toThrow(/portalBaseUrl/);

        const c = await sql`
          SELECT count(*)::int AS c FROM customers WHERE razon_social = ${tag + ' strict S.L.'}
        `.execute(db);
        expect(c.rows[0].c).toBe(0);
        const u = await sql`
          SELECT count(*)::int AS c FROM customer_users WHERE email = ${tagEmail('strict')}
        `.execute(db);
        expect(u.rows[0].c).toBe(0);
      } finally {
        if (saved !== undefined) process.env.PORTAL_BASE_URL = saved;
      }
    });

    it('customer + customer_user + audit + outbox commit atomically (rollback on duplicate user email)', async () => {
      const r = await service.create(db, {
        razonSocial: `${tag} atomic-1 S.L.`,
        primaryUser: { name: 'A', email: tagEmail('atomic') },
      }, baseCtx());
      expect(r.customerId).toMatch(/^[0-9a-f-]{36}$/);

      // Second call collides on customer_users.email UNIQUE inside the
      // transaction, AFTER the customers INSERT has already happened.
      // Everything must roll back: no second customers row, no second
      // outbox row, no second audit row.
      await expect(
        service.create(db, {
          razonSocial: `${tag} atomic-2 S.L.`,
          primaryUser: { name: 'A2', email: tagEmail('atomic') },
        }, baseCtx()),
      ).rejects.toThrow();

      const customers = await sql`
        SELECT count(*)::int AS c FROM customers WHERE razon_social LIKE ${tag + ' atomic-%'}
      `.execute(db);
      expect(customers.rows[0].c).toBe(1);

      const users = await sql`
        SELECT count(*)::int AS c FROM customer_users WHERE email = ${tagEmail('atomic')}
      `.execute(db);
      expect(users.rows[0].c).toBe(1);

      const ob = await sql`
        SELECT count(*)::int AS c FROM email_outbox WHERE to_address = ${tagEmail('atomic')}
      `.execute(db);
      expect(ob.rows[0].c).toBe(1);

      const audit = await sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE action = 'customer.created' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows[0].c).toBe(1);
    });
  });
});
