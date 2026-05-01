import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import * as service from '../../../domain/customers/service.js';
import { hashPassword } from '../../../lib/crypto/hash.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customers/service verifyLogin', () => {
  let db;
  let kek;
  const tag = `cust_vl_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;
  const baseCtx = () => ({
    ip: '198.51.100.7',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  // Creates an active customer + user, then sets a known password hash.
  // Returns { customerId, userId, email }.
  async function makeActiveCustomer(slug, password) {
    const r = await service.create(db, {
      razonSocial: `${tag} ${slug} S.L.`,
      nif: 'B12345678',
      domicilio: 'Calle Test 1, 28001 Madrid',
      primaryUser: { name: slug, email: tagEmail(slug) },
    }, baseCtx());
    const hash = await hashPassword(password);
    await sql`
      UPDATE customer_users SET password_hash = ${hash}
       WHERE email = ${tagEmail(slug)}::citext
    `.execute(db);
    return { customerId: r.customerId, userId: r.primaryUserId, email: tagEmail(slug) };
  }

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

  it('returns the customer_user row for the correct password', async () => {
    const { userId } = await makeActiveCustomer('happy', 'correct-passphrase-1234');
    const r = await service.verifyLogin(db, { email: tagEmail('happy'), password: 'correct-passphrase-1234' });
    expect(r).not.toBeNull();
    expect(r.id).toBe(userId);
  });

  it('returns null for the wrong password', async () => {
    await makeActiveCustomer('wrongpw', 'correct-passphrase-1234');
    const r = await service.verifyLogin(db, { email: tagEmail('wrongpw'), password: 'wrong' });
    expect(r).toBeNull();
  });

  it('returns null for an unknown email', async () => {
    const r = await service.verifyLogin(db, { email: tagEmail('nobody'), password: 'anything' });
    expect(r).toBeNull();
  });

  it('returns null when password_hash is not yet set (user pre-welcome)', async () => {
    await service.create(db, {
      razonSocial: `${tag} prewelcome S.L.`,
      nif: 'B12345678',
      domicilio: 'Calle Test 1, 28001 Madrid',
      primaryUser: { name: 'prewelcome', email: tagEmail('prewelcome') },
    }, baseCtx());
    const r = await service.verifyLogin(db, { email: tagEmail('prewelcome'), password: 'anything' });
    expect(r).toBeNull();
  });

  it('returns null when customer is suspended', async () => {
    const { customerId } = await makeActiveCustomer('suspended', 'correct-passphrase-1234');
    await service.suspendCustomer(db, { customerId }, baseCtx());
    const r = await service.verifyLogin(db, { email: tagEmail('suspended'), password: 'correct-passphrase-1234' });
    expect(r).toBeNull();
  });

  it('takes comparable wall-clock time for missing user vs wrong password (timing safety)', async () => {
    await makeActiveCustomer('timingtest', 'correct-passphrase-1234');

    // Warm up argon2 to avoid JIT / cache cold-start skew.
    await service.verifyLogin(db, { email: tagEmail('timingtest'), password: 'wrong' });

    const t0 = Date.now();
    await service.verifyLogin(db, { email: tagEmail('timingtest'), password: 'wrong' });
    const dWrong = Date.now() - t0;

    const t1 = Date.now();
    await service.verifyLogin(db, { email: tagEmail('no-such-customer@example.test'), password: 'wrong' });
    const dMissing = Date.now() - t1;

    const lo = Math.min(dWrong, dMissing);
    const hi = Math.max(dWrong, dMissing);
    // Allow a generous 4× ratio and 50ms floor to keep this stable on shared CI.
    expect(hi - lo).toBeLessThan(Math.max(50, lo * 3));
  });
});
