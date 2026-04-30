import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../../config/db.js';
import * as service from '../../../../domain/customer-users/service.js';
import {
  generateDek, wrapDek, encrypt,
} from '../../../../lib/crypto/envelope.js';
import { generateSecret, generateToken } from '../../../../lib/auth/totp.js';
import { generateBackupCodes, verifyAndConsume } from '../../../../lib/auth/backup-codes.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('customer-users/service.regenBackupCodes', () => {
  let db;
  let kek;
  const tag = `cu_bc_test_${Date.now()}`;
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
    const { codes, stored } = await generateBackupCodes();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (
        ${customerId}::uuid, ${tag + ' ' + suffix + ' S.L.'},
        ${wrapped.ciphertext}::bytea, ${wrapped.iv}::bytea, ${wrapped.tag}::bytea
      )
    `.execute(db);
    await sql`
      INSERT INTO customer_users (
        id, customer_id, email, name,
        totp_secret_enc, totp_iv, totp_tag, backup_codes
      ) VALUES (
        ${userId}::uuid, ${customerId}::uuid, ${tagEmail(suffix)},
        ${'Cust ' + suffix},
        ${env.ciphertext}::bytea, ${env.iv}::bytea, ${env.tag}::bytea,
        ${JSON.stringify(stored)}::jsonb
      )
    `.execute(db);
    return { customerId, userId, totpSecret, dek, oldCodes: codes };
  }

  function ctx() {
    return {
      ip: '198.51.100.7',
      userAgentHash: 'uahash',
      audit: { tag },
      kek,
    };
  }

  it('verifies current TOTP, replaces all 8 codes, returns plaintext, audits visible_to_customer', async () => {
    const u = await seedUserWithTotp('a');
    const code = generateToken(u.totpSecret);

    const r = await service.regenBackupCodes(
      db,
      { customerUserId: u.userId, currentCode: code },
      ctx(),
    );
    expect(r.codes).toHaveLength(8);
    expect(r.codes.every((c) => /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(c))).toBe(true);
    expect(r.codes.some((c) => u.oldCodes.includes(c))).toBe(false);

    const userRow = await sql`SELECT backup_codes FROM customer_users WHERE id = ${u.userId}::uuid`.execute(db);
    const stored = userRow.rows[0].backup_codes;
    expect(stored).toHaveLength(8);
    // New codes should verify
    for (const c of r.codes) {
      const consumed = await verifyAndConsume(stored, c);
      expect(consumed.ok).toBe(true);
    }
    // Old codes should NOT verify
    for (const c of u.oldCodes) {
      const consumed = await verifyAndConsume(stored, c);
      expect(consumed.ok).toBe(false);
    }

    const audits = await sql`SELECT action, visible_to_customer FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    expect(audits.rows.map((a) => a.action)).toContain('customer_user.backup_codes_regenerated');
    expect(audits.rows.find((a) => a.action === 'customer_user.backup_codes_regenerated').visible_to_customer).toBe(true);
  });

  it('rejects wrong current TOTP code', async () => {
    const u = await seedUserWithTotp('b');
    await expect(
      service.regenBackupCodes(
        db,
        { customerUserId: u.userId, currentCode: '000000' },
        ctx(),
      ),
    ).rejects.toThrow(/code|verify/i);
    const userRow = await sql`SELECT backup_codes FROM customer_users WHERE id = ${u.userId}::uuid`.execute(db);
    const stored = userRow.rows[0].backup_codes;
    // Old codes still valid
    for (const c of u.oldCodes) {
      const consumed = await verifyAndConsume(stored, c);
      expect(consumed.ok).toBe(true);
    }
  });

  it('also accepts a backup code as proof-of-2FA (and consumes it)', async () => {
    const u = await seedUserWithTotp('c');
    const usedBackupCode = u.oldCodes[0];
    const r = await service.regenBackupCodes(
      db,
      { customerUserId: u.userId, backupCode: usedBackupCode },
      ctx(),
    );
    expect(r.codes).toHaveLength(8);
    // The old code that was used as proof must no longer be present in the
    // new set (it's a fresh 8 anyway). The other 7 old codes are gone too.
    expect(r.codes.every((c) => !u.oldCodes.includes(c))).toBe(true);
  });

  it('requires KEK', async () => {
    const u = await seedUserWithTotp('d');
    const code = generateToken(u.totpSecret);
    await expect(
      service.regenBackupCodes(
        db,
        { customerUserId: u.userId, currentCode: code },
        { ...ctx(), kek: undefined },
      ),
    ).rejects.toThrow(/kek/i);
  });
});
