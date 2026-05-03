// Route-level integration tests for routes/admin/credential-requests.js.
// Service-layer behaviour is covered in workflow.test.js; these tests
// exercise the HTTP surface: auth gate, CSRF, UUID validation, cross-
// customer 404s, the typed-error → safe-copy mapping, and the redirect.
//
// Mirrors tests/integration/phases/routes.test.js shape.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as crService from '../../../domain/credential-requests/service.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cradminroutes_${Date.now()}`;

function parseSetCookies(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((line) => {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1) };
  });
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function mergeCookies(jar, res) {
  for (const c of parseSetCookies(res)) jar[c.name] = c.value;
}
function extractInputValue(html, name) {
  const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']+)["']`);
  const m = html.match(re);
  return m ? m[1] : null;
}
function urlencoded(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

describe.skipIf(skip)('admin credential-requests routes (HTTP)', () => {
  let app, db, env, kek, customerAId, customerBId;
  const adminTag = `${tag}_admin`;
  const baseCtx = () => ({
    actorType: 'system',
    actorId: null,
    ip: '198.51.100.60',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });

    const a = await customersService.create(db, {
      razonSocial: `${tag} A S.L.`,
      primaryUser: { name: 'User A', email: `${tag}+a@example.com` },
    }, baseCtx());
    customerAId = a.customerId;

    const b = await customersService.create(db, {
      razonSocial: `${tag} B S.L.`,
      primaryUser: { name: 'User B', email: `${tag}+b@example.com` },
    }, baseCtx());
    customerBId = b.customerId;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await sql`DELETE FROM credential_requests WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'} OR to_address LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (
      SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}
      UNION SELECT id FROM admins WHERE email LIKE ${adminTag + '%'}
    )`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + adminTag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM pending_digest_items WHERE metadata->>'tag' = ${tag}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function loginAdmin(suffix) {
    const password = 'admin-pw-928374-strong';
    const created = await adminsService.create(
      db,
      { email: `${adminTag}+${suffix}@example.com`, name: `Admin ${suffix}` },
      { actorType: 'system', audit: { tag } },
    );
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
    await adminsService.consumeInvite(db, {
      token: created.inviteToken, newPassword: password,
    }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    await adminsService.enroll2faTotp(db, {
      adminId: created.id, secret: enrolSecret, kek: app.kek,
    }, { audit: { tag } });

    const jar = {};
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, lGet);
    const lCsrf = extractInputValue(lGet.body, '_csrf');
    const lOk = await app.inject({
      method: 'POST', url: '/login',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ email: `${adminTag}+${suffix}@example.com`, password, _csrf: lCsrf }),
    });
    expect(lOk.statusCode).toBe(302);
    mergeCookies(jar, lOk);
    const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(jar) } });
    mergeCookies(jar, cGet);
    const cCsrf = extractInputValue(cGet.body, '_csrf');
    const cOk = await app.inject({
      method: 'POST', url: '/login/2fa',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ method: 'totp', totp_code: generateToken(enrolSecret), _csrf: cCsrf }),
    });
    expect(cOk.statusCode).toBe(302);
    mergeCookies(jar, cOk);
    return { jar, adminId: created.id };
  }

  async function csrfFromDetail(jar, customerId, requestId) {
    const r = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/credential-requests/${requestId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(r.statusCode).toBe(200);
    mergeCookies(jar, r);
    const csrf = extractInputValue(r.body, '_csrf');
    expect(csrf).toBeTruthy();
    return csrf;
  }

  async function postForm(jar, url, fields, { csrf } = {}) {
    return app.inject({
      method: 'POST',
      url,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      payload: urlencoded(fields),
    });
  }

  async function makeRequest(customerId, adminId, suffix = 'p') {
    const r = await crService.createByAdmin(db, {
      adminId, customerId, provider: `prov-${suffix}`,
      fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
    }, baseCtx());
    return r.requestId;
  }

  it('GET /admin/customers/:cid/credential-requests requires admin session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerAId}/credential-requests`,
    });
    expect([302, 401]).toContain(res.statusCode);
  });

  it('POST /:cid/credential-requests/:id/cancel without CSRF returns 403', async () => {
    const { jar, adminId } = await loginAdmin('csrf');
    const requestId = await makeRequest(customerAId, adminId, 'csrf');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerAId}/credential-requests/${requestId}/cancel`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({}),
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /:cid/credential-requests/:id 404s when id is malformed', async () => {
    const { jar } = await loginAdmin('baduuid');
    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerAId}/credential-requests/not-a-uuid`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('GET /:cid/credential-requests/:id 404s when id belongs to a different customer', async () => {
    const { jar, adminId } = await loginAdmin('crosscust');
    const requestId = await makeRequest(customerAId, adminId, 'cross');
    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerBId}/credential-requests/${requestId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /:cid/credential-requests/:id/cancel happy-path 302 to detail', async () => {
    const { jar, adminId } = await loginAdmin('happy');
    const requestId = await makeRequest(customerAId, adminId, 'happy');
    const csrf = await csrfFromDetail(jar, customerAId, requestId);
    const res = await postForm(jar,
      `/admin/customers/${customerAId}/credential-requests/${requestId}/cancel`,
      { _csrf: csrf }, { csrf });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `/admin/customers/${customerAId}/credential-requests/${requestId}`,
    );
    const row = await sql`
      SELECT status FROM credential_requests WHERE id = ${requestId}::uuid
    `.execute(db);
    expect(row.rows[0].status).toBe('cancelled');
  });

  it('POST cancel maps CREDENTIAL_REQUEST_NOT_OPEN to safe copy (422, not raw err.message)', async () => {
    const { jar, adminId } = await loginAdmin('notopen');
    const requestId = await makeRequest(customerAId, adminId, 'notopen');
    // Grab a valid CSRF while the request is still 'open' (the detail
    // page only renders the cancel form for open requests). Then flip
    // status to drive the typed-error mapping path.
    const csrf = await csrfFromDetail(jar, customerAId, requestId);
    await sql`UPDATE credential_requests SET status = 'fulfilled' WHERE id = ${requestId}::uuid`.execute(db);
    const res = await postForm(jar,
      `/admin/customers/${customerAId}/credential-requests/${requestId}/cancel`,
      { _csrf: csrf }, { csrf });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('That credential request is not open.');
    expect(res.body).not.toMatch(/CredentialRequestNotOpen/);
  });
});
