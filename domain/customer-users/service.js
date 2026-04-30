import { randomBytes, createHash } from 'node:crypto';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import {
  hashPassword, verifyPassword, hibpHasBeenPwned as defaultHibp, SENTINEL_HASH,
} from '../../lib/crypto/hash.js';
import { encrypt, decrypt, unwrapDek } from '../../lib/crypto/envelope.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { generateBackupCodes, verifyAndConsume } from '../../lib/auth/backup-codes.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
import { findCustomerUserById } from './repo.js';

export const PASSWORD_MIN_LENGTH = 12;

const NAME_MAX = 256;

export const VERIFY_TTL_MS = 24 * 3_600_000;
export const REVERT_TTL_MS = 7 * 24 * 3_600_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 320;

function audit(db, ctx, action, { customerUserId, customerId, metadata = {}, visibleToCustomer = true }) {
  return writeAudit(db, {
    actorType: ctx?.actorType ?? 'customer',
    actorId: ctx?.actorId ?? customerUserId,
    action,
    targetType: 'customer_user',
    targetId: customerUserId,
    metadata: { ...(ctx?.audit ?? {}), customerId, ...metadata },
    visibleToCustomer,
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  });
}

function generateToken() {
  return randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
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

export async function updateName(db, { customerUserId, name }, ctx = {}) {
  if (typeof name !== 'string') {
    throw new Error('updateName: name must be a string');
  }
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new Error('updateName: name cannot be blank');
  }
  if (trimmed.length > NAME_MAX) {
    throw new Error(`updateName: name exceeds ${NAME_MAX} characters`);
  }

  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT cu.id::text AS id, cu.customer_id::text AS customer_id, cu.name
        FROM customer_users cu
       WHERE cu.id = ${customerUserId}::uuid
       FOR UPDATE
    `.execute(tx);
    const row = r.rows[0];
    if (!row) {
      throw new Error(`customer_user ${customerUserId} not found`);
    }
    if (row.name === trimmed) {
      return { customerUserId, customerId: row.customer_id, changed: false };
    }
    await sql`
      UPDATE customer_users SET name = ${trimmed} WHERE id = ${customerUserId}::uuid
    `.execute(tx);
    await audit(tx, ctx, 'customer_user.name_changed', {
      customerUserId,
      customerId: row.customer_id,
      metadata: { previousName: row.name, newName: trimmed },
    });
    return { customerUserId, customerId: row.customer_id, changed: true };
  });
}

function normaliseEmail(raw) {
  if (typeof raw !== 'string') {
    throw new Error('email must be a string');
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX) {
    throw new Error('email is not a valid address');
  }
  if (!EMAIL_RE.test(trimmed)) {
    throw new Error('email is not a valid address');
  }
  return trimmed;
}

export async function requestEmailChange(db, { customerUserId, newEmail }, ctx = {}) {
  const baseUrl = requirePortalBaseUrl(ctx, 'requestEmailChange');
  const next = normaliseEmail(newEmail);

  return await db.transaction().execute(async (tx) => {
    const userR = await sql`
      SELECT id::text AS id, customer_id::text AS customer_id, email, name
        FROM customer_users WHERE id = ${customerUserId}::uuid FOR UPDATE
    `.execute(tx);
    const user = userR.rows[0];
    if (!user) throw new Error(`customer_user ${customerUserId} not found`);
    if (user.email === next) {
      throw new Error('new email is the same as the current email');
    }

    // Reject hard collision against any existing user (admins or customer_users).
    const collA = await sql`SELECT 1 FROM customer_users WHERE email = ${next}`.execute(tx);
    const collB = await sql`SELECT 1 FROM admins WHERE email = ${next}`.execute(tx);
    if (collA.rows.length > 0 || collB.rows.length > 0) {
      throw new Error('email already in use');
    }

    // Cancel any prior in-flight request — drop tokens too so the partial
    // unique index frees up.
    await sql`
      UPDATE email_change_requests
         SET cancelled_at = now(), verify_token_hash = NULL, revert_token_hash = NULL
       WHERE user_type = 'customer_user'
         AND user_id = ${customerUserId}::uuid
         AND verified_at IS NULL AND cancelled_at IS NULL
    `.execute(tx);

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MS);
    const reqId = uuidv7();
    await sql`
      INSERT INTO email_change_requests (
        id, user_type, user_id, old_email, new_email, verify_token_hash, verify_expires_at
      )
      VALUES (
        ${reqId}::uuid, 'customer_user', ${customerUserId}::uuid,
        ${user.email}, ${next}, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz
      )
    `.execute(tx);

    await enqueueEmail(tx, {
      idempotencyKey: `email_change_verify:${reqId}`,
      toAddress: next,
      template: 'email-change-verification',
      locals: {
        recipientName: user.name,
        newEmail: next,
        verifyUrl: `${baseUrl}/customer/profile/email/verify/${token}`,
        expiresAt: expiresAt.toISOString(),
      },
    });

    await audit(tx, ctx, 'customer_user.email_change_requested', {
      customerUserId,
      customerId: user.customer_id,
      metadata: { oldEmail: user.email, newEmail: next, requestId: reqId },
    });

    return { token, expiresAt, requestId: reqId, oldEmail: user.email, newEmail: next };
  });
}

async function lockChangeRequest(tx, where, errMsg) {
  const r = await sql`
    SELECT id::text AS id,
           user_type,
           user_id::text AS user_id,
           old_email,
           new_email,
           verify_token_hash,
           verify_expires_at,
           verified_at,
           revert_token_hash,
           revert_expires_at,
           reverted_at,
           cancelled_at
      FROM email_change_requests
     WHERE ${where}
       FOR UPDATE
  `.execute(tx);
  if (r.rows.length === 0) throw new Error(errMsg);
  return r.rows[0];
}

export async function verifyEmailChange(db, { token }, ctx = {}) {
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('verifyEmailChange: invalid token');
  }
  const tokenHash = hashToken(token);

  return await db.transaction().execute(async (tx) => {
    const reqR = await sql`
      SELECT id::text AS id,
             user_type,
             user_id::text AS user_id,
             old_email,
             new_email,
             verify_expires_at,
             verified_at,
             cancelled_at
        FROM email_change_requests
       WHERE verify_token_hash = ${tokenHash}
       FOR UPDATE
    `.execute(tx);
    if (reqR.rows.length === 0) throw new Error('verifyEmailChange: invalid token');
    const req = reqR.rows[0];
    if (req.user_type !== 'customer_user') {
      throw new Error('verifyEmailChange: token is not for a customer_user');
    }
    if (req.cancelled_at || req.verified_at) {
      throw new Error('verifyEmailChange: invalid token');
    }
    if (new Date(req.verify_expires_at).getTime() <= Date.now()) {
      throw new Error('verifyEmailChange: token expired');
    }

    // Re-check collision against new_email at swap time — catches the
    // race where a different user took the address between request and
    // verify.
    const userR = await sql`
      SELECT customer_id::text AS customer_id, name
        FROM customer_users WHERE id = ${req.user_id}::uuid FOR UPDATE
    `.execute(tx);
    if (userR.rows.length === 0) {
      throw new Error('verifyEmailChange: user no longer exists');
    }
    const collA = await sql`SELECT 1 FROM customer_users WHERE email = ${req.new_email} AND id <> ${req.user_id}::uuid`.execute(tx);
    const collB = await sql`SELECT 1 FROM admins WHERE email = ${req.new_email}`.execute(tx);
    if (collA.rows.length > 0 || collB.rows.length > 0) {
      throw new Error('verifyEmailChange: email already in use');
    }

    const baseUrl = requirePortalBaseUrl(ctx, 'verifyEmailChange');
    const revertToken = generateToken();
    const revertTokenHash = hashToken(revertToken);
    const revertExpiresAt = new Date(Date.now() + REVERT_TTL_MS);

    await sql`
      UPDATE customer_users SET email = ${req.new_email}
       WHERE id = ${req.user_id}::uuid
    `.execute(tx);
    await sql`
      UPDATE email_change_requests
         SET verified_at = now(),
             verify_token_hash = NULL,
             revert_token_hash = ${revertTokenHash},
             revert_expires_at = ${revertExpiresAt.toISOString()}::timestamptz
       WHERE id = ${req.id}::uuid
    `.execute(tx);

    await enqueueEmail(tx, {
      idempotencyKey: `email_change_revert:${req.id}`,
      toAddress: req.old_email,
      template: 'email-change-notification-old',
      locals: {
        recipientName: userR.rows[0].name,
        oldEmail: req.old_email,
        newEmail: req.new_email,
        changedAt: new Date().toISOString(),
        revertUrl: `${baseUrl}/customer/profile/email/revert/${revertToken}`,
      },
    });

    await audit(tx, ctx, 'customer_user.email_change_verified', {
      customerUserId: req.user_id,
      customerId: userR.rows[0].customer_id,
      metadata: { oldEmail: req.old_email, newEmail: req.new_email, requestId: req.id },
    });

    return {
      customerUserId: req.user_id,
      customerId: userR.rows[0].customer_id,
      oldEmail: req.old_email,
      newEmail: req.new_email,
      revertToken,
      revertExpiresAt,
    };
  });
}

function requireKek(ctx, callerName) {
  const kek = ctx?.kek;
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error(`${callerName} requires ctx.kek (32-byte Buffer from app.kek)`);
  }
  return kek;
}

async function loadCustomerUserForTotp(tx, customerUserId) {
  const r = await sql`
    SELECT cu.id::text AS id,
           cu.customer_id::text AS customer_id,
           cu.totp_secret_enc, cu.totp_iv, cu.totp_tag,
           c.dek_ciphertext, c.dek_iv, c.dek_tag
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.id = ${customerUserId}::uuid
       FOR UPDATE OF cu
  `.execute(tx);
  return r.rows[0] ?? null;
}

export async function regenTotp(
  db,
  { customerUserId, currentCode, newSecret, newCode },
  ctx = {},
) {
  const kek = requireKek(ctx, 'regenTotp');
  if (typeof newSecret !== 'string' || newSecret.length < 16) {
    throw new Error('regenTotp: newSecret must be a base32 TOTP secret');
  }
  if (typeof currentCode !== 'string' || typeof newCode !== 'string') {
    throw new Error('regenTotp: codes must be strings');
  }

  return await db.transaction().execute(async (tx) => {
    const row = await loadCustomerUserForTotp(tx, customerUserId);
    if (!row) throw new Error(`customer_user ${customerUserId} not found`);
    if (!row.totp_secret_enc) throw new Error('regenTotp: user has no current TOTP secret to verify against');

    const dek = unwrapDek(
      { ciphertext: row.dek_ciphertext, iv: row.dek_iv, tag: row.dek_tag },
      kek,
    );
    const currentSecret = decrypt(
      { ciphertext: row.totp_secret_enc, iv: row.totp_iv, tag: row.totp_tag },
      dek,
    ).toString('utf8');
    if (!verifyTotp(currentSecret, currentCode)) {
      throw new Error('regenTotp: current code did not verify');
    }
    if (!verifyTotp(newSecret, newCode)) {
      throw new Error('regenTotp: new code did not verify the new secret');
    }

    const env = encrypt(Buffer.from(newSecret, 'utf8'), dek);
    await sql`
      UPDATE customer_users
         SET totp_secret_enc = ${env.ciphertext},
             totp_iv = ${env.iv},
             totp_tag = ${env.tag}
       WHERE id = ${customerUserId}::uuid
    `.execute(tx);
    await audit(tx, ctx, 'customer_user.2fa_totp_regenerated', {
      customerUserId,
      customerId: row.customer_id,
      visibleToCustomer: true,
    });

    return { customerUserId, customerId: row.customer_id };
  });
}

// Regenerate the 8-code backup-code set. Must prove current 2FA either
// via a TOTP code (currentCode) OR by spending an unconsumed backup code
// (backupCode); the latter path is the canonical recovery if the user
// just lost their authenticator and is using a backup code to log in,
// then immediately wants a fresh set. The old set is replaced wholesale.
export async function regenBackupCodes(
  db,
  { customerUserId, currentCode = null, backupCode = null },
  ctx = {},
) {
  const kek = requireKek(ctx, 'regenBackupCodes');
  if (!currentCode && !backupCode) {
    throw new Error('regenBackupCodes: provide currentCode (TOTP) or backupCode');
  }

  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT cu.id::text AS id,
             cu.customer_id::text AS customer_id,
             cu.totp_secret_enc, cu.totp_iv, cu.totp_tag,
             cu.backup_codes,
             c.dek_ciphertext, c.dek_iv, c.dek_tag
        FROM customer_users cu
        JOIN customers c ON c.id = cu.customer_id
       WHERE cu.id = ${customerUserId}::uuid
         FOR UPDATE OF cu
    `.execute(tx);
    const row = r.rows[0];
    if (!row) throw new Error(`customer_user ${customerUserId} not found`);

    // Verify proof-of-2FA — TOTP first (cheap), backup-code fallback.
    let proofOk = false;
    let usedBackupCode = false;
    if (currentCode) {
      if (!row.totp_secret_enc) {
        throw new Error('regenBackupCodes: user has no TOTP enrolled to verify against');
      }
      const dek = unwrapDek(
        { ciphertext: row.dek_ciphertext, iv: row.dek_iv, tag: row.dek_tag },
        kek,
      );
      const totpSecret = decrypt(
        { ciphertext: row.totp_secret_enc, iv: row.totp_iv, tag: row.totp_tag },
        dek,
      ).toString('utf8');
      proofOk = verifyTotp(totpSecret, currentCode);
    }
    if (!proofOk && backupCode) {
      const consumed = await verifyAndConsume(row.backup_codes ?? [], backupCode);
      proofOk = consumed.ok;
      usedBackupCode = consumed.ok;
    }
    if (!proofOk) {
      throw new Error('regenBackupCodes: 2FA code did not verify');
    }

    const { codes, stored } = await generateBackupCodes();
    await sql`
      UPDATE customer_users SET backup_codes = ${JSON.stringify(stored)}::jsonb
       WHERE id = ${customerUserId}::uuid
    `.execute(tx);
    await audit(tx, ctx, 'customer_user.backup_codes_regenerated', {
      customerUserId,
      customerId: row.customer_id,
      visibleToCustomer: true,
      metadata: { proof: usedBackupCode ? 'backup_code' : 'totp' },
    });
    return { customerUserId, customerId: row.customer_id, codes };
  });
}

