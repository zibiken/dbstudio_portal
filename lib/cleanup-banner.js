import { sql } from 'kysely';

// Phase D — "DB Studio cleaned up your <provider> credential" banner.
//
// Reads the most recent admin-actor credential.deleted audit row in the
// last 7 days for this customer that is NOT older than the customer's
// last_cleanup_banner_dismissed_at stamp.  Returns null when nothing
// qualifies. The banner copy + provider value comes straight from the
// audit row's metadata (existing schema:
// {customerId, provider, label} written by domain/credentials/service).
export async function getCleanupBannerForCustomer(db, customerId) {
  const r = await sql`
    SELECT id, ts, metadata
      FROM audit_log
     WHERE action = 'credential.deleted'
       AND actor_type = 'admin'
       AND visible_to_customer = true
       AND metadata->>'customerId' = ${customerId}::text
       AND ts > now() - interval '7 days'
       AND ts > COALESCE(
         (SELECT last_cleanup_banner_dismissed_at FROM customers WHERE id = ${customerId}::uuid),
         '-infinity'::timestamptz
       )
     ORDER BY ts DESC
     LIMIT 1
  `.execute(db);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    auditId: row.id,
    ts: row.ts,
    provider: row.metadata?.provider ?? 'credential',
  };
}

export async function dismissCleanupBanner(db, customerId) {
  await sql`
    UPDATE customers
       SET last_cleanup_banner_dismissed_at = now()
     WHERE id = ${customerId}::uuid
  `.execute(db);
}
