import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import * as service from '../../../domain/customers/service.js';
import { listCustomers } from '../../../domain/customers/repo.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customers/repo — listCustomers', () => {
  let db;
  let kek;
  const tag = `list_test_${Date.now()}`;
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
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE action LIKE 'customer.%' AND metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
  });

  // Each test seeds 2-3 customers with distinctive razón social / NIF / contact
  // name / contact email so the search matrix can match exactly one without
  // interference. The tag prefix keeps every row isolated to this test file.
  async function seedThree() {
    const acme = await service.create(db, {
      razonSocial: `${tag} Acme S.L.`,
      nif: 'B11111111',
      domicilio: 'Calle Acme 1',
      primaryUser: { name: 'Alice Anderson', email: tagEmail('alice') },
    }, baseCtx());
    const beta = await service.create(db, {
      razonSocial: `${tag} Beta Industries`,
      nif: 'B22222222',
      domicilio: 'Calle Beta 2',
      primaryUser: { name: 'Bob Bauer', email: tagEmail('bob') },
    }, baseCtx());
    const gamma = await service.create(db, {
      razonSocial: `${tag} Gamma Group`,
      nif: 'B33333333',
      domicilio: 'Calle Gamma 3',
      primaryUser: { name: 'Carol Chen', email: tagEmail('carol') },
    }, baseCtx());
    return { acme, beta, gamma };
  }

  function tagged(rows) {
    // Restrict assertions to this test file's seeded customers — other tests
    // running concurrently in the same DB might leave rows behind.
    return rows.filter((r) => r.razon_social && r.razon_social.startsWith(tag));
  }

  it('matches by razón social substring (regression — was the only previous match key)', async () => {
    await seedThree();
    const { rows, total } = await listCustomers(db, { q: 'Beta' });
    const ours = tagged(rows);
    expect(ours).toHaveLength(1);
    expect(ours[0].razon_social).toContain('Beta Industries');
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('matches by contact email substring across customer_users', async () => {
    await seedThree();
    // Use the per-test unique tag so we hit exactly one customer's primary user.
    const { rows } = await listCustomers(db, { q: tagEmail('bob') });
    const ours = tagged(rows);
    expect(ours).toHaveLength(1);
    expect(ours[0].razon_social).toContain('Beta Industries');
  });

  it('matches by contact name substring across customer_users', async () => {
    await seedThree();
    const { rows } = await listCustomers(db, { q: 'Carol Chen' });
    const ours = tagged(rows);
    expect(ours).toHaveLength(1);
    expect(ours[0].razon_social).toContain('Gamma Group');
  });

  it('does not duplicate a customer that has multiple matching users', async () => {
    const { acme } = await seedThree();
    // Append a second user on Acme whose name ALSO matches "Alice". The
    // EXISTS-based search must keep the customer row at one-per-customer.
    const { v7: uuidv7 } = await import('uuid');
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (${uuidv7()}::uuid, ${acme.customerId}::uuid, ${tagEmail('alice2')}, 'Alice Adamski')
    `.execute(db);
    const { rows, total } = await listCustomers(db, { q: 'Alice' });
    const ours = tagged(rows);
    // Despite two matching users (Alice Anderson + Alice Adamski) on the same
    // customer, the customer appears exactly once.
    expect(ours).toHaveLength(1);
    expect(ours[0].razon_social).toContain('Acme S.L.');
    // total counts customers, not user-matches.
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('returns all this test\'s customers when q is empty', async () => {
    await seedThree();
    const { rows } = await listCustomers(db, { q: '', limit: 100 });
    const ours = tagged(rows);
    expect(ours).toHaveLength(3);
  });

  it('surfaces primary_contact_name and primary_contact_email on each row', async () => {
    await seedThree();
    const { rows } = await listCustomers(db, { q: tag });
    const ours = tagged(rows);
    const acme = ours.find((r) => r.razon_social.includes('Acme'));
    expect(acme).toBeTruthy();
    expect(acme.primary_contact_name).toBe('Alice Anderson');
    expect(acme.primary_contact_email).toBe(tagEmail('alice'));
  });

  it('handles a customer with zero customer_users (defensive — service.create always seeds one, but the LEFT JOIN must not drop the row)', async () => {
    const { v7: uuidv7 } = await import('uuid');
    const id = uuidv7();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (${id}::uuid, ${tag + ' Empty Co'}, '\\x'::bytea, '\\x'::bytea, '\\x'::bytea)
    `.execute(db);
    const { rows } = await listCustomers(db, { q: 'Empty Co' });
    const ours = tagged(rows);
    expect(ours).toHaveLength(1);
    expect(ours[0].primary_contact_name).toBeNull();
    expect(ours[0].primary_contact_email).toBeNull();
  });
});