export async function changePassword(
  db,
  { customerUserId, currentPassword, newPassword, currentSessionId = null },
  ctx = {},
) {
  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`changePassword: new password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw new Error('changePassword: current password is required');
  }
  if (newPassword === currentPassword) {
    throw new Error('changePassword: new password must be different from current password');
  }

  // Load row for verify; if missing/no-pw, run a sentinel verify so the
  // wall-clock cost is constant regardless of branch (mirrors admins.verifyLogin).
  const userR = await sql`
    SELECT id::text AS id, customer_id::text AS customer_id, password_hash
      FROM customer_users WHERE id = ${customerUserId}::uuid
  `.execute(db);
  const user = userR.rows[0] ?? null;
  const ok = await verifyPassword(user?.password_hash ?? SENTINEL_HASH, currentPassword);
  if (!ok || !user?.password_hash) {
    await audit(db, ctx, 'customer_user.password_change_failed', {
      customerUserId,
      customerId: user?.customer_id ?? null,
      visibleToCustomer: true,
    });
    throw new Error('changePassword: current password did not match');
  }

  const hibpFn = ctx.hibpHasBeenPwned ?? defaultHibp;
  if (await hibpFn(newPassword)) {
    throw new Error('changePassword: new password appears in a known data breach (HIBP)');
  }

  const newHash = await hashPassword(newPassword);

  await db.transaction().execute(async (tx) => {
    await sql`UPDATE customer_users SET password_hash = ${newHash} WHERE id = ${customerUserId}::uuid`.execute(tx);
    // Revoke every other session — common best practice on password change.
    // The current session stays alive so the in-flight browser doesn't
    // get bounced in the middle of the form submission.
    await sql`
      UPDATE sessions
         SET revoked_at = now()
       WHERE user_type = 'customer'
         AND user_id = ${customerUserId}::uuid
         AND revoked_at IS NULL
         AND id <> COALESCE(${currentSessionId}, '')
    `.execute(tx);
    await audit(tx, ctx, 'customer_user.password_changed', {
      customerUserId,
      customerId: user.customer_id,
      visibleToCustomer: true,
    });
  });

  return { customerUserId, customerId: user.customer_id };
}

export async function revertEmailChange(db, { token }, ctx = {}) {
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('revertEmailChange: invalid token');
  }
  const tokenHash = hashToken(token);

  return await db.transaction().execute(async (tx) => {
    const reqR = await sql`
      SELECT id::text AS id,
             user_type,
             user_id::text AS user_id,
             old_email,
             new_email,
             revert_expires_at,
             reverted_at
        FROM email_change_requests
       WHERE revert_token_hash = ${tokenHash}
       FOR UPDATE
    `.execute(tx);
    if (reqR.rows.length === 0) throw new Error('revertEmailChange: invalid token');
    const req = reqR.rows[0];
    if (req.user_type !== 'customer_user') {
      throw new Error('revertEmailChange: token is not for a customer_user');
    }
    if (req.reverted_at) throw new Error('revertEmailChange: invalid token');
    if (!req.revert_expires_at || new Date(req.revert_expires_at).getTime() <= Date.now()) {
      throw new Error('revertEmailChange: token expired');
    }

    const userR = await sql`
      SELECT customer_id::text AS customer_id
        FROM customer_users WHERE id = ${req.user_id}::uuid FOR UPDATE
    `.execute(tx);
    if (userR.rows.length === 0) {
      throw new Error('revertEmailChange: user no longer exists');
    }

    await sql`
      UPDATE customer_users SET email = ${req.old_email}
       WHERE id = ${req.user_id}::uuid
    `.execute(tx);
    await sql`
      UPDATE email_change_requests
         SET reverted_at = now(),
             revert_token_hash = NULL
       WHERE id = ${req.id}::uuid
    `.execute(tx);
    await sql`
      UPDATE sessions
         SET revoked_at = now()
       WHERE user_type = 'customer'
         AND user_id = ${req.user_id}::uuid
         AND revoked_at IS NULL
    `.execute(tx);

    await audit(tx, ctx, 'customer_user.email_change_reverted', {
      customerUserId: req.user_id,
      customerId: userR.rows[0].customer_id,
      metadata: { restoredEmail: req.old_email, undoneEmail: req.new_email, requestId: req.id },
    });

    return {
      customerUserId: req.user_id,
      customerId: userR.rows[0].customer_id,
      restoredEmail: req.old_email,
    };
  });
}
