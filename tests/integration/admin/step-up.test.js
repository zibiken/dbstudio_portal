import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import { encrypt } from '../../../lib/crypto/envelope.js';
import { generateToken } from '../../../lib/auth/totp.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `step_up_${Date.now()}`;

function parseSetCookies(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(line => {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1) };
  });
}

describe.skipIf(skip)('admin step-up route', () => {
  let app;
  let db;
  let env;
  let kek;
  let adminId;
  let totpSecret;

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });
    adminId = uuidv7();
    // 32 base32 chars = 20 decoded bytes; otplib requires ≥16-byte secrets.
    totpSecret = 'JBSWY3DPEHPK3PXPMFRGGZDFMZTWQ2LK';
    const enc = encrypt(Buffer.from(totpSecret, 'utf8'), kek);
    await sql`
      INSERT INTO admins (id, email, name, password_hash, totp_secret_enc, totp_iv, totp_tag)
      VALUES (${adminId}::uuid, ${tag + '@example.com'}, 'StepUp Admin',
              ${'$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'},
              ${enc.ciphertext}, ${enc.iv}, ${enc.tag})
    `.execute(db);
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM sessions WHERE user_id = ${adminId}::uuid`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'step-up:admin:' + adminId + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
    await db.destroy();
  });

  async function makeAdminSession() {
    const sid = await createSession(db, { userType: 'admin', userId: adminId, ip: '198.51.100.1' });
    await stepUp(db, sid);
    return { sid, signed: app.signCookie(sid) };
  }

  it('GET renders TOTP form with hidden return field', async () => {
    const { signed } = await makeAdminSession();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/step-up?return=/admin/customers',
      cookies: { sid: signed },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="totp_code"');
    expect(res.body).toMatch(/value="\/admin\/customers"/);
  });

  it('GET sanitises external return URL to /admin/', async () => {
    const { signed } = await makeAdminSession();
    for (const bad of ['https://evil.com', '//evil.com', '/admin/../foo', '/admin/?return=https://evil.com']) {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/step-up?return=${encodeURIComponent(bad)}`,
        cookies: { sid: signed },
      });
      expect(res.statusCode).toBe(200);
      const m = res.body.match(/name="return"[^>]*value="([^"]*)"/);
      expect(m?.[1]).toMatch(/^\/admin\//);
      expect(m?.[1]).not.toContain('://');
      expect(m?.[1]).not.toMatch(/\?return=/i);
    }
  });

  it('GET without admin session redirects to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/step-up' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  async function getWithCsrf(signed, returnTo = '/admin/') {
    const get = await app.inject({
      method: 'GET',
      url: `/admin/step-up?return=${encodeURIComponent(returnTo)}`,
      cookies: { sid: signed },
    });
    // Build a literal Cookie header from the GET's Set-Cookie pairs so
    // url-encoded values (CSRF cookie carries '+', '/', '=' which become
    // %2B/%2F/%3D when serialized) round-trip verbatim. Light-my-request's
    // cookies-dict re-encodes and the csrf-protection plugin then can't
    // find the secret.
    const cookieHeader = ['sid=' + signed]
      .concat(parseSetCookies(get).map(c => `${c.name}=${c.value}`))
      .join('; ');
    const csrfToken = get.body.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
    return { cookieHeader, csrfToken };
  }

  it('POST with valid TOTP refreshes step-up + vault, 303s to validated return', async () => {
    const { sid, signed } = await makeAdminSession();
    const { cookieHeader, csrfToken } = await getWithCsrf(signed, '/admin/customers');
    const code = generateToken(totpSecret);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/step-up',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${encodeURIComponent(csrfToken)}&return=${encodeURIComponent('/admin/customers')}&totp_code=${code}`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin/customers');

    const sRow = await sql`
      SELECT vault_unlocked_at, step_up_at FROM sessions WHERE id = ${sid}
    `.execute(db);
    expect(sRow.rows[0].vault_unlocked_at).not.toBeNull();
    expect(sRow.rows[0].step_up_at).not.toBeNull();
  });

  it('POST with wrong TOTP rerenders 422 + increments rate bucket', async () => {
    await sql`DELETE FROM rate_limit_buckets WHERE key = ${'step-up:admin:' + adminId}`.execute(db);
    const { signed } = await makeAdminSession();
    const { cookieHeader, csrfToken } = await getWithCsrf(signed, '/admin/');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/step-up',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${encodeURIComponent(csrfToken)}&return=${encodeURIComponent('/admin/')}&totp_code=000000`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/code/i);

    const bucket = await sql`SELECT count FROM rate_limit_buckets WHERE key = ${'step-up:admin:' + adminId}`.execute(db);
    expect(bucket.rows[0]?.count).toBeGreaterThanOrEqual(1);
  });

  it('POST 6× wrong TOTP returns 429 lockout', async () => {
    await sql`DELETE FROM rate_limit_buckets WHERE key = ${'step-up:admin:' + adminId}`.execute(db);
    const { signed } = await makeAdminSession();
    const { cookieHeader, csrfToken } = await getWithCsrf(signed, '/admin/');

    let lastStatus;
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/admin/step-up',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `_csrf=${encodeURIComponent(csrfToken)}&return=${encodeURIComponent('/admin/')}&totp_code=000000`,
      });
      lastStatus = r.statusCode;
    }
    expect(lastStatus).toBe(429);
  });
});
