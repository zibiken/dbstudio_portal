import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import * as crService from '../../../domain/credential-requests/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { listCredentialActivityForCustomer } from '../../../lib/activity-feed.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_feed_${Date.now()}`;

// Customer activity-feed slice for the vault (Task 7.5):
//   - Reads only audit rows scoped to the customer that the requester is
//     a member of, AND only rows with visible_to_customer=true.
//   - Resolves admin actors to admins.name (the operator's display name).
//     NEVER exposes admins.email to a customer audit consumer.
//   - Strips IP + user_agent_hash from the returned shape (those columns
//     are operator-forensic, not for customer display).
//   - Returns a stable shape that the M9 activity feed UI can render.
describe.skipIf(skip)('listCredentialActivityForCustomer (Task 7.5)', () => {
  let db;
  let kek;
  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.70',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  async function makeAdmin(suffix, name) {
    const created = await adminsService.create(
      db,
      { email: `${tag}+${suffix}@example.com`, name },
      { actorType: 'system', audit: { tag } },
    );
    await adminsService.consumeInvite(
      db,
      { token: created.inviteToken, newPassword: 'admin-pw-shouldnt-matter-7283' },
      { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) },
    );
    return created.id;
  }

  async function makeCustomer(suffix) {
    return await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}-user@example.com` },
    }, baseCtx());
  }

  async function makeAdminSession(adminId) {
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    await stepUp(db, sid);
    return sid;
  }

  async function cleanup() {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    // credential_requests.fulfilled_credential_id FKs into credentials —
    // requests must be deleted before the credentials they point at.
    await sql`DELETE FROM credential_requests WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
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
    await cleanup();
  });

  it('returns the customer\'s credential audit slice in newest-first order with display names + redacted shape', async () => {
    const adminId = await makeAdmin('admin1', 'Bram (operator)');
    const sid = await makeAdminSession(adminId);
    const { customerId, primaryUserId } = await makeCustomer('co');

    // Drive a workflow: admin creates request, customer fulfils,
    // admin views the resulting credential, admin marks needs_update,
    // customer rotates payload, admin views again, customer deletes.
    const req = await crService.createByAdmin(db, {
      adminId, customerId, provider: 'github',
      fields: [
        { name: 'username', label: 'Username', type: 'text', required: true },
        { name: 'token', label: 'Token', type: 'secret', required: true },
      ],
    }, baseCtx());

    const fulfilled = await crService.fulfilByCustomer(db, {
      customerUserId: primaryUserId,
      requestId: req.requestId,
      payload: { username: 'alice', token: 'gh_xyz_secret' },
      label: 'GitHub CI',
    }, baseCtx());

    await credentialsService.view(db, {
      adminId, sessionId: sid, credentialId: fulfilled.credentialId,
    }, baseCtx());

    await credentialsService.markNeedsUpdate(db, {
      adminId, credentialId: fulfilled.credentialId,
    }, baseCtx());

    await credentialsService.updateByCustomer(db, {
      customerUserId: primaryUserId,
      credentialId: fulfilled.credentialId,
      payload: { username: 'alice', token: 'gh_rotated_secret' },
    }, baseCtx());

    await credentialsService.deleteByCustomer(db, {
      customerUserId: primaryUserId,
      credentialId: fulfilled.credentialId,
    }, baseCtx());

    const feed = await listCredentialActivityForCustomer(db, customerId);

    // Newest-first ordering.
    const timestamps = feed.map((r) => new Date(r.ts).getTime());
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }

    // Expected actions in the slice (scoped to credential.* and
    // credential_request.*, visible_to_customer only):
    const actions = feed.map((r) => r.action);
    expect(actions).toContain('credential_request.created');
    expect(actions).toContain('credential_request.fulfilled');
    expect(actions).toContain('credential.created');
    expect(actions).toContain('credential.viewed');
    expect(actions).toContain('credential.needs_update_marked');
    expect(actions).toContain('credential.updated');
    expect(actions).toContain('credential.deleted');

    // Every row carries a stable display shape: id, ts, actor_type,
    // actor_display_name, action, target_type, target_id, label,
    // metadata (subset, scrubbed of operator-forensic fields).
    for (const row of feed) {
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof row.ts).toBe('object'); // Date or ISO via pg
      expect(['admin', 'customer', 'system']).toContain(row.actor_type);
      expect(typeof row.action).toBe('string');
      expect(typeof row.label).toBe('string');
      expect(row.label.length).toBeGreaterThan(0);
      // Operator-forensic fields MUST NOT appear.
      expect(row).not.toHaveProperty('ip');
      expect(row).not.toHaveProperty('user_agent_hash');
      expect(row).not.toHaveProperty('userAgentHash');
      expect(row.metadata).not.toHaveProperty('tag');
    }

    // Admin-actor rows carry actor_display_name = admins.name.
    const adminRows = feed.filter((r) => r.actor_type === 'admin');
    expect(adminRows.length).toBeGreaterThan(0);
    for (const row of adminRows) {
      expect(row.actor_display_name).toBe('Bram (operator)');
      // Admin email MUST NEVER leak through to the customer feed.
      const json = JSON.stringify(row);
      expect(json).not.toContain('@example.com');
      expect(json).not.toContain(`${tag}+admin1`);
    }

    // Customer-actor rows have actor_display_name = the customer_user's name.
    const customerRows = feed.filter((r) => r.actor_type === 'customer');
    expect(customerRows.length).toBeGreaterThan(0);
    for (const row of customerRows) {
      expect(row.actor_display_name).toBe('User co');
    }

    // Plaintext payload values MUST NEVER reach the feed (defence in
    // depth — the audit-write side already scrubs, this is the read-side
    // assertion).
    const allJson = JSON.stringify(feed);
    expect(allJson).not.toContain('gh_xyz_secret');
    expect(allJson).not.toContain('gh_rotated_secret');
  });

  it('does NOT bleed audit rows from another customer', async () => {
    const adminId = await makeAdmin('admin2', 'Op');
    const a = await makeCustomer('alice');
    const b = await makeCustomer('bob');

    await crService.createByAdmin(db, {
      adminId, customerId: a.customerId, provider: 'aws',
      fields: [{ name: 'access_key_id', label: 'AKID', type: 'text', required: true }],
    }, baseCtx());
    await crService.createByAdmin(db, {
      adminId, customerId: b.customerId, provider: 'github',
      fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }],
    }, baseCtx());

    const aFeed = await listCredentialActivityForCustomer(db, a.customerId);
    const bFeed = await listCredentialActivityForCustomer(db, b.customerId);

    expect(aFeed.length).toBeGreaterThanOrEqual(1);
    expect(bFeed.length).toBeGreaterThanOrEqual(1);
    for (const row of aFeed) {
      expect(JSON.stringify(row)).not.toContain('github');
    }
    for (const row of bFeed) {
      expect(JSON.stringify(row)).not.toContain('aws');
    }
  });

  it('does NOT include rows where visible_to_customer=false (e.g. integrity audits)', async () => {
    const adminId = await makeAdmin('admin3', 'Op3');
    const { customerId, primaryUserId } = await makeCustomer('forensic-co');

    // Insert a synthetic operator-forensic audit row scoped to a fake
    // credential id. It should NOT show up in the customer feed.
    const credentialId = '11111111-1111-7111-8111-111111111111';
    await sql`
      INSERT INTO audit_log (id, actor_type, actor_id, action, target_type, target_id, metadata, visible_to_customer)
      VALUES (gen_random_uuid(), 'system', NULL, 'document.file_integrity_failure',
              'credential', ${credentialId}::uuid,
              ${JSON.stringify({ tag, customerId, label: 'forensic' })}::jsonb, FALSE)
    `.execute(db);

    // Plus a customer-visible row to confirm the filter applies row-by-row.
    await credentialsService.createByCustomer(db, {
      customerId, customerUserId: primaryUserId,
      provider: 'github', label: 'normal', payload: { token: 't' },
    }, baseCtx());

    const feed = await listCredentialActivityForCustomer(db, customerId);
    const actions = feed.map((r) => r.action);
    expect(actions).not.toContain('document.file_integrity_failure');
    expect(actions).toContain('credential.created');
  });

  it('strips unknown metadata keys via an explicit allow-list (M7 review M1 — hardens against future audit-writer drift)', async () => {
    // Synthesise an audit row whose metadata carries fields the
    // activity-feed reader has never been asked to expose. The reader
    // MUST NOT pass them through; even though current writers all stamp
    // a known shape, "trust the writer" leaks under future drift.
    const customer = await makeCustomer('allowlist');
    const credentialId = '22222222-2222-7222-8222-222222222222';
    await sql`
      INSERT INTO audit_log (id, actor_type, actor_id, action, target_type, target_id, metadata, visible_to_customer)
      VALUES (gen_random_uuid(), 'admin', NULL, 'credential.viewed',
              'credential', ${credentialId}::uuid,
              ${JSON.stringify({
                tag,
                customerId: customer.customerId,
                provider: 'GitHub',
                label: 'Allowlist test',
                // The leak-bait fields:
                adminEmail: 'leaked@example.com',
                rawPayloadSnippet: 'gh_should_never_appear',
                userAgentHash: 'should-not-render',
                ip: '127.0.0.1',
              })}::jsonb, TRUE)
    `.execute(db);

    const feed = await listCredentialActivityForCustomer(db, customer.customerId);
    expect(feed).toHaveLength(1);
    const row = feed[0];

    // The known-good keys came through.
    expect(row.label).toBe('Allowlist test');
    expect(row.metadata.provider).toBe('GitHub');
    expect(row.metadata.customerId).toBe(customer.customerId);

    // The leak-bait keys did NOT.
    expect(row.metadata).not.toHaveProperty('adminEmail');
    expect(row.metadata).not.toHaveProperty('rawPayloadSnippet');
    expect(row.metadata).not.toHaveProperty('userAgentHash');
    expect(row.metadata).not.toHaveProperty('ip');

    const json = JSON.stringify(row);
    expect(json).not.toContain('leaked@example.com');
    expect(json).not.toContain('gh_should_never_appear');
  });

  it('respects the limit option (default 50; explicit limit clamps the slice)', async () => {
    const adminId = await makeAdmin('admin4', 'Op4');
    const { customerId, primaryUserId } = await makeCustomer('limit-co');

    for (let i = 0; i < 7; i += 1) {
      await credentialsService.createByCustomer(db, {
        customerId, customerUserId: primaryUserId,
        provider: 'github', label: `L${i}`, payload: { token: `t${i}` },
      }, baseCtx());
    }

    const feed = await listCredentialActivityForCustomer(db, customerId, { limit: 3 });
    expect(feed.length).toBeLessThanOrEqual(3);
    // Newest first.
    const labels = feed.map((r) => r.label);
    expect(labels[0]).toBe('L6');
  });
});
