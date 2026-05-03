// Fragment-mode integration tests: phase routes content-negotiate on
// Accept: text/html-fragment (or ?fragment=row) — return _phase-row.ejs
// fragment for mutations, redirect-with-#phase-<id> otherwise.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as phasesService from '../../../domain/phases/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `phase_frag_${Date.now()}`;

function cookiesFromRes(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr.map(c => c.split(';')[0]).join('; ');
}

describe.skipIf(skip)('phase routes content-negotiate fragment vs redirect', () => {
  let app, db, env, customerId, projectId, phaseId, signedSid;

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    app = await build({ skipSafetyCheck: true, kek: randomBytes(32) });

    const c = await customersService.create(db, {
      razonSocial: `${tag} Co S.L.`,
      primaryUser: { name: 'U', email: `${tag}+u@example.com` },
    }, { actorType: 'system', audit: { tag }, kek: app.kek, portalBaseUrl: env.PORTAL_BASE_URL });
    customerId = c.customerId;
    projectId = uuidv7();
    await sql`
      INSERT INTO projects (id, customer_id, name, objeto_proyecto, status)
      VALUES (${projectId}::uuid, ${customerId}::uuid, ${'P'}, ${'x'}, 'active')
    `.execute(db);
    const ph = await phasesService.create(
      db,
      { projectId, customerId, label: '1' },
      { actorType: 'admin', audit: { tag }, ip: '198.51.100.60', userAgentHash: 'h' },
      { adminId: '00000000-0000-0000-0000-000000000001' },
    );
    phaseId = ph.phaseId;

    const created = await adminsService.create(db, { email: `${tag}+a@example.com`, name: 'A' }, { actorType: 'system', audit: { tag } });
    await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'a-pw-shouldnt-matter-12345' }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    const sid = await createSession(db, { userType: 'admin', userId: created.id, ip: '198.51.100.60' });
    await stepUp(db, sid);
    signedSid = app.signCookie(sid);
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM phase_checklist_items WHERE phase_id IN (SELECT id FROM project_phases WHERE project_id = ${projectId}::uuid)`.execute(db);
    await sql`DELETE FROM project_phases WHERE project_id = ${projectId}::uuid`.execute(db);
    await sql`DELETE FROM projects WHERE id = ${projectId}::uuid`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function getCsrf() {
    const r = await app.inject({ method: 'GET', url: `/admin/customers/${customerId}/projects/${projectId}`, headers: { cookie: 'sid=' + signedSid } });
    expect(r.statusCode).toBe(200);
    const token = (r.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    expect(token).toBeTruthy();
    return { token, cookies: cookiesFromRes(r) };
  }

  it('default redirects with #phase-<id>', async () => {
    const { token, cookies } = await getCsrf();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerId}/projects/${projectId}/phases/${phaseId}/rename`,
      headers: { cookie: 'sid=' + signedSid + (cookies ? '; ' + cookies : ''), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: token, label: '1.5' }).toString(),
    });
    expect([302, 303]).toContain(res.statusCode);
    expect(res.headers.location).toMatch(new RegExp(`^/admin/customers/${customerId}/projects/${projectId}(\\?[^#]*)?#phase-${phaseId}$`));
  });

  it('returns row fragment when Accept: text/html-fragment', async () => {
    const { token, cookies } = await getCsrf();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerId}/projects/${projectId}/phases/${phaseId}/rename`,
      headers: {
        cookie: 'sid=' + signedSid + (cookies ? '; ' + cookies : ''),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html-fragment',
      },
      payload: new URLSearchParams({ _csrf: token, label: '2' }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(new RegExp(`<li class="phase-row card" id="phase-${phaseId}"`));
    expect(res.body).not.toMatch(/<\/html>/i);
  });

  it('returns data-phase-deleted div on delete in fragment mode', async () => {
    // Make a phase to delete (don't delete the shared one).
    const ph = await phasesService.create(
      db,
      { projectId, customerId, label: 'todelete' },
      { actorType: 'admin', audit: { tag }, ip: '198.51.100.60', userAgentHash: 'h' },
      { adminId: '00000000-0000-0000-0000-000000000001' },
    );
    const { token, cookies } = await getCsrf();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerId}/projects/${projectId}/phases/${ph.phaseId}/delete`,
      headers: {
        cookie: 'sid=' + signedSid + (cookies ? '; ' + cookies : ''),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html-fragment',
      },
      payload: new URLSearchParams({ _csrf: token }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(new RegExp(`data-phase-deleted="${ph.phaseId}"`));
  });
});
