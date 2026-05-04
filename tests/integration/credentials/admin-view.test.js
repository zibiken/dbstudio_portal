import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { unlockVault } from '../../../lib/auth/vault-lock.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_admin_view_${Date.now()}`;

describe.skipIf(skip)('admin credential detail + reveal flow', () => {
  let app;
  let db;
  let kek;
  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.40',
    userAgentHash: 'uahash',
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
    if (!db) return;
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    const adminIdsR = await sql`SELECT id FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTestPollution(db, { recipientIds: adminIdsR.rows.map(r => r.id) });
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function makeAdmin(suffix) {
    const created = await adminsService.create(
      db,
      { email: `${tag}+${suffix}@example.com`, name: `Admin ${suffix}` },
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

  async function makeCredential(customerId, customerUserId, payload) {
    return await credentialsService.createByCustomer(db, {
      customerId, customerUserId,
      provider: 'wp-engine',
      label: 'Test cred',
      payload,
    }, baseCtx());
  }

  async function makeAdminSignedCookie(adminId) {
    const sid = await createSession(db, { userType: 'admin', userId: adminId, ip: '198.51.100.40' });
    await stepUp(db, sid);
    return { sid, signed: app.signCookie(sid) };
  }

  it('GET detail with vault locked renders metadata + Reveal button + no plaintext', async () => {
    const adminId = await makeAdmin('lock1');
    const { customerId, primaryUserId } = await makeCustomer('lock1-co');
    const plaintext = 'super-secret-' + Date.now();
    const cred = await makeCredential(customerId, primaryUserId, { password: plaintext });
    const { signed } = await makeAdminSignedCookie(adminId);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/credentials/${cred.credentialId}`,
      headers: { cookie: 'sid=' + signed },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('wp-engine');
    expect(res.body).toMatch(/Reveal/i);
    expect(res.body).not.toContain(plaintext);
  });

  it('GET with mismatched cid + credId returns 404', async () => {
    const adminId = await makeAdmin('xc');
    const { customerId, primaryUserId } = await makeCustomer('xc-a');
    const other = await makeCustomer('xc-b');
    const cred = await makeCredential(customerId, primaryUserId, { password: 'x' });
    const { signed } = await makeAdminSignedCookie(adminId);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${other.customerId}/credentials/${cred.credentialId}`,
      headers: { cookie: 'sid=' + signed },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET ?mode=reveal while vault locked 302s to /admin/step-up?return=…?mode=reveal', async () => {
    const adminId = await makeAdmin('lock2');
    const { customerId, primaryUserId } = await makeCustomer('lock2-co');
    const cred = await makeCredential(customerId, primaryUserId, { password: 'x' });
    const { sid, signed } = await makeAdminSignedCookie(adminId);
    // Simulate the realistic "idle past 5 min" case. (stepUp() also sets
    // vault_unlocked_at, so a fresh stepped-up session has the vault open
    // by definition. The locked scenario in production is sliding-idle
    // expiry, which we model here by clearing the column directly.)
    await sql`UPDATE sessions SET vault_unlocked_at = NULL WHERE id = ${sid}`.execute(db);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/credentials/${cred.credentialId}?mode=reveal`,
      headers: { cookie: 'sid=' + signed },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/admin\/step-up\?return=/);
    const decoded = decodeURIComponent(res.headers.location.replace(/^\/admin\/step-up\?return=/, ''));
    expect(decoded).toContain(`/credentials/${cred.credentialId}?mode=reveal`);
  });

  it('GET ?mode=reveal with vault unlocked decrypts + writes audit + enqueues digest event', async () => {
    const adminId = await makeAdmin('reveal1');
    const { customerId, primaryUserId } = await makeCustomer('reveal1-co');
    const plaintext = 'plainval-' + Date.now();
    const cred = await makeCredential(customerId, primaryUserId, { password: plaintext });
    const { sid, signed } = await makeAdminSignedCookie(adminId);
    await unlockVault(db, sid);

    const before = await sql`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'credential.viewed' AND target_id = ${cred.credentialId}::uuid`.execute(db);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/credentials/${cred.credentialId}?mode=reveal`,
      headers: { cookie: 'sid=' + signed },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(plaintext);

    const after = await sql`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'credential.viewed' AND target_id = ${cred.credentialId}::uuid`.execute(db);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);

    const digest = await sql`
      SELECT COUNT(*)::int AS n FROM pending_digest_items
      WHERE event_type = 'credential.viewed'
        AND customer_id = ${customerId}::uuid
    `.execute(db);
    expect(digest.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('GET ?mode=reveal with corrupted ciphertext renders error + forensic audit + no plaintext', async () => {
    const adminId = await makeAdmin('df');
    const { customerId, primaryUserId } = await makeCustomer('df-co');
    const plaintext = 'plainval-df-' + Date.now();
    const cred = await makeCredential(customerId, primaryUserId, { password: plaintext });
    const { sid, signed } = await makeAdminSignedCookie(adminId);
    await unlockVault(db, sid);

    // Replace the ciphertext with all-zero bytes so GCM auth-tag check fails.
    await sql`
      UPDATE credentials SET payload_ciphertext = '\\x00000000000000000000000000000000'::bytea
      WHERE id = ${cred.credentialId}::uuid
    `.execute(db);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/credentials/${cred.credentialId}?mode=reveal`,
      headers: { cookie: 'sid=' + signed },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(plaintext);
    expect(res.body).toMatch(/could not decrypt/i);

    const forensic = await sql`
      SELECT COUNT(*)::int AS n FROM audit_log
      WHERE action = 'credential.decrypt_failure'
        AND target_id = ${cred.credentialId}::uuid
        AND visible_to_customer = false
    `.execute(db);
    expect(forensic.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
