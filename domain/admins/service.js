import { randomBytes, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import {
  hashPassword, verifyPassword, hibpHasBeenPwned as defaultHibp, SENTINEL_HASH,
} from '../../lib/crypto/hash.js';
import { writeAudit } from '../../lib/audit.js';
import { encrypt, decrypt } from '../../lib/crypto/envelope.js';
import { saveRegisteredCredential } from '../../lib/auth/webauthn.js';
import { generateBackupCodes, verifyAndConsume } from '../../lib/auth/backup-codes.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { createSession, stepUp } from '../../lib/auth/session.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
import {
  insertAdmin, findById, findByEmail, updateAdmin,
} from './repo.js';

export const PASSWORD_MIN_LENGTH = 12;
export const ADMIN_NAME_MAX = 256;
export const EMAIL_VERIFY_TTL_MS = 24 * 3_600_000;
export const EMAIL_REVERT_TTL_MS = 7 * 24 * 3_600_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 320;

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

function requirePortalBaseUrl(ctx, callerName) {
  const url = trimTrailingSlashes(ctx?.portalBaseUrl ?? process.env.PORTAL_BASE_URL ?? '');
  if (!url) {
    throw new Error(`${callerName} requires portalBaseUrl (ctx.portalBaseUrl or PORTAL_BASE_URL env)`);
  }
  return url;
}

export async function create(db, { email, name }, ctx = {}) {
  const id = uuidv7();
  const inviteToken = generateInviteToken();
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const baseUrl = requirePortalBaseUrl(ctx, 'admins.create');

  await db.transaction().execute(async (tx) => {
    await insertAdmin(tx, { id, email, name, inviteTokenHash, inviteExpiresAt });
    await audit(tx, ctx, 'admin.created', { adminId: id, metadata: { email } });
    await enqueueEmail(tx, {
      idempotencyKey: `admin_welcome:${id}`,
      toAddress: email,
      template: 'admin-welcome',
      locals: {
        recipientName: name,
        welcomeUrl: `${baseUrl}/welcome/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });
  });

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
  { token, newPassword, totpSecret, kek, sessionIp = null, sessionDeviceFingerprint = null },
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

    // Mint the admin's first session inside the same tx as the invite
    // consumption — mirrors completeCustomerWelcome. Without this the
    // operator would have to do a separate /login + /login/2fa hop after
    // already proving both factors (password + TOTP) in this POST, which
    // surfaces as a confusing bounce back to /login.
    const sid = await createSession(tx, {
      userType: 'admin',
      userId: row.id,
      ip: sessionIp,
      deviceFingerprint: sessionDeviceFingerprint,
    });
    await stepUp(tx, sid);
    await audit(tx, ctx, 'admin.login_success', {
      adminId: row.id,
      metadata: { method: 'totp', via: 'onboarding' },
    });

    return { adminId: row.id, codes, sid };
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
  const baseUrl = requirePortalBaseUrl(ctx, 'admins.requestPasswordReset');

  await db.transaction().execute(async (tx) => {
    await updateAdmin(tx, admin.id, {
      inviteTokenHash,
      inviteExpiresAt,
      inviteConsumedAt: null,
    });
    await audit(tx, ctx, 'admin.password_reset_requested', { adminId: admin.id });
    await enqueueEmail(tx, {
      idempotencyKey: `admin_pw_reset:${admin.id}:${inviteTokenHash.slice(0, 16)}`,
      toAddress: admin.email,
      template: 'admin-pw-reset',
      locals: {
        recipientName: admin.name,
        resetUrl: `${baseUrl}/reset/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });
  });

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

  const baseUrl = requirePortalBaseUrl(
    { portalBaseUrl: portalBaseUrl ?? ctx?.portalBaseUrl },
    'admins.noticeLoginDevice',
  );

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

// ─── M9 admin self-service profile management ────────────────────────────

function requireKek(ctx, callerName) {
  const kek = ctx?.kek;
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error(`${callerName} requires ctx.kek (32-byte Buffer from app.kek)`);
  }
  return kek;
}

function profileAudit(db, ctx, action, { adminId, metadata = {}, visibleToCustomer = false }) {
  return writeAudit(db, {
    actorType: ctx?.actorType ?? 'admin',
    actorId: ctx?.actorId ?? adminId,
    action,
    targetType: 'admin',
    targetId: adminId,
    metadata: { ...(ctx?.audit ?? {}), ...metadata },
    visibleToCustomer,
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  });
}

export async function updateAdminName(db, { adminId, name }, ctx = {}) {
  if (typeof name !== 'string') throw new Error('updateAdminName: name must be a string');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('updateAdminName: name cannot be blank');
  if (trimmed.length > ADMIN_NAME_MAX) throw new Error(`updateAdminName: name exceeds ${ADMIN_NAME_MAX} chars`);
  return await db.transaction().execute(async (tx) => {
    const r = await sql`SELECT name FROM admins WHERE id = ${adminId}::uuid FOR UPDATE`.execute(tx);
    if (r.rows.length === 0) throw new Error(`admin ${adminId} not found`);
    const previousName = r.rows[0].name;
    if (previousName === trimmed) return { adminId, changed: false };
    await sql`UPDATE admins SET name = ${trimmed} WHERE id = ${adminId}::uuid`.execute(tx);
    await profileAudit(tx, ctx, 'admin.name_changed', {
      adminId, metadata: { previousName, newName: trimmed },
    });
    return { adminId, changed: true };
  });
}

export async function changeAdminPassword(
  db,
  { adminId, currentPassword, newPassword, currentSessionId = null },
  ctx = {},
) {
  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`changeAdminPassword: new password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw new Error('changeAdminPassword: current password is required');
  }
  if (newPassword === currentPassword) {
    throw new Error('changeAdminPassword: new password must differ from current');
  }

  const r = await sql`SELECT password_hash FROM admins WHERE id = ${adminId}::uuid`.execute(db);
  const stored = r.rows[0]?.password_hash ?? null;
  const ok = await verifyPassword(stored ?? SENTINEL_HASH, currentPassword);
  if (!ok || !stored) {
    await profileAudit(db, ctx, 'admin.password_change_failed', { adminId });
    throw new Error('changeAdminPassword: current password did not match');
  }

  const hibpFn = ctx.hibpHasBeenPwned ?? defaultHibp;
  if (await hibpFn(newPassword)) {
    throw new Error('changeAdminPassword: new password appears in a known data breach (HIBP)');
  }
  const newHash = await hashPassword(newPassword);

  await db.transaction().execute(async (tx) => {
    await sql`UPDATE admins SET password_hash = ${newHash} WHERE id = ${adminId}::uuid`.execute(tx);
    await sql`
      UPDATE sessions
         SET revoked_at = now()
       WHERE user_type = 'admin'
         AND user_id = ${adminId}::uuid
         AND revoked_at IS NULL
         AND id <> COALESCE(${currentSessionId}, '')
    `.execute(tx);
    await profileAudit(tx, ctx, 'admin.password_changed', { adminId });
  });
  return { adminId };
}

function generateChangeToken() { return randomBytes(32).toString('base64url'); }
function hashChangeToken(token) { return createHash('sha256').update(token).digest('hex'); }
function trimSlash(s) { return typeof s === 'string' ? s.replace(/\/+$/, '') : ''; }
function reqBaseUrl(ctx, caller) {
  const u = trimSlash(ctx?.portalBaseUrl ?? process.env.PORTAL_BASE_URL ?? '');
  if (!u) throw new Error(`${caller} requires portalBaseUrl`);
  return u;
}
function normaliseEmail(raw) {
  if (typeof raw !== 'string') throw new Error('email must be a string');
  const t = raw.trim().toLowerCase();
  if (!t || t.length > EMAIL_MAX || !EMAIL_RE.test(t)) {
    throw new Error('email is not a valid address');
  }
  return t;
}

export async function requestAdminEmailChange(db, { adminId, newEmail }, ctx = {}) {
  const baseUrl = reqBaseUrl(ctx, 'requestAdminEmailChange');
  const next = normaliseEmail(newEmail);
  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT id::text AS id, email, name FROM admins WHERE id = ${adminId}::uuid FOR UPDATE
    `.execute(tx);
    if (r.rows.length === 0) throw new Error(`admin ${adminId} not found`);
    const admin = r.rows[0];
    if (admin.email === next) throw new Error('new email is the same as the current email');

    const collA = await sql`SELECT 1 FROM admins WHERE email = ${next} AND id <> ${adminId}::uuid`.execute(tx);
    const collB = await sql`SELECT 1 FROM customer_users WHERE email = ${next}`.execute(tx);
    if (collA.rows.length > 0 || collB.rows.length > 0) throw new Error('email already in use');

    await sql`
      UPDATE email_change_requests
         SET cancelled_at = now(), verify_token_hash = NULL, revert_token_hash = NULL
       WHERE user_type = 'admin' AND user_id = ${adminId}::uuid
         AND verified_at IS NULL AND cancelled_at IS NULL
    `.execute(tx);

    const token = generateChangeToken();
    const tokenHash = hashChangeToken(token);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_MS);
    const reqId = uuidv7();
    await sql`
      INSERT INTO email_change_requests (
        id, user_type, user_id, old_email, new_email, verify_token_hash, verify_expires_at
      ) VALUES (
        ${reqId}::uuid, 'admin', ${adminId}::uuid, ${admin.email}, ${next},
        ${tokenHash}, ${expiresAt.toISOString()}::timestamptz
      )
    `.execute(tx);

    await enqueueEmail(tx, {
      idempotencyKey: `admin_email_change_verify:${reqId}`,
      toAddress: next,
      template: 'email-change-verification',
      locals: {
        recipientName: admin.name,
        newEmail: next,
        verifyUrl: `${baseUrl}/admin/profile/email/verify/${token}`,
        expiresAt: expiresAt.toISOString(),
      },
    });
    await profileAudit(tx, ctx, 'admin.email_change_requested', {
      adminId, metadata: { oldEmail: admin.email, newEmail: next, requestId: reqId },
    });
    return { token, expiresAt, requestId: reqId, oldEmail: admin.email, newEmail: next };
  });
}

