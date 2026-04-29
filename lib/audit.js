import { v7 as uuidv7 } from 'uuid';

export async function writeAudit(db, entry) {
  await db.insertInto('audit_log').values({
    id: uuidv7(),
    actor_type: entry.actorType,
    actor_id: entry.actorId ?? null,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    metadata: JSON.stringify(entry.metadata ?? {}),
    visible_to_customer: !!entry.visibleToCustomer,
    ip: entry.ip ?? null,
    user_agent_hash: entry.userAgentHash ?? null,
  }).execute();
}
