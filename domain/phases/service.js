import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import { listActiveAdmins, listActiveCustomerUsers } from '../../lib/digest-fanout.js';
import * as repo from './repo.js';

const VALID_STATUSES = new Set(['not_started', 'in_progress', 'blocked', 'done']);
const STATUS_GAP = 100;

export class PhaseNotFoundError extends Error {
  constructor() { super('phase not found'); this.code = 'PHASE_NOT_FOUND'; }
}
export class PhaseLabelConflictError extends Error {
  constructor() { super('phase label already used in this project'); this.code = 'PHASE_LABEL_CONFLICT'; }
}
export class PhaseInvalidStatusError extends Error {
  constructor() { super('invalid status'); this.code = 'PHASE_INVALID_STATUS'; }
}
export class PhaseReorderEdgeError extends Error {
  constructor() { super('phase already at edge'); this.code = 'PHASE_REORDER_EDGE'; }
}
export class PhaseLabelInvalidError extends Error {
  constructor() { super('phase label is required'); this.code = 'PHASE_LABEL_INVALID'; }
}
export class PhaseDirectionInvalidError extends Error {
  constructor() { super('direction must be up or down'); this.code = 'PHASE_DIRECTION_INVALID'; }
}

export function phaseVisible(status) {
  return status === 'in_progress' || status === 'blocked' || status === 'done';
}

function baseAuditMetadata(ctx) {
  return ctx?.audit ?? {};
}

async function findCustomerName(db, customerId) {
  const r = await sql`SELECT razon_social FROM customers WHERE id = ${customerId}::uuid`.execute(db);
  return r.rows[0]?.razon_social ?? null;
}

async function fanOut(tx, {
  customerId,
  projectId,
  phaseId,
  eventType,
  visibleToCustomer,
  varsForAdmin,
  varsForCustomer,
  linkAdmin,
  linkCustomer,
  metadataExtra = {},
  bucket = 'fyi',
}) {
  const admins = await listActiveAdmins(tx);
  for (const a of admins) {
    await recordForDigest(tx, {
      recipientType: 'admin',
      recipientId: a.id,
      customerId,
      bucket,
      eventType,
      title: titleFor(eventType, a.locale, varsForAdmin),
      linkPath: linkAdmin,
      metadata: { ...metadataExtra, customerId, projectId, phaseId },
      vars: varsForAdmin,
      locale: a.locale,
    });
  }
  if (!visibleToCustomer) return;
  const users = await listActiveCustomerUsers(tx, customerId);
  for (const u of users) {
    await recordForDigest(tx, {
      // pending_digest_items.recipient_type CHECK constraint allows
      // 'customer_user' or 'admin' only — see migration 0010.
      recipientType: 'customer_user',
      recipientId: u.id,
      customerId,
      bucket,
      eventType,
      title: titleFor(eventType, u.locale, varsForCustomer),
      linkPath: linkCustomer,
      metadata: { ...metadataExtra, customerId, projectId, phaseId },
      vars: varsForCustomer,
      locale: u.locale,
    });
  }
}

