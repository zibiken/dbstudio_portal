import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import {
  createSession,
  loadSession,
  stepUp,
  isStepped,
  revokeAll,
  IDLE_MS,
  ABSOLUTE_MS,
  STEP_UP_WINDOW_MS,
} from '../../../lib/auth/session.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('sessions', () => {
  let db;
  const userId = uuidv7();

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM sessions WHERE user_id = ${userId}::uuid`.execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM sessions WHERE user_id = ${userId}::uuid`.execute(db);
  });

  it('exposes the spec timeouts as constants', () => {
    expect(IDLE_MS).toBe(30 * 60_000);
    expect(ABSOLUTE_MS).toBe(12 * 3_600_000);
    expect(STEP_UP_WINDOW_MS).toBe(5 * 60_000);
  });

  it('createSession returns a 64-hex-char id (32 bytes) and inserts a row', async () => {
    const id = await createSession(db, { userType: 'admin', userId, ip: '198.51.100.1', deviceFingerprint: 'fp1' });
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    const r = await sql`SELECT user_type, user_id::text AS user_id, host(ip) AS ip, device_fingerprint, absolute_expires_at FROM sessions WHERE id = ${id}`.execute(db);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].user_type).toBe('admin');
    expect(r.rows[0].user_id).toBe(userId);
    expect(r.rows[0].ip).toBe('198.51.100.1');
    expect(r.rows[0].device_fingerprint).toBe('fp1');
    const absDrift = new Date(r.rows[0].absolute_expires_at).getTime() - Date.now();
    expect(absDrift).toBeGreaterThan(ABSOLUTE_MS - 5_000);
    expect(absDrift).toBeLessThanOrEqual(ABSOLUTE_MS + 5_000);
  });

  it('loadSession returns null when token does not exist', async () => {
    expect(await loadSession(db, 'nope')).toBeNull();
  });

  it('loadSession returns the session and bumps last_seen_at on hit', async () => {
    const id = await createSession(db, { userType: 'admin', userId });
    // Backdate last_seen_at so we can verify the bump.
    await sql`UPDATE sessions SET last_seen_at = now() - INTERVAL '5 minutes' WHERE id = ${id}`.execute(db);

    const s = await loadSession(db, id);
    expect(s).not.toBeNull();
    expect(s.id).toBe(id);

    const r = await sql`SELECT last_seen_at FROM sessions WHERE id = ${id}`.execute(db);
    const lastSeenDrift = Math.abs(Date.now() - new Date(r.rows[0].last_seen_at).getTime());
    expect(lastSeenDrift).toBeLessThan(5_000);
  });

  it('loadSession returns null when idle-timed-out (last_seen older than IDLE_MS)', async () => {
    const id = await createSession(db, { userType: 'admin', userId });
    await sql`UPDATE sessions SET last_seen_at = now() - INTERVAL '31 minutes' WHERE id = ${id}`.execute(db);
    expect(await loadSession(db, id)).toBeNull();
  });

  it('loadSession returns null when absolute-expired', async () => {
    const id = await createSession(db, { userType: 'admin', userId });
    await sql`UPDATE sessions SET absolute_expires_at = now() - INTERVAL '1 minute' WHERE id = ${id}`.execute(db);
    expect(await loadSession(db, id)).toBeNull();
  });

  it('loadSession returns null when revoked', async () => {
    const id = await createSession(db, { userType: 'admin', userId });
    await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${id}`.execute(db);
    expect(await loadSession(db, id)).toBeNull();
  });

  it('stepUp sets step_up_at and isStepped is true within the window, false after', async () => {
    const id = await createSession(db, { userType: 'admin', userId });
    expect(await isStepped(db, id)).toBe(false);

    await stepUp(db, id);
    expect(await isStepped(db, id)).toBe(true);

    // Backdate beyond the step-up window.
    await sql`UPDATE sessions SET step_up_at = now() - INTERVAL '6 minutes' WHERE id = ${id}`.execute(db);
    expect(await isStepped(db, id)).toBe(false);
  });

  it('revokeAll revokes every active session for the user', async () => {
    const a = await createSession(db, { userType: 'admin', userId });
    const b = await createSession(db, { userType: 'admin', userId });
    await revokeAll(db, { userType: 'admin', userId });

    expect(await loadSession(db, a)).toBeNull();
    expect(await loadSession(db, b)).toBeNull();

    const r = await sql`SELECT count(*) FROM sessions WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`.execute(db);
    expect(Number(r.rows[0].count)).toBe(0);
  });

  it('revokeAll does not touch other users\' sessions', async () => {
    const otherUserId = uuidv7();
    const otherId = await createSession(db, { userType: 'admin', userId: otherUserId });
    try {
      const myId = await createSession(db, { userType: 'admin', userId });
      await revokeAll(db, { userType: 'admin', userId });

      expect(await loadSession(db, myId)).toBeNull();
      expect(await loadSession(db, otherId)).not.toBeNull();
    } finally {
      await sql`DELETE FROM sessions WHERE user_id = ${otherUserId}::uuid`.execute(db);
    }
  });
});
