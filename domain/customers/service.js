import { randomBytes, createHash } from 'node:crypto';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import {
  generateDek, wrapDek, unwrapDek, encrypt, decrypt,
} from '../../lib/crypto/envelope.js';
import { hashPassword, verifyPassword, hibpHasBeenPwned as defaultHibp, SENTINEL_HASH } from '../../lib/crypto/hash.js';
import { generateBackupCodes, verifyAndConsume } from '../../lib/auth/backup-codes.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { createSession, stepUp } from '../../lib/auth/session.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
import { listActiveCustomerUsers } from '../../lib/digest-fanout.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import { insertCustomer, insertCustomerUser, updateCustomer as repoUpdateCustomer } from './repo.js';

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;

function generateInviteToken() {
  return randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function audit(db, ctx, action, { customerId, metadata = {} } = {}) {
  return writeAudit(db, {
    actorType: ctx?.actorType ?? 'system',
    actorId: ctx?.actorId ?? null,
    action,
    targetType: 'customer',
    targetId: customerId ?? null,
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

function requireKek(ctx, callerName) {
  const kek = ctx?.kek;
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error(`${callerName} requires ctx.kek (32-byte Buffer from app.kek)`);
  }
  return kek;
}

export async function create(
  db,
  { razonSocial, nif = null, domicilio = null, primaryUser },
  ctx = {},
) {
  const baseUrl = requirePortalBaseUrl(ctx, 'customers.create');
  const kek = requireKek(ctx, 'customers.create');

  const customerId = uuidv7();
  const primaryUserId = uuidv7();
  const inviteToken = generateInviteToken();
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const dek = generateDek();
  const wrapped = wrapDek(dek, kek);

  await db.transaction().execute(async (tx) => {
    await insertCustomer(tx, {
      id: customerId,
      razonSocial,
      nif,
      domicilio,
      dekCiphertext: wrapped.ciphertext,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
    });
    await insertCustomerUser(tx, {
      id: primaryUserId,
      customerId,
      email: primaryUser.email,
      name: primaryUser.name,
      inviteTokenHash,
      inviteExpiresAt,
    });
    await audit(tx, ctx, 'customer.created', {
      customerId,
      metadata: {
        razonSocial,
        primaryUserId,
        primaryUserEmail: primaryUser.email,
      },
    });
    await enqueueEmail(tx, {
      idempotencyKey: `customer_welcome:${customerId}`,
      toAddress: primaryUser.email,
      template: 'customer-invitation',
      locals: {
        recipientName: primaryUser.name,
        inviteUrl: `${baseUrl}/customer/welcome/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });
  });

  return { customerId, primaryUserId, inviteToken };
}

// Mints a fresh invite token on an existing customer_user row + emails
// a reset link. Mirrors admins.requestPasswordReset:
// - Always neutral on the public surface (POST /reset always renders
//   the same "Check your email" page) — no enumeration.
// - When the email matches an active customer_user, this writes
//   customer.password_reset_requested + enqueues a customer-pw-reset
//   email pointing at /customer/welcome/<token>. The customer onboarding
//   handler already consumes invite_token_hash and re-enrols password +
//   TOTP atomically — same path as first-time setup.
// - Otherwise audits customer.password_reset_requested_unknown.
//
// Suspended / archived customers don't receive a reset link — the
// account state already blocks login.
export async function requestCustomerPasswordReset(db, { email }, ctx = {}) {
  const baseUrl = requirePortalBaseUrl(ctx, 'customers.requestPasswordReset');
  const safeEmail = typeof email === 'string' ? email.slice(0, 320) : null;

  const r = await sql`
    SELECT cu.id AS user_id, cu.customer_id, cu.email::text AS email, cu.name,
           c.status AS customer_status
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.email = ${email}::citext
     LIMIT 1
  `.execute(db);
  const row = r.rows[0];

  if (!row || row.customer_status !== 'active') {
    await writeAudit(db, {
      actorType: ctx?.actorType ?? 'system',
      actorId: ctx?.actorId ?? null,
      action: 'customer.password_reset_requested_unknown',
      targetType: 'customer_user',
      targetId: row?.user_id ?? null,
      metadata: {
        email: safeEmail,
        ...(ctx?.audit ?? {}),
        ...(row && row.customer_status !== 'active' ? { customer_status: row.customer_status } : {}),
      },
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });
    return { inviteToken: null };
  }

  const inviteToken = generateInviteToken();
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await db.transaction().execute(async (tx) => {
    await sql`
      UPDATE customer_users
         SET invite_token_hash = ${inviteTokenHash},
             invite_expires_at = ${inviteExpiresAt},
             invite_consumed_at = NULL
       WHERE id = ${row.user_id}::uuid
    `.execute(tx);
    await writeAudit(tx, {
      actorType: ctx?.actorType ?? 'system',
      actorId: ctx?.actorId ?? null,
      action: 'customer.password_reset_requested',
      targetType: 'customer_user',
      targetId: row.user_id,
      metadata: { ...(ctx?.audit ?? {}) },
      visibleToCustomer: true,
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });
    await enqueueEmail(tx, {
      idempotencyKey: `customer_pw_reset:${row.user_id}:${inviteTokenHash.slice(0, 16)}`,
      toAddress: row.email,
      template: 'customer-pw-reset',
      locals: {
        recipientName: row.name,
        resetUrl: `${baseUrl}/customer/reset/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });
  });

  return { inviteToken };
}

// Admin-driven combined reset for a customer_user. Clears the user's
// existing TOTP secret + backup codes + password hash, mints a fresh
// invite token (7 day TTL), revokes all of the user's active sessions,
// and enqueues a customer-pw-reset email pointing at the welcome flow.
// The customer's DEK is unchanged so vault-encrypted data (credentials,
// docs) survives. The user re-enrols password + TOTP via the existing
// completeCustomerWelcome flow.
// Audit: customer.auth_reset_by_admin, visible_to_customer = true.
export async function adminResetCustomerUserAuth(
  db,
  { customerId, customerUserId, adminId },
  ctx = {},
) {
  const baseUrl = requirePortalBaseUrl(ctx, 'customers.adminResetCustomerUserAuth');
  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT cu.id::text AS user_id, cu.customer_id::text AS customer_id,
             cu.email::text AS email, cu.name
        FROM customer_users cu
       WHERE cu.id = ${customerUserId}::uuid AND cu.customer_id = ${customerId}::uuid
       FOR UPDATE
    `.execute(tx);
    const row = r.rows[0];
    if (!row) throw new Error(`customer_user ${customerUserId} not found for customer ${customerId}`);

    const inviteToken = generateInviteToken();
    const inviteTokenHash = hashToken(inviteToken);
    const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);

    await sql`
      UPDATE customer_users
         SET password_hash = NULL,
             totp_secret_enc = NULL,
             totp_iv = NULL,
             totp_tag = NULL,
             backup_codes = '[]'::jsonb,
             invite_token_hash = ${inviteTokenHash},
             invite_expires_at = ${inviteExpiresAt},
             invite_consumed_at = NULL
       WHERE id = ${customerUserId}::uuid
    `.execute(tx);

    await sql`DELETE FROM sessions WHERE user_id = ${customerUserId}::uuid`.execute(tx);

    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'customer.auth_reset_by_admin',
      targetType: 'customer_user',
      targetId: customerUserId,
      metadata: { ...(ctx?.audit ?? {}), customerId },
      visibleToCustomer: true,
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });

    await enqueueEmail(tx, {
      idempotencyKey: `customer_admin_auth_reset:${customerUserId}:${inviteTokenHash.slice(0, 16)}`,
      toAddress: row.email,
      template: 'customer-pw-reset',
      locals: {
        recipientName: row.name,
        resetUrl: `${baseUrl}/customer/welcome/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });

    return { customerUserId, inviteToken };
  });
}

