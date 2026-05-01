import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { mkdtempSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb } from '../../../config/db.js';
import { runMigrations } from '../../../migrations/runner.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('migration 0011_phase_d', () => {
  const schema = `mig_0011_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let setupDb;
  let db;
  let tmpDir;

  beforeAll(async () => {
    setupDb = createDb({ connectionString: process.env.DATABASE_URL });
    await sql.raw(`CREATE SCHEMA "${schema}"`).execute(setupDb);
    const url = new URL(process.env.DATABASE_URL);
    // CITEXT lives in the public schema (installed at DB bootstrap). Include
    // public on search_path so the type resolves; writes still go to our
    // test schema because it's listed first.
    url.searchParams.set('options', `-c search_path=${schema},public`);
    db = createDb({ connectionString: url.toString() });

    tmpDir = mkdtempSync(join(tmpdir(), 'mig0011-'));
    const src = join(process.cwd(), 'migrations');
    for (const f of readdirSync(src).filter(f => /^\d{4}_.*\.sql$/.test(f))) {
      copyFileSync(join(src, f), join(tmpDir, f));
    }
    await runMigrations({ db, dir: tmpDir });
  });

  afterAll(async () => {
    if (db) await db.destroy();
    if (setupDb) {
      await sql.raw(`DROP SCHEMA "${schema}" CASCADE`).execute(setupDb);
      await setupDb.destroy();
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds nda_signed_at to customers as nullable timestamptz', async () => {
    const r = await sql`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'customers' AND column_name = 'nda_signed_at'
    `.execute(db);
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0].data_type).toBe('timestamp with time zone');
    expect(r.rows[0].is_nullable).toBe('YES');
  });

  it('adds last_cleanup_banner_dismissed_at to customers as nullable timestamptz', async () => {
    const r = await sql`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'customers' AND column_name = 'last_cleanup_banner_dismissed_at'
    `.execute(db);
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0].data_type).toBe('timestamp with time zone');
    expect(r.rows[0].is_nullable).toBe('YES');
  });

  it('creates customer_questions with expected columns', async () => {
    const r = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'customer_questions'
      ORDER BY ordinal_position
    `.execute(db);
    const cols = Object.fromEntries(r.rows.map(x => [x.column_name, x]));
    expect(cols.id?.data_type).toBe('uuid');
    expect(cols.customer_id?.data_type).toBe('uuid');
    expect(cols.created_by_admin_id?.data_type).toBe('uuid');
    expect(cols.answered_by_customer_user_id?.data_type).toBe('uuid');
    expect(cols.question?.data_type).toBe('text');
    expect(cols.answer_text?.data_type).toBe('text');
    expect(cols.status?.data_type).toBe('text');
    expect(cols.created_at?.data_type).toBe('timestamp with time zone');
    expect(cols.answered_at?.data_type).toBe('timestamp with time zone');
    expect(cols.answer_text.is_nullable).toBe('YES');
    expect(cols.answered_by_customer_user_id.is_nullable).toBe('YES');
    expect(cols.answered_at.is_nullable).toBe('YES');
  });

  it('enforces status check constraint', async () => {
    const customerId = '00000000-0000-0000-0000-000000000001';
    const adminId = '00000000-0000-0000-0000-000000000002';
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (${customerId}::uuid, 'fixture', '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea)
    `.execute(db);
    await sql`
      INSERT INTO admins (id, email, name)
      VALUES (${adminId}::uuid, 'a@example.com', 'a')
    `.execute(db);
    await expect(sql`
      INSERT INTO customer_questions (id, customer_id, created_by_admin_id, question, status)
      VALUES (gen_random_uuid(), ${customerId}::uuid, ${adminId}::uuid, 'q', 'bogus')
    `.execute(db)).rejects.toThrow();
  });
});
