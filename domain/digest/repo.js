// Phase B digest pipeline storage layer.
//
// Two tables, four operations:
//   1. insertItem / findCoalescable / updateCoalesced — write side
//   2. upsertSchedule — keeps the per-recipient debounce timer current
//   3. claimDue + drainItems + clearSchedule — the worker's drain loop
//
// upsertSchedule writes the next configured fire slot (08:00 / 17:00
// Atlantic/Canary) into due_at; oldest_item_at survives across upserts
// in the same cycle as the timestamp of the first pending item.

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

export async function upsertSchedule(db, { recipientType, recipientId, dueAt }) {
  // dueAt is a Date computed by nextDigestFire(); we always overwrite the
  // schedule to the next configured fire slot. The LEAST(...) cap from the
  // sliding-window era is gone — items now wait deterministically for the
  // next 08:00 or 17:00 Atlantic/Canary fire.
  // oldest_item_at is set on insert and untouched on conflict so it
  // preserves the timestamp of the first pending item in the current cycle.
  const dueAtIso = dueAt.toISOString();
  await sql`
    INSERT INTO digest_schedules (recipient_type, recipient_id, due_at, oldest_item_at)
    VALUES (
      ${recipientType}, ${recipientId}::uuid,
      ${dueAtIso}::timestamptz,
      now()
    )
    ON CONFLICT (recipient_type, recipient_id) DO UPDATE
      SET due_at = ${dueAtIso}::timestamptz
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