async function lockCustomerById(tx, customerId) {
  const r = await sql`
    SELECT id, status FROM customers WHERE id = ${customerId}::uuid FOR UPDATE
  `.execute(tx);
  if (r.rows.length === 0) throw new Error(`customer ${customerId} not found`);
  return r.rows[0];
}

async function revokeCustomerSessions(tx, customerId) {
  await sql`
    UPDATE sessions
       SET revoked_at = now()
     WHERE user_type = 'customer'
       AND revoked_at IS NULL
       AND user_id IN (SELECT id FROM customer_users WHERE customer_id = ${customerId}::uuid)
  `.execute(tx);
}

function customerAudit(tx, ctx, action, customerId, { metadata = {}, visibleToCustomer = false } = {}) {
  return writeAudit(tx, {
    actorType: ctx?.actorType ?? 'admin',
    actorId: ctx?.actorId ?? null,
    action,
    targetType: 'customer',
    targetId: customerId,
    metadata: { ...(ctx?.audit ?? {}), ...metadata },
    visibleToCustomer,
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  });
}

export async function suspendCustomer(db, { customerId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await lockCustomerById(tx, customerId);
    if (row.status !== 'active') {
      throw new Error(`cannot suspend a customer in status '${row.status}' — must be 'active'`);
    }
    await sql`UPDATE customers SET status = 'suspended', updated_at = now() WHERE id = ${customerId}::uuid`.execute(tx);
    await revokeCustomerSessions(tx, customerId);
    // Customer-visible: when the M9 activity feed lands, the customer
    // who lived through the suspend should be able to see it happened.
    await customerAudit(tx, ctx, 'customer.suspended', customerId, { visibleToCustomer: true });
    return { customerId, status: 'suspended' };
  });
}

