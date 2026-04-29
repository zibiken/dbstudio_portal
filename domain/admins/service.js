import { randomBytes, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import {
  hashPassword, verifyPassword, hibpHasBeenPwned as defaultHibp, SENTINEL_HASH,
} from '../../lib/crypto/hash.js';
import { writeAudit } from '../../lib/audit.js';
import { encrypt } from '../../lib/crypto/envelope.js';
import { saveRegisteredCredential } from '../../lib/auth/webauthn.js';
import { generateBackupCodes, verifyAndConsume } from '../../lib/auth/backup-codes.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
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

function trimTrailingSlashes(s) {
  return typeof s === 'string' ? s.replace(/\/+$/, '') : '';
}

function resolvePortalBaseUrl(ctx) {
  return trimTrailingSlashes(ctx?.portalBaseUrl ?? process.env.PORTAL_BASE_URL ?? '');
}

export async function create(db, { email, name }, ctx = {}) {
  const id = uuidv7();
  const inviteToken = generateInviteToken();
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await insertAdmin(db, { id, email, name, inviteTokenHash, inviteExpiresAt });
  await audit(db, ctx, 'admin.created', { adminId: id, metadata: { email } });

  const baseUrl = resolvePortalBaseUrl(ctx);
  if (baseUrl) {
    await enqueueEmail(db, {
      idempotencyKey: `admin_welcome:${id}`,
      toAddress: email,
      template: 'admin-welcome',
      locals: {
        recipientName: name,
        welcomeUrl: `${baseUrl}/welcome/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });
  }

  return { id, inviteToken };
}

async function lockInviteRow(tx, tokenHash) {
  const r = await sql`
    SELECT id, invite_consumed_at, invite_expires_at
      FROM admins
     WHERE invite_token_hash = ${tokenHash}
       FOR UPDATE
  `.execute(tx);
  if (r.rows.length === 0) throw new Error('invalid invite token');
  const row = r.rows[0];
  if (row.invite_consumed_at) throw new Error('invite already consumed');
  if (new Date(row.invite_expires_at).getTime() <= Date.now()) {
    throw new Error('invite expired');
  }
  return row;
}

export async function consumeInvite(db, { token, newPassword }, ctx = {}) {
  const hibpFn = ctx.hibpHasBeenPwned ?? defaultHibp;
  if (await hibpFn(newPassword)) {
    throw new Error('password compromised in a known breach');
  }

  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(newPassword);

  const adminId = await db.transaction().execute(async (tx) => {
    const row = await lockInviteRow(tx, tokenHash);
    await sql`
      UPDATE admins
         SET password_hash = ${passwordHash},
             invite_consumed_at = now()
       WHERE id = ${row.id}::uuid
    `.execute(tx);
    return row.id;
  });

  await audit(db, ctx, 'admin.password_set_via_invite', { adminId });
  return { adminId };
}

export async function completeWelcome(
  db,
  { token, newPassword, totpSecret, kek },
  ctx = {},
) {
  const hibpFn = ctx.hibpHasBeenPwned ?? defaultHibp;
  if (await hibpFn(newPassword)) {
    throw new Error('password compromised in a known breach');
  }

  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(newPassword);
  const { codes, stored } = await generateBackupCodes();
  const env = encrypt(Buffer.from(totpSecret, 'utf8'), kek);

  return await db.transaction().execute(async (tx) => {
    const row = await lockInviteRow(tx, tokenHash);
    await sql`
      UPDATE admins
         SET password_hash = ${passwordHash},
             invite_consumed_at = now(),
             totp_secret_enc = ${env.ciphertext},
             totp_iv = ${env.iv},
             totp_tag = ${env.tag},
             backup_codes = ${JSON.stringify(stored)}::jsonb
       WHERE id = ${row.id}::uuid
    `.execute(tx);

    await audit(tx, ctx, 'admin.password_set_via_invite', { adminId: row.id });
    await audit(tx, ctx, 'admin.2fa_totp_enrolled', { adminId: row.id });
    await audit(tx, ctx, 'admin.backup_codes_regenerated', { adminId: row.id });

    return { adminId: row.id, codes };
  });
}

export async function verifyLogin(db, { email, password }) {
  const admin = typeof email === 'string' ? await findByEmail(db, email) : null;
  // Always run argon2 verify so the wall-clock cost is constant regardless
  // of whether the email exists or has a password set. Without this an
  // attacker can enumerate valid admin emails by timing the response.
  const ok = await verifyPassword(admin?.password_hash ?? SENTINEL_HASH, password ?? '');
  return ok && admin?.password_hash ? admin : null;
}

export async function requestPasswordReset(db, { email }, ctx = {}) {
  const admin = await findByEmail(db, email);
  if (!admin) {
    const safeEmail = typeof email === 'string' ? email.slice(0, 320) : null;
    await audit(db, ctx, 'admin.password_reset_requested_unknown', { metadata: { email: safeEmail } });
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

  const baseUrl = resolvePortalBaseUrl(ctx);
  if (baseUrl) {
    await enqueueEmail(db, {
      idempotencyKey: `admin_pw_reset:${admin.id}:${inviteTokenHash.slice(0, 16)}`,
      toAddress: admin.email,
      template: 'admin-pw-reset',
      locals: {
        recipientName: admin.name,
        resetUrl: `${baseUrl}/reset/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });
  }

  return { inviteToken };
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
  {
    adminId,
    fingerprint,
    toAddress,
    recipientName,
    ip,
    userAgent,
    portalBaseUrl,
    excludeSessionId = null,
  },
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

  const baseUrl = trimTrailingSlashes(portalBaseUrl ?? ctx?.portalBaseUrl ?? process.env.PORTAL_BASE_URL ?? '');
  if (!baseUrl) throw new Error('noticeLoginDevice requires portalBaseUrl');

  const idempotencyKey = `new_device_login:${adminId}:${fingerprint}:${monthBucket()}`;
  const locals = {
    recipientName: recipientName ?? '',
    when: new Date().toISOString(),
    ip: ip ?? '',
    userAgent: userAgent ?? '',
    sessionsUrl: `${baseUrl}/profile/sessions`,
  };
  await sql`
    INSERT INTO email_outbox (id, idempotency_key, to_address, template, locals)
    VALUES (
      ${uuidv7()}::uuid,
      ${idempotencyKey},
      ${toAddress},
      'new-device-login',
      ${JSON.stringify(locals)}::jsonb
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
