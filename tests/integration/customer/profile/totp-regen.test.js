import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../../config/db.js';
import * as service from '../../../../domain/customer-users/service.js';
import {
  generateDek, wrapDek, encrypt, decrypt,
} from '../../../../lib/crypto/envelope.js';
import { generateSecret, generateToken } from '../../../../lib/auth/totp.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customer-users/service.regenTotp', () => {
  let db;
  let kek;
  const tag = `cu_totp_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  async function seedUserWithTotp(suffix) {
    const customerId = uuidv7();
    const userId = uuidv7();
    const dek = generateDek();
    const wrapped = wrapDek(dek, kek);
    const totpSecret = generateSecret();
    const env = encrypt(Buffer.from(totpSecret, 'utf8'), dek);
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (
        ${customerId}::uuid, ${tag + ' ' + suffix + ' S.L.'},
        ${wrapped.ciphertext}::bytea, ${wrapped.iv}::bytea, ${wrapped.tag}::bytea
      )
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name, totp_secret_enc, totp_iv, totp_tag)
      VALUES (
        ${userId}::uuid, ${customerId}::uuid, ${tagEmail(suffix)},
        ${'Cust ' + suffix}, ${env.ciphertext}::bytea, ${env.iv}::bytea, ${env.tag}::bytea
      )
    `.execute(db);
    return { customerId, userId, totpSecret, dek };
  }

  function ctx() {
    return {
      ip: '198.51.100.7',
      userAgentHash: 'uahash',
      audit: { tag },
      kek,
    };
  }

  it('happy path: verify current code, swap secret encrypted under DEK, audit visible_to_customer', async () => {
    const u = await seedUserWithTotp('a');
    const newSecret = generateSecret();
    const currentCode = generateToken(u.totpSecret);
    const newCode = generateToken(newSecret);

    const r = await service.regenTotp(
      db,
      { customerUserId: u.userId, currentCode, newSecret, newCode },
      ctx(),
    );
    expect(r.customerUserId).toBe(u.userId);
    expect(r.customerId).toBe(u.customerId);

    const userRow = await sql`
      SELECT totp_secret_enc, totp_iv, totp_tag FROM customer_users WHERE id = ${u.userId}::uuid
    `.execute(db);
    const recovered = decrypt({
      ciphertext: userRow.rows[0].totp_secret_enc,
      iv: userRow.rows[0].totp_iv,
      tag: userRow.rows[0].totp_tag,
    }, u.dek).toString('utf8');
    expect(recovered).toBe(newSecret);
    expect(recovered).not.toBe(u.totpSecret);

    const audits = await sql`SELECT action, visible_to_customer FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    expect(audits.rows.map((a) => a.action)).toContain('customer_user.2fa_totp_regenerated');
    expect(audits.rows.find((a) => a.action === 'customer_user.2fa_totp_regenerated').visible_to_customer).toBe(true);
  });

  it('rejects wrong current code; secret unchanged', async () => {
    const u = await seedUserWithTotp('b');
    const newSecret = generateSecret();
    const newCode = generateToken(newSecret);
    await expect(
      service.regenTotp(
        db,
        { customerUserId: u.userId, currentCode: '000000', newSecret, newCode },
        ctx(),
      ),
    ).rejects.toThrow(/code|verify/i);
    const userRow = await sql`
      SELECT totp_secret_enc, totp_iv, totp_tag FROM customer_users WHERE id = ${u.userId}::uuid
    `.execute(db);
    const recovered = decrypt({
      ciphertext: userRow.rows[0].totp_secret_enc,
      iv: userRow.rows[0].totp_iv,
      tag: userRow.rows[0].totp_tag,
    }, u.dek).toString('utf8');
    expect(recovered).toBe(u.totpSecret);
  });

  it('rejects wrong new code (proves the user actually scanned the new QR)', async () => {
    const u = await seedUserWithTotp('c');
    const newSecret = generateSecret();
    const currentCode = generateToken(u.totpSecret);
    await expect(
      service.regenTotp(
        db,
        { customerUserId: u.userId, currentCode, newSecret, newCode: '000000' },
        ctx(),
      ),
    ).rejects.toThrow(/code|verify/i);
  });

  it('requires KEK', async () => {
    const u = await seedUserWithTotp('d');
    const newSecret = generateSecret();
    const currentCode = generateToken(u.totpSecret);
    const newCode = generateToken(newSecret);
    await expect(
      service.regenTotp(
        db,
        { customerUserId: u.userId, currentCode, newSecret, newCode },
        { ...ctx(), kek: undefined },
      ),
    ).rejects.toThrow(/kek/i);
  });
});
