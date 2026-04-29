import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as projectsService from '../../../domain/projects/service.js';
import {
  findProjectById,
  listProjectsByCustomer,
} from '../../../domain/projects/repo.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `proj_test_${Date.now()}`;

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

describe.skipIf(skip)('projects CRUD', () => {
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

  async function makeCustomer(suffix) {
    const r = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, baseCtx());
    return r;
  }

  async function loginAdminFully(suffix, password = 'admin-pw-928374-strong') {
    const created = await adminsService.create(db, {
      email: `${tag}+adm-${suffix}@example.com`, name: `Admin ${suffix}`,
    }, { actorType: 'system', audit: { tag } });
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
    await adminsService.consumeInvite(db, {
      token: created.inviteToken, newPassword: password,
    }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    await adminsService.enroll2faTotp(db, {
      adminId: created.id, secret: enrolSecret, kek: app.kek,
    }, { audit: { tag } });

    const jar = {};
    const lGet = await app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, lGet);
    const lCsrf = extractInputValue(lGet.body, '_csrf');
    const lOk = await app.inject({
      method: 'POST', url: '/login',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(`${tag}+adm-${suffix}@example.com`)}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
    });
    expect(lOk.statusCode).toBe(302);
    mergeCookies(jar, lOk);
    const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(jar) } });
    mergeCookies(jar, cGet);
    const cCsrf = extractInputValue(cGet.body, '_csrf');
    const cOk = await app.inject({
      method: 'POST', url: '/login/2fa',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `method=totp&totp_code=${generateToken(enrolSecret)}&_csrf=${encodeURIComponent(cCsrf)}`,
    });
    expect(cOk.statusCode).toBe(302);
    mergeCookies(jar, cOk);
    return jar;
  }

  async function loginCustomerFully(inviteToken) {
    const r = await customersService.completeCustomerWelcome(db, {
      token: inviteToken,
      newPassword: 'customer-pw-928374-strong',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      kek,
      sessionIp: '198.51.100.7',
      sessionDeviceFingerprint: null,
    }, { hibpHasBeenPwned: vi.fn(async () => false), audit: { tag } });
    return { jar: { sid: app.signCookie(r.sid) } };
  }

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM projects WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (
      SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}
      UNION SELECT id FROM admins WHERE email LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM projects WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (
      SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}
      UNION SELECT id FROM admins WHERE email LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  describe('service.create', () => {
    it('inserts a project with active status, audits visible_to_customer', async () => {
      const cust = await makeCustomer('create-happy');
      const r = await projectsService.create(db, {
        customerId: cust.customerId,
        name: 'Phase 1',
        objetoProyecto: 'Migrate the storefront onto a new stack',
      }, baseCtx());

      expect(r.projectId).toMatch(/^[0-9a-f-]{36}$/);
      const row = await findProjectById(db, r.projectId);
      expect(row).not.toBeNull();
      expect(row.customer_id).toBe(cust.customerId);
      expect(row.name).toBe('Phase 1');
      expect(row.objeto_proyecto).toBe('Migrate the storefront onto a new stack');
      expect(row.status).toBe('active');

      const audit = await sql`
        SELECT action, target_type, target_id, visible_to_customer
          FROM audit_log
         WHERE action = 'project.created' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].target_type).toBe('project');
      expect(audit.rows[0].target_id).toBe(r.projectId);
      expect(audit.rows[0].visible_to_customer).toBe(true);
    });

    it('rejects when objeto_proyecto is missing or empty (NDA in M8 needs it)', async () => {
      const cust = await makeCustomer('create-nopurpose');
      await expect(
        projectsService.create(db, {
          customerId: cust.customerId,
          name: 'No-purpose project',
          objetoProyecto: '',
        }, baseCtx()),
      ).rejects.toThrow(/objeto/i);

      await expect(
        projectsService.create(db, {
          customerId: cust.customerId,
          name: 'Also missing',
        }, baseCtx()),
      ).rejects.toThrow(/objeto/i);
    });

    it('rejects when name is missing', async () => {
      const cust = await makeCustomer('create-noname');
      await expect(
        projectsService.create(db, {
          customerId: cust.customerId,
          name: '',
          objetoProyecto: 'something',
        }, baseCtx()),
      ).rejects.toThrow(/name/i);
    });

    it('rejects an unknown customer id', async () => {
      const ghost = uuidv7();
      await expect(
        projectsService.create(db, {
          customerId: ghost,
          name: 'X',
          objetoProyecto: 'Y',
        }, baseCtx()),
      ).rejects.toThrow();
    });
  });

  describe('service.update / updateStatus', () => {
    it('updates name and/or objeto_proyecto with an audit row', async () => {
      const cust = await makeCustomer('update-fields');
      const c = await projectsService.create(db, {
        customerId: cust.customerId,
        name: 'Old',
        objetoProyecto: 'old purpose',
      }, baseCtx());

      await projectsService.update(db, {
        projectId: c.projectId,
        name: 'New',
        objetoProyecto: 'new purpose',
      }, baseCtx());

      const row = await findProjectById(db, c.projectId);
      expect(row.name).toBe('New');
      expect(row.objeto_proyecto).toBe('new purpose');

      const audit = await sql`
        SELECT action FROM audit_log
         WHERE action = 'project.updated' AND target_id = ${c.projectId}::uuid
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
    });

    it('logs every status transition with visible_to_customer audit (free in v1)', async () => {
      const cust = await makeCustomer('status-log');
      const c = await projectsService.create(db, {
        customerId: cust.customerId,
        name: 'Lifecycle',
        objetoProyecto: 'Walk the lifecycle',
      }, baseCtx());

      for (const next of ['paused', 'active', 'done', 'archived']) {
        await projectsService.updateStatus(db, {
          projectId: c.projectId, status: next,
        }, baseCtx());
        const row = await findProjectById(db, c.projectId);
        expect(row.status).toBe(next);
      }

      const audit = await sql`
        SELECT metadata->>'newStatus' AS new_status, visible_to_customer
          FROM audit_log
         WHERE action = 'project.status_changed'
           AND target_id = ${c.projectId}::uuid
         ORDER BY ts ASC
      `.execute(db);
      expect(audit.rows.map(r => r.new_status)).toEqual(['paused', 'active', 'done', 'archived']);
      for (const r of audit.rows) expect(r.visible_to_customer).toBe(true);
    });

    it('rejects an invalid status value', async () => {
      const cust = await makeCustomer('status-invalid');
      const c = await projectsService.create(db, {
        customerId: cust.customerId, name: 'X', objetoProyecto: 'Y',
      }, baseCtx());
      await expect(
        projectsService.updateStatus(db, {
          projectId: c.projectId, status: 'banana',
        }, baseCtx()),
      ).rejects.toThrow(/status/i);
    });
  });

  describe('repo.listProjectsByCustomer', () => {
    it('returns only the given customer\'s projects, newest first', async () => {
      const a = await makeCustomer('list-a');
      const b = await makeCustomer('list-b');
      await projectsService.create(db, { customerId: a.customerId, name: 'A1', objetoProyecto: 'a1' }, baseCtx());
      await projectsService.create(db, { customerId: a.customerId, name: 'A2', objetoProyecto: 'a2' }, baseCtx());
      await projectsService.create(db, { customerId: b.customerId, name: 'B1', objetoProyecto: 'b1' }, baseCtx());

      const aRows = await listProjectsByCustomer(db, a.customerId);
      expect(aRows).toHaveLength(2);
      expect(aRows.every(r => r.customer_id === a.customerId)).toBe(true);
      const bRows = await listProjectsByCustomer(db, b.customerId);
      expect(bRows).toHaveLength(1);
      expect(bRows[0].customer_id).toBe(b.customerId);
    });
  });

  describe('admin HTTP routes', () => {
    it('redirects unauthenticated GET to /login', async () => {
      const cust = await makeCustomer('http-unauth');
      const r = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cust.customerId}/projects`,
      });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('/login');
    });

    it('happy path: list (empty) → new → POST → list shows the project', async () => {
      const cust = await makeCustomer('http-happy');
      const jar = await loginAdminFully('http-happy');

      const list0 = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cust.customerId}/projects`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(list0.statusCode).toBe(200);

      const newGet = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cust.customerId}/projects/new`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(newGet.statusCode).toBe(200);
      mergeCookies(jar, newGet);
      const csrf = extractInputValue(newGet.body, '_csrf');
      expect(csrf).toBeTruthy();

      const post = await app.inject({
        method: 'POST',
        url: `/admin/customers/${cust.customerId}/projects`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `name=${encodeURIComponent('HTTP project')}&objeto_proyecto=${encodeURIComponent('Build the thing')}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(302);
      expect(post.headers.location).toMatch(`/admin/customers/${cust.customerId}/projects/`);

      const list1 = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cust.customerId}/projects`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(list1.statusCode).toBe(200);
      expect(list1.body).toContain('HTTP project');
    });

    it('rejects creation without _csrf with 403', async () => {
      const cust = await makeCustomer('http-nocsrf');
      const jar = await loginAdminFully('http-nocsrf');
      const r = await app.inject({
        method: 'POST',
        url: `/admin/customers/${cust.customerId}/projects`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `name=X&objeto_proyecto=Y`,
      });
      expect(r.statusCode).toBe(403);
    });

    it('edits name + objeto_proyecto via POST /admin/customers/:cid/projects/:id (review I2)', async () => {
      const cust = await makeCustomer('http-edit');
      const jar = await loginAdminFully('http-edit');
      const created = await projectsService.create(db, {
        customerId: cust.customerId,
        name: 'Old name',
        objetoProyecto: 'old purpose with a typo',
      }, baseCtx());

      const detailGet = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cust.customerId}/projects/${created.projectId}`,
        headers: { cookie: cookieHeader(jar) },
      });
      mergeCookies(jar, detailGet);
      const csrf = extractInputValue(detailGet.body, '_csrf');

      const post = await app.inject({
        method: 'POST',
        url: `/admin/customers/${cust.customerId}/projects/${created.projectId}`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `name=${encodeURIComponent('New name')}&objeto_proyecto=${encodeURIComponent('corrected purpose')}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(302);

      const row = await findProjectById(db, created.projectId);
      expect(row.name).toBe('New name');
      expect(row.objeto_proyecto).toBe('corrected purpose');
    });

    it('422 + form-rerender when name or objeto_proyecto missing', async () => {
      const cust = await makeCustomer('http-422');
      const jar = await loginAdminFully('http-422');
      const newGet = await app.inject({
        method: 'GET',
        url: `/admin/customers/${cust.customerId}/projects/new`,
        headers: { cookie: cookieHeader(jar) },
      });
      mergeCookies(jar, newGet);
      const csrf = extractInputValue(newGet.body, '_csrf');

      const r = await app.inject({
        method: 'POST',
        url: `/admin/customers/${cust.customerId}/projects`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `name=&objeto_proyecto=&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(r.statusCode).toBe(422);
    });
  });

  describe('customer HTTP routes', () => {
    it('redirects unauthenticated GET to /', async () => {
      const r = await app.inject({ method: 'GET', url: '/customer/projects' });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('/');
    });

    it('lists only the customer\'s own projects', async () => {
      const owner = await makeCustomer('cp-owner');
      const other = await makeCustomer('cp-other');
      await projectsService.create(db, {
        customerId: owner.customerId, name: 'OWN-PROJECT',
        objetoProyecto: 'visible to me',
      }, baseCtx());
      await projectsService.create(db, {
        customerId: other.customerId, name: 'OTHER-PROJECT',
        objetoProyecto: 'must not be visible',
      }, baseCtx());

      const { jar } = await loginCustomerFully(owner.inviteToken);
      const r = await app.inject({
        method: 'GET',
        url: '/customer/projects',
        headers: { cookie: cookieHeader(jar) },
      });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('OWN-PROJECT');
      expect(r.body).not.toContain('OTHER-PROJECT');
    });
  });
});
