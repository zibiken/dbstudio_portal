import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb } from '../../../config/db.js';
import { runMigrations } from '../../../migrations/runner.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('runMigrations', () => {
  const schema = `mig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const tmpDirs = [];
  let setupDb;
  let db;

  function makeMigDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body);
    }
    tmpDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    setupDb = createDb({ connectionString: process.env.DATABASE_URL });
    await sql.raw(`CREATE SCHEMA "${schema}"`).execute(setupDb);

    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = createDb({ connectionString: url.toString() });
  });

  afterAll(async () => {
    if (db) await db.destroy();
    if (setupDb) {
      await sql.raw(`DROP SCHEMA "${schema}" CASCADE`).execute(setupDb);
      await setupDb.destroy();
    }
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it('creates _migrations ledger, applies pending files, and is idempotent across reruns', async () => {
    const dir = makeMigDir({
      '9001_alpha.sql': 'CREATE TABLE alpha (id INT PRIMARY KEY);',
      '9002_beta.sql':  'CREATE TABLE beta  (id INT PRIMARY KEY);',
    });

    await runMigrations({ db, dir });
    await runMigrations({ db, dir });

    const ledger = await sql`SELECT name FROM _migrations WHERE name IN ('9001_alpha.sql','9002_beta.sql') ORDER BY name`.execute(db);
    expect(ledger.rows.map(r => r.name)).toEqual(['9001_alpha.sql', '9002_beta.sql']);

    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = ${schema} AND tablename IN ('alpha','beta')
      ORDER BY tablename
    `.execute(db);
    expect(tables.rows.map(r => r.tablename)).toEqual(['alpha', 'beta']);
  });

  it('applies migrations in numerical filename order regardless of write order', async () => {
    const dir = makeMigDir({
      '9020_second.sql': 'CREATE TABLE ord_b (id INT);',
      '9010_first.sql':  'CREATE TABLE ord_a (id INT);',
    });

    await runMigrations({ db, dir });

    const ledger = await sql`
      SELECT name FROM _migrations
      WHERE name IN ('9010_first.sql','9020_second.sql')
      ORDER BY applied_at
    `.execute(db);
    expect(ledger.rows.map(r => r.name)).toEqual(['9010_first.sql', '9020_second.sql']);
  });

  it('rolls back a failing migration: file not recorded, partial DDL not committed', async () => {
    const dir = makeMigDir({
      '9100_bad.sql': 'CREATE TABLE rollback_me (id INT); SELECT 1/0;',
    });

    await expect(runMigrations({ db, dir })).rejects.toThrow();

    const ledger = await sql`SELECT name FROM _migrations WHERE name = '9100_bad.sql'`.execute(db);
    expect(ledger.rows).toHaveLength(0);

    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = ${schema} AND tablename = 'rollback_me'
    `.execute(db);
    expect(tables.rows).toHaveLength(0);
  });

  it('ignores files that do not match \\d{4}_.*\\.sql', async () => {
    const dir = makeMigDir({
      '_meta.sql':   'CREATE TABLE skip_meta (id INT);',
      'README.md':   '# not a migration',
      'notes.sql':   'CREATE TABLE skip_no_prefix (id INT);',
    });

    await runMigrations({ db, dir });

    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = ${schema} AND tablename IN ('skip_meta','skip_no_prefix')
    `.execute(db);
    expect(tables.rows).toHaveLength(0);
  });
});
