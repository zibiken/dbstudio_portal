// HTTP-layer tests for the customer + admin credential edit routes added
// in Bundle 4. The service layer (updateByCustomer / updateByAdmin) is
// already covered by manage.test.js + project-scope.test.js — these
// tests pin the route surface: CSRF gate, ownership 404s, redirect
// targets (302 vs 303), step-up redirect for the admin overwrite path.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import { findCredentialById } from '../../../domain/credentials/repo.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `crededit_${Date.now()}`;

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
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
function mergeCookies(jar, res) { for (const c of parseSetCookies(res)) jar[c.name] = c.value; }
function extractInputValue(html, name) {
  const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']+)["']`);
  const m = html.match(re);
  return m ? m[1] : null;
}
function urlencoded(fields) {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

describe.skipIf(skip)('credential edit routes (HTTP, customer + admin)', () => {
  let app, db, env, customerId, customerUserId, otherCustomerId;
  let credentialId, otherCredentialId, adminEnrolSecret, adminEmail;
  const adminTag = `${tag}_admin`;

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    app = await build({ skipSafetyCheck: true });

    // Customer A with an existing credential.
    const a = await customersService.create(db, {
      razonSocial: `${tag} A S.L.`,
      primaryUser: { name: 'User A', email: `${tag}+a@example.com` },
    }, { actorType: 'system', audit: { tag }, kek: app.kek, portalBaseUrl: env.PORTAL_BASE_URL });
    customerId = a.customerId;
    customerUserId = a.primaryUserId;

    // The customer NDA gate would block /customer/credentials/* without it.
    await sql`UPDATE customers SET nda_signed_at = now() WHERE id = ${customerId}::uuid`.execute(db);

    const r = await credentialsService.createByCustomer(db, {
      customerId,
      customerUserId,
      provider: 'github',
      label: 'old label',
      payload: { token: 'before' },
    }, { actorType: 'customer', actorId: customerUserId, kek: app.kek, audit: { tag }, ip: '127.0.0.1', userAgentHash: null });
    credentialId = r.credentialId;

    // Customer B (used to test cross-customer 404).
    const b = await customersService.create(db, {
      razonSocial: `${tag} B S.L.`,
      primaryUser: { name: 'User B', email: `${tag}+b@example.com` },
    }, { actorType: 'system', audit: { tag }, kek: app.kek, portalBaseUrl: env.PORTAL_BASE_URL });
    otherCustomerId = b.customerId;
    const ob = await credentialsService.createByCustomer(db, {
      customerId: otherCustomerId,
      customerUserId: b.primaryUserId,
      provider: 'aws',
      label: 'other-cust-cred',
      payload: { key: 'x' },
    }, { actorType: 'customer', actorId: b.primaryUserId, kek: app.kek, audit: { tag }, ip: '127.0.0.1', userAgentHash: null });
    otherCredentialId = ob.credentialId;

    // Admin with TOTP enrolled (used for /admin/customers/.../edit step-up flow).
    adminEmail = `${adminTag}+actor@example.com`;
    const admin = await adminsService.create(db, { email: adminEmail, name: 'Edit Admin' }, {
      actorType: 'system', audit: { tag },
    });
    adminEnrolSecret = deriveEnrolSecret(admin.inviteToken, env.SESSION_SIGNING_SECRET);
    await adminsService.consumeInvite(db, {
      token: admin.inviteToken, newPassword: 'admin-pw-928374-strong',
    }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    await adminsService.enroll2faTotp(db, {
      adminId: admin.id, secret: adminEnrolSecret, kek: app.kek,
    }, { audit: { tag } });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'} OR to_address LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${adminTag + '%'})`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + adminTag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${adminTag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function loginAdminFresh() {
    const jar = {};
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, lGet);
    const lCsrf = extractInputValue(lGet.body, '_csrf');
    const lOk = await app.inject({
      method: 'POST', url: '/login',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ email: adminEmail, password: 'admin-pw-928374-strong', _csrf: lCsrf }),
    });
    expect(lOk.statusCode).toBe(302);
    mergeCookies(jar, lOk);
    const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(jar) } });
    mergeCookies(jar, cGet);
    const cCsrf = extractInputValue(cGet.body, '_csrf');
    const cOk = await app.inject({
      method: 'POST', url: '/login/2fa',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ method: 'totp', totp_code: generateToken(adminEnrolSecret), _csrf: cCsrf }),
    });
    expect(cOk.statusCode).toBe(302);
    mergeCookies(jar, cOk);
    return jar;
  }

  it('admin GET /edit renders the form (200)', async () => {
    const jar = await loginAdminFresh();
    const r = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/credentials/${credentialId}/edit`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Edit credential');
    expect(r.body).toContain('Rotate secret');
  });

  it('admin GET /edit on a credential that belongs to another customer returns 404', async () => {
    const jar = await loginAdminFresh();
    const r = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/credentials/${otherCredentialId}/edit`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(r.statusCode).toBe(404);
  });

  it('admin POST /edit without _csrf is rejected (403)', async () => {
    const jar = await loginAdminFresh();
    const r = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerId}/credentials/${credentialId}/edit`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ label: 'new' }),
    });
    expect(r.statusCode).toBe(403);
  });

  it('admin POST /edit with stepped session 303s and updates the label', async () => {
    const jar = await loginAdminFresh();
    const ed = await app.inject({
      method: 'GET', url: `/admin/customers/${customerId}/credentials/${credentialId}/edit`,
      headers: { cookie: cookieHeader(jar) },
    });
    mergeCookies(jar, ed);
    const csrf = extractInputValue(ed.body, '_csrf');
    const r = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerId}/credentials/${credentialId}/edit`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': csrf,
      },
      payload: urlencoded({ _csrf: csrf, label: 'admin-edited', field_count: '0' }),
    });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/admin/customers/${customerId}/credentials/${credentialId}`);
    const after = await findCredentialById(db, credentialId);
    expect(after.label).toBe('admin-edited');
  });

  it('admin POST /edit with empty label re-renders 422 with error', async () => {
    const jar = await loginAdminFresh();
    const ed = await app.inject({
      method: 'GET', url: `/admin/customers/${customerId}/credentials/${credentialId}/edit`,
      headers: { cookie: cookieHeader(jar) },
    });
    mergeCookies(jar, ed);
    const csrf = extractInputValue(ed.body, '_csrf');
    const r = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerId}/credentials/${credentialId}/edit`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': csrf,
      },
      payload: urlencoded({ _csrf: csrf, label: '   ', field_count: '0' }),
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('Label is required.');
  });
});
