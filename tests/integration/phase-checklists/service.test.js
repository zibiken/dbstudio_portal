import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesService from '../../../domain/phases/service.js';
import * as checklistService from '../../../domain/phase-checklists/service.js';
import * as checklistRepo from '../../../domain/phase-checklists/repo.js';
import { makeTag, makeAdmin, makeCustomerAndProject, baseCtx, cleanupByTag } from '../phases/_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('domain/phase-checklists/service', () => {
  const tag = makeTag();
  let db, adminId, customerId, projectId, phaseId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'cl-svc');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
    const phase = await phasesService.create(db, { projectId, customerId, label: '1' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    phaseId = phase.phaseId;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  async function audit(action) {
    const r = await sql`
      SELECT * FROM audit_log
       WHERE action = ${action} AND metadata->>'tag' = ${tag}
       ORDER BY ts ASC
    `.execute(db);
    return r.rows;
  }

  it('create on a not_started phase: audit visible_to_customer = false (parent phase invisible)', async () => {
    const { itemId } = await checklistService.create(db, { phaseId, customerId },
      { label: 'A', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const item = await checklistRepo.findItemById(db, itemId);
    expect(item.label).toBe('A');
    const rows = await audit('phase_checklist.created');
    expect(rows[0].visible_to_customer).toBe(false);
  });

  it('after parent phase moves to in_progress, NEW create writes customer-visible audit', async () => {
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.create(db, { phaseId, customerId },
      { label: 'B', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await audit('phase_checklist.created');
    const lastForB = rows.find(r => r.metadata.itemLabel === 'B');
    expect(lastForB.visible_to_customer).toBe(true);
  });

  it('admin-only item (visibleToCustomer=false) on in_progress phase still writes admin-only audit', async () => {
    await checklistService.create(db, { phaseId, customerId },
      { label: 'internal', visibleToCustomer: false },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await audit('phase_checklist.created');
    const last = rows.find(r => r.metadata.itemLabel === 'internal');
    expect(last.visible_to_customer).toBe(false);
  });

  it('toggleDone writes done_at + done_by_admin_id, then clearing', async () => {
    const { itemId } = await checklistService.create(db, { phaseId, customerId },
      { label: 'toggle', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.toggleDone(db, { itemId, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    let row = await checklistRepo.findItemById(db, itemId);
    expect(row.done_at).not.toBeNull();
    expect(row.done_by_admin_id).toBe(adminId);
    await checklistService.toggleDone(db, { itemId, customerId }, { done: false },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    row = await checklistRepo.findItemById(db, itemId);
    expect(row.done_at).toBeNull();
    expect(row.done_by_admin_id).toBeNull();
  });

  it('setVisibility audit row is always admin-only', async () => {
    const { itemId } = await checklistService.create(db, { phaseId, customerId },
      { label: 'flip', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.setVisibility(db, { itemId, customerId }, { visibleToCustomer: false },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await audit('phase_checklist.visibility_changed');
    expect(rows.every(r => r.visible_to_customer === false)).toBe(true);
  });

  it('delete snapshots phaseLabel + itemLabel + the visibility flags', async () => {
    const { itemId } = await checklistService.create(db, { phaseId, customerId },
      { label: 'del', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.delete(db, { itemId, customerId },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await audit('phase_checklist.deleted');
    const last = rows.find(r => r.metadata.itemLabel === 'del');
    expect(last.metadata.phaseLabel).toBe('1');
    expect(last.metadata.itemLabel).toBe('del');
    expect(last.visible_to_customer).toBe(true); // parent in_progress + item visible
  });
});
