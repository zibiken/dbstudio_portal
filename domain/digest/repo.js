// Phase B digest pipeline storage layer.
//
// Two tables, four operations:
//   1. insertItem / findCoalescable / updateCoalesced — write side
//   2. upsertSchedule — keeps the per-recipient debounce timer current
//   3. claimDue + drainItems + clearSchedule — the worker's drain loop
//
// Cadence (post-Phase-G hybrid revert): each new event resets a 10-minute
// idle timer per recipient ("send the digest 10 min after the LAST event"),
// with a 60-minute hard cap measured from the first un-sent item so a
// continuous activity stream still drains. Phase F's twice-daily fixed
// fires (08:00 + 17:00 Atlantic/Canary) are reverted; the per-customer
// admin grouping, dynamic subject and recipient-aware copy from Phase F
// are preserved upstream in lib/digest-strings.js + emails/.

import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

export async function insertItem(db, {
  recipientType, recipientId, customerId, bucket,
  eventType, title, detail, linkPath, metadata,
}) {
  const id = uuidv7();
  await sql`
    INSERT INTO pending_digest_items
      (id, recipient_type, recipient_id, customer_id, bucket, event_type, title, detail, link_path, metadata)
    VALUES (
      ${id}::uuid, ${recipientType}, ${recipientId}::uuid,
      ${customerId ? sql`${customerId}::uuid` : sql`NULL`},
      ${bucket}, ${eventType}, ${title}, ${detail ?? null}, ${linkPath ?? null},
      ${JSON.stringify(metadata ?? {})}::jsonb
    )
  `.execute(db);
  return id;
}

// `metadataMatch` (optional): per-event-type extra discriminators read from
// `metadata->>'<key>'` so callers can require a row to share, e.g., the same
// phaseId before coalescing. Without this, two phases toggled in the same
// digest window collapsed into one row carrying the first phase's label
// (post-Phase-G follow-up; spec Decision 5 deviation).
export async function findCoalescable(db, {
  recipientType, recipientId, eventType, customerId, metadataMatch = null,
}) {
  const metaClauses = metadataMatch && typeof metadataMatch === 'object'
    ? Object.entries(metadataMatch).map(([k, v]) => (
        v == null
          ? sql` AND (metadata->>${k}) IS NULL`
          : sql` AND metadata->>${k} = ${String(v)}`
      ))
    : [];
  const metaClause = metaClauses.length > 0 ? sql.join(metaClauses, sql``) : sql``;
  const r = await sql`
    SELECT id::text AS id, title, detail, metadata
      FROM pending_digest_items
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
       AND event_type     = ${eventType}
       AND customer_id IS NOT DISTINCT FROM ${customerId ? sql`${customerId}::uuid` : sql`NULL::uuid`}
       ${metaClause}
     ORDER BY created_at DESC
     LIMIT 1
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function updateCoalesced(db, { id, title, detail, metadata }) {
  await sql`
    UPDATE pending_digest_items
       SET title    = ${title},
           detail   = ${detail ?? null},
           metadata = ${JSON.stringify(metadata ?? {})}::jsonb
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function upsertSchedule(db, {
  recipientType, recipientId, now, windowMinutes, capMinutes,
}) {
  // Debounce semantics:
  //   - INSERT (no schedule yet): due_at = now + windowMinutes,
  //     oldest_item_at = now (anchors the cap).
  //   - UPDATE (existing schedule): due_at slides to LEAST(now + window,
  //     oldest_item_at + cap). oldest_item_at is preserved across upserts;
  //     the worker drains and clears the row at fire time, after which
  //     the next event re-INSERTs and re-anchors oldest_item_at.
  const nowIso = (now ?? new Date()).toISOString();
  const window = `${Number(windowMinutes)} minutes`;
  const cap    = `${Number(capMinutes)} minutes`;
  await sql`
    INSERT INTO digest_schedules (recipient_type, recipient_id, due_at, oldest_item_at)
    VALUES (
      ${recipientType}, ${recipientId}::uuid,
      ${nowIso}::timestamptz + ${window}::interval,
      ${nowIso}::timestamptz
    )
    ON CONFLICT (recipient_type, recipient_id) DO UPDATE
      SET due_at = LEAST(
        ${nowIso}::timestamptz + ${window}::interval,
        digest_schedules.oldest_item_at + ${cap}::interval
      )
  `.execute(db);
}

export async function findSchedule(db, { recipientType, recipientId }) {
  const r = await sql`
    SELECT recipient_type, recipient_id::text AS recipient_id, due_at, oldest_item_at
      FROM digest_schedules
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function claimDue(tx, { batchSize, now = new Date() }) {
  const r = await sql`
    SELECT recipient_type, recipient_id::text AS recipient_id
      FROM digest_schedules
     WHERE due_at <= ${now.toISOString()}::timestamptz
     ORDER BY due_at ASC
     LIMIT ${Number(batchSize)}
     FOR UPDATE SKIP LOCKED
  `.execute(tx);
  return r.rows;
}

export async function drainItems(tx, { recipientType, recipientId }) {
  const r = await sql`
    DELETE FROM pending_digest_items
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
    RETURNING id::text AS id, customer_id::text AS customer_id, bucket, event_type, title, detail, link_path, metadata, created_at
  `.execute(tx);
  return r.rows;
}

export async function clearSchedule(tx, { recipientType, recipientId }) {
  await sql`
    DELETE FROM digest_schedules
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
  `.execute(tx);
}
