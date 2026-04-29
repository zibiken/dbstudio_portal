import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import {
  insertAdmin,
  findById,
  findByEmail,
  countAdmins,
  updateAdmin,
} from '../../../domain/admins/repo.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('admins/repo', () => {
  let db;
  const tag = `repo_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
  });

  it('insertAdmin persists a row with NULL password_hash and pending invite fields', async () => {
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    await insertAdmin(db, {
      id,
      email: tagEmail('a'),
      name: 'A',
      inviteTokenHash: 'h_a',
      inviteExpiresAt: expiresAt,
    });

    const r = await findById(db, id);
    expect(r.id).toBe(id);
    expect(r.email).toBe(tagEmail('a'));
    expect(r.name).toBe('A');
    expect(r.password_hash).toBeNull();
    expect(r.invite_token_hash).toBe('h_a');
    expect(r.invite_consumed_at).toBeNull();
    expect(new Date(r.invite_expires_at).getTime()).toBe(expiresAt.getTime());
  });

  it('findByEmail is case-insensitive (CITEXT) and returns null on miss', async () => {
    const id = uuidv7();
    await insertAdmin(db, { id, email: tagEmail('Mixed'), name: 'X' });
    const r = await findByEmail(db, tagEmail('mixed'));
    expect(r?.id).toBe(id);
    expect(await findByEmail(db, tagEmail('absent'))).toBeNull();
  });

  it('countAdmins reflects insert count, scoped by tag for isolation', async () => {
    expect(await countAdmins(db, { emailLike: tag + '%' })).toBe(0);
    await insertAdmin(db, { id: uuidv7(), email: tagEmail('c1'), name: '1' });
    await insertAdmin(db, { id: uuidv7(), email: tagEmail('c2'), name: '2' });
    expect(await countAdmins(db, { emailLike: tag + '%' })).toBe(2);
  });

  it('updateAdmin sets the provided columns and ignores undefined ones', async () => {
    const id = uuidv7();
    await insertAdmin(db, { id, email: tagEmail('u'), name: 'U', inviteTokenHash: 'h' });

    await updateAdmin(db, id, { passwordHash: 'argon2_hash', inviteConsumedAt: new Date() });

    const r = await findById(db, id);
    expect(r.password_hash).toBe('argon2_hash');
    expect(r.invite_consumed_at).not.toBeNull();
    // Untouched
    expect(r.invite_token_hash).toBe('h');
    expect(r.name).toBe('U');
  });

  it('updateAdmin is a no-op when no fields are provided', async () => {
    const id = uuidv7();
    await insertAdmin(db, { id, email: tagEmail('noop'), name: 'N' });
    await updateAdmin(db, id, {});
    const r = await findById(db, id);
    expect(r.name).toBe('N');
  });
});
