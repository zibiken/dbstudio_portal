import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as adminsService from '../../../domain/admins/service.js';
import { findCustomerById } from '../../../domain/customers/repo.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cust_trans_test_${Date.now()}`;
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
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
function mergeCookies(jar, res) { for (const c of parseSetCookies(res)) jar[c.name] = c.value; }
function extractInputValue(html, name) {
  const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']+)["']`);
  const m = html.match(re);
  return m ? m[1] : null;
}

describe.skipIf(skip)('customers/service transitions + admin route wiring', () => {
  let app;
  let db;
  let env;
  let kek;
  const baseCtx = () => ({
    actorType: 'admin',
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
    app = await build({ skipSafetyCheck: true });
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM customer_users WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
  });

  async function seedCustomer(suffix) {
    return await customersService.create(
      db,
      {
        razonSocial: `${tag} ${suffix} S.L.`,
        primaryUser: { name: `Cust ${suffix}`, email: tagEmail(suffix) },
      },
      baseCtx(),
    );
  }

  async function seedActiveCustomerSession(suffix) {
    // Mint a fully-stepped-up customer session bypassing onboarding so the
    // suspend/archive tests can prove the revoke side-effect without
    // running the entire welcome flow.
    const created = await seedCustomer(suffix);
    const sid = await createSession(db, {
      userType: 'customer',
      userId: created.primaryUserId,
      ip: '198.51.100.7',
    });
    await stepUp(db, sid);
    return { ...created, sid };
  }

  describe('service-level transitions', () => {
    it('suspend: active → suspended, all customer-user sessions revoked, audit row written', async () => {
      const { customerId, sid } = await seedActiveCustomerSession('s1');

      await customersService.suspendCustomer(db, { customerId }, baseCtx());

      const customer = await findCustomerById(db, customerId);
      expect(customer.status).toBe('suspended');

      const ses = await sql`SELECT revoked_at FROM sessions WHERE id = ${sid}`.execute(db);
      expect(ses.rows[0].revoked_at).not.toBeNull();

      const audit = await sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE action = 'customer.suspended' AND target_id = ${customerId}::uuid
      `.execute(db);
      expect(audit.rows[0].c).toBe(1);
    });

    it('archive: active → archived (terminal), sessions revoked, audit', async () => {
      const { customerId, sid } = await seedActiveCustomerSession('a1');
      await customersService.archiveCustomer(db, { customerId }, baseCtx());

      const customer = await findCustomerById(db, customerId);
      expect(customer.status).toBe('archived');

      const ses = await sql`SELECT revoked_at FROM sessions WHERE id = ${sid}`.execute(db);
      expect(ses.rows[0].revoked_at).not.toBeNull();

      const audit = await sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE action = 'customer.archived' AND target_id = ${customerId}::uuid
      `.execute(db);
      expect(audit.rows[0].c).toBe(1);
    });

    it('archive: suspended → archived is allowed', async () => {
      const { customerId } = await seedActiveCustomerSession('a2');
      await customersService.suspendCustomer(db, { customerId }, baseCtx());
      await customersService.archiveCustomer(db, { customerId }, baseCtx());

      const customer = await findCustomerById(db, customerId);
      expect(customer.status).toBe('archived');
    });

    it('reactivate: suspended → active, OLD sessions stay revoked (customer must re-login)', async () => {
      const { customerId, sid } = await seedActiveCustomerSession('r1');
      await customersService.suspendCustomer(db, { customerId }, baseCtx());
      await customersService.reactivateCustomer(db, { customerId }, baseCtx());

      const customer = await findCustomerById(db, customerId);
      expect(customer.status).toBe('active');

      // Reactivation does NOT un-revoke old sessions — fresh login required.
      const ses = await sql`SELECT revoked_at FROM sessions WHERE id = ${sid}`.execute(db);
      expect(ses.rows[0].revoked_at).not.toBeNull();
    });

    it('invalid transitions throw: suspend an archived; reactivate an active; reactivate an archived', async () => {
      const { customerId } = await seedActiveCustomerSession('i1');
      await customersService.archiveCustomer(db, { customerId }, baseCtx());
      await expect(customersService.suspendCustomer(db, { customerId }, baseCtx()))
        .rejects.toThrow(/active/);
      await expect(customersService.reactivateCustomer(db, { customerId }, baseCtx()))
        .rejects.toThrow(/suspended/);

      const { customerId: cid2 } = await seedActiveCustomerSession('i2');
      await expect(customersService.reactivateCustomer(db, { customerId: cid2 }, baseCtx()))
        .rejects.toThrow(/suspended/);
    });

    it('atomicity: an archive failure (target customer absent) writes no audit row', async () => {
      const ghostId = '00000000-0000-7000-8000-000000000000';
      await expect(customersService.archiveCustomer(db, { customerId: ghostId }, baseCtx()))
        .rejects.toThrow();
      const audit = await sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE action = 'customer.archived' AND target_id = ${ghostId}::uuid
      `.execute(db);
      expect(audit.rows[0].c).toBe(0);
    });
  });

  describe('admin route wiring', () => {
    async function loginAdmin(suffix) {
      const password = 'admin-pw-928374-strong';
      const created = await adminsService.create(
        db,
        { email: tagEmail('adm-' + suffix), name: `Admin ${suffix}` },
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
        method: 'POST', url: '/login',
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=${encodeURIComponent(tagEmail('adm-' + suffix))}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
      });
      mergeCookies(jar, lOk);
      const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(jar) } });
      const cCsrf = extractInputValue(cGet.body, '_csrf');
      mergeCookies(jar, cGet);
      const cOk = await app.inject({
        method: 'POST', url: '/login/2fa',
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `method=totp&totp_code=${generateToken(enrolSecret)}&_csrf=${encodeURIComponent(cCsrf)}`,
      });
      mergeCookies(jar, cOk);
      return { adminId: created.id, jar };
    }

    it('POST /admin/customers/:id/reactivate happy path: suspended → active; sessions stay revoked', async () => {
      const { customerId, primaryUserId } = await seedActiveCustomerSession('routereact');
      // Drive into the suspended state via service so the test focuses on
      // the reactivate route only.
      await customersService.suspendCustomer(db, { customerId }, baseCtx());

      const { jar } = await loginAdmin('routereact');
      const detailGet = await app.inject({
        method: 'GET',
        url: `/admin/customers/${customerId}`,
        headers: { cookie: cookieHeader(jar) },
      });
      const csrf = extractInputValue(detailGet.body, '_csrf');
      mergeCookies(jar, detailGet);

      const ok = await app.inject({
        method: 'POST',
        url: `/admin/customers/${customerId}/reactivate`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toBe(`/admin/customers/${customerId}`);

      const c = await findCustomerById(db, customerId);
      expect(c.status).toBe('active');

      // Sessions for the customer-user must stay revoked even after
      // reactivation — this is the reactivate-doesn't-auto-restore
      // contract, asserted at the route layer this time.
      const ses = await sql`
        SELECT revoked_at FROM sessions
         WHERE user_type = 'customer' AND user_id = ${primaryUserId}::uuid
      `.execute(db);
      expect(ses.rows[0].revoked_at).not.toBeNull();
    });

    it('POST /admin/customers/:id/archive happy path: 303 detail page, status=archived, sessions revoked', async () => {
      const { customerId, primaryUserId } = await seedActiveCustomerSession('routearch');

      const { jar } = await loginAdmin('routearch');
      const detailGet = await app.inject({
        method: 'GET',
        url: `/admin/customers/${customerId}`,
        headers: { cookie: cookieHeader(jar) },
      });
      const csrf = extractInputValue(detailGet.body, '_csrf');
      mergeCookies(jar, detailGet);

      const ok = await app.inject({
        method: 'POST',
        url: `/admin/customers/${customerId}/archive`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toBe(`/admin/customers/${customerId}`);

      const c = await findCustomerById(db, customerId);
      expect(c.status).toBe('archived');

      const ses = await sql`
        SELECT revoked_at FROM sessions
         WHERE user_type = 'customer' AND user_id = ${primaryUserId}::uuid
      `.execute(db);
      expect(ses.rows[0].revoked_at).not.toBeNull();

      // Detail GET on an archived customer must NOT render any action
      // buttons (suspend/reactivate hidden by status, archive hidden by
      // top-level guard). One assertion per absent button.
      const archDetail = await app.inject({
        method: 'GET',
        url: `/admin/customers/${customerId}`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(archDetail.statusCode).toBe(200);
      expect(archDetail.body).not.toMatch(/action="\/admin\/customers\/[^"]+\/suspend"/);
      expect(archDetail.body).not.toMatch(/action="\/admin\/customers\/[^"]+\/reactivate"/);
      expect(archDetail.body).not.toMatch(/action="\/admin\/customers\/[^"]+\/archive"/);
    });

    it('POST against an already-suspended customer → 422 + detail rerender with banner (catch-block coverage)', async () => {
      const { customerId } = await seedActiveCustomerSession('routebad');
      await customersService.suspendCustomer(db, { customerId }, baseCtx());

      const { jar } = await loginAdmin('routebad');
      const detailGet = await app.inject({
        method: 'GET',
        url: `/admin/customers/${customerId}`,
        headers: { cookie: cookieHeader(jar) },
      });
      const csrf = extractInputValue(detailGet.body, '_csrf');
      mergeCookies(jar, detailGet);

      const r = await app.inject({
        method: 'POST',
        url: `/admin/customers/${customerId}/suspend`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(r.statusCode).toBe(422);
      // Body must be the detail page rerendered with an error banner —
      // the service throws "cannot suspend ... must be 'active'".
      expect(r.body).toMatch(/cannot suspend/i);
      expect(r.body).toContain(`${tag} routebad S.L.`);

      // Status unchanged.
      const c = await findCustomerById(db, customerId);
      expect(c.status).toBe('suspended');
    });

    it('POST with a malformed UUID in the path returns 404 not-found (no transition attempted)', async () => {
      const { jar } = await loginAdmin('route404');
      const detailGet = await app.inject({
        method: 'GET',
        url: `/admin/customers/new`,
        headers: { cookie: cookieHeader(jar) },
      });
      const csrf = extractInputValue(detailGet.body, '_csrf');
      mergeCookies(jar, detailGet);

      const r = await app.inject({
        method: 'POST',
        url: '/admin/customers/not-a-uuid/suspend',
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(r.statusCode).toBe(404);
      expect(r.body).toMatch(/customer not found/i);
    });

    it('detail page surfaces the right action button per status (active=Suspend+Archive, suspended=Reactivate+Archive, archived=none)', async () => {
      // Three independent customers, one per status.
      const { customerId: cActive } = await seedActiveCustomerSession('btnactive');
      const { customerId: cSuspended } = await seedActiveCustomerSession('btnsusp');
      await customersService.suspendCustomer(db, { customerId: cSuspended }, baseCtx());
      const { customerId: cArchived } = await seedActiveCustomerSession('btnarch');
      await customersService.archiveCustomer(db, { customerId: cArchived }, baseCtx());

      const { jar } = await loginAdmin('btn');

      const active = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cActive}`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(active.body).toMatch(/action="\/admin\/customers\/[^"]+\/suspend"/);
      expect(active.body).toMatch(/action="\/admin\/customers\/[^"]+\/archive"/);
      expect(active.body).not.toMatch(/action="\/admin\/customers\/[^"]+\/reactivate"/);

      const suspended = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cSuspended}`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(suspended.body).toMatch(/action="\/admin\/customers\/[^"]+\/reactivate"/);
      expect(suspended.body).toMatch(/action="\/admin\/customers\/[^"]+\/archive"/);
      expect(suspended.body).not.toMatch(/action="\/admin\/customers\/[^"]+\/suspend"/);

      const archived = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cArchived}`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(archived.body).not.toMatch(/action="\/admin\/customers\/[^"]+\/suspend"/);
      expect(archived.body).not.toMatch(/action="\/admin\/customers\/[^"]+\/reactivate"/);
      expect(archived.body).not.toMatch(/action="\/admin\/customers\/[^"]+\/archive"/);
    });

    it('M2: transition audits are flagged visible_to_customer=TRUE', async () => {
      const { customerId } = await seedActiveCustomerSession('m2vis');

      await customersService.suspendCustomer(db, { customerId }, baseCtx());
      await customersService.reactivateCustomer(db, { customerId }, baseCtx());
      await customersService.archiveCustomer(db, { customerId }, baseCtx());

      const r = await sql`
        SELECT action, visible_to_customer FROM audit_log
         WHERE target_id = ${customerId}::uuid
           AND action IN ('customer.suspended', 'customer.reactivated', 'customer.archived')
         ORDER BY ts ASC
      `.execute(db);
      expect(r.rows).toHaveLength(3);
      for (const row of r.rows) {
        expect(row.visible_to_customer).toBe(true);
      }
    });

    it('POST /admin/customers/:id/suspend → 303 detail page; CSRF + admin gate enforced', async () => {
      const { customerId } = await seedCustomer('routesusp');
      const { jar } = await loginAdmin('routesusp');

      // Pull a CSRF token from the detail page (it's embedded in the
      // suspend / archive forms there).
      const detailGet = await app.inject({
        method: 'GET',
        url: `/admin/customers/${customerId}`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(detailGet.statusCode).toBe(200);
      const csrf = extractInputValue(detailGet.body, '_csrf');
      expect(csrf).toBeTruthy();
      mergeCookies(jar, detailGet);

      // POST without CSRF → 403/400
      const noCsrf = await app.inject({
        method: 'POST',
        url: `/admin/customers/${customerId}/suspend`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      expect([403, 400]).toContain(noCsrf.statusCode);

      // Unauth GET → 302 /login (admin gate). The corresponding unauth POST
      // is bounced earlier by the csrfProtection preHandler (no signed
      // csrf cookie on a fresh request) — both 403 and 302-to-login are
      // secure outcomes; the gate ordering is enforced separately by the
      // admin-customers list test in tests/integration/admin/.
      const unauth = await app.inject({
        method: 'GET',
        url: `/admin/customers/${customerId}`,
      });
      expect(unauth.statusCode).toBe(302);
      expect(unauth.headers.location).toBe('/login');

      // Authed + CSRF → 303 to detail page
      const ok = await app.inject({
        method: 'POST',
        url: `/admin/customers/${customerId}/suspend`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toBe(`/admin/customers/${customerId}`);

      const customer = await findCustomerById(db, customerId);
      expect(customer.status).toBe('suspended');
    });
  });
});
