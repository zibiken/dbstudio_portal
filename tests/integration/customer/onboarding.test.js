import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes, createHash } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import { unwrapDek, decrypt } from '../../../lib/crypto/envelope.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cust_onb_test_${Date.now()}`;
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

describe.skipIf(skip)('customer onboarding routes', () => {
  let app;
  let db;
  let env;
  const okHibp = vi.fn(async () => false);

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    app = await build({ skipSafetyCheck: true, hibpHasBeenPwned: okHibp });
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
  });

  async function seedCustomer(suffix) {
    return await customersService.create(
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
        portalBaseUrl: app.env.PORTAL_BASE_URL,
        kek: app.kek,
        audit: { tag },
      },
    );
  }

  it('full flow: token → set password + TOTP → backup codes → profile review → dashboard; secret encrypted under customer DEK', async () => {
    const created = await seedCustomer('full');
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
    const password = 'a-real-strong-passphrase-29384';

    // GET /customer/welcome/:token — set password + enrol form
    const jar = {};
    const wGet = await app.inject({ method: 'GET', url: `/customer/welcome/${created.inviteToken}` });
    expect(wGet.statusCode).toBe(200);
    expect(wGet.body).toContain('name="password"');
    expect(wGet.body).toContain('name="totp_code"');
    expect(wGet.body).toContain(enrolSecret);
    mergeCookies(jar, wGet);
    const csrf = extractInputValue(wGet.body, '_csrf');
    expect(csrf).toBeTruthy();

    // POST without CSRF → 403
    const noCsrf = await app.inject({
      method: 'POST',
      url: `/customer/welcome/${created.inviteToken}`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `password=${encodeURIComponent(password)}&totp_code=${generateToken(enrolSecret)}`,
    });
    expect([403, 400]).toContain(noCsrf.statusCode);

    // POST with valid password + TOTP → 200 backup codes view, sid cookie set
    const totp = generateToken(enrolSecret);
    const wPost = await app.inject({
      method: 'POST',
      url: `/customer/welcome/${created.inviteToken}`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `password=${encodeURIComponent(password)}&totp_code=${totp}&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(wPost.statusCode).toBe(200);
    // 8 backup codes (5+5 alphanum, no I/O/0/1) joined by '-'
    const codeMatches = wPost.body.match(/[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}/g) ?? [];
    expect(codeMatches.length).toBeGreaterThanOrEqual(8);
    mergeCookies(jar, wPost);
    expect(jar.sid).toBeTruthy();

    // DB state: customer_users row has password_hash, encrypted totp, codes,
    // invite_consumed_at set.
    const u = await sql`
      SELECT id, customer_id, password_hash, totp_secret_enc, totp_iv, totp_tag,
             backup_codes, invite_consumed_at
        FROM customer_users WHERE email = ${tagEmail('full')}::citext
    `.execute(db);
    expect(u.rows).toHaveLength(1);
    const userRow = u.rows[0];
    expect(userRow.password_hash?.startsWith('$argon2id$')).toBe(true);
    expect(userRow.invite_consumed_at).not.toBeNull();
    expect(Array.isArray(userRow.backup_codes)).toBe(true);
    expect(userRow.backup_codes.length).toBe(8);
    expect(Buffer.isBuffer(userRow.totp_secret_enc)).toBe(true);
    expect(Buffer.isBuffer(userRow.totp_iv)).toBe(true);
    expect(Buffer.isBuffer(userRow.totp_tag)).toBe(true);

    // Critical: the TOTP secret is encrypted under the CUSTOMER's DEK,
    // not under the KEK directly. Round-trip via unwrapDek(KEK) → decrypt(DEK).
    const c = await sql`
      SELECT dek_ciphertext, dek_iv, dek_tag FROM customers WHERE id = ${userRow.customer_id}
    `.execute(db);
    const dek = unwrapDek({
      ciphertext: c.rows[0].dek_ciphertext,
      iv: c.rows[0].dek_iv,
      tag: c.rows[0].dek_tag,
    }, app.kek);
    const recoveredSecret = decrypt({
      ciphertext: userRow.totp_secret_enc,
      iv: userRow.totp_iv,
      tag: userRow.totp_tag,
    }, dek).toString('utf8');
    expect(recoveredSecret).toBe(enrolSecret);

    // The wrong KEK or the KEK directly must NOT decrypt the TOTP secret.
    expect(() => decrypt({
      ciphertext: userRow.totp_secret_enc,
      iv: userRow.totp_iv,
      tag: userRow.totp_tag,
    }, app.kek)).toThrow();

    // Customer session was created with user_type='customer', step_up_at set.
    const s = await sql`
      SELECT user_type, user_id::text AS user_id, step_up_at, revoked_at
        FROM sessions WHERE user_id = ${userRow.id}::uuid AND user_type = 'customer'
    `.execute(db);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].user_type).toBe('customer');
    expect(s.rows[0].step_up_at).not.toBeNull();
    expect(s.rows[0].revoked_at).toBeNull();

    // GET /customer/welcome/profile (auth via the new sid cookie)
    const profileGet = await app.inject({
      method: 'GET',
      url: '/customer/welcome/profile',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(profileGet.statusCode).toBe(200);
    expect(profileGet.body).toContain(`Cust full`);
    expect(profileGet.body).toContain(tagEmail('full'));
    expect(profileGet.body).toContain(`${tag} full S.L.`);
    const pCsrf = extractInputValue(profileGet.body, '_csrf');
    mergeCookies(jar, profileGet);

    // POST /customer/welcome/profile → 302 /customer/dashboard
    const profilePost = await app.inject({
      method: 'POST',
      url: '/customer/welcome/profile',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(pCsrf)}`,
    });
    expect(profilePost.statusCode).toBe(302);
    expect(profilePost.headers.location).toBe('/customer/dashboard');

    // Re-using the consumed token must fail.
    const wReplay = await app.inject({
      method: 'GET',
      url: `/customer/welcome/${created.inviteToken}`,
    });
    expect([400, 410]).toContain(wReplay.statusCode);
  });

  it('GET with bogus, expired, or consumed token returns 410 invalid view (no CSRF cookie issued)', async () => {
    // Bogus
    const bogus = await app.inject({ method: 'GET', url: `/customer/welcome/${randomBytes(16).toString('hex')}` });
    expect(bogus.statusCode).toBe(410);
    expect(parseSetCookies(bogus).find((c) => c.name === 'csrf')).toBeFalsy();

    // Expired
    const created = await seedCustomer('expired');
    const tokenHash = createHash('sha256').update(created.inviteToken).digest('hex');
    await sql`UPDATE customer_users SET invite_expires_at = now() - INTERVAL '1 minute' WHERE invite_token_hash = ${tokenHash}`.execute(db);
    const expired = await app.inject({ method: 'GET', url: `/customer/welcome/${created.inviteToken}` });
    expect(expired.statusCode).toBe(410);

    // Consumed
    const created2 = await seedCustomer('consumed');
    const tokenHash2 = createHash('sha256').update(created2.inviteToken).digest('hex');
    await sql`UPDATE customer_users SET invite_consumed_at = now() WHERE invite_token_hash = ${tokenHash2}`.execute(db);
    const consumed = await app.inject({ method: 'GET', url: `/customer/welcome/${created2.inviteToken}` });
    expect(consumed.statusCode).toBe(410);
  });
});
