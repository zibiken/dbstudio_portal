import { sql } from 'kysely';

export async function checkLockout(db, key) {
  const r = await sql`
    SELECT locked_until
      FROM rate_limit_buckets
     WHERE key = ${key}
       AND locked_until IS NOT NULL
       AND locked_until > now()
  `.execute(db);
  if (r.rows.length === 0) return { locked: false };
  const retryAfterMs = new Date(r.rows[0].locked_until).getTime() - Date.now();
  return { locked: true, retryAfterMs };
}

export async function recordFail(db, key, { limit, windowMs, lockoutMs = 0 }) {
  const r = await sql`
    INSERT INTO rate_limit_buckets (key, count, reset_at)
    VALUES (${key}, 1, now() + (${windowMs}::bigint || ' milliseconds')::interval)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limit_buckets.reset_at <= now() THEN 1
        ELSE rate_limit_buckets.count + 1
      END,
      reset_at = CASE
        WHEN rate_limit_buckets.reset_at <= now()
          THEN now() + (${windowMs}::bigint || ' milliseconds')::interval
        ELSE rate_limit_buckets.reset_at
      END,
      locked_until = CASE
        WHEN rate_limit_buckets.reset_at > now()
         AND rate_limit_buckets.count + 1 >= ${limit}
          THEN now() + (${lockoutMs}::bigint || ' milliseconds')::interval
        ELSE rate_limit_buckets.locked_until
      END
    RETURNING count, locked_until
  `.execute(db);
  return r.rows[0];
}

export async function reset(db, key) {
  await sql`DELETE FROM rate_limit_buckets WHERE key = ${key}`.execute(db);
}
