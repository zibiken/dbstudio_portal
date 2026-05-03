import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import { listActiveAdmins, listActiveCustomerUsers } from '../../lib/digest-fanout.js';
import * as repo from './repo.js';
import * as phasesRepo from '../phases/repo.js';
import { phaseVisible } from '../phases/service.js';

const ITEM_GAP = 100;

export class ItemNotFoundError extends Error {
  constructor() { super('checklist item not found'); this.code = 'ITEM_NOT_FOUND'; }
}
export class PhaseGoneError extends Error {
  constructor() { super('parent phase missing'); this.code = 'ITEM_PARENT_GONE'; }
}
export class ItemLabelInvalidError extends Error {
  constructor() { super('checklist item label is required'); this.code = 'ITEM_LABEL_INVALID'; }
}

function baseAuditMetadata(ctx) { return ctx?.audit ?? {}; }

async function findCustomerName(db, customerId) {
  const r = await sql`SELECT razon_social FROM customers WHERE id = ${customerId}::uuid`.execute(db);
  return r.rows[0]?.razon_social ?? null;
}

function audibleVisible(itemVisible, parentStatus) {
  return !!itemVisible && phaseVisible(parentStatus);
}

async function fanOut(tx, {
  customerId, projectId, phaseId, itemId,
  eventType, visibleToCustomer, varsForAdmin, varsForCustomer,
  linkAdmin, linkCustomer, metadataExtra = {}, bucket = 'fyi',
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
      metadata: { ...metadataExtra, customerId, projectId, phaseId, itemId },
      vars: varsForAdmin,
      locale: a.locale,
    });
  }
  if (!visibleToCustomer) return;
  const users = await listActiveCustomerUsers(tx, customerId);
  for (const u of users) {
    await recordForDigest(tx, {
      // 'customer_user' — see CHECK constraint in migration 0010.
      recipientType: 'customer_user',
      recipientId: u.id,
      customerId,
      bucket,
      eventType,
      title: titleFor(eventType, u.locale, varsForCustomer),
      linkPath: linkCustomer,
      metadata: { ...metadataExtra, customerId, projectId, phaseId, itemId },
      vars: varsForCustomer,
      locale: u.locale,
    });
  }
}

export async function create(db, { phaseId, customerId }, { label, visibleToCustomer = true }, ctx, { adminId }) {
  if (typeof label !== 'string' || !label.trim()) throw new ItemLabelInvalidError();
  const labelTrimmed = label.trim();
  return await db.transaction().execute(async (tx) => {
    const phase = await phasesRepo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseGoneError();
    const max = await repo.findMaxItemDisplayOrder(tx, phaseId);
    const itemId = uuidv7();
    await repo.insertItem(tx, {
      id: itemId, phaseId, label: labelTrimmed,
      displayOrder: max + ITEM_GAP, visibleToCustomer: !!visibleToCustomer,
    });

    const customerName = await findCustomerName(tx, customerId);
    const visible = audibleVisible(visibleToCustomer, phase.status);
    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.created',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...auditMeta,
        customerId, projectId: phase.project_id, phaseId, itemId,
        phaseLabel: phase.label, itemLabel: labelTrimmed,
      },
      visibleToCustomer: visible,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId, itemId,
      eventType: 'phase_checklist.created',
      visibleToCustomer: visible,
      metadataExtra: auditMeta,
      varsForAdmin: { customerName, phaseLabel: phase.label, itemLabel: labelTrimmed, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, itemLabel: labelTrimmed, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return { itemId };
  });
}

