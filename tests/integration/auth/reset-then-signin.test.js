import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as service from '../../../domain/admins/service.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `reset_signin_${Date.now()}`;
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

describe.skipIf(skip)('reset → first-attempt sign-in', () => {
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
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:ip:10.0.0.%'`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql.raw(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify`).execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify`).execute(db);
    await db.destroy();
  });

  it('POST /reset with any address renders soft-conditional success copy', async () => {
    const get = await app.inject({ method: 'GET', url: '/reset' });
    const csrf = extractInputValue(get.body, '_csrf');
    const jar = {};
    mergeCookies(jar, get);

    const res = await app.inject({
      method: 'POST',
      url: '/reset',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(tagEmail('typo'))}&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/if your address is registered/i);
    expect(res.body).toMatch(/double-check the address/i);
  });

  it('after a successful reset, sign-in with the new password verifies on the first attempt + leaves no login bucket fail count', async () => {
    // 1. Create an admin + complete welcome (mirrors the canonical reset
    //    test in login-flow.test.js).
    const created = await service.create(
      db,
      { email: tagEmail('rs1'), name: 'Reset Signin' },
      { actorType: 'system', audit: { tag } },
    );
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
    await service.completeWelcome(
      db,
      {
        token: created.inviteToken,
        newPassword: 'baseline-pw-29384-old',
        totpSecret: enrolSecret,
        kek: app.kek,
      },
      { audit: { tag }, hibpHasBeenPwned: okHibp },
    );

    // 2. Request a reset and consume it via /reset/:token.
    const reset = await service.requestPasswordReset(
      db,
      { email: tagEmail('rs1') },
      { audit: { tag }, portalBaseUrl: env.PORTAL_BASE_URL },
    );
    const newPassword = 'reset-then-signin-passphrase-7281';
    const totp = generateToken(enrolSecret);
    const jar = {};

    const get = await app.inject({ method: 'GET', url: `/reset/${reset.inviteToken}` });
    mergeCookies(jar, get);
    const csrf = extractInputValue(get.body, '_csrf');
    const post = await app.inject({
      method: 'POST',
      url: `/reset/${reset.inviteToken}`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `password=${encodeURIComponent(newPassword)}&totp_code=${totp}&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(post.statusCode).toBe(302);

    // Drop the auto-login session so we genuinely test "fresh sign-in".
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email = ${tagEmail('rs1')})`.execute(db);

    // 3. Sign in with the new password ON THE FIRST ATTEMPT.
    const loginJar = {};
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    mergeCookies(loginJar, lGet);
    const lCsrf = extractInputValue(lGet.body, '_csrf');

    const lPost = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: cookieHeader(loginJar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(tagEmail('rs1'))}&password=${encodeURIComponent(newPassword)}&_csrf=${encodeURIComponent(lCsrf)}`,
    });
    // Login success → 302 to /login/2fa (password verified, 2FA next).
    expect(lPost.statusCode).toBe(302);
    expect(lPost.headers.location).toBe('/login/2fa');

    // 4. No login:email:* fail bucket should have a positive count for
    //    this address. (resetBucket clears on success.)
    const r = await sql`
      SELECT count FROM rate_limit_buckets
       WHERE key = ${'login:email:' + tagEmail('rs1')}
    `.execute(db);
    expect(r.rows[0]?.count ?? 0).toBe(0);
  });
});
