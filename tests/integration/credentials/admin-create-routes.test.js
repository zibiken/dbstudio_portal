import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_admin_routes_${Date.now()}`;

describe.skipIf(skip)('admin add-credential routes', () => {
  let app, db, kek;
  const ctx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.40',
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

  async function makeCustomer(suffix) {
    return await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `U ${suffix}`, email: `${tag}+${suffix}-cu@example.com` },
    }, ctx());
  }

  async function makeAdminWithUnlockedSession(suffix) {
    const created = await adminsService.create(db, { email: `${tag}+${suffix}-a@example.com`, name: `A ${suffix}` }, { actorType: 'system', audit: { tag } });
    await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'a-pw-shouldnt-matter-12345' }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    const sid = await createSession(db, { userType: 'admin', userId: created.id, ip: '198.51.100.40' });
    await stepUp(db, sid); // also sets vault_unlocked_at
    return { adminId: created.id, signed: app.signCookie(sid), sid };
  }

  async function makeAdminLockedSession(suffix) {
    const created = await adminsService.create(db, { email: `${tag}+${suffix}-a@example.com`, name: `A ${suffix}` }, { actorType: 'system', audit: { tag } });
    await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'a-pw-shouldnt-matter-12345' }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    const sid = await createSession(db, { userType: 'admin', userId: created.id, ip: '198.51.100.40' });
    await stepUp(db, sid);
    // stepUp() also sets vault_unlocked_at; clear it to simulate the
    // 5-min idle re-lock state.
    await sql`UPDATE sessions SET vault_unlocked_at = NULL WHERE id = ${sid}`.execute(db);
    return { adminId: created.id, signed: app.signCookie(sid), sid };
  }

  function cookiesFromRes(res) {
    const setCookie = res.headers['set-cookie'];
    if (!setCookie) return '';
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    return arr.map(c => c.split(';')[0]).join('; ');
  }

  it('POST /admin/customers/:id/credentials creates a cred and 303s to detail', async () => {
    const c = await makeCustomer('happy');
    const { signed } = await makeAdminWithUnlockedSession('rt');

    const csrfRes = await app.inject({
      method: 'GET',
      url: `/admin/customers/${c.customerId}/credentials/new`,
      headers: { cookie: 'sid=' + signed },
    });
    expect(csrfRes.statusCode).toBe(200);
    const csrfToken = (csrfRes.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    expect(csrfToken).toBeTruthy();
    const csrfCookies = cookiesFromRes(csrfRes);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${c.customerId}/credentials`,
      headers: { cookie: 'sid=' + signed + (csrfCookies ? '; ' + csrfCookies : ''), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrfToken,
        provider: 'aws',
        label: 'AWS prod root',
        project_id: '',
        field_count: '1',
        field_name_0: 'access_key_id',
        field_value_0: 'AKIA-' + Date.now(),
      }).toString(),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(new RegExp(`^/admin/customers/${c.customerId}/credentials/[0-9a-f-]{36}$`));
  });

  it('GET /admin/customers/:id/credentials/new redirects to step-up when vault locked', async () => {
    const c = await makeCustomer('locked');
    const { signed } = await makeAdminLockedSession('lc');
    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${c.customerId}/credentials/new`,
      headers: { cookie: 'sid=' + signed },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/admin\/step-up\?return=/);
  });

  it('POST without provider re-renders with 422 + error', async () => {
    const c = await makeCustomer('val');
    const { signed } = await makeAdminWithUnlockedSession('vl');
    const csrfRes = await app.inject({
      method: 'GET',
      url: `/admin/customers/${c.customerId}/credentials/new`,
      headers: { cookie: 'sid=' + signed },
    });
    const csrfToken = (csrfRes.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const csrfCookies = cookiesFromRes(csrfRes);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${c.customerId}/credentials`,
      headers: { cookie: 'sid=' + signed + (csrfCookies ? '; ' + csrfCookies : ''), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrfToken,
        provider: '',
        label: 'L',
        field_count: '1',
        field_name_0: 'k',
        field_value_0: 'v',
      }).toString(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/Provider is required/);
  });
});
