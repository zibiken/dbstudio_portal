import { randomBytes, createHash } from 'node:crypto';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import {
  generateDek, wrapDek, unwrapDek, encrypt,
} from '../../lib/crypto/envelope.js';
import { hashPassword, hibpHasBeenPwned as defaultHibp } from '../../lib/crypto/hash.js';
import { generateBackupCodes } from '../../lib/auth/backup-codes.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
import { insertCustomer, insertCustomerUser } from './repo.js';

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
  { token, newPassword, totpSecret, kek },
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

    return {
      customerUserId: row.user_id,
      customerId: row.customer_id,
      razonSocial: row.razon_social,
      codes,
    };
  });
}
