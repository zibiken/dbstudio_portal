import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { checkLockout, recordFail, reset } from '../../../lib/auth/rate-limit.js';

const skip = !process.env.RUN_DB_TESTS;

const LOGIN_OPTS = { limit: 5, windowMs: 15 * 60_000, lockoutMs: 30 * 60_000 };

describe.skipIf(skip)('rate-limit', () => {
  let db;
  const tag = `rl_test_${Date.now()}`;
  const key = (suffix) => `${tag}:${suffix}`;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${tag + ':%'}`.execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${tag + ':%'}`.execute(db);
  });

  it('checkLockout returns {locked:false} when no row exists', async () => {
    const r = await checkLockout(db, key('a'));
    expect(r.locked).toBe(false);
  });

  it('records failures and locks at the limit-th fail', async () => {
    const k = key('b');
    for (let i = 1; i <= 4; i++) {
      const r = await recordFail(db, k, LOGIN_OPTS);
      expect(Number(r.count)).toBe(i);
      expect(r.locked_until).toBeNull();
    }
    const fifth = await recordFail(db, k, LOGIN_OPTS);
    expect(Number(fifth.count)).toBe(5);
    expect(fifth.locked_until).not.toBeNull();
    const drift = new Date(fifth.locked_until).getTime() - Date.now();
    expect(drift).toBeGreaterThan(LOGIN_OPTS.lockoutMs - 5_000);
    expect(drift).toBeLessThanOrEqual(LOGIN_OPTS.lockoutMs + 5_000);
  });

  it('after lockout, checkLockout returns {locked:true, retryAfterMs}', async () => {
    const k = key('c');
    for (let i = 0; i < 5; i++) await recordFail(db, k, LOGIN_OPTS);
    const r = await checkLockout(db, k);
    expect(r.locked).toBe(true);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs).toBeLessThanOrEqual(LOGIN_OPTS.lockoutMs);
  });

  it('resets count when the window expires', async () => {
    const k = key('d');
    // Pre-stage an expired bucket
    await sql`
      INSERT INTO rate_limit_buckets (key, count, reset_at)
      VALUES (${k}, 4, now() - INTERVAL '1 minute')
    `.execute(db);

    const r = await recordFail(db, k, LOGIN_OPTS);
    expect(Number(r.count)).toBe(1);
    expect(r.locked_until).toBeNull();
  });

  it('reset() deletes the bucket', async () => {
    const k = key('e');
    await recordFail(db, k, LOGIN_OPTS);
    await reset(db, k);
    const r = await sql`SELECT * FROM rate_limit_buckets WHERE key = ${k}`.execute(db);
    expect(r.rows).toHaveLength(0);
  });

  it('checkLockout treats expired locked_until as not-locked', async () => {
    const k = key('f');
    await sql`
      INSERT INTO rate_limit_buckets (key, count, reset_at, locked_until)
      VALUES (${k}, 5, now() + INTERVAL '10 minutes', now() - INTERVAL '1 minute')
    `.execute(db);
    const r = await checkLockout(db, k);
    expect(r.locked).toBe(false);
  });
});
