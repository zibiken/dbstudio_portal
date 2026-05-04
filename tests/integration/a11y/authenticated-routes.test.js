// axe-core a11y audit on authenticated views. Complements
// scripts/a11y-check.js which only covers public routes (/login, /reset)
// and static EJS pattern checks. Asserts no serious/critical axe-core
// violations on the main admin + customer logged-in pages.
//
// Why a vitest test instead of extending a11y-check.js:
// - Fixture login flow already exists in tests/integration/* and is
//   non-trivial (admin: invite → consume → enrol 2FA → /login + /login/2fa;
//   customer: completeCustomerWelcome → seat sid).
// - Vitest has the DB + cleanup infra; mirroring it inside a CLI script
//   would duplicate ~150 lines.
// - Failure surfaces in run-tests.sh exit code naturally.
//
// JSDOM caveats (same as scripts/a11y-check.js axe section): no canvas,
// so axe-core skips the color-contrast rule. The static checks in the
// CLI script cover what JSDOM cannot.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { JSDOM } from 'jsdom';
import * as axeMod from 'axe-core';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const axe = axeMod.default ?? axeMod;
const skip = !process.env.RUN_DB_TESTS;
const tag = `a11yauth_${Date.now()}`;
const adminTag = `${tag}_admin`;

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

async function runAxe(html, sourceUrl) {
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.eval(axe.source);
  if (!dom.window.axe) {
    throw new Error(`failed to attach axe-core to JSDOM for ${sourceUrl}`);
  }
  const result = await dom.window.axe.run(dom.window.document, {
    resultTypes: ['violations'],
  });
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
}

describe.skipIf(skip)('a11y: authenticated routes (axe-core)', () => {
  let app, db, env, kek;
  let adminJar, customerJar;
  let customerId;

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });

    // ---- Admin fixture + 2FA login ----
    const adminPassword = 'admin-pw-928374-strong';
    const created = await adminsService.create(db,
      { email: `${adminTag}+a@example.com`, name: 'Admin A' },
      { actorType: 'system', audit: { tag } },
    );
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
    await adminsService.consumeInvite(db, {
      token: created.inviteToken, newPassword: adminPassword,
    }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    await adminsService.enroll2faTotp(db, {
      adminId: created.id, secret: enrolSecret, kek,
    }, { audit: { tag } });

    adminJar = {};
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    mergeCookies(adminJar, lGet);
    const lCsrf = extractInputValue(lGet.body, '_csrf');
    const lOk = await app.inject({
      method: 'POST', url: '/login',
      headers: { cookie: cookieHeader(adminJar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ email: `${adminTag}+a@example.com`, password: adminPassword, _csrf: lCsrf }),
    });
    expect(lOk.statusCode).toBe(302);
    mergeCookies(adminJar, lOk);
    const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(adminJar) } });
    mergeCookies(adminJar, cGet);
    const cCsrf = extractInputValue(cGet.body, '_csrf');
    const cOk = await app.inject({
      method: 'POST', url: '/login/2fa',
      headers: { cookie: cookieHeader(adminJar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ method: 'totp', totp_code: generateToken(enrolSecret), _csrf: cCsrf }),
    });
    expect(cOk.statusCode).toBe(302);
    mergeCookies(adminJar, cOk);

    // ---- Customer fixture + welcome login ----
    const cust = await customersService.create(db,
      { razonSocial: `${tag} Cust S.L.`, primaryUser: { name: 'Cust', email: `${tag}+u@example.com` } },
      { actorType: 'system', audit: { tag }, kek, portalBaseUrl: env.PORTAL_BASE_URL || 'https://portal.test' },
    );
    customerId = cust.customerId;
    const r = await customersService.completeCustomerWelcome(db, {
      token: cust.inviteToken,
      newPassword: 'customer-pw-928374-strong',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      kek,
      sessionIp: '198.51.100.7',
      sessionDeviceFingerprint: null,
    }, { hibpHasBeenPwned: vi.fn(async () => false), audit: { tag } });
    await sql`UPDATE customers SET nda_signed_at = now() WHERE id = ${customerId}::uuid`.execute(db);
    customerJar = { sid: app.signCookie(r.sid) };

    // Project so the customer dashboard renders a representative non-empty
    // state instead of the zero-projects empty state.
    await sql`
      INSERT INTO projects (id, customer_id, name, objeto_proyecto, status)
      VALUES (${uuidv7()}::uuid, ${customerId}::uuid, ${'Test Project'}, ${'a11y'}, 'active')
    `.execute(db);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await sql`DELETE FROM project_phases WHERE project_id IN (
      SELECT pr.id FROM projects pr JOIN customers c ON c.id = pr.customer_id WHERE c.razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'} OR to_address LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (
      SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}
      UNION SELECT id FROM admins WHERE email LIKE ${adminTag + '%'}
    )`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM pending_digest_items WHERE metadata->>'tag' = ${tag}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  // Admin routes. /admin redirects to /admin/customers; we hit the
  // landing destination directly. Keep the list small + representative
  // — extend as new view families land.
  const adminRoutes = [
    { url: '/admin/customers', label: 'admin customers list' },
    { url: '/admin/audit', label: 'admin audit log' },
    { url: '/admin/profile', label: 'admin profile' },
  ];
  for (const route of adminRoutes) {
    it(`${route.label} (${route.url}) has no serious/critical axe violations`, async () => {
      const res = await app.inject({
        method: 'GET', url: route.url,
        headers: { cookie: cookieHeader(adminJar) },
      });
      expect(res.statusCode, `expected 200 from ${route.url}, body: ${res.body.slice(0, 300)}`).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      const violations = await runAxe(res.body, route.url);
      expect(violations, `axe violations on ${route.url}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
    });
  }

  const customerRoutes = [
    { url: '/customer/dashboard', label: 'customer dashboard' },
    { url: '/customer/credentials', label: 'customer credentials list' },
    { url: '/customer/activity', label: 'customer activity feed' },
    { url: '/customer/profile', label: 'customer profile' },
  ];
  for (const route of customerRoutes) {
    it(`${route.label} (${route.url}) has no serious/critical axe violations`, async () => {
      const res = await app.inject({
        method: 'GET', url: route.url,
        headers: { cookie: cookieHeader(customerJar) },
      });
      expect(res.statusCode, `expected 200 from ${route.url}, body: ${res.body.slice(0, 300)}`).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      const violations = await runAxe(res.body, route.url);
      expect(violations, `axe violations on ${route.url}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
    });
  }
});