export async function reactivateCustomer(db, { customerId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await lockCustomerById(tx, customerId);
    if (row.status !== 'suspended') {
      throw new Error(`cannot reactivate a customer in status '${row.status}' — must be 'suspended'`);
    }
    await sql`UPDATE customers SET status = 'active', updated_at = now() WHERE id = ${customerId}::uuid`.execute(tx);
    // Old sessions stay revoked — reactivation requires the customer to
    // log in fresh.
    await customerAudit(tx, ctx, 'customer.reactivated', customerId, { visibleToCustomer: true });

    // Phase B: customer FYI fan-out — the customer is back to 'active' so
    // listActiveCustomerUsers will find them. Suspend / archive cannot
    // fan-out because the customer-user query would return zero rows
    // post-flip; those state changes are handled out-of-band by the
    // operator via direct contact, not by the portal email pipeline.
    const recipients = await listActiveCustomerUsers(tx, customerId);
    for (const u of recipients) {
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId,
        bucket:        'fyi',
        eventType:     'customer.reactivated',
        title:         titleFor('customer.reactivated', u.locale, {}),
        linkPath:      '/customer/dashboard',
      });
    }

    return { customerId, status: 'active' };
  });
}

// Editable customer profile fields. NOT included: status (managed via
// suspend/reactivate/archive), DEK columns (immutable per customer),
// timestamps. The legal-representative trio (representante_*) was added
// in M8 Task 8.4 — those values feed the NDA generator and must be
// editable here so the operator can complete a customer profile before
// generating the first NDA. NULL clears the field; undefined keeps it.
const EDITABLE_FIELDS = Object.freeze([
  'razonSocial',
  'nif',
  'domicilio',
  'representanteNombre',
  'representanteDni',
  'representanteCargo',
]);
const EDITABLE_FIELD_TO_DB_COLUMN = Object.freeze({
  representanteNombre: 'representante_nombre',
  representanteDni:    'representante_dni',
  representanteCargo:  'representante_cargo',
});

