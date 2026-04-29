import { createHash, randomInt } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';

export const TTL_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;
const CODE_DIGITS = 6;

function generateCode() {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

function hashCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

export async function requestOtp(db, { userType, userId, toAddress }) {
  const code = generateCode();
  const codeHash = hashCode(code);
  const id = uuidv7();
  const outboxId = uuidv7();

  await db.transaction().execute(async (tx) => {
    await sql`
      UPDATE email_otp_codes
         SET consumed_at = now()
       WHERE user_type = ${userType}
         AND user_id = ${userId}::uuid
         AND consumed_at IS NULL
    `.execute(tx);

    await sql`
      INSERT INTO email_otp_codes (id, user_type, user_id, code_hash, expires_at)
      VALUES (
        ${id},
        ${userType},
        ${userId}::uuid,
        ${codeHash},
        now() + (${TTL_MS}::bigint || ' milliseconds')::interval
      )
    `.execute(tx);

    await sql`
      INSERT INTO email_outbox (id, idempotency_key, to_address, template, locals)
      VALUES (
        ${outboxId},
        ${'email_otp:' + id},
        ${toAddress},
        'email_otp',
        ${JSON.stringify({ code })}::jsonb
      )
    `.execute(tx);
  });

  return { id };
}

export async function verifyOtp(db, { userType, userId, code }) {
  const codeHash = hashCode(code);
  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT id, code_hash, expires_at, attempts
        FROM email_otp_codes
       WHERE user_type = ${userType}
         AND user_id = ${userId}::uuid
         AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
    `.execute(tx);
    if (r.rows.length === 0) return false;

    const row = r.rows[0];
    if (new Date(row.expires_at).getTime() <= Date.now()) return false;
    if (Number(row.attempts) >= MAX_ATTEMPTS) return false;

    await sql`UPDATE email_otp_codes SET attempts = attempts + 1 WHERE id = ${row.id}`.execute(tx);

    if (row.code_hash !== codeHash) return false;

    await sql`UPDATE email_otp_codes SET consumed_at = now() WHERE id = ${row.id}`.execute(tx);
    return true;
  });
}
