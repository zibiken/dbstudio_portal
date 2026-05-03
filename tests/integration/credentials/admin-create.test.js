import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as projectsService from '../../../domain/projects/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import * as credentialsRepo from '../../../domain/credentials/repo.js';
import { unwrapDek, decrypt } from '../../../lib/crypto/envelope.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { unlockVault } from '../../../lib/auth/vault-lock.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_admin_create_${Date.now()}`;

describe.skipIf(skip)('credentials/service createByAdmin', () => {
  let db, kek, app;
  const ctx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.10',
    userAgentHash: 'h',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM phase_checklist_items WHERE phase_id IN (SELECT id FROM project_phases WHERE project_id IN (SELECT id FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})))`.execute(db);
    await sql`DELETE FROM project_phases WHERE project_id IN (SELECT id FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}))`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    const userIdsR = await sql`SELECT id FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await pruneTestPollution(db, { recipientIds: userIdsR.rows.map(r => r.id) });
    const adminIdsR = await sql`SELECT id FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTestPollution(db, { recipientIds: adminIdsR.rows.map(r => r.id) });
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function makeCustomer(suffix) {
    return await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `U ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, ctx());
  }

  async function makeAdminId(suffix) {
    const created = await adminsService.create(db, { email: `${tag}+${suffix}@example.com`, name: `A ${suffix}` }, { actorType: 'system', audit: { tag } });
    await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'a-pw-shouldnt-matter-12345' }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
    return created.id;
  }

  it('encrypts payload under the customer DEK and writes a customer-visible audit row', async () => {
    const c = await makeCustomer('happy');
    const adminId = await makeAdminId('a-happy');
    const r = await credentialsService.createByAdmin(db, {
      adminId,
      customerId: c.customerId,
      provider: 'github',
      label: 'GitHub deploy key',
      payload: { token: 'gh-secret-' + Date.now() },
      projectId: null,
    }, ctx());
    expect(r.credentialId).toMatch(/^[0-9a-f-]{36}$/);

    const cred = await credentialsRepo.findCredentialById(db, r.credentialId);
    expect(cred.created_by).toBe('admin');
    expect(cred.project_id).toBeNull();
    expect(cred.provider).toBe('github');

    const cust = await sql`SELECT dek_ciphertext, dek_iv, dek_tag FROM customers WHERE id = ${c.customerId}::uuid`.execute(db);
    const dek = unwrapDek({ ciphertext: cust.rows[0].dek_ciphertext, iv: cust.rows[0].dek_iv, tag: cust.rows[0].dek_tag }, kek);
    const plaintext = decrypt({ ciphertext: cred.payload_ciphertext, iv: cred.payload_iv, tag: cred.payload_tag }, dek).toString('utf8');
    expect(JSON.parse(plaintext)).toEqual({ token: expect.stringContaining('gh-secret-') });

    const audit = await sql`SELECT action, visible_to_customer, metadata, actor_type FROM audit_log WHERE target_id = ${r.credentialId}::uuid ORDER BY ts`.execute(db);
    expect(audit.rows[0].action).toBe('credential.created');
    expect(audit.rows[0].visible_to_customer).toBe(true);
    expect(audit.rows[0].actor_type).toBe('admin');
    expect(audit.rows[0].metadata.createdBy).toBe('admin');

    const digest = await sql`SELECT recipient_type, recipient_id, event_type FROM pending_digest_items WHERE metadata->>'credentialId' = ${r.credentialId}`.execute(db);
    expect(digest.rows.some(row => row.recipient_type === 'customer_user')).toBe(true);
    expect(digest.rows.every(row => row.event_type === 'credential.created')).toBe(true);
  });

  it('rejects when project does not belong to the customer', async () => {
    const a = await makeCustomer('xa');
    const b = await makeCustomer('xb');
    const adminId = await makeAdminId('a-xc');
    const pj = await projectsService.create(db, { customerId: b.customerId, name: 'B-pj', objetoProyecto: 'x' }, ctx());
    await expect(credentialsService.createByAdmin(db, {
      adminId,
      customerId: a.customerId,
      provider: 'aws',
      label: 'whatever',
      payload: { x: '1' },
      projectId: pj.projectId,
    }, ctx())).rejects.toThrow();
  });

  it('throws when KEK is absent (vault locked)', async () => {
    const c = await makeCustomer('lock');
    const adminId = await makeAdminId('a-lock');
    await expect(credentialsService.createByAdmin(db, {
      adminId,
      customerId: c.customerId,
      provider: 'aws',
      label: 'no-kek',
      payload: { x: '1' },
    }, { ...ctx(), kek: undefined })).rejects.toThrow();
  });
});
