import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { isVaultUnlocked, unlockVault, VAULT_LOCK_IDLE_MS } from '../../../lib/auth/vault-lock.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_autolock_${Date.now()}`;

// Vault-lock contract (plan Task 7.3):
//   - Session-scoped, separate from step-up.
//   - Step-up unlocks the vault (sets sessions.vault_unlocked_at = now()).
//   - Each successful credential view refreshes the unlock timer (sliding).
//   - 5 min of credential idleness → vault locked → next view throws
//     StepUpRequiredError; route 302s to /login/2fa.
describe.skipIf(skip)('credentials/service vault-lock (Task 7.3)', () => {
  let db;
  let kek;
  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.50',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
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

  async function makeCustomerAndCred(suffix, payload = { token: 't' }) {
    const customer = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}-user@example.com` },
    }, baseCtx());
    const cred = await credentialsService.createByCustomer(db, {
      customerId: customer.customerId,
      customerUserId: customer.primaryUserId,
      provider: 'github', label: `Cred ${suffix}`,
      payload,
    }, baseCtx());
    return { ...customer, credentialId: cred.credentialId };
  }

  async function cleanup() {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
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

  it('exposes the spec timeout as VAULT_LOCK_IDLE_MS = 5 min', () => {
    expect(VAULT_LOCK_IDLE_MS).toBe(5 * 60_000);
  });

  it('isVaultUnlocked is false on a fresh session (never stepped up, never unlocked)', async () => {
    const adminId = await makeAdmin('fresh');
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    expect(await isVaultUnlocked(db, sid)).toBe(false);
  });

  it('stepUp unlocks the vault (sets vault_unlocked_at = now())', async () => {
    const adminId = await makeAdmin('step');
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    await stepUp(db, sid);
    expect(await isVaultUnlocked(db, sid)).toBe(true);
  });

  it('isVaultUnlocked returns false after the 5-min idle window has elapsed', async () => {
    const adminId = await makeAdmin('idle');
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    await stepUp(db, sid);
    // Backdate beyond the 5-min idle window.
    await sql`UPDATE sessions SET vault_unlocked_at = now() - INTERVAL '6 minutes' WHERE id = ${sid}`.execute(db);
    expect(await isVaultUnlocked(db, sid)).toBe(false);
  });

  it('unlockVault refreshes vault_unlocked_at to now() (sliding window primitive)', async () => {
    const adminId = await makeAdmin('renew');
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    await stepUp(db, sid);
    await sql`UPDATE sessions SET vault_unlocked_at = now() - INTERVAL '4 minutes' WHERE id = ${sid}`.execute(db);
    await unlockVault(db, sid);
    expect(await isVaultUnlocked(db, sid)).toBe(true);
    const r = await sql`SELECT vault_unlocked_at FROM sessions WHERE id = ${sid}`.execute(db);
    const drift = Math.abs(new Date(r.rows[0].vault_unlocked_at).getTime() - Date.now());
    expect(drift).toBeLessThan(5_000);
  });

  it('credentialsService.view succeeds when the vault is unlocked AND refreshes the timer', async () => {
    const adminId = await makeAdmin('view-ok');
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    await stepUp(db, sid);
    const { customerId, credentialId } = await makeCustomerAndCred('view-ok');

    // Backdate to 4 minutes — within the 5-min window — to prove the view
    // refreshes the timer back to ~now() rather than just passing through.
    await sql`UPDATE sessions SET vault_unlocked_at = now() - INTERVAL '4 minutes' WHERE id = ${sid}`.execute(db);

    const before = await sql`SELECT vault_unlocked_at FROM sessions WHERE id = ${sid}`.execute(db);
    const beforeMs = new Date(before.rows[0].vault_unlocked_at).getTime();

    const r = await credentialsService.view(db, { adminId, sessionId: sid, credentialId }, baseCtx());
    expect(r.credentialId).toBe(credentialId);
    expect(r.payload).toBeDefined();

    const after = await sql`SELECT vault_unlocked_at FROM sessions WHERE id = ${sid}`.execute(db);
    const afterMs = new Date(after.rows[0].vault_unlocked_at).getTime();
    expect(afterMs).toBeGreaterThan(beforeMs + 60_000); // moved forward by at least 1 min
    const drift = Math.abs(afterMs - Date.now());
    expect(drift).toBeLessThan(5_000);
  });

  it('credentialsService.view refuses when vault is locked (idle >5 min) and does NOT refresh the timer', async () => {
    const adminId = await makeAdmin('view-locked');
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    await stepUp(db, sid);
    const { credentialId } = await makeCustomerAndCred('view-locked');

    // Push the unlock timestamp 6 minutes back — vault is locked.
    await sql`UPDATE sessions SET vault_unlocked_at = now() - INTERVAL '6 minutes' WHERE id = ${sid}`.execute(db);
    const before = await sql`SELECT vault_unlocked_at FROM sessions WHERE id = ${sid}`.execute(db);
    const beforeMs = new Date(before.rows[0].vault_unlocked_at).getTime();

    await expect(
      credentialsService.view(db, { adminId, sessionId: sid, credentialId }, baseCtx()),
    ).rejects.toThrow(/step.?up/i);

    // The locked-vault view path MUST NOT renew the timer (otherwise an
    // attacker with a leaked sid could keep the vault unlocked forever
    // by hammering the route).
    const after = await sql`SELECT vault_unlocked_at FROM sessions WHERE id = ${sid}`.execute(db);
    const afterMs = new Date(after.rows[0].vault_unlocked_at).getTime();
    expect(afterMs).toBe(beforeMs);

    // No credential.viewed audit was written.
    const audit = await sql`
      SELECT count(*)::int AS c FROM audit_log
       WHERE action = 'credential.viewed' AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(audit.rows[0].c).toBe(0);
  });

  it('view never refreshes the timer when the credential is missing (input-error path stays neutral)', async () => {
    const adminId = await makeAdmin('view-missing-noref');
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    await stepUp(db, sid);
    await sql`UPDATE sessions SET vault_unlocked_at = now() - INTERVAL '4 minutes' WHERE id = ${sid}`.execute(db);

    const before = await sql`SELECT vault_unlocked_at FROM sessions WHERE id = ${sid}`.execute(db);
    const beforeMs = new Date(before.rows[0].vault_unlocked_at).getTime();

    await expect(
      credentialsService.view(db, {
        adminId, sessionId: sid,
        credentialId: '00000000-0000-7000-8000-000000000000',
      }, baseCtx()),
    ).rejects.toThrow(/not found|credential/i);

    const after = await sql`SELECT vault_unlocked_at FROM sessions WHERE id = ${sid}`.execute(db);
    const afterMs = new Date(after.rows[0].vault_unlocked_at).getTime();
    // Timer untouched — the view tx rolled back.
    expect(afterMs).toBe(beforeMs);
  });

  it('after a fresh stepUp following lockout, view works again', async () => {
    const adminId = await makeAdmin('relock');
    const sid = await createSession(db, { userType: 'admin', userId: adminId });
    await stepUp(db, sid);
    const { credentialId } = await makeCustomerAndCred('relock');

    await sql`UPDATE sessions SET vault_unlocked_at = now() - INTERVAL '6 minutes' WHERE id = ${sid}`.execute(db);
    await expect(
      credentialsService.view(db, { adminId, sessionId: sid, credentialId }, baseCtx()),
    ).rejects.toThrow(/step.?up/i);

    // Fresh 2FA → vault is back open.
    await stepUp(db, sid);
    const r = await credentialsService.view(db, { adminId, sessionId: sid, credentialId }, baseCtx());
    expect(r.credentialId).toBe(credentialId);
  });
});