export async function verifyAdminEmailChange(db, { token }, ctx = {}) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('verifyAdminEmailChange: invalid token');
  const tokenHash = hashChangeToken(token);
  const baseUrl = reqBaseUrl(ctx, 'verifyAdminEmailChange');

  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT id::text AS id, user_type, user_id::text AS user_id,
             old_email, new_email, verify_expires_at, verified_at, cancelled_at
        FROM email_change_requests WHERE verify_token_hash = ${tokenHash} FOR UPDATE
    `.execute(tx);
    if (r.rows.length === 0) throw new Error('verifyAdminEmailChange: invalid token');
    const req = r.rows[0];
    if (req.user_type !== 'admin') throw new Error('verifyAdminEmailChange: token is not for an admin');
    if (req.cancelled_at || req.verified_at) throw new Error('verifyAdminEmailChange: invalid token');
    if (new Date(req.verify_expires_at).getTime() <= Date.now()) {
      throw new Error('verifyAdminEmailChange: token expired');
    }
    const adminR = await sql`SELECT name FROM admins WHERE id = ${req.user_id}::uuid FOR UPDATE`.execute(tx);
    if (adminR.rows.length === 0) throw new Error('verifyAdminEmailChange: admin no longer exists');
    const collA = await sql`SELECT 1 FROM admins WHERE email = ${req.new_email} AND id <> ${req.user_id}::uuid`.execute(tx);
    const collB = await sql`SELECT 1 FROM customer_users WHERE email = ${req.new_email}`.execute(tx);
    if (collA.rows.length > 0 || collB.rows.length > 0) throw new Error('verifyAdminEmailChange: email already in use');

    const revertToken = generateChangeToken();
    const revertTokenHash = hashChangeToken(revertToken);
    const revertExpiresAt = new Date(Date.now() + EMAIL_REVERT_TTL_MS);

    await sql`UPDATE admins SET email = ${req.new_email} WHERE id = ${req.user_id}::uuid`.execute(tx);
    await sql`
      UPDATE email_change_requests
         SET verified_at = now(), verify_token_hash = NULL,
             revert_token_hash = ${revertTokenHash},
             revert_expires_at = ${revertExpiresAt.toISOString()}::timestamptz
       WHERE id = ${req.id}::uuid
    `.execute(tx);
    await enqueueEmail(tx, {
      idempotencyKey: `admin_email_change_revert:${req.id}`,
      toAddress: req.old_email,
      template: 'email-change-notification-old',
      locals: {
        recipientName: adminR.rows[0].name,
        oldEmail: req.old_email,
        newEmail: req.new_email,
        changedAt: new Date().toISOString(),
        revertUrl: `${baseUrl}/admin/profile/email/revert/${revertToken}`,
      },
    });
    await profileAudit(tx, ctx, 'admin.email_change_verified', {
      adminId: req.user_id,
      metadata: { oldEmail: req.old_email, newEmail: req.new_email, requestId: req.id },
    });
    return { adminId: req.user_id, oldEmail: req.old_email, newEmail: req.new_email, revertToken, revertExpiresAt };
  });
}

export async function revertAdminEmailChange(db, { token }, ctx = {}) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('revertAdminEmailChange: invalid token');
  const tokenHash = hashChangeToken(token);

  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT id::text AS id, user_type, user_id::text AS user_id,
             old_email, new_email, revert_expires_at, reverted_at
        FROM email_change_requests WHERE revert_token_hash = ${tokenHash} FOR UPDATE
    `.execute(tx);
    if (r.rows.length === 0) throw new Error('revertAdminEmailChange: invalid token');
    const req = r.rows[0];
    if (req.user_type !== 'admin') throw new Error('revertAdminEmailChange: token is not for an admin');
    if (req.reverted_at) throw new Error('revertAdminEmailChange: invalid token');
    if (!req.revert_expires_at || new Date(req.revert_expires_at).getTime() <= Date.now()) {
      throw new Error('revertAdminEmailChange: token expired');
    }
    await sql`UPDATE admins SET email = ${req.old_email} WHERE id = ${req.user_id}::uuid`.execute(tx);
    await sql`
      UPDATE email_change_requests SET reverted_at = now(), revert_token_hash = NULL WHERE id = ${req.id}::uuid
    `.execute(tx);
    await sql`
      UPDATE sessions
         SET revoked_at = now()
       WHERE user_type = 'admin' AND user_id = ${req.user_id}::uuid AND revoked_at IS NULL
    `.execute(tx);
    await profileAudit(tx, ctx, 'admin.email_change_reverted', {
      adminId: req.user_id,
      metadata: { restoredEmail: req.old_email, undoneEmail: req.new_email, requestId: req.id },
    });
    return { adminId: req.user_id, restoredEmail: req.old_email };
  });
}

