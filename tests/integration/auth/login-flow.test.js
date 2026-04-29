import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as service from '../../../domain/admins/service.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `flow_test_${Date.now()}`;
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

describe.skipIf(skip)('public auth route flow', () => {
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
    if (db) {
      await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
      await sql`DELETE FROM email_otp_codes WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
      await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
      await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
      await sql`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:ip:10.0.0.%'`.execute(db);
      await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify`).execute(db);
      await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify`).execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    // The distributed-brute-force test uses fixed IPs (10.0.0.1..5, 10.0.0.99).
    // Without this scrub, lockouts left by a previous run on the same IP keys
    // make /login short-circuit at checkLockout — so recordFail never fires
    // on the email-keyed bucket and the assertion at line 304 silently flips
    // to 401. The IPs are not used by any other test in this file.
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:ip:10.0.0.%'`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
  });

  it('full flow: welcome → set password + TOTP → backup codes → login → 2FA → success', async () => {
    const created = await service.create(
      db,
      { email: tagEmail('full'), name: 'Full Flow' },
      { actorType: 'system', audit: { tag } },
    );

    // GET /welcome/:token — render set-password + 2FA enrol form
    const jar = {};
    const wGet = await app.inject({ method: 'GET', url: `/welcome/${created.inviteToken}` });
    expect(wGet.statusCode).toBe(200);
    expect(wGet.body).toContain('name="password"');
    expect(wGet.body).toContain('name="totp_code"');
    mergeCookies(jar, wGet);
    const wCsrf = extractInputValue(wGet.body, '_csrf');
    expect(wCsrf).toBeTruthy();

    // Verify the QR/manual-entry secret is shown so the admin can enrol.
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
    expect(wGet.body).toContain(enrolSecret);

    const password = 'a-real-strong-passphrase-29384';
    const totp = generateToken(enrolSecret);

    // POST /welcome/:token — set password, enrol TOTP, show backup codes once
    const wPost = await app.inject({
      method: 'POST',
      url: `/welcome/${created.inviteToken}`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `password=${encodeURIComponent(password)}&totp_code=${totp}&_csrf=${encodeURIComponent(wCsrf)}`,
    });
    expect(wPost.statusCode).toBe(200);
    // backup codes appear: 5+5 alphanumeric (no I/O/0/1) joined by '-'
    const codeMatches = wPost.body.match(/[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}/g) ?? [];
    expect(codeMatches.length).toBeGreaterThanOrEqual(8);
    const backupCode = codeMatches[0];

    // Reusing the invite token must fail (single-use)
    const wReplay = await app.inject({
      method: 'POST',
      url: `/welcome/${created.inviteToken}`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `password=${encodeURIComponent(password)}&totp_code=${generateToken(enrolSecret)}&_csrf=${encodeURIComponent(wCsrf)}`,
    });
    expect([400, 410, 422]).toContain(wReplay.statusCode);

    // GET /login — render
    const lJar = {};
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    expect(lGet.statusCode).toBe(200);
    expect(lGet.body).toContain('name="email"');
    expect(lGet.body).toContain('name="password"');
    mergeCookies(lJar, lGet);
    const lCsrf = extractInputValue(lGet.body, '_csrf');
    expect(lCsrf).toBeTruthy();

    // POST /login with wrong password → no enumeration; rate-limit recorded
    const lFail = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: cookieHeader(lJar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(tagEmail('full'))}&password=wrong&_csrf=${encodeURIComponent(lCsrf)}`,
    });
    expect([200, 401]).toContain(lFail.statusCode);
    expect(lFail.body).not.toContain('no such user');

    // POST /login with right password → 302 to /login/2fa, sid cookie set
    const lOk = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: cookieHeader(lJar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(tagEmail('full'))}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
    });
    expect(lOk.statusCode).toBe(302);
    expect(lOk.headers.location).toBe('/login/2fa');
    mergeCookies(lJar, lOk);
    expect(lJar.sid).toBeTruthy();

    // GET /login/2fa
    const cGet = await app.inject({
      method: 'GET',
      url: '/login/2fa',
      headers: { cookie: cookieHeader(lJar) },
    });
    expect(cGet.statusCode).toBe(200);
    expect(cGet.body).toContain('name="totp_code"');
    const cCsrf = extractInputValue(cGet.body, '_csrf');
    mergeCookies(lJar, cGet);

    // POST /login/2fa with TOTP → 302 to /
    const totp2 = generateToken(enrolSecret);
    const cOk = await app.inject({
      method: 'POST',
      url: '/login/2fa',
      headers: {
        cookie: cookieHeader(lJar),
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'flow-test/1.0',
      },
      payload: `method=totp&totp_code=${totp2}&_csrf=${encodeURIComponent(cCsrf)}`,
    });
    expect(cOk.statusCode).toBe(302);
    expect(cOk.headers.location).toBe('/');

    // First login from a fresh device fingerprint must queue a new-device-login
    // outbox row and write an admin.new_device_login audit row.
    const outbox = await sql`
      SELECT template, idempotency_key FROM email_outbox
       WHERE to_address = ${tagEmail('full')}::citext AND template = 'new-device-login'
    `.execute(db);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].idempotency_key).toContain('new_device_login:');

    const ndAudit = await sql`
      SELECT 1 FROM audit_log
       WHERE action = 'admin.new_device_login'
         AND target_id = (SELECT id FROM admins WHERE email = ${tagEmail('full')})
    `.execute(db);
    expect(ndAudit.rows).toHaveLength(1);

    const successAudit = await sql`
      SELECT 1 FROM audit_log
       WHERE action = 'admin.login_success'
         AND actor_id = (SELECT id FROM admins WHERE email = ${tagEmail('full')})
    `.execute(db);
    expect(successAudit.rows).toHaveLength(1);

    // GET /logout revokes the session
    const out = await app.inject({
      method: 'GET',
      url: '/logout',
      headers: { cookie: cookieHeader(lJar) },
    });
    expect(out.statusCode).toBe(302);
    expect(out.headers.location).toBe('/login');
  });

  it('login → 2FA challenge: backup-code path consumes the code and grants step-up', async () => {
    const created = await service.create(
      db,
      { email: tagEmail('bk'), name: 'Bk Code' },
      { actorType: 'system', audit: { tag } },
    );
    const password = 'second-strong-passphrase-29384';
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);

    // Drive welcome via service to keep the test focused on the login leg.
    await service.consumeInvite(
      db,
      { token: created.inviteToken, newPassword: password },
      { audit: { tag }, hibpHasBeenPwned: okHibp },
    );
    await service.enroll2faTotp(db, { adminId: created.id, secret: enrolSecret, kek: app.kek }, { audit: { tag } });
    const { codes } = await service.regenBackupCodes(db, { adminId: created.id }, { audit: { tag } });

    const jar = {};
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, lGet);
    const lCsrf = extractInputValue(lGet.body, '_csrf');

    const lOk = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(tagEmail('bk'))}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
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
      payload: `method=backup&backup_code=${encodeURIComponent(codes[0])}&_csrf=${encodeURIComponent(cCsrf)}`,
    });
    expect(cOk.statusCode).toBe(302);
    expect(cOk.headers.location).toBe('/');

    // Same code cannot be used a second time.
    const cReplay = await app.inject({
      method: 'POST',
      url: '/login/2fa',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `method=backup&backup_code=${encodeURIComponent(codes[0])}&_csrf=${encodeURIComponent(cCsrf)}`,
    });
    expect([200, 401]).toContain(cReplay.statusCode);
  });

  it('locks the email-keyed bucket even if the attacker rotates source IP (account protected from distributed brute-force)', async () => {
    await service.create(
      db,
      { email: tagEmail('dist'), name: 'Dist' },
      { actorType: 'system', audit: { tag } },
    );

    // Five failed POSTs simulating distinct source IPs through the proxy
    // header all targeting the same email. With only IP-keyed limiting the
    // account never locks; with email-keyed limiting it does.
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    const csrf = extractInputValue(lGet.body, '_csrf');
    const csrfCookie = parseSetCookies(lGet).find((c) => c.name === 'csrf');

    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          cookie: `csrf=${csrfCookie.value}`,
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': `10.0.0.${i + 1}`,
        },
        payload: `email=${encodeURIComponent(tagEmail('dist'))}&password=wrong${i}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([401, 429]).toContain(r.statusCode);
    }

    // The email bucket has now tripped its limit. A POST from a fresh IP
    // with the right email should be locked.
    const blocked = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        cookie: `csrf=${csrfCookie.value}`,
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '10.0.0.99',
      },
      payload: `email=${encodeURIComponent(tagEmail('dist'))}&password=anything&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('rate-limits /login/2fa: 5 wrong codes lock the half-auth session and clear sid', async () => {
    const created = await service.create(
      db,
      { email: tagEmail('rl'), name: 'RL' },
      { actorType: 'system', audit: { tag } },
    );
    const password = 'rate-limit-passphrase-29384';
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);

    await service.consumeInvite(
      db,
      { token: created.inviteToken, newPassword: password },
      { audit: { tag }, hibpHasBeenPwned: okHibp },
    );
    await service.enroll2faTotp(db, { adminId: created.id, secret: enrolSecret, kek: app.kek }, { audit: { tag } });

    const jar = {};
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, lGet);
    const lCsrf = extractInputValue(lGet.body, '_csrf');
    const lOk = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(tagEmail('rl'))}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
    });
    mergeCookies(jar, lOk);

    const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(jar) } });
    const cCsrf = extractInputValue(cGet.body, '_csrf');
    mergeCookies(jar, cGet);

    // Five wrong codes — last one returns 401 and trips the lockout.
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/login/2fa',
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `method=totp&totp_code=000000&_csrf=${encodeURIComponent(cCsrf)}`,
      });
      expect(r.statusCode).toBe(401);
    }

    // Sixth POST hits the lockout: 429 and the sid cookie is cleared.
    const blocked = await app.inject({
      method: 'POST',
      url: '/login/2fa',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `method=totp&totp_code=${generateToken(enrolSecret)}&_csrf=${encodeURIComponent(cCsrf)}`,
    });
    expect(blocked.statusCode).toBe(429);
    const cleared = parseSetCookies(blocked).find((c) => c.name === 'sid');
    expect(cleared).toBeTruthy();
    expect(cleared.value).toBe('');
  });

  it('reset/:token mirrors welcome flow for forgotten password', async () => {
    const created = await service.create(
      db,
      { email: tagEmail('rs'), name: 'Reset' },
      { actorType: 'system', audit: { tag } },
    );
    // Establish a baseline password first.
    await service.consumeInvite(
      db,
      { token: created.inviteToken, newPassword: 'first-baseline-pw-29384' },
      { audit: { tag }, hibpHasBeenPwned: okHibp },
    );
    const reset = await service.requestPasswordReset(db, { email: tagEmail('rs') }, { audit: { tag } });
    expect(reset.inviteToken).toBeTruthy();

    const enrolSecret = deriveEnrolSecret(reset.inviteToken, env.SESSION_SIGNING_SECRET);
    const newPassword = 'reset-flow-passphrase-99481';
    const totp = generateToken(enrolSecret);

    const jar = {};
    const get = await app.inject({ method: 'GET', url: `/reset/${reset.inviteToken}` });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('name="password"');
    expect(get.body).toContain('name="totp_code"');
    mergeCookies(jar, get);
    const csrf = extractInputValue(get.body, '_csrf');

    const post = await app.inject({
      method: 'POST',
      url: `/reset/${reset.inviteToken}`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `password=${encodeURIComponent(newPassword)}&totp_code=${totp}&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(post.statusCode).toBe(200);
    expect(post.body).toMatch(/[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}/);
  });
});
