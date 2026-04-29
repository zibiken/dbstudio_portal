import { randomBytes, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import {
  hashPassword, verifyPassword, hibpHasBeenPwned as defaultHibp,
} from '../../lib/crypto/hash.js';
import { writeAudit } from '../../lib/audit.js';
import {
  insertAdmin, findByEmail, updateAdmin,
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
