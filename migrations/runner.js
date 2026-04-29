import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';

const FILE_RE = /^\d{4}_.*\.sql$/;

export async function runMigrations({ db, dir }) {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  const files = readdirSync(dir).filter(f => FILE_RE.test(f)).sort();
  const appliedRows = await sql`SELECT name FROM _migrations`.execute(db);
  const applied = new Set(appliedRows.rows.map(r => r.name));

  for (const f of files) {
    if (applied.has(f)) continue;
    const text = readFileSync(join(dir, f), 'utf8');
    await db.transaction().execute(async (tx) => {
      await sql.raw(text).execute(tx);
      await sql`INSERT INTO _migrations (name) VALUES (${f})`.execute(tx);
    });
    console.log(`migrated: ${f}`);
  }
}
