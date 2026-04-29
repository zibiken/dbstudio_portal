import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `admcust_test_${Date.now()}`;
const tagEmail = (s) => `${tag}+${s}@example.com`;

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

async function loginAdminFully(app, db, env, suffix, password = 'admin-pw-928374-strong') {
  // Driver: drive admin to a fully-authenticated, stepped-up session.
  const created = await adminsService.create(
    db,
    { email: tagEmail(suffix), name: `Admin ${suffix}` },
    { actorType: 'system', audit: { tag } },
  );
  const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
  await adminsService.consumeInvite(
    db,
    { token: created.inviteToken, newPassword: password },
    { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) },
  );
  await adminsService.enroll2faTotp(
    db,
    { adminId: created.id, secret: enrolSecret, kek: app.kek },
    { audit: { tag } },
  );

  const jar = {};
  const lGet = await app.inject({ method: 'GET', url: '/login' });
  mergeCookies(jar, lGet);
  const lCsrf = extractInputValue(lGet.body, '_csrf');
  const lOk = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
    payload: `email=${encodeURIComponent(tagEmail(suffix))}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
  });
  expect(lOk.statusCode).toBe(302);
  mergeCookies(jar, lOk);

  const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(jar) } });
  const cCsrf = extractInputValue(cGet.body, '_csrf');
  mergeCookies(jar, cGet);

  const cOk = await app.inject({
    method: 'POST',
    url: '/login/2fa',
    headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
    payload: `method=totp&totp_code=${generateToken(enrolSecret)}&_csrf=${encodeURIComponent(cCsrf)}`,
  });
  expect(cOk.statusCode).toBe(302);
  mergeCookies(jar, cOk);

  return { adminId: created.id, jar };
}

async function halfLoggedIn(app, db, env, suffix, password = 'admin-pw-928374-strong') {
  // Password verified, /login/2fa not yet completed (no step_up_at).
  const created = await adminsService.create(
    db,
    { email: tagEmail(suffix), name: `Admin ${suffix}` },
    { actorType: 'system', audit: { tag } },
  );
  const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
  await adminsService.consumeInvite(
    db,
    { token: created.inviteToken, newPassword: password },
    { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) },
  );
  await adminsService.enroll2faTotp(
    db,
    { adminId: created.id, secret: enrolSecret, kek: app.kek },
    { audit: { tag } },
  );

  const jar = {};
  const lGet = await app.inject({ method: 'GET', url: '/login' });
  mergeCookies(jar, lGet);
  const lCsrf = extractInputValue(lGet.body, '_csrf');
  const lOk = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
    payload: `email=${encodeURIComponent(tagEmail(suffix))}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
  });
  expect(lOk.statusCode).toBe(302);
  mergeCookies(jar, lOk);
  return { jar };
}

