import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { findCustomerUserById } from './repo.js';

const NAME_MAX = 256;

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
