import { randomBytes, createHash } from 'node:crypto';
import { sql } from 'kysely';

export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 12 * 3_600_000;
export const STEP_UP_WINDOW_MS = 5 * 60_000;

function ipv4SubnetPrefix(ip) {
  const parts = String(ip ?? '').split('.');
  if (parts.length !== 4) return String(ip ?? '');
  return parts.slice(0, 3).join('.') + '.0/24';
}

export function computeDeviceFingerprint(userAgent, ip) {
  const ua = String(userAgent ?? '');
  const subnet = ipv4SubnetPrefix(ip);
  return createHash('sha256').update(ua).update('|').update(subnet).digest('hex');
}

export async function createSession(db, { userType, userId, ip = null, deviceFingerprint = null }) {
  const id = randomBytes(32).toString('hex');
  await sql`
    INSERT INTO sessions (id, user_type, user_id, ip, device_fingerprint, absolute_expires_at)
    VALUES (
      ${id},
      ${userType},
      ${userId}::uuid,
      ${ip}::inet,
      ${deviceFingerprint},
      now() + (${ABSOLUTE_MS}::bigint || ' milliseconds')::interval
    )
  `.execute(db);
  return id;
}

export async function loadSession(db, id) {
  const r = await sql`
    UPDATE sessions
       SET last_seen_at = now()
     WHERE id = ${id}
       AND revoked_at IS NULL
       AND absolute_expires_at > now()
       AND last_seen_at > now() - (${IDLE_MS}::bigint || ' milliseconds')::interval
    RETURNING id, user_type, user_id::text AS user_id, step_up_at, device_fingerprint, host(ip) AS ip
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function stepUp(db, id) {
  await sql`UPDATE sessions SET step_up_at = now() WHERE id = ${id}`.execute(db);
}

export async function isStepped(db, id) {
  const r = await sql`
    SELECT 1 FROM sessions
     WHERE id = ${id}
       AND step_up_at IS NOT NULL
       AND step_up_at > now() - (${STEP_UP_WINDOW_MS}::bigint || ' milliseconds')::interval
  `.execute(db);
  return r.rows.length > 0;
}

export async function revokeAll(db, { userType, userId }) {
  await sql`
    UPDATE sessions
       SET revoked_at = now()
     WHERE user_type = ${userType}
       AND user_id = ${userId}::uuid
       AND revoked_at IS NULL
  `.execute(db);
}