export async function rename(db, { itemId, customerId }, { label }, ctx, { adminId }) {
  if (typeof label !== 'string' || !label.trim()) throw new ItemLabelInvalidError();
  const labelTrimmed = label.trim();
  return await db.transaction().execute(async (tx) => {
    const item = await repo.findItemById(tx, itemId);
    if (!item) throw new ItemNotFoundError();
    const phase = await phasesRepo.findPhaseById(tx, item.phase_id);
    if (!phase) throw new PhaseGoneError();
    await repo.updateItemLabel(tx, itemId, labelTrimmed);

    const customerName = await findCustomerName(tx, customerId);
    const visible = audibleVisible(item.visible_to_customer, phase.status);
    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.renamed',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...auditMeta,
        customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
        phaseLabel: phase.label, oldLabel: item.label, newLabel: labelTrimmed,
      },
      visibleToCustomer: visible,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
      eventType: 'phase_checklist.renamed',
      visibleToCustomer: visible,
      metadataExtra: auditMeta,
      varsForAdmin: { customerName, phaseLabel: phase.label, oldLabel: item.label, newLabel: labelTrimmed, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, oldLabel: item.label, newLabel: labelTrimmed, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

export async function setVisibility(db, { itemId, customerId }, { visibleToCustomer }, ctx, { adminId }) {
  return await db.transaction().execute(async (tx) => {
    const item = await repo.findItemById(tx, itemId);
    if (!item) throw new ItemNotFoundError();
    const phase = await phasesRepo.findPhaseById(tx, item.phase_id);
    if (!phase) throw new PhaseGoneError();
    await repo.setItemVisibility(tx, itemId, !!visibleToCustomer);

    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.visibility_changed',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...auditMeta,
        customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
        phaseLabel: phase.label, itemLabel: item.label,
        from: item.visible_to_customer, to: !!visibleToCustomer,
      },
      visibleToCustomer: false, // admin-only per Decision 7
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    // Admin-only fan-out — visibility flips are admin-only per Decision 7.
    const admins = await listActiveAdmins(tx);
    const customerName = await findCustomerName(tx, customerId);
    for (const a of admins) {
      await recordForDigest(tx, {
        recipientType: 'admin', recipientId: a.id, customerId,
        bucket: 'fyi',
        eventType: 'phase_checklist.visibility_changed',
        title: titleFor('phase_checklist.visibility_changed', a.locale, { customerName, phaseLabel: phase.label, itemLabel: item.label }),
        linkPath: `/admin/customers/${customerId}/projects/${phase.project_id}`,
        metadata: { ...auditMeta, customerId, projectId: phase.project_id, phaseId: phase.id, itemId },
        vars: { customerName, phaseLabel: phase.label, itemLabel: item.label },
        locale: a.locale,
      });
    }
    return {};
  });
}

export async function toggleDone(db, { itemId, customerId }, { done }, ctx, { adminId }) {
  return await db.transaction().execute(async (tx) => {
    const item = await repo.findItemById(tx, itemId);
    if (!item) throw new ItemNotFoundError();
    const phase = await phasesRepo.findPhaseById(tx, item.phase_id);
    if (!phase) throw new PhaseGoneError();

    const doneAt = done ? new Date() : null;
    const doneBy = done ? adminId : null;
    await repo.setItemDone(tx, itemId, { doneAt, doneByAdminId: doneBy });

    const customerName = await findCustomerName(tx, customerId);
    const visible = audibleVisible(item.visible_to_customer, phase.status);
    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.toggled',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...auditMeta,
        customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
        phaseLabel: phase.label, itemLabel: item.label, done: !!done,
      },
      visibleToCustomer: visible,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
      eventType: 'phase_checklist.toggled',
      visibleToCustomer: visible,
      metadataExtra: auditMeta,
      varsForAdmin: { customerName, phaseLabel: phase.label, itemLabel: item.label, done: !!done, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, itemLabel: item.label, done: !!done, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

async function deleteItemService(db, { itemId, customerId }, ctx, { adminId }) {
  return await db.transaction().execute(async (tx) => {
    const item = await repo.findItemById(tx, itemId);
    if (!item) throw new ItemNotFoundError();
    const phase = await phasesRepo.findPhaseById(tx, item.phase_id);
    if (!phase) throw new PhaseGoneError();
    const itemVisibleAtDelete = item.visible_to_customer;
    const phaseStatusAtDelete = phase.status;
    const itemLabelAtDelete = item.label;

    await repo.deleteItem(tx, itemId);

    const customerName = await findCustomerName(tx, customerId);
    const visible = audibleVisible(itemVisibleAtDelete, phaseStatusAtDelete);
    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.deleted',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...auditMeta,
        customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
        phaseLabel: phase.label, itemLabel: itemLabelAtDelete,
        wasVisible: itemVisibleAtDelete, parentStatusAtDelete: phaseStatusAtDelete,
      },
      visibleToCustomer: visible,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
      eventType: 'phase_checklist.deleted',
      visibleToCustomer: visible,
      metadataExtra: auditMeta,
      varsForAdmin: { customerName, phaseLabel: phase.label, itemLabel: itemLabelAtDelete, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, itemLabel: itemLabelAtDelete, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

export { deleteItemService as delete };
