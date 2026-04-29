import { randomBytes, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import {
  hashPassword, verifyPassword, hibpHasBeenPwned as defaultHibp,
} from '../../lib/crypto/hash.js';
import { writeAudit } from '../../lib/audit.js';
import { encrypt } from '../../lib/crypto/envelope.js';
import { saveRegisteredCredential } from '../../lib/auth/webauthn.js';
import { generateBackupCodes, verifyAndConsume } from '../../lib/auth/backup-codes.js';
import {
  insertAdmin, findById, findByEmail, updateAdmin,
} from './repo.js';

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;

function generateInviteToken() {
  return randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function audit(db, ctx, action, { adminId, metadata = {} } = {}) {
  return writeAudit(db, {
    actorType: ctx?.actorType ?? 'system',
    actorId: ctx?.actorId ?? null,
    action,
    targetType: 'admin',
    targetId: adminId ?? null,
    metadata: { ...(ctx?.audit ?? {}), ...metadata },
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  });
}

export async function create(db, { email, name }, ctx = {}) {
  const id = uuidv7();
  const inviteToken = generateInviteToken();
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await insertAdmin(db, { id, email, name, inviteTokenHash, inviteExpiresAt });
  await audit(db, ctx, 'admin.created', { adminId: id, metadata: { email } });

  return { id, inviteToken };
}

export async function consumeInvite(db, { token, newPassword }, ctx = {}) {
  const hibpFn = ctx.hibpHasBeenPwned ?? defaultHibp;
  if (await hibpFn(newPassword)) {
    throw new Error('password compromised in a known breach');
  }

  const tokenHash = hashToken(token);
  const admin = (await db.transaction().execute(async (tx) => {
    const found = await findByInviteHash(tx, tokenHash);
    if (!found) throw new Error('invalid invite token');
    if (found.invite_consumed_at) throw new Error('invite already consumed');
    if (new Date(found.invite_expires_at).getTime() <= Date.now()) {
      throw new Error('invite expired');
    }
    const passwordHash = await hashPassword(newPassword);
    await updateAdmin(tx, found.id, {
      passwordHash,
      inviteConsumedAt: new Date(),
    });
    return found;
  }));

  await audit(db, ctx, 'admin.password_set_via_invite', { adminId: admin.id });
  return { adminId: admin.id };
}

export async function verifyLogin(db, { email, password }) {
  const admin = await findByEmail(db, email);
  if (!admin) return null;
  if (!admin.password_hash) return null;
  const ok = await verifyPassword(admin.password_hash, password);
  return ok ? admin : null;
}

export async function requestPasswordReset(db, { email }, ctx = {}) {
  const admin = await findByEmail(db, email);
  if (!admin) {
    await audit(db, ctx, 'admin.password_reset_requested_unknown', { metadata: { email } });
    return { inviteToken: null };
  }

  const inviteToken = generateInviteToken();
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await updateAdmin(db, admin.id, {
    inviteTokenHash,
    inviteExpiresAt,
    inviteConsumedAt: null,
  });

  await audit(db, ctx, 'admin.password_reset_requested', { adminId: admin.id });
  return { inviteToken };
}

async function findByInviteHash(db, hash) {
  const r = await sql`SELECT * FROM admins WHERE invite_token_hash = ${hash}`.execute(db);
  return r.rows[0] ?? null;
}

export async function enroll2faTotp(db, { adminId, secret, kek }, ctx = {}) {
  const { ciphertext, iv, tag } = encrypt(Buffer.from(secret, 'utf8'), kek);
  await sql`
    UPDATE admins
       SET totp_secret_enc = ${ciphertext},
           totp_iv = ${iv},
           totp_tag = ${tag}
     WHERE id = ${adminId}::uuid
  `.execute(db);
  await audit(db, ctx, 'admin.2fa_totp_enrolled', { adminId });
}

export async function enroll2faWebauthn(db, { adminId, registrationInfo }, ctx = {}) {
  const admin = await findById(db, adminId);
  if (!admin) throw new Error('admin not found');
  const updated = saveRegisteredCredential(admin.webauthn_creds ?? [], registrationInfo);
  await sql`
    UPDATE admins
       SET webauthn_creds = ${JSON.stringify(updated)}::jsonb
     WHERE id = ${adminId}::uuid
  `.execute(db);
  await audit(db, ctx, 'admin.2fa_webauthn_enrolled', {
    adminId,
    metadata: { credentialId: registrationInfo.credentialID },
  });
}

export async function enroll2faEmailOtp(db, { adminId }, ctx = {}) {
  await sql`UPDATE admins SET email_otp_enabled = TRUE WHERE id = ${adminId}::uuid`.execute(db);
  await audit(db, ctx, 'admin.2fa_email_otp_enrolled', { adminId });
}

export async function regenBackupCodes(db, { adminId }, ctx = {}) {
  const { codes, stored } = await generateBackupCodes();
  await sql`
    UPDATE admins
       SET backup_codes = ${JSON.stringify(stored)}::jsonb
     WHERE id = ${adminId}::uuid
  `.execute(db);
  await audit(db, ctx, 'admin.backup_codes_regenerated', { adminId });
  return { codes };
}

export const NEW_DEVICE_WINDOW_MS = 30 * 24 * 3_600_000;

function monthBucket(date = new Date()) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function noticeLoginDevice(
  db,
  { adminId, fingerprint, toAddress, excludeSessionId = null },
  ctx = {},
) {
  const r = await sql`
    SELECT 1
      FROM sessions
     WHERE user_type = 'admin'
       AND user_id = ${adminId}::uuid
       AND device_fingerprint = ${fingerprint}
       AND id <> COALESCE(${excludeSessionId}, '')
       AND last_seen_at > now() - (${NEW_DEVICE_WINDOW_MS}::bigint || ' milliseconds')::interval
     LIMIT 1
  `.execute(db);
  if (r.rows.length > 0) return { isNew: false };

  const idempotencyKey = `new_device_login:${adminId}:${fingerprint}:${monthBucket()}`;
  await sql`
    INSERT INTO email_outbox (id, idempotency_key, to_address, template, locals)
    VALUES (
      ${uuidv7()}::uuid,
      ${idempotencyKey},
      ${toAddress},
      'new_device_login',
      ${JSON.stringify({ fingerprint, at: new Date().toISOString() })}::jsonb
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `.execute(db);

  await audit(db, ctx, 'admin.new_device_login', {
    adminId,
    metadata: { fingerprint },
  });

  return { isNew: true };
}

export async function consumeBackupCode(db, { adminId, code }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const admin = await findById(tx, adminId);
    if (!admin) return { ok: false };
    const stored = admin.backup_codes ?? [];
    const r = await verifyAndConsume(stored, code);
    if (!r.ok) return { ok: false };
    await sql`
      UPDATE admins SET backup_codes = ${JSON.stringify(r.stored)}::jsonb
       WHERE id = ${adminId}::uuid
    `.execute(tx);
    await audit(tx, ctx, 'admin.backup_code_consumed', { adminId });
    return { ok: true };
  });
}
