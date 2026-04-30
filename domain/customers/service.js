import { randomBytes, createHash } from 'node:crypto';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import {
  generateDek, wrapDek, unwrapDek, encrypt,
} from '../../lib/crypto/envelope.js';
import { hashPassword, hibpHasBeenPwned as defaultHibp } from '../../lib/crypto/hash.js';
import { generateBackupCodes } from '../../lib/auth/backup-codes.js';
import { createSession, stepUp } from '../../lib/auth/session.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
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
