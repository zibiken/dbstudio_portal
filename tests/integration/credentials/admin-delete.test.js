import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_admin_del_${Date.now()}`;

function cookiesFromRes(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr.map(c => c.split(';')[0]).join('; ');
}

describe.skipIf(skip)('credentials admin delete', () => {
  let app, db, kek;
  const ctx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.50',
    userAgentHash: 'h',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
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
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    const userIdsR = await sql`SELECT id FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await pruneTestPollution(db, { recipientIds: userIdsR.rows.map(r => r.id) });
    const adminIdsR = await sql`SELECT id FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTestPollution(db, { recipientIds: adminIdsR.rows.map(r => r.id) });
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function makeFixture(suffix) {
    const c = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `U ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, ctx());
    const created = await adminsService.create(db, { email: `${tag}+${suffix}-a@example.com`, name: `A ${suffix}` }, { actorType: 'system', audit: { tag } });
    await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'a-pw-shouldnt-matter-12345' }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    const sid = await createSession(db, { userType: 'admin', userId: created.id, ip: '198.51.100.50' });
    await stepUp(db, sid);
    const cred = await credentialsService.createByAdmin(db, {
      adminId: created.id, customerId: c.customerId, provider: 'wp', label: 'wp', payload: { x: '1' },
    }, ctx());
    return { customerId: c.customerId, credentialId: cred.credentialId, adminId: created.id, signed: app.signCookie(sid) };
  }

  async function csrfFromAddForm(signed, customerId) {
    const r = await app.inject({ method: 'GET', url: `/admin/customers/${customerId}/credentials/new`, headers: { cookie: 'sid=' + signed } });
    expect(r.statusCode).toBe(200);
    const token = (r.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    expect(token).toBeTruthy();
    return { token, cookies: cookiesFromRes(r) };
  }

  it('removes the credential and writes a customer-visible audit row', async () => {
    const f = await makeFixture('happy');
    const { token, cookies } = await csrfFromAddForm(f.signed, f.customerId);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${f.customerId}/credentials/${f.credentialId}/delete`,
      headers: { cookie: 'sid=' + f.signed + (cookies ? '; ' + cookies : ''), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: token }).toString(),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/admin/customers/${f.customerId}/credentials`);

    const after = await sql`SELECT id FROM credentials WHERE id = ${f.credentialId}::uuid`.execute(db);
    expect(after.rows).toHaveLength(0);

    const audit = await sql`SELECT action, visible_to_customer, actor_type FROM audit_log WHERE target_id = ${f.credentialId}::uuid AND action = 'credential.deleted'`.execute(db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_type).toBe('admin');
    expect(audit.rows[0].visible_to_customer).toBe(true);
  });

  it('404s when credId does not belong to URL customer', async () => {
    const a = await makeFixture('xa');
    const b = await makeFixture('xb');
    const { token, cookies } = await csrfFromAddForm(a.signed, a.customerId);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${a.customerId}/credentials/${b.credentialId}/delete`,
      headers: { cookie: 'sid=' + a.signed + (cookies ? '; ' + cookies : ''), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: token }).toString(),
    });
    expect(res.statusCode).toBe(404);
  });
});
