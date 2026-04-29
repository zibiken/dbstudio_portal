import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('createDb', () => {
  it('connects and returns 1 from a trivial select', async () => {
    const db = createDb({ connectionString: process.env.DATABASE_URL });
    const r = await sql`SELECT 1::int as ok`.execute(db);
    expect(r.rows[0].ok).toBe(1);
    await db.destroy();
  });

  it('reports current_user = portal_user when DATABASE_URL is the portal db', async () => {
    const db = createDb({ connectionString: process.env.DATABASE_URL });
    const r = await sql`SELECT current_user as usr, current_database() as db`.execute(db);
    expect(r.rows[0].usr).toBe('portal_user');
    expect(r.rows[0].db).toBe('portal_db');
    await db.destroy();
  });
});
