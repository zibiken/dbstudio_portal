// Route-level integration tests for routes/customer/credential-requests.js.
// Service-layer behaviour is covered in workflow.test.js; these tests
// exercise the customer-side HTTP surface: auth gate, NDA gate, CSRF,
// UUID validation, cross-customer 404s, and the fulfil happy-path.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as crService from '../../../domain/credential-requests/service.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `crcustroutes_${Date.now()}`;

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

describe.skipIf(skip)('customer credential-requests routes (HTTP)', () => {
  let app, db, env, kek, adminId;
  const adminTag = `${tag}_admin`;
  const baseCtx = () => ({
    actorType: 'system',
    actorId: null,
    ip: '198.51.100.7',
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

    const created = await adminsService.create(
      db,
      { email: `${adminTag}+a@example.com`, name: 'Admin A' },
      { actorType: 'system', audit: { tag } },
    );
    await adminsService.consumeInvite(db, {
      token: created.inviteToken, newPassword: 'admin-pw-928374-strong',
    }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    adminId = created.id;
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
    await sql`DELETE FROM admins WHERE email LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM pending_digest_items WHERE metadata->>'tag' = ${tag}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function makeCustomer(suffix) {
    return await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, baseCtx());
  }

  // Drives a customer from invite to a stepped-up session by calling
  // completeCustomerWelcome directly and seating its returned sid as the
  // session cookie (mirrors tests/integration/documents/download.test.js).
  async function loginCustomer({ customerId, inviteToken }) {
    const r = await customersService.completeCustomerWelcome(db, {
      token: inviteToken,
      newPassword: 'customer-pw-928374-strong',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      kek,
      sessionIp: '198.51.100.7',
      sessionDeviceFingerprint: null,
    }, { hibpHasBeenPwned: vi.fn(async () => false), audit: { tag } });

    // Clear NDA gate so credential-request routes return their actual
    // status code rather than the /customer/waiting redirect.
    await sql`UPDATE customers SET nda_signed_at = now() WHERE id = ${customerId}::uuid`.execute(db);

    const signed = app.signCookie(r.sid);
    return { jar: { sid: signed }, customerUserId: r.customerUserId };
  }

  async function makeRequestForCustomer(customerId, suffix = 'p') {
    const r = await crService.createByAdmin(db, {
      adminId, customerId, provider: `prov-${suffix}`,
      fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
    }, baseCtx());
    return r.requestId;
  }

  it('GET /customer/credential-requests requires customer session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/customer/credential-requests',
    });
    expect([302, 401]).toContain(res.statusCode);
  });

  it('POST /:id/fulfil without CSRF returns 403', async () => {
    const cust = await makeCustomer('csrf');
    const { jar } = await loginCustomer({ customerId: cust.customerId, inviteToken: cust.inviteToken });
    const requestId = await makeRequestForCustomer(cust.customerId, 'csrf');
    const res = await app.inject({
      method: 'POST',
      url: `/customer/credential-requests/${requestId}/fulfil`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ field__token: 'x' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /:id 404s when id is malformed', async () => {
    const cust = await makeCustomer('baduuid');
    const { jar } = await loginCustomer({ customerId: cust.customerId, inviteToken: cust.inviteToken });
    const res = await app.inject({
      method: 'GET',
      url: '/customer/credential-requests/not-a-uuid',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('GET /:id 404s when request belongs to a different customer', async () => {
    const a = await makeCustomer('cross-a');
    const b = await makeCustomer('cross-b');
    const { jar } = await loginCustomer({ customerId: a.customerId, inviteToken: a.inviteToken });
    const requestId = await makeRequestForCustomer(b.customerId, 'cross-other');
    const res = await app.inject({
      method: 'GET',
      url: `/customer/credential-requests/${requestId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /:id/fulfil happy-path 302 to detail and creates credential', async () => {
    const cust = await makeCustomer('happy');
    const { jar } = await loginCustomer({ customerId: cust.customerId, inviteToken: cust.inviteToken });
    const requestId = await makeRequestForCustomer(cust.customerId, 'happy');

    const detail = await app.inject({
      method: 'GET',
      url: `/customer/credential-requests/${requestId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(detail.statusCode).toBe(200);
    mergeCookies(jar, detail);
    const csrf = extractInputValue(detail.body, '_csrf');
    expect(csrf).toBeTruthy();

    const res = await app.inject({
      method: 'POST',
      url: `/customer/credential-requests/${requestId}/fulfil`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': csrf,
      },
      payload: urlencoded({ _csrf: csrf, label: 'My token', field__token: 'gh_secret_xyz' }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/customer/credential-requests/${requestId}`);

    const reqRow = await sql`
      SELECT status FROM credential_requests WHERE id = ${requestId}::uuid
    `.execute(db);
    expect(reqRow.rows[0].status).toBe('fulfilled');
    const credRow = await sql`
      SELECT count(*)::int AS c FROM credentials WHERE customer_id = ${cust.customerId}::uuid
    `.execute(db);
    expect(credRow.rows[0].c).toBe(1);
  });
});