export async function regenAdminTotpSelf(
  db,
  { adminId, currentCode, newSecret, newCode },
  ctx = {},
) {
  const kek = requireKek(ctx, 'regenAdminTotpSelf');
  if (typeof newSecret !== 'string' || newSecret.length < 16) {
    throw new Error('regenAdminTotpSelf: newSecret must be a base32 TOTP secret');
  }
  if (typeof currentCode !== 'string' || typeof newCode !== 'string') {
    throw new Error('regenAdminTotpSelf: codes must be strings');
  }
  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT totp_secret_enc, totp_iv, totp_tag FROM admins WHERE id = ${adminId}::uuid FOR UPDATE
    `.execute(tx);
    if (r.rows.length === 0) throw new Error(`admin ${adminId} not found`);
    if (!r.rows[0].totp_secret_enc) {
      throw new Error('regenAdminTotpSelf: admin has no current TOTP secret to verify against');
    }
    const currentSecret = decrypt({
      ciphertext: r.rows[0].totp_secret_enc,
      iv: r.rows[0].totp_iv,
      tag: r.rows[0].totp_tag,
    }, kek).toString('utf8');
    if (!verifyTotp(currentSecret, currentCode)) throw new Error('regenAdminTotpSelf: current code did not verify');
    if (!verifyTotp(newSecret, newCode)) throw new Error('regenAdminTotpSelf: new code did not verify the new secret');

    const env = encrypt(Buffer.from(newSecret, 'utf8'), kek);
    await sql`
      UPDATE admins SET totp_secret_enc = ${env.ciphertext}, totp_iv = ${env.iv}, totp_tag = ${env.tag}
       WHERE id = ${adminId}::uuid
    `.execute(tx);
    await profileAudit(tx, ctx, 'admin.2fa_totp_regenerated', { adminId });
    return { adminId };
  });
}

export async function regenAdminBackupCodesSelf(
  db,
  { adminId, currentCode = null, backupCode = null },
  ctx = {},
) {
  const kek = requireKek(ctx, 'regenAdminBackupCodesSelf');
  if (!currentCode && !backupCode) {
    throw new Error('regenAdminBackupCodesSelf: provide currentCode (TOTP) or backupCode');
  }
  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT totp_secret_enc, totp_iv, totp_tag, backup_codes
        FROM admins WHERE id = ${adminId}::uuid FOR UPDATE
    `.execute(tx);
    if (r.rows.length === 0) throw new Error(`admin ${adminId} not found`);
    let proofOk = false;
    let usedBackupCode = false;
    if (currentCode) {
      if (!r.rows[0].totp_secret_enc) {
        throw new Error('regenAdminBackupCodesSelf: admin has no TOTP enrolled to verify against');
      }
      const totpSecret = decrypt({
        ciphertext: r.rows[0].totp_secret_enc,
        iv: r.rows[0].totp_iv,
        tag: r.rows[0].totp_tag,
      }, kek).toString('utf8');
      proofOk = verifyTotp(totpSecret, currentCode);
    }
    if (!proofOk && backupCode) {
      const consumed = await verifyAndConsume(r.rows[0].backup_codes ?? [], backupCode);
      proofOk = consumed.ok;
      usedBackupCode = consumed.ok;
    }
    if (!proofOk) throw new Error('regenAdminBackupCodesSelf: 2FA code did not verify');

    const { codes, stored } = await generateBackupCodes();
    await sql`UPDATE admins SET backup_codes = ${JSON.stringify(stored)}::jsonb WHERE id = ${adminId}::uuid`.execute(tx);
    await profileAudit(tx, ctx, 'admin.backup_codes_regenerated', {
      adminId, metadata: { proof: usedBackupCode ? 'backup_code' : 'totp' },
    });
    return { adminId, codes };
  });
}

