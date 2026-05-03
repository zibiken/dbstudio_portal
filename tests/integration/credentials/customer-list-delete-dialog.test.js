import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_cust_dlg_${Date.now()}`;

describe.skipIf(skip)('GET /customer/credentials renders confirm-dialog for delete', () => {
  let app, db, kek;
  const ctx = () => ({
    actorType: 'system',
    audit: { tag },
    ip: '198.51.100.1',
    userAgentHash: 'h',
    portalBaseUrl: 'https://portal.example.test/',
    kek,
  });

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}))`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    const userIdsR = await sql`SELECT id FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await pruneTestPollution(db, { recipientIds: userIdsR.rows.map(r => r.id) });
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  it('renders the new _confirm-dialog (no clipped Delete <label>… summary)', async () => {
    const c = await customersService.create(db, {
      razonSocial: `${tag} Co S.L.`,
      primaryUser: { name: 'U', email: `${tag}+u@example.com` },
    }, ctx());
    await credentialsService.createByCustomer(db, {
      customerId: c.customerId,
      customerUserId: c.primaryUserId,
      provider: 'hosting',
      label: 'Hosting Credentials',
      payload: { user: 'x', password: 'y' },
    }, ctx());
    await sql`UPDATE customers SET nda_signed_at = now() WHERE id = ${c.customerId}::uuid`.execute(db);

    const sid = await createSession(db, { userType: 'customer', userId: c.primaryUserId, ip: '198.51.100.1' });
    await stepUp(db, sid);
    const signed = app.signCookie(sid);

    const res = await app.inject({
      method: 'GET',
      url: '/customer/credentials',
      headers: { cookie: 'sid=' + signed },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/data-confirm-dialog/);
    expect(res.body).toMatch(/<summary class="btn btn--danger btn--sm"[^>]*>\s*\n?\s*Delete\s*\n?\s*<\/summary>/);
    expect(res.body).not.toMatch(/Delete Hosting Credentials…/);
  });
});
