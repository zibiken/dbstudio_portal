import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import { createSession } from '../../../lib/auth/session.js';
import { unlockVault } from '../../../lib/auth/vault-lock.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_customer_view_${Date.now()}`;

describe.skipIf(skip)('viewByCustomer (customer-side credential reveal)', () => {
  let app;
  let db;
  let kek;

  const baseCtx = () => ({
    actorType: 'customer',
    actorId: null,
    ip: '198.51.100.41',
    userAgentHash: 'uahash',
    audit: { tag },
    kek,
  });

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });

    // The customer fan-out helper iterates active admins. Make at least one
    // so the digest fan-out has a real audience.
    const created = await adminsService.create(
      db,
      { email: `${tag}+admin@example.com`, name: 'Test Admin' },
      { actorType: 'system', audit: { tag } },
    );
    await adminsService.consumeInvite(
      db,
      { token: created.inviteToken, newPassword: 'admin-pw-doesnt-matter-1234' },
      { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) },
    );
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    const cuIdsR = await sql`SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTestPollution(db, { recipientIds: cuIdsR.rows.map(r => r.id) });
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    const adminIdsR = await sql`SELECT id FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTestPollution(db, { recipientIds: adminIdsR.rows.map(r => r.id) });
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function makeCustomer(suffix) {
    return await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}-user@example.com` },
    }, baseCtx());
  }

  async function makeCredential(customerId, customerUserId, payload) {
    return await credentialsService.createByCustomer(db, {
      customerId, customerUserId,
      provider: 'github',
      label: 'cust-cred',
      payload,
    }, baseCtx());
  }

  it('throws StepUpRequiredError when vault is locked', async () => {
    const c = await makeCustomer('lock1');
    const cred = await makeCredential(c.customerId, c.primaryUserId, { token: 'abc' });
    const sid = await createSession(db, { userType: 'customer', userId: c.primaryUserId, ip: '198.51.100.41' });
    await expect(credentialsService.viewByCustomer(db, {
      customerUserId: c.primaryUserId,
      sessionId:      sid,
      credentialId:   cred.credentialId,
    }, { kek, audit: { tag } })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('decrypts payload + writes customer-actor audit + admin digest fan-out when vault unlocked', async () => {
    const c = await makeCustomer('ok1');
    const plain = 'secret-' + Date.now();
    const cred = await makeCredential(c.customerId, c.primaryUserId, { token: plain });
    const sid = await createSession(db, { userType: 'customer', userId: c.primaryUserId, ip: '198.51.100.41' });
    await unlockVault(db, sid);

    const r = await credentialsService.viewByCustomer(db, {
      customerUserId: c.primaryUserId,
      sessionId:      sid,
      credentialId:   cred.credentialId,
    }, { kek, ip: '198.51.100.41', audit: { tag } });
    expect(r.payload).toMatchObject({ token: plain });

    // Customer-actor audit row
    const auditR = await sql`
      SELECT actor_type, action, visible_to_customer
        FROM audit_log
       WHERE target_id = ${cred.credentialId}::uuid
         AND action = 'credential.viewed'
         AND metadata->>'tag' = ${tag}
       ORDER BY ts DESC
       LIMIT 1
    `.execute(db);
    expect(auditR.rows[0].actor_type).toBe('customer');
    expect(auditR.rows[0].visible_to_customer).toBe(true);

    // Digest fan-out: admin recipients only (not the customer who acted).
    const digestR = await sql`
      SELECT recipient_type FROM pending_digest_items
        WHERE event_type = 'credential.viewed'
          AND customer_id = ${c.customerId}::uuid
    `.execute(db);
    expect(digestR.rows.length).toBeGreaterThan(0);
    expect(digestR.rows.every((row) => row.recipient_type === 'admin')).toBe(true);
  });

  it('refuses cross-customer access', async () => {
    const a = await makeCustomer('xa');
    const b = await makeCustomer('xb');
    const credB = await makeCredential(b.customerId, b.primaryUserId, { token: 'xyz' });
    const sid = await createSession(db, { userType: 'customer', userId: a.primaryUserId, ip: '198.51.100.41' });
    await unlockVault(db, sid);
    await expect(credentialsService.viewByCustomer(db, {
      customerUserId: a.primaryUserId,
      sessionId:      sid,
      credentialId:   credB.credentialId,
    }, { kek, audit: { tag } })).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
  });
});