function adminIpPrefix(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.0/24`;
  const v6 = ip.match(/^([0-9a-f:]+):[0-9a-f]+$/i);
  if (v6) return `${v6[1]}::/64`;
  return ip;
}

export async function listAdminSessions(db, { adminId, currentSessionId = null }) {
  const r = await sql`
    SELECT id, created_at, last_seen_at, absolute_expires_at, step_up_at,
           device_fingerprint, host(ip) AS ip
      FROM sessions
     WHERE user_type = 'admin' AND user_id = ${adminId}::uuid
       AND revoked_at IS NULL AND absolute_expires_at > now()
     ORDER BY last_seen_at DESC
  `.execute(db);
  return r.rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    absolute_expires_at: row.absolute_expires_at,
    step_up_at: row.step_up_at,
    device_fingerprint: row.device_fingerprint,
    ip_prefix: adminIpPrefix(row.ip),
    is_current: currentSessionId !== null && row.id === currentSessionId,
  }));
}

export async function revokeAdminSession(db, { adminId, sessionId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      UPDATE sessions SET revoked_at = now()
       WHERE id = ${sessionId} AND user_type = 'admin' AND user_id = ${adminId}::uuid AND revoked_at IS NULL
       RETURNING id
    `.execute(tx);
    if (r.rows.length === 0) throw new Error('revokeAdminSession: session not found for this admin');
    await profileAudit(tx, ctx, 'admin.session_revoked', {
      adminId, metadata: { sessionId },
    });
    return { sessionId };
  });
}

export async function revokeAllAdminSessions(
  db,
  { adminId, exceptSessionId = null },
  ctx = {},
) {
  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      UPDATE sessions SET revoked_at = now()
       WHERE user_type = 'admin' AND user_id = ${adminId}::uuid AND revoked_at IS NULL
         AND id <> COALESCE(${exceptSessionId}, '')
       RETURNING id
    `.execute(tx);
    await profileAudit(tx, ctx, 'admin.logged_out_everywhere', {
      adminId,
      metadata: { revokedCount: r.rows.length, keptSessionId: exceptSessionId },
    });
    return { revokedCount: r.rows.length };
  });
}
