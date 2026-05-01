import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as svc from '../../../domain/customer-questions/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cq_pages_${Date.now()}`;

describe.skipIf(skip)('admin customer-questions pages', () => {
  let app;
  let db;
  let adminId;
  let adminCookie;
  let customerId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    app = await build({ skipSafetyCheck: true });

    const created = await adminsService.create(
      db,
      { email: `${tag}+a@example.com`, name: 'Admin A' },
      { actorType: 'system', audit: { tag } },
    );
    await adminsService.consumeInvite(
      db,
      { token: created.inviteToken, newPassword: 'admin-pw-doesnt-matter-12345' },
      { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) },
    );
    adminId = created.id;
    const sid = await createSession(db, { userType: 'admin', userId: adminId, ip: '127.0.0.1' });
    await stepUp(db, sid);
    adminCookie = `sid=${app.signCookie(sid)}`;

    customerId = uuidv7();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (${customerId}::uuid, ${tag + ' Acme'}, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea)
    `.execute(db);
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM customer_questions WHERE customer_id = ${customerId}::uuid`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id = ${adminId}::uuid`.execute(db);
    await pruneTestPollution(db, { recipientIds: [adminId] });
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
    await sql`DELETE FROM customers WHERE id = ${customerId}::uuid`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  it('GET /admin/customers/:cid/questions renders list with the resource-type header', async () => {
    await svc.createQuestion(db, {
      customerId,
      createdByAdminId: adminId,
      question: 'What hosting provider do you currently use?',
    }, { ip: '127.0.0.1', userAgentHash: null, audit: { tag } });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/questions`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ADMIN · CUSTOMERS');
    expect(res.body).toMatch(/<h1[^>]*page-header__title[^>]*>Questions<\/h1>/);
    expect(res.body).toContain(tag + ' Acme');
    expect(res.body).toMatch(/What hosting provider do you currently use\?/);
  });

  it('GET /admin/customers/:cid/questions/:qid renders detail with status branch', async () => {
    const q = await svc.createQuestion(db, {
      customerId,
      createdByAdminId: adminId,
      question: 'Backup strategy?',
    }, { ip: '127.0.0.1', userAgentHash: null, audit: { tag } });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/questions/${q.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<h1[^>]*page-header__title[^>]*>Question<\/h1>/);
    expect(res.body).toContain('Backup strategy?');
    expect(res.body).toContain('Awaiting customer response');
  });
});
