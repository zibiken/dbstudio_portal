// Phase B digest pipeline storage layer.
//
// Two tables, four operations:
//   1. insertItem / findCoalescable / updateCoalesced — write side
//   2. upsertSchedule — keeps the per-recipient debounce timer current
//   3. claimDue + drainItems + clearSchedule — the worker's drain loop
//
// upsertSchedule's LEAST(...) clause enforces the 60-min hard cap so a
// recipient who keeps generating events cannot starve their digest
// indefinitely; once oldest_item_at is 60 min old, due_at stops sliding.

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

export async function findCoalescable(db, {
  recipientType, recipientId, eventType, customerId,
}) {
  const r = await sql`
    SELECT id::text AS id, title, detail, metadata
      FROM pending_digest_items
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
       AND event_type     = ${eventType}
       AND customer_id IS NOT DISTINCT FROM ${customerId ? sql`${customerId}::uuid` : sql`NULL::uuid`}
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
  recipientType, recipientId, windowMinutes, capMinutes,
}) {
  const window = `${Number(windowMinutes)} minutes`;
  const cap = `${Number(capMinutes)} minutes`;
  await sql`
    INSERT INTO digest_schedules (recipient_type, recipient_id, due_at, oldest_item_at)
    VALUES (
      ${recipientType}, ${recipientId}::uuid,
      now() + ${window}::interval,
      now()
    )
    ON CONFLICT (recipient_type, recipient_id) DO UPDATE
      SET due_at = LEAST(
        now() + ${cap === '0 minutes' ? sql`'0 minutes'::interval` : sql`${window}::interval`},
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

export async function claimDue(tx, { batchSize }) {
  const r = await sql`
    SELECT recipient_type, recipient_id::text AS recipient_id
      FROM digest_schedules
     WHERE due_at <= now()
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