describe.skipIf(skip)('admin customers routes (list / new / detail)', () => {
  let app;
  let db;
  let env;

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    app = await build({ skipSafetyCheck: true });
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
  });

  it('redirects unauthenticated and half-authenticated requests to /login', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/admin/customers' });
    expect(r1.statusCode).toBe(302);
    expect(r1.headers.location).toBe('/login');

    const { jar } = await halfLoggedIn(app, db, env, 'half');
    const r2 = await app.inject({
      method: 'GET',
      url: '/admin/customers',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(r2.statusCode).toBe(302);
    expect(r2.headers.location).toBe('/login');
  });

  it('happy path: list (empty) → new → POST → confirmation w/ invite URL → list shows it → detail page', async () => {
    const { jar } = await loginAdminFully(app, db, env, 'happy');

    // List (empty)
    const list0 = await app.inject({
      method: 'GET',
      url: '/admin/customers',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(list0.statusCode).toBe(200);
    expect(list0.body).toMatch(/Customers/i);
    expect(list0.body).toMatch(/no customers yet/i);

    // New form
    const newGet = await app.inject({
      method: 'GET',
      url: '/admin/customers/new',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(newGet.statusCode).toBe(200);
    expect(newGet.body).toContain('name="razon_social"');
    expect(newGet.body).toContain('name="nif"');
    expect(newGet.body).toContain('name="domicilio"');
    expect(newGet.body).toContain('name="primary_user_email"');
    expect(newGet.body).toContain('name="primary_user_name"');
    const csrf = extractInputValue(newGet.body, '_csrf');
    expect(csrf).toBeTruthy();
    mergeCookies(jar, newGet);

    // POST without CSRF → 403
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/admin/customers',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `razon_social=${encodeURIComponent(tag + ' Happy S.L.')}&primary_user_email=${encodeURIComponent(tagEmail('p1'))}&primary_user_name=Pri+One`,
    });
    expect([403, 400]).toContain(noCsrf.statusCode);

    // POST with CSRF → 200 confirmation page exposing the invite URL once
    const created = await app.inject({
      method: 'POST',
      url: '/admin/customers',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: [
        `razon_social=${encodeURIComponent(tag + ' Happy S.L.')}`,
        `nif=${encodeURIComponent('B12345678')}`,
        `domicilio=${encodeURIComponent('Calle 1, Tenerife')}`,
        `primary_user_email=${encodeURIComponent(tagEmail('p1'))}`,
        `primary_user_name=${encodeURIComponent('Pri One')}`,
        `_csrf=${encodeURIComponent(csrf)}`,
      ].join('&'),
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).toMatch(/customer created/i);
    // Plaintext invite URL should appear exactly once on the created page.
    const urlMatches = created.body.match(/https?:\/\/[^\s"<]+\/welcome\/[A-Za-z0-9_-]{20,}/g) ?? [];
    expect(urlMatches).toHaveLength(1);

    // DB state — one customer + one customer_user + one outbox + one audit.
    const cRows = await sql`
      SELECT id, razon_social, nif, status FROM customers WHERE razon_social LIKE ${tag + '%'}
    `.execute(db);
    expect(cRows.rows).toHaveLength(1);
    const customerId = cRows.rows[0].id;
    expect(cRows.rows[0].razon_social).toBe(tag + ' Happy S.L.');
    expect(cRows.rows[0].nif).toBe('B12345678');
    expect(cRows.rows[0].status).toBe('active');

    const uRows = await sql`SELECT id, email, name FROM customer_users WHERE customer_id = ${customerId}::uuid`.execute(db);
    expect(uRows.rows).toHaveLength(1);
    expect(uRows.rows[0].email).toBe(tagEmail('p1'));
    expect(uRows.rows[0].name).toBe('Pri One');

    const ob = await sql`
      SELECT template, idempotency_key FROM email_outbox WHERE to_address = ${tagEmail('p1')}::citext
    `.execute(db);
    expect(ob.rows).toHaveLength(1);
    expect(ob.rows[0].template).toBe('customer-invitation');

    const audit = await sql`
      SELECT actor_type, actor_id, action, target_id FROM audit_log
       WHERE action = 'customer.created' AND target_id = ${customerId}::uuid
    `.execute(db);
    expect(audit.rows).toHaveLength(1);
    // The route must attribute the create to the logged-in admin (not 'system').
    expect(audit.rows[0].actor_type).toBe('admin');
    expect(audit.rows[0].actor_id).not.toBeNull();

    // List view now shows the customer + a status badge.
    const list1 = await app.inject({
      method: 'GET',
      url: '/admin/customers',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(list1.statusCode).toBe(200);
    expect(list1.body).toContain(tag + ' Happy S.L.');
    expect(list1.body).toMatch(/active/i);

    // Detail page shows the customer + primary user.
    const detail = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain(tag + ' Happy S.L.');
    expect(detail.body).toContain('B12345678');
    expect(detail.body).toContain('Calle 1, Tenerife');
    expect(detail.body).toContain(tagEmail('p1'));
  });

  it('list: paginates and filters by razon_social / nif', async () => {
    const { jar, adminId } = await loginAdminFully(app, db, env, 'paged');

    // Seed three customers via the route so we exercise the same code path.
    const newGet = await app.inject({
      method: 'GET',
      url: '/admin/customers/new',
      headers: { cookie: cookieHeader(jar) },
    });
    const csrf = extractInputValue(newGet.body, '_csrf');
    mergeCookies(jar, newGet);

    for (const i of [1, 2, 3]) {
      const r = await app.inject({
        method: 'POST',
        url: '/admin/customers',
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: [
          `razon_social=${encodeURIComponent(`${tag} Paged-${i} S.L.`)}`,
          `nif=${encodeURIComponent(`B0000000${i}`)}`,
          `primary_user_email=${encodeURIComponent(tagEmail(`pg${i}`))}`,
          `primary_user_name=${encodeURIComponent(`PG ${i}`)}`,
          `_csrf=${encodeURIComponent(csrf)}`,
        ].join('&'),
      });
      expect(r.statusCode).toBe(200);
    }

    // Page 1 with perPage=2 → exactly 2 of the 3 customers.
    const p1 = await app.inject({
      method: 'GET',
      url: '/admin/customers?per_page=2&page=1',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(p1.statusCode).toBe(200);
    const p1Hits = (p1.body.match(new RegExp(tag + ' Paged-\\d S\\.L\\.', 'g')) ?? []).length;
    expect(p1Hits).toBe(2);
    // Pagination control is rendered.
    expect(p1.body).toMatch(/page=2/);

    // Page 2 → the remaining customer.
    const p2 = await app.inject({
      method: 'GET',
      url: '/admin/customers?per_page=2&page=2',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(p2.statusCode).toBe(200);
    const p2Hits = (p2.body.match(new RegExp(tag + ' Paged-\\d S\\.L\\.', 'g')) ?? []).length;
    expect(p2Hits).toBe(1);

    // Search by razon_social — narrows to one.
    const filterRs = await app.inject({
      method: 'GET',
      url: `/admin/customers?q=Paged-2`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(filterRs.statusCode).toBe(200);
    expect(filterRs.body).toContain(tag + ' Paged-2 S.L.');
    expect(filterRs.body).not.toContain(tag + ' Paged-1 S.L.');
    expect(filterRs.body).not.toContain(tag + ' Paged-3 S.L.');

    // Search by NIF — narrows to one.
    const filterNif = await app.inject({
      method: 'GET',
      url: `/admin/customers?q=B00000003`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(filterNif.statusCode).toBe(200);
    expect(filterNif.body).toContain(tag + ' Paged-3 S.L.');
    expect(filterNif.body).not.toContain(tag + ' Paged-1 S.L.');
    expect(filterNif.body).not.toContain(tag + ' Paged-2 S.L.');

    expect(adminId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