export async function create(db, { projectId, customerId, label }, ctx, { adminId }) {
  if (typeof label !== 'string' || !label.trim()) {
    throw new PhaseLabelInvalidError();
  }
  const labelTrimmed = label.trim();
  return await db.transaction().execute(async (tx) => {
    const conflict = await repo.findPhaseByLabel(tx, projectId, labelTrimmed);
    if (conflict) throw new PhaseLabelConflictError();

    const max = await repo.findMaxDisplayOrder(tx, projectId);
    const phaseId = uuidv7();
    await repo.insertPhase(tx, {
      id: phaseId, projectId, label: labelTrimmed,
      displayOrder: max + STATUS_GAP, status: 'not_started',
      startedAt: null, completedAt: null,
    });

    const customerName = await findCustomerName(tx, customerId);
    const visibleToCustomer = phaseVisible('not_started'); // = false
    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.created',
      targetType: 'project_phase', targetId: phaseId,
      metadata: { ...auditMeta, customerId, projectId, phaseId, phaseLabel: labelTrimmed },
      visibleToCustomer,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId, phaseId,
      eventType: 'phase.created',
      visibleToCustomer,
      metadataExtra: auditMeta,
      varsForAdmin: { customerName, phaseLabel: labelTrimmed, recipient: 'admin' },
      varsForCustomer: { phaseLabel: labelTrimmed, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${projectId}`,
      linkCustomer: `/customer/projects/${projectId}`,
    });

    return { phaseId };
  });
}

export async function rename(db, { phaseId, customerId }, { label }, ctx, { adminId }) {
  if (typeof label !== 'string' || !label.trim()) throw new PhaseLabelInvalidError();
  const labelTrimmed = label.trim();
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    const conflict = await repo.findPhaseByLabel(tx, phase.project_id, labelTrimmed);
    if (conflict && conflict.id !== phaseId) throw new PhaseLabelConflictError();
    await repo.updatePhaseLabel(tx, phaseId, labelTrimmed);

    const customerName = await findCustomerName(tx, customerId);
    const visibleToCustomer = phaseVisible(phase.status);
    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.renamed',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...auditMeta, customerId,
        projectId: phase.project_id, phaseId,
        oldLabel: phase.label, newLabel: labelTrimmed,
      },
      visibleToCustomer,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId,
      eventType: 'phase.renamed',
      visibleToCustomer,
      metadataExtra: auditMeta,
      varsForAdmin: { customerName, oldLabel: phase.label, newLabel: labelTrimmed, recipient: 'admin' },
      varsForCustomer: { oldLabel: phase.label, newLabel: labelTrimmed, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

export async function reorder(db, { phaseId, customerId }, { direction }, ctx, { adminId }) {
  if (direction !== 'up' && direction !== 'down') throw new PhaseDirectionInvalidError();
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    const all = await repo.listPhasesByProject(tx, phase.project_id);
    const idx = all.findIndex(p => p.id === phaseId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= all.length) throw new PhaseReorderEdgeError();
    const neighbour = all[swapIdx];

    await repo.setPhaseDisplayOrder(tx, phaseId, neighbour.display_order);
    await repo.setPhaseDisplayOrder(tx, neighbour.id, phase.display_order);

    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.reordered',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...auditMeta, customerId,
        projectId: phase.project_id, phaseId,
        from: phase.display_order, to: neighbour.display_order,
        swappedWith: neighbour.id,
      },
      visibleToCustomer: false, // admin-only per Decision 7
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    // Admin-only fan-out (no customer leg) — phase.reordered is admin-only
    // per spec Decision 7.
    const admins = await listActiveAdmins(tx);
    const customerName = await findCustomerName(tx, customerId);
    for (const a of admins) {
      await recordForDigest(tx, {
        recipientType: 'admin',
        recipientId: a.id,
        customerId,
        bucket: 'fyi',
        eventType: 'phase.reordered',
        title: titleFor('phase.reordered', a.locale, { customerName, phaseLabel: phase.label }),
        linkPath: `/admin/customers/${customerId}/projects/${phase.project_id}`,
        metadata: { ...auditMeta, customerId, projectId: phase.project_id, phaseId },
        vars: { customerName, phaseLabel: phase.label },
        locale: a.locale,
      });
    }

    return {};
  });
}

export async function changeStatus(db, { phaseId, customerId }, { newStatus }, ctx, { adminId }) {
  if (!VALID_STATUSES.has(newStatus)) throw new PhaseInvalidStatusError();
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    if (phase.status === newStatus) return {};

    const now = new Date();
    let startedAt = phase.started_at;
    let completedAt = phase.completed_at;
    if (newStatus === 'in_progress') {
      // Auto-set started_at only if it's never been set; an explicit
      // override (typed by an admin via setPhaseDates) wins forever.
      if (!startedAt) startedAt = now;
      // Going back to in_progress from done clears the completed mark
      // — the work is no longer done.
      completedAt = null;
    } else if (newStatus === 'done') {
      // Same rule: explicit completed_at wins. Only auto-stamp on the
      // first transition into done.
      if (!completedAt) completedAt = now;
    } else if (newStatus === 'not_started') {
      // Reverting to not_started clears both — the work effectively
      // never happened.
      startedAt = null;
      completedAt = null;
    } else if (newStatus === 'blocked') {
      // keep started_at; clear completed_at (work isn't done while blocked).
      completedAt = null;
    }
    await repo.setPhaseStatus(tx, phaseId, { status: newStatus, startedAt, completedAt });

    const customerName = await findCustomerName(tx, customerId);
    const visibleToCustomer = phaseVisible(newStatus);
    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.status_changed',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...auditMeta, customerId,
        projectId: phase.project_id, phaseId, phaseLabel: phase.label,
        from: phase.status, to: newStatus,
      },
      visibleToCustomer,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId,
      eventType: 'phase.status_changed',
      visibleToCustomer,
      metadataExtra: auditMeta,
      varsForAdmin: { customerName, phaseLabel: phase.label, from: phase.status, to: newStatus, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, from: phase.status, to: newStatus, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

async function deletePhaseService(db, { phaseId, customerId }, ctx, { adminId }) {
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    const statusAtDelete = phase.status;
    const labelAtDelete = phase.label;
    const projectId = phase.project_id;

    await repo.deletePhase(tx, phaseId);

    const customerName = await findCustomerName(tx, customerId);
    const visibleToCustomer = phaseVisible(statusAtDelete);
    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.deleted',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...auditMeta, customerId,
        projectId, phaseId, phaseLabel: labelAtDelete,
        statusAtDelete,
      },
      visibleToCustomer,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId, phaseId,
      eventType: 'phase.deleted',
      visibleToCustomer,
      metadataExtra: auditMeta,
      varsForAdmin: { customerName, phaseLabel: labelAtDelete, recipient: 'admin' },
      varsForCustomer: { phaseLabel: labelAtDelete, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${projectId}`,
      linkCustomer: `/customer/projects/${projectId}`,
    });

    return {};
  });
}

// Re-export with the name the route layer uses (avoid keyword collision).
export { deletePhaseService as delete };
