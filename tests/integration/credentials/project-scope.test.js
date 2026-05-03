// Integration tests for G4 — credentials per-project scope.
// Cover: nullable project_id on create, cross-customer project rejection,
// project change writes a credential.project_changed audit row, and
// listCredentialsByProject scopes correctly.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import * as credentialsRepo from '../../../domain/credentials/repo.js';
import * as projectsService from '../../../domain/projects/service.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_scope_${Date.now()}`;

describe.skipIf(skip)('credentials/service project scope (G4)', () => {
  let db;
  let kek;
  let createdCustomerIds = [];

  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.10',
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
    createdCustomerIds.push(r.customerId);
    return r;
  }

  async function makeProject(customerId, name) {
    const r = await projectsService.create(db, {
      customerId,
      name,
      objetoProyecto: `objective for ${name}`,
    }, baseCtx());
    return r.projectId;
  }

  async function cleanup() {
    await sql`DELETE FROM credentials WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  }

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.destroy();
  });

  beforeEach(async () => {
    createdCustomerIds = [];
    await cleanup();
  });

  it('createByCustomer with projectId persists project_id and lists it back', async () => {
    const { customerId, primaryUserId } = await makeCustomer('list');
    const projectId = await makeProject(customerId, 'Phase 1');

    const r = await credentialsService.createByCustomer(db, {
      customerId,
      customerUserId: primaryUserId,
      provider: 'AWS',
      label: 'staging deploy key',
      payload: { access_key: 'AKIA', secret: 'shh' },
      projectId,
    }, baseCtx());

    const row = await credentialsRepo.findCredentialById(db, r.credentialId);
    expect(row.project_id).toBe(projectId);

    const list = await credentialsRepo.listCredentialsByCustomer(db, customerId);
    expect(list).toHaveLength(1);
    expect(list[0].project_id).toBe(projectId);

    const scoped = await credentialsRepo.listCredentialsByProject(db, customerId, projectId);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).toBe(r.credentialId);
  });

  it('createByCustomer without projectId persists NULL (company-wide) and is excluded from per-project list', async () => {
    const { customerId, primaryUserId } = await makeCustomer('cw');
    const projectId = await makeProject(customerId, 'Phase X');

    const r = await credentialsService.createByCustomer(db, {
      customerId,
      customerUserId: primaryUserId,
      provider: 'GitHub',
      label: 'org-wide token',
      payload: { token: 't' },
      // no projectId
    }, baseCtx());

    const row = await credentialsRepo.findCredentialById(db, r.credentialId);
    expect(row.project_id).toBeNull();

    const scoped = await credentialsRepo.listCredentialsByProject(db, customerId, projectId);
    expect(scoped).toHaveLength(0);
  });

  it('rejects projectId that belongs to a different customer (ProjectScopeError)', async () => {
    const a = await makeCustomer('a');
    const b = await makeCustomer('b');
    const bProject = await makeProject(b.customerId, 'B-only project');

    await expect(credentialsService.createByCustomer(db, {
      customerId: a.customerId,
      customerUserId: a.primaryUserId,
      provider: 'X',
      label: 'cross',
      payload: { v: 1 },
      projectId: bProject,
    }, baseCtx())).rejects.toMatchObject({ code: 'PROJECT_SCOPE' });
  });

  it('updateByCustomer changing scope writes credential.project_changed audit + flips project_id', async () => {
    const { customerId, primaryUserId } = await makeCustomer('move');
    const projectId = await makeProject(customerId, 'Phase 1');

    const create = await credentialsService.createByCustomer(db, {
      customerId,
      customerUserId: primaryUserId,
      provider: 'AWS',
      label: 'starts company-wide',
      payload: { v: 1 },
    }, baseCtx());
    expect((await credentialsRepo.findCredentialById(db, create.credentialId)).project_id).toBeNull();

    await credentialsService.updateByCustomer(db, {
      customerUserId: primaryUserId,
      credentialId: create.credentialId,
      projectId,
    }, baseCtx());

    const after = await credentialsRepo.findCredentialById(db, create.credentialId);
    expect(after.project_id).toBe(projectId);

    const audits = await sql`
      SELECT action, metadata FROM audit_log
       WHERE target_id = ${create.credentialId}::uuid
         AND metadata->>'tag' = ${tag}
       ORDER BY ts ASC
    `.execute(db);
    const actions = audits.rows.map((r) => r.action);
    expect(actions).toContain('credential.project_changed');
    const change = audits.rows.find((r) => r.action === 'credential.project_changed');
    expect(change.metadata.fromProjectId).toBeNull();
    expect(change.metadata.toProjectId).toBe(projectId);
  });

  it('updateByCustomer without projectId leaves project_id unchanged (label-only update)', async () => {
    const { customerId, primaryUserId } = await makeCustomer('label-only');
    const projectId = await makeProject(customerId, 'Phase 1');

    const create = await credentialsService.createByCustomer(db, {
      customerId, customerUserId: primaryUserId,
      provider: 'AWS', label: 'original', payload: { v: 1 },
      projectId,
    }, baseCtx());

    await credentialsService.updateByCustomer(db, {
      customerUserId: primaryUserId,
      credentialId: create.credentialId,
      label: 'renamed',
    }, baseCtx());

    const after = await credentialsRepo.findCredentialById(db, create.credentialId);
    expect(after.label).toBe('renamed');
    expect(after.project_id).toBe(projectId);

    const changeRows = await sql`
      SELECT 1 FROM audit_log
       WHERE target_id = ${create.credentialId}::uuid
         AND action = 'credential.project_changed'
         AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(changeRows.rows).toHaveLength(0);
  });

  it('updateByCustomer rejects cross-customer projectId on rescope', async () => {
    const a = await makeCustomer('rescope-a');
    const b = await makeCustomer('rescope-b');
    const bProject = await makeProject(b.customerId, 'B project');

    const cred = await credentialsService.createByCustomer(db, {
      customerId: a.customerId,
      customerUserId: a.primaryUserId,
      provider: 'X', label: 'a-cred', payload: { v: 1 },
    }, baseCtx());

    await expect(credentialsService.updateByCustomer(db, {
      customerUserId: a.primaryUserId,
      credentialId: cred.credentialId,
      projectId: bProject,
    }, baseCtx())).rejects.toMatchObject({ code: 'PROJECT_SCOPE' });
  });
});
