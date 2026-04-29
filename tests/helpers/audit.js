import { sql } from 'kysely';

// Cleans tagged audit_log rows by toggling the append-only trigger inside
// a single tx, so a crash mid-cleanup doesn't leave the trigger disabled
// on the live database (review M4 from the M6 → M7 checkpoint).
//
// `whereSqlFragment` is a sql`...` template carrying the WHERE predicate
// (without the literal "WHERE"). Example:
//   await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
export async function pruneTaggedAuditRows(db, whereSqlFragment) {
  await db.transaction().execute(async (tx) => {
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(tx);
    await sql`DELETE FROM audit_log WHERE ${whereSqlFragment}`.execute(tx);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(tx);
  });
}