function normaliseEditField(name, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`updateCustomer: ${name} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function updateCustomer(db, { customerId, fields }, ctx = {}) {
  const patch = {};
  for (const k of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields ?? {}, k)) {
      patch[k] = normaliseEditField(k, fields[k]);
    }
  }
  if (patch.razonSocial === null) {
    throw new Error('updateCustomer: razonSocial cannot be cleared (NOT NULL)');
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('updateCustomer: at least one editable field must be provided');
  }

  return await db.transaction().execute(async (tx) => {
    const row = await lockCustomerById(tx, customerId);
    if (row.status === 'archived') {
      throw new Error(`cannot edit an archived customer`);
    }

    // The repo's updateCustomer accepts camelCase keys for the
    // razonSocial/nif/domicilio cases via CUSTOMER_COLUMN_MAP; the three
    // representante_ keys post-date that map, so we land them via raw
    // UPDATEs in the same tx (one statement per provided field — the set
    // is small and bounded).
    const repoFields = {};
    const extraSql = [];
    for (const [k, v] of Object.entries(patch)) {
      const repCol = EDITABLE_FIELD_TO_DB_COLUMN[k];
      if (repCol) {
        extraSql.push({ col: repCol, val: v });
      } else {
        repoFields[k] = v;
      }
    }
    if (Object.keys(repoFields).length > 0) {
      await repoUpdateCustomer(tx, customerId, repoFields);
    }
    for (const { col, val } of extraSql) {
      await sql`UPDATE customers SET ${sql.ref(col)} = ${val}, updated_at = now() WHERE id = ${customerId}::uuid`.execute(tx);
    }

    await customerAudit(tx, ctx, 'customer.updated', customerId, {
      visibleToCustomer: false,
      metadata: { fieldsChanged: Object.keys(patch) },
    });
    return { customerId };
  });
}

export async function archiveCustomer(db, { customerId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await lockCustomerById(tx, customerId);
    if (row.status === 'archived') {
      throw new Error(`customer ${customerId} is already archived`);
    }
    await sql`UPDATE customers SET status = 'archived', updated_at = now() WHERE id = ${customerId}::uuid`.execute(tx);
    await revokeCustomerSessions(tx, customerId);
    await customerAudit(tx, ctx, 'customer.archived', customerId, { visibleToCustomer: true });
    return { customerId, status: 'archived' };
  });
}

async function lockCustomerInviteRow(tx, tokenHash) {
  // Locks both the customer_users row (for the consume) and joins to the
  // customers row (for DEK unwrap). FOR UPDATE on customer_users is enough
  // to serialize concurrent welcome attempts on the same token.
  const r = await sql`
    SELECT cu.id           AS user_id,
           cu.customer_id  AS customer_id,
           cu.invite_consumed_at,
           cu.invite_expires_at,
           c.dek_ciphertext,
           c.dek_iv,
           c.dek_tag,
           c.razon_social
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.invite_token_hash = ${tokenHash}
       FOR UPDATE OF cu
  `.execute(tx);
  if (r.rows.length === 0) throw new Error('invalid invite token');
  const row = r.rows[0];
  if (row.invite_consumed_at) throw new Error('invite already consumed');
  if (new Date(row.invite_expires_at).getTime() <= Date.now()) {
    throw new Error('invite expired');
  }
  return row;
}

export async function completeCustomerWelcome(
  db,
  { token, newPassword, totpSecret, kek, sessionIp = null, sessionDeviceFingerprint = null },
  ctx = {},
) {
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error('customers.completeCustomerWelcome requires a 32-byte kek');
  }
  const hibpFn = ctx.hibpHasBeenPwned ?? defaultHibp;
  if (await hibpFn(newPassword)) {
    throw new Error('password compromised in a known breach');
  }

  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(newPassword);
  const { codes, stored } = await generateBackupCodes();

  return await db.transaction().execute(async (tx) => {
    const row = await lockCustomerInviteRow(tx, tokenHash);

    // Per spec §2.4: customer-user TOTP secrets are encrypted with the
    // customer's DEK (not the KEK directly). We unwrap the DEK once here
    // and let it fall out of scope when the transaction returns; it is
    // never logged, never serialised, and never persisted.
    const dek = unwrapDek(
      { ciphertext: row.dek_ciphertext, iv: row.dek_iv, tag: row.dek_tag },
      kek,
    );
    const env = encrypt(Buffer.from(totpSecret, 'utf8'), dek);

    await sql`
      UPDATE customer_users
         SET password_hash = ${passwordHash},
             invite_consumed_at = now(),
             totp_secret_enc = ${env.ciphertext},
             totp_iv = ${env.iv},
             totp_tag = ${env.tag},
             backup_codes = ${JSON.stringify(stored)}::jsonb
       WHERE id = ${row.user_id}::uuid
    `.execute(tx);

    await writeAudit(tx, {
      actorType: ctx?.actorType ?? 'customer',
      actorId: row.user_id,
      action: 'customer.password_set_via_invite',
      targetType: 'customer_user',
      targetId: row.user_id,
      metadata: { ...(ctx?.audit ?? {}) },
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });
    await writeAudit(tx, {
      actorType: ctx?.actorType ?? 'customer',
      actorId: row.user_id,
      action: 'customer.2fa_totp_enrolled',
      targetType: 'customer_user',
      targetId: row.user_id,
      metadata: { ...(ctx?.audit ?? {}) },
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });
    await writeAudit(tx, {
      actorType: ctx?.actorType ?? 'customer',
      actorId: row.user_id,
      action: 'customer.backup_codes_regenerated',
      targetType: 'customer_user',
      targetId: row.user_id,
      metadata: { ...(ctx?.audit ?? {}) },
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });

    // Mint the customer's first session inside the same tx as the invite
    // consumption — closes the race where suspendCustomer's revoke could
    // interleave between consume and mint and leave a never-revoked sid.
    const sid = await createSession(tx, {
      userType: 'customer',
      userId: row.user_id,
      ip: sessionIp,
      deviceFingerprint: sessionDeviceFingerprint,
    });
    await stepUp(tx, sid);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: row.user_id,
      action: 'customer.login_success',
      targetType: 'customer_user',
      targetId: row.user_id,
      metadata: { method: 'totp', via: 'onboarding', ...(ctx?.audit ?? {}) },
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });

    return {
      customerUserId: row.user_id,
      customerId: row.customer_id,
      razonSocial: row.razon_social,
      codes,
      sid,
    };
  });
}

// Mirror of admins.completePasswordReset for customers. Same posture:
// reset requires both factors at once — possession of the email reset
// link AND a valid current TOTP code (or unconsumed backup code) from
// the existing authenticator. totp_secret_enc / backup_codes are NOT
// rewritten — the user's authenticator entry continues to work.
//
// Refuses if:
// - the token is unknown / expired / consumed
// - the customer status is not active
// - the customer_user has no totp_secret_enc yet (must use
//   /customer/welcome — this is a reset, not first-time setup)
// - neither totpCode nor backupCode is provided / valid
//
// On success: hashes the new password, marks invite_token consumed
// (one-shot), mints a session + step-up + audits
// Verifies email + password for a customer_user. Returns the row on
// success (includes totp_secret_enc/iv/tag + backup_codes needed by the
// 2FA gate), null on failure. Always runs argon2 so timing is constant
// regardless of whether the email exists.
export async function verifyLogin(db, { email, password }) {
  // Single JOIN prevents a race between reading the user row and checking
  // customer.status: a concurrent suspendCustomer cannot sneak between the two.
  const r = typeof email === 'string'
    ? await sql`
        SELECT cu.*, c.status AS customer_status
          FROM customer_users cu
          JOIN customers c ON c.id = cu.customer_id
         WHERE cu.email = ${email}::citext
      `.execute(db)
    : { rows: [] };
  const user = r.rows[0] ?? null;
  const ok = await verifyPassword(user?.password_hash ?? SENTINEL_HASH, password ?? '');
  if (!ok || !user?.password_hash) return null;
  if (user.customer_status !== 'active') return null;
  return user;
}

// customer.password_reset_completed and customer.login_success
// (via='reset'). The customer DEK is unwrapped only to verify the
// existing TOTP secret; it falls out of scope when the tx returns.
export async function completePasswordReset(
  db,
  { token, newPassword, totpCode, backupCode, kek, sessionIp = null, sessionDeviceFingerprint = null },
  ctx = {},
) {
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error('customers.completePasswordReset requires a 32-byte kek');
  }
  const hibpFn = ctx.hibpHasBeenPwned ?? defaultHibp;
  if (await hibpFn(newPassword)) {
    throw new Error('password compromised in a known breach');
  }

  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(newPassword);

  return await db.transaction().execute(async (tx) => {
    const r = await sql`
      SELECT cu.id AS user_id, cu.customer_id, cu.totp_secret_enc, cu.totp_iv,
             cu.totp_tag, cu.backup_codes, cu.invite_consumed_at, cu.invite_expires_at,
             c.status AS customer_status,
             c.dek_ciphertext, c.dek_iv, c.dek_tag
        FROM customer_users cu
        JOIN customers c ON c.id = cu.customer_id
       WHERE cu.invite_token_hash = ${tokenHash}
         FOR UPDATE OF cu
    `.execute(tx);
    const row = r.rows[0];
    if (!row) throw new Error('invalid reset token');
    if (row.invite_consumed_at) throw new Error('reset link already used');
    if (new Date(row.invite_expires_at).getTime() <= Date.now()) {
      throw new Error('reset link expired');
    }
    if (row.customer_status !== 'active') {
      throw new Error('customer account is not active');
    }
    if (!row.totp_secret_enc) {
      throw new Error('TOTP not yet enrolled — use the welcome link to finish first-time setup');
    }

    let ok = false;
    let usedMethod = null;
    let updatedBackupCodes = null;

    if (typeof totpCode === 'string' && totpCode.length > 0) {
      const dek = unwrapDek(
        { ciphertext: row.dek_ciphertext, iv: row.dek_iv, tag: row.dek_tag },
        kek,
      );
      const secret = decrypt(
        { ciphertext: row.totp_secret_enc, iv: row.totp_iv, tag: row.totp_tag },
        dek,
      ).toString('utf8');
      ok = verifyTotp(secret, totpCode);
      if (ok) usedMethod = 'totp';
    }
    if (!ok && typeof backupCode === 'string' && backupCode.length > 0) {
      const stored = row.backup_codes ?? [];
      const r2 = await verifyAndConsume(stored, backupCode.trim());
      if (r2.ok) {
        ok = true;
        usedMethod = 'backup';
        updatedBackupCodes = r2.stored;
      }
    }
    if (!ok) throw new Error('TOTP code or backup code did not match');

    await sql`
      UPDATE customer_users
         SET password_hash = ${passwordHash},
             invite_consumed_at = now()
             ${updatedBackupCodes ? sql`, backup_codes = ${JSON.stringify(updatedBackupCodes)}::jsonb` : sql``}
       WHERE id = ${row.user_id}::uuid
    `.execute(tx);

    await writeAudit(tx, {
      actorType: 'customer',
      actorId: row.user_id,
      action: 'customer.password_reset_completed',
      targetType: 'customer_user',
      targetId: row.user_id,
      metadata: { method: usedMethod, ...(ctx?.audit ?? {}) },
      visibleToCustomer: true,
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });

    const sid = await createSession(tx, {
      userType: 'customer',
      userId: row.user_id,
      ip: sessionIp,
      deviceFingerprint: sessionDeviceFingerprint,
    });
    await stepUp(tx, sid);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: row.user_id,
      action: 'customer.login_success',
      targetType: 'customer_user',
      targetId: row.user_id,
      metadata: { method: usedMethod, via: 'reset', ...(ctx?.audit ?? {}) },
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });

    return {
      customerUserId: row.user_id,
      customerId: row.customer_id,
      sid,
    };
  });
}
