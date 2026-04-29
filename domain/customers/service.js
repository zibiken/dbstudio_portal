import { randomBytes, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import { generateDek, wrapDek } from '../../lib/crypto/envelope.js';
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
        inviteUrl: `${baseUrl}/welcome/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });
  });

  return { customerId, primaryUserId, inviteToken };
}
