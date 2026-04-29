import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

export async function enqueue(
  db,
  { idempotencyKey, toAddress, template, locale = 'en', locals = {}, sendAfter = null },
) {
  const id = uuidv7();
  const localsJson = JSON.stringify(locals);
  const r = await sql`
    INSERT INTO email_outbox (id, idempotency_key, to_address, template, locale, locals, send_after)
    VALUES (
      ${id}::uuid,
      ${idempotencyKey},
      ${toAddress},
      ${template},
      ${locale},
      ${localsJson}::jsonb,
      COALESCE(${sendAfter}::timestamptz, now())
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `.execute(db);
  return r.rows[0]?.id ?? null;
}

export async function claim(tx, { batchSize }) {
  const r = await sql`
    UPDATE email_outbox
       SET status = 'sending',
           attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM email_outbox
        WHERE status IN ('queued', 'failed')
          AND send_after <= now()
          AND attempts < 5
        ORDER BY send_after ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, idempotency_key, to_address, template, locale, locals, attempts
  `.execute(tx);
  return r.rows;
}

export async function markSent(tx, { id }) {
  await sql`
    UPDATE email_outbox
       SET status = 'sent',
           sent_at = now(),
           last_error = NULL,
           locals = locals - 'code'
     WHERE id = ${id}::uuid
  `.execute(tx);
}

export async function markFailed(tx, { id, retryable, attempts, errorMessage }) {
  const capped = Number(attempts) >= 5;
  const nextStatus = retryable && !capped ? 'queued' : 'failed';
  const backoffMs = Math.min(2 ** Number(attempts) * 60_000, 3_600_000);
  await sql`
    UPDATE email_outbox
       SET status = ${nextStatus},
           send_after = now() + (${backoffMs}::bigint || ' milliseconds')::interval,
           last_error = ${errorMessage}
     WHERE id = ${id}::uuid
  `.execute(tx);
}
