import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

export async function enqueue(
  db,
  { idempotencyKey, toAddress, template, locale = 'en', locals = {}, sendAfter = null, subjectOverride = null },
) {
  const id = uuidv7();
  const localsForRender = subjectOverride
    ? { ...locals, __subject_override: subjectOverride }
    : locals;
  const localsJson = JSON.stringify(localsForRender);
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

// Token-bearing locals are bearer credentials. The outbox row outlives
// the send (kept for forensics + idempotency dedupe), so plaintext
// magic-link URLs and OTP codes must not linger past delivery.
const SENSITIVE_LOCAL_KEYS = Object.freeze([
  'code',
  'welcomeUrl',
  'resetUrl',
  'inviteUrl',
  'verifyUrl',
  'revertUrl',
]);

export async function markSent(tx, { id }) {
  // jsonb minus a text[] removes every named key in one statement.
  await sql`
    UPDATE email_outbox
       SET status = 'sent',
           sent_at = now(),
           last_error = NULL,
           locals = locals - ${SENSITIVE_LOCAL_KEYS}::text[]
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
