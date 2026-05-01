import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import { listActiveCustomerUsers } from '../../lib/digest-fanout.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import {
  insertProject,
  findProjectById,
  updateProjectFields,
  updateProjectStatus,
} from './repo.js';

const ALLOWED_STATUSES = new Set(['active', 'paused', 'archived', 'done']);

function projectAudit(tx, ctx, action, projectId, { metadata = {}, visibleToCustomer = true } = {}) {
  return writeAudit(tx, {
    actorType: ctx?.actorType ?? 'admin',
    actorId: ctx?.actorId ?? null,
    action,
    targetType: 'project',
    targetId: projectId,
    metadata: { ...(ctx?.audit ?? {}), ...metadata },
    visibleToCustomer,
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  });
}

async function assertCustomerExists(tx, customerId) {
  const r = await sql`SELECT id FROM customers WHERE id = ${customerId}::uuid`.execute(tx);
  if (r.rows.length === 0) throw new Error(`customer ${customerId} not found`);
}

export async function create(db, { customerId, name, objetoProyecto }, ctx = {}) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('projects.create: name is required');
  }
  if (typeof objetoProyecto !== 'string' || objetoProyecto.trim().length === 0) {
    throw new Error('projects.create: objeto_proyecto is required (used by NDA in M8)');
  }

  const projectId = uuidv7();
  await db.transaction().execute(async (tx) => {
    await assertCustomerExists(tx, customerId);
    await insertProject(tx, {
      id: projectId,
      customerId,
      name: name.trim(),
      objetoProyecto: objetoProyecto.trim(),
    });
    await projectAudit(tx, ctx, 'project.created', projectId, {
      metadata: { customerId, name: name.trim() },
    });

    // Phase B: customer FYI fan-out — new project created on their account.
    const recipients = await listActiveCustomerUsers(tx, customerId);
    for (const u of recipients) {
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId,
        bucket:        'fyi',
        eventType:     'project.created',
        title:         titleFor('project.created', u.locale, { projectName: name.trim() }),
        linkPath:      '/customer/projects',
        metadata:      { projectId, projectName: name.trim() },
      });
    }
  });
  return { projectId };
}

export async function update(db, { projectId, name, objetoProyecto }, ctx = {}) {
  const trimmedName = typeof name === 'string' ? name.trim() : null;
  const trimmedPurpose = typeof objetoProyecto === 'string' ? objetoProyecto.trim() : null;
  if (!trimmedName && !trimmedPurpose) {
    throw new Error('projects.update: at least one of name / objeto_proyecto required');
  }
  if (name !== undefined && (typeof name !== 'string' || trimmedName === '')) {
    throw new Error('projects.update: name cannot be empty');
  }
  if (objetoProyecto !== undefined && (typeof objetoProyecto !== 'string' || trimmedPurpose === '')) {
    throw new Error('projects.update: objeto_proyecto cannot be empty');
  }

  await db.transaction().execute(async (tx) => {
    const row = await findProjectById(tx, projectId);
    if (!row) throw new Error(`project ${projectId} not found`);
    await updateProjectFields(tx, projectId, {
      name: trimmedName || null,
      objetoProyecto: trimmedPurpose || null,
    });
    await projectAudit(tx, ctx, 'project.updated', projectId, {
      metadata: {
        ...(trimmedName ? { name: trimmedName } : {}),
        ...(trimmedPurpose ? { objetoProyecto: trimmedPurpose } : {}),
      },
    });
  });
}

export async function updateStatus(db, { projectId, status }, ctx = {}) {
  if (!ALLOWED_STATUSES.has(status)) {
    throw new Error(`projects.updateStatus: invalid status '${status}'`);
  }
  await db.transaction().execute(async (tx) => {
    const row = await findProjectById(tx, projectId);
    if (!row) throw new Error(`project ${projectId} not found`);
    await updateProjectStatus(tx, projectId, status);
    await projectAudit(tx, ctx, 'project.status_changed', projectId, {
      metadata: { previousStatus: row.status, newStatus: status },
    });

    // Phase B: customer FYI fan-out — project status flipped.
    const recipients = await listActiveCustomerUsers(tx, row.customer_id);
    for (const u of recipients) {
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId:    row.customer_id,
        bucket:        'fyi',
        eventType:     'project.status_changed',
        title:         titleFor('project.status_changed', u.locale, { projectName: row.name, status }),
        linkPath:      '/customer/projects',
        metadata:      { projectId, status, previousStatus: row.status },
      });
    }
  });
}
