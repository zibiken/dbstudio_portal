// Route-level integration tests for routes/admin/project-phases.js.
// Service-layer behaviour is covered in service.test.js + repo.test.js;
// these tests exercise the HTTP surface: CSRF gate, UUID validation,
// cross-customer / cross-project / cross-phase 404s, the styled
// not-found EJS, the typed-error → flash mapping, and the 303 redirect.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `phaseroutes_${Date.now()}`;

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

describe.skipIf(skip)('admin project-phases routes (HTTP)', () => {
  let app, db, env, customerAId, projectAId, customerBId, projectBId;
  const adminTag = `${tag}_admin`;

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    app = await build({ skipSafetyCheck: true });

    const a = await customersService.create(db, {
      razonSocial: `${tag} A S.L.`,
      primaryUser: { name: 'User A', email: `${tag}+a@example.com` },
    }, { actorType: 'system', audit: { tag }, kek: app.kek, portalBaseUrl: env.PORTAL_BASE_URL });
    customerAId = a.customerId;
    projectAId = uuidv7();
    await sql`
      INSERT INTO projects (id, customer_id, name, objeto_proyecto, status)
      VALUES (${projectAId}::uuid, ${customerAId}::uuid, ${'Project A'}, ${'A'}, 'active')
    `.execute(db);

    const b = await customersService.create(db, {
      razonSocial: `${tag} B S.L.`,
      primaryUser: { name: 'User B', email: `${tag}+b@example.com` },
    }, { actorType: 'system', audit: { tag }, kek: app.kek, portalBaseUrl: env.PORTAL_BASE_URL });
    customerBId = b.customerId;
    projectBId = uuidv7();
    await sql`
      INSERT INTO projects (id, customer_id, name, objeto_proyecto, status)
      VALUES (${projectBId}::uuid, ${customerBId}::uuid, ${'Project B'}, ${'B'}, 'active')
    `.execute(db);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await sql`DELETE FROM phase_checklist_items WHERE phase_id IN (
      SELECT pp.id FROM project_phases pp
        JOIN projects pr ON pr.id = pp.project_id
        JOIN customers c ON c.id = pr.customer_id WHERE c.razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM project_phases WHERE project_id IN (
      SELECT pr.id FROM projects pr JOIN customers c ON c.id = pr.customer_id WHERE c.razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'} OR to_address LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${adminTag + '%'})`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + adminTag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM pending_digest_items WHERE metadata->>'tag' = ${tag}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function loginAdmin(suffix) {
    const password = 'admin-pw-928374-strong';
    const created = await adminsService.create(
      db,
      { email: `${adminTag}+${suffix}@example.com`, name: `Admin ${suffix}` },
      { actorType: 'system', audit: { tag } },
    );
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
      payload: urlencoded({ email: `${adminTag}+${suffix}@example.com`, password, _csrf: lCsrf }),
    });
    expect(lOk.statusCode).toBe(302);
    mergeCookies(jar, lOk);
    const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(jar) } });
    mergeCookies(jar, cGet);
    const cCsrf = extractInputValue(cGet.body, '_csrf');
    const cOk = await app.inject({
      method: 'POST', url: '/login/2fa',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ method: 'totp', totp_code: generateToken(enrolSecret), _csrf: cCsrf }),
    });
    expect(cOk.statusCode).toBe(302);
    mergeCookies(jar, cOk);
    return jar;
  }

  async function csrfFromProjectDetail(jar, customerId, projectId) {
    const r = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/projects/${projectId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(r.statusCode).toBe(200);
    mergeCookies(jar, r);
    const csrf = extractInputValue(r.body, '_csrf');
    expect(csrf).toBeTruthy();
    return csrf;
  }

  async function postPhaseForm(jar, url, fields, { withCsrfHeader = true, csrf } = {}) {
    return app.inject({
      method: 'POST',
      url,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
        ...(withCsrfHeader && csrf ? { 'x-csrf-token': csrf } : {}),
      },
      payload: urlencoded(fields),
    });
  }

  it('POST without _csrf is rejected (403)', async () => {
    const jar = await loginAdmin('csrf');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: urlencoded({ label: 'no-csrf' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('malformed customerId in URL renders the styled 404 EJS, not JSON', async () => {
    const jar = await loginAdmin('badcust');
    const csrf = await csrfFromProjectDetail(jar, customerAId, projectAId);
    const res = await postPhaseForm(jar,
      `/admin/customers/not-a-uuid/projects/${projectAId}/phases`,
      { _csrf: csrf, label: 'x' }, { csrf });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).not.toContain('"error":"not_found"');
  });

  it('malformed phaseId renders the styled 404, not JSON', async () => {
    const jar = await loginAdmin('badphase');
    const csrf = await csrfFromProjectDetail(jar, customerAId, projectAId);
    const res = await postPhaseForm(jar,
      `/admin/customers/${customerAId}/projects/${projectAId}/phases/not-a-uuid/rename`,
      { _csrf: csrf, label: 'x' }, { csrf });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('cross-customer URL (project belongs to customer A, URL says customer B) is 404', async () => {
    const jar = await loginAdmin('crosscust');
    const csrf = await csrfFromProjectDetail(jar, customerBId, projectBId);
    // URL says customerB but projectAId belongs to customerA — guards must 404.
    const res = await postPhaseForm(jar,
      `/admin/customers/${customerBId}/projects/${projectAId}/phases`,
      { _csrf: csrf, label: 'cross-c' }, { csrf });
    expect(res.statusCode).toBe(404);
  });

  it('cross-project URL on phase action (phase belongs to project A, URL says project B) is 404', async () => {
    const jar = await loginAdmin('crossproj');
    // Create a phase on project A first.
    const csrfA = await csrfFromProjectDetail(jar, customerAId, projectAId);
    const create = await postPhaseForm(jar,
      `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
      { _csrf: csrfA, label: 'phase-on-A' }, { csrf: csrfA });
    expect(create.statusCode).toBe(303);
    const phase = await sql`
      SELECT id::text AS id FROM project_phases
       WHERE project_id = ${projectAId}::uuid AND label = ${'phase-on-A'}
    `.execute(db);
    const phaseAOnA = phase.rows[0].id;

    // Now hit /rename via the customerB / projectB URL — must 404 even
    // though the phaseId itself exists.
    const csrfB = await csrfFromProjectDetail(jar, customerBId, projectBId);
    const res = await postPhaseForm(jar,
      `/admin/customers/${customerBId}/projects/${projectBId}/phases/${phaseAOnA}/rename`,
      { _csrf: csrfB, label: 'hijack' }, { csrf: csrfB });
    expect(res.statusCode).toBe(404);
  });

  it('happy path: create phase 303-redirects to project detail, phase row exists', async () => {
    const jar = await loginAdmin('happy');
    const csrf = await csrfFromProjectDetail(jar, customerAId, projectAId);
    const res = await postPhaseForm(jar,
      `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
      { _csrf: csrf, label: 'happy-phase' }, { csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/admin/customers/${customerAId}/projects/${projectAId}`);
    const r = await sql`
      SELECT count(*)::int AS c FROM project_phases
       WHERE project_id = ${projectAId}::uuid AND label = ${'happy-phase'}
    `.execute(db);
    expect(r.rows[0].c).toBe(1);
  });

  it('PHASE_LABEL_INVALID surfaces via phaseError flash query param', async () => {
    const jar = await loginAdmin('emptylabel');
    const csrf = await csrfFromProjectDetail(jar, customerAId, projectAId);
    const res = await postPhaseForm(jar,
      `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
      { _csrf: csrf, label: '   ' }, { csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/phaseError=/);
    expect(decodeURIComponent(res.headers.location)).toContain('Phase label is required.');
  });

  it('PHASE_LABEL_CONFLICT surfaces a specific message (not the generic fallback)', async () => {
    const jar = await loginAdmin('conflict');
    const csrf = await csrfFromProjectDetail(jar, customerAId, projectAId);
    await postPhaseForm(jar,
      `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
      { _csrf: csrf, label: 'dupe-label' }, { csrf });
    const res = await postPhaseForm(jar,
      `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
      { _csrf: csrf, label: 'dupe-label' }, { csrf });
    expect(res.statusCode).toBe(303);
    expect(decodeURIComponent(res.headers.location)).toContain('A phase with that label already exists.');
  });
});
