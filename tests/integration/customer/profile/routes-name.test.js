import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { build } from '../../../../server.js';
import { createDb } from '../../../../config/db.js';
import { loadEnv } from '../../../../config/env.js';
import * as customersService from '../../../../domain/customers/service.js';
import { deriveEnrolSecret } from '../../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../../lib/auth/totp.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cust_profile_route_test_${Date.now()}`;
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
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const mergeCookies = (jar, res) => { for (const c of parseSetCookies(res)) jar[c.name] = c.value; };
const extractInputValue = (html, name) => {
  const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']+)["']`);
  const m = html.match(re);
  return m ? m[1] : null;
};

async function seedAndLogIn(app, db, suffix) {
  const env = app.env;
  const created = await customersService.create(
    db,
    {
      razonSocial: `${tag} ${suffix} S.L.`,
      nif: 'B12345678',
      domicilio: 'Calle Falsa 1, Tenerife',
      primaryUser: { name: `Cust ${suffix}`, email: tagEmail(suffix) },
    },
    {
      actorType: 'admin',
      actorId: null,
      ip: '198.51.100.7',
      userAgentHash: 'uahash',
      portalBaseUrl: env.PORTAL_BASE_URL,
      kek: app.kek,
      audit: { tag },
    },
  );

  const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
  const jar = {};
  const wGet = await app.inject({ method: 'GET', url: `/customer/welcome/${created.inviteToken}` });
  mergeCookies(jar, wGet);
  const csrf = extractInputValue(wGet.body, '_csrf');
  const totp = generateToken(enrolSecret);
  const password = 'a-real-strong-passphrase-29384';
  const wPost = await app.inject({
    method: 'POST',
    url: `/customer/welcome/${created.inviteToken}`,
    headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
    payload: `password=${encodeURIComponent(password)}&totp_code=${totp}&_csrf=${encodeURIComponent(csrf)}`,
  });
  expect(wPost.statusCode).toBe(200);
  mergeCookies(jar, wPost);
  return { jar, customerUserId: created.primaryUserId };
}

describe.skipIf(skip)('customer profile name routes', () => {
  let app;
  let db;
  const okHibp = vi.fn(async () => false);

  beforeAll(async () => {
    db = createDb({ connectionString: loadEnv().DATABASE_URL });
    app = await build({ skipSafetyCheck: true, hibpHasBeenPwned: okHibp });
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  it('GET /customer/profile renders the profile form with current name', async () => {
    const { jar } = await seedAndLogIn(app, db, 'a');
    const res = await app.inject({
      method: 'GET',
      url: '/customer/profile',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="name"');
    expect(res.body).toContain('Cust a');
    expect(res.body).toContain(tagEmail('a'));
  });

  it('GET /customer/profile redirects unauthenticated visitors to /', async () => {
    const res = await app.inject({ method: 'GET', url: '/customer/profile' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('POST /customer/profile/name without CSRF → 403/400', async () => {
    const { jar } = await seedAndLogIn(app, db, 'b');
    const res = await app.inject({
      method: 'POST',
      url: '/customer/profile/name',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=Whoever',
    });
    expect([400, 403]).toContain(res.statusCode);
  });

  it('POST /customer/profile/name happy path → 302 + name persisted', async () => {
    const { jar, customerUserId } = await seedAndLogIn(app, db, 'c');
    const get = await app.inject({
      method: 'GET',
      url: '/customer/profile',
      headers: { cookie: cookieHeader(jar) },
    });
    const csrf = extractInputValue(get.body, '_csrf');
    const post = await app.inject({
      method: 'POST',
      url: '/customer/profile/name',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `name=${encodeURIComponent('New Display Name')}&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(post.statusCode).toBe(302);
    expect(post.headers.location).toBe('/customer/profile');
    const r = await sql`SELECT name FROM customer_users WHERE id = ${customerUserId}::uuid`.execute(db);
    expect(r.rows[0].name).toBe('New Display Name');
  });

  it('POST /customer/profile/name with blank name → 422 + form error', async () => {
    const { jar } = await seedAndLogIn(app, db, 'd');
    const get = await app.inject({
      method: 'GET',
      url: '/customer/profile',
      headers: { cookie: cookieHeader(jar) },
    });
    const csrf = extractInputValue(get.body, '_csrf');
    const post = await app.inject({
      method: 'POST',
      url: '/customer/profile/name',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `name=${encodeURIComponent('   ')}&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(post.statusCode).toBe(422);
    expect(post.body).toContain('form-error');
  });
});
