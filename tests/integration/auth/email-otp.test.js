import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { requestOtp, verifyOtp } from '../../../lib/auth/email-otp.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('email-otp', () => {
  let db;
  const userId = uuidv7();
  const userType = 'admin';
  const toAddress = 'admin@example.com';

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM email_otp_codes WHERE user_id = ${userId}::uuid`.execute(db);
      await sql`DELETE FROM email_outbox WHERE to_address = ${toAddress}`.execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM email_otp_codes WHERE user_id = ${userId}::uuid`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address = ${toAddress}`.execute(db);
  });

  it('requestOtp inserts a row and queues an email_outbox entry with the plaintext code', async () => {
    await requestOtp(db, { userType, userId, toAddress });

    const rows = await sql`SELECT id, code_hash, expires_at, attempts, consumed_at FROM email_otp_codes WHERE user_id = ${userId}::uuid`.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(rows.rows[0].attempts)).toBe(0);
    expect(rows.rows[0].consumed_at).toBeNull();
    const ttl = new Date(rows.rows[0].expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000 + 1000);

    const outbox = await sql`SELECT template, locals, to_address, idempotency_key FROM email_outbox WHERE to_address = ${toAddress}`.execute(db);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].template).toBe('email_otp');
    expect(outbox.rows[0].locals.code).toMatch(/^\d{6}$/);
  });

  it('verifyOtp returns true for the correct code and consumes it (single-use)', async () => {
    await requestOtp(db, { userType, userId, toAddress });
    const ob = await sql`SELECT locals FROM email_outbox WHERE to_address = ${toAddress}`.execute(db);
    const code = ob.rows[0].locals.code;

    expect(await verifyOtp(db, { userType, userId, code })).toBe(true);
    expect(await verifyOtp(db, { userType, userId, code })).toBe(false);
  });

  it('verifyOtp returns false for the wrong code', async () => {
    await requestOtp(db, { userType, userId, toAddress });
    expect(await verifyOtp(db, { userType, userId, code: '000000' })).toBe(false);
  });

  it('verifyOtp returns false after expiry', async () => {
    await requestOtp(db, { userType, userId, toAddress });
    const ob = await sql`SELECT locals FROM email_outbox WHERE to_address = ${toAddress}`.execute(db);
    const code = ob.rows[0].locals.code;
    await sql`UPDATE email_otp_codes SET expires_at = now() - INTERVAL '1 minute' WHERE user_id = ${userId}::uuid`.execute(db);
    expect(await verifyOtp(db, { userType, userId, code })).toBe(false);
  });

  it('locks out after 3 wrong attempts; the correct code on a 4th try is rejected', async () => {
    await requestOtp(db, { userType, userId, toAddress });
    const ob = await sql`SELECT locals FROM email_outbox WHERE to_address = ${toAddress}`.execute(db);
    const code = ob.rows[0].locals.code;

    expect(await verifyOtp(db, { userType, userId, code: '111111' })).toBe(false);
    expect(await verifyOtp(db, { userType, userId, code: '222222' })).toBe(false);
    expect(await verifyOtp(db, { userType, userId, code: '333333' })).toBe(false);
    expect(await verifyOtp(db, { userType, userId, code })).toBe(false);
  });

  it('a fresh requestOtp invalidates the previous unused code', async () => {
    await requestOtp(db, { userType, userId, toAddress });
    const ob1 = await sql`SELECT locals FROM email_outbox WHERE to_address = ${toAddress} ORDER BY created_at LIMIT 1`.execute(db);
    const oldCode = ob1.rows[0].locals.code;

    await requestOtp(db, { userType, userId, toAddress });
    expect(await verifyOtp(db, { userType, userId, code: oldCode })).toBe(false);
  });
});
