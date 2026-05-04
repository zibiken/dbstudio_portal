import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesService from '../../../domain/phases/service.js';
import * as phasesRepo from '../../../domain/phases/repo.js';
import { makeTag, makeAdmin, makeCustomerAndProject, baseCtx, cleanupByTag } from './_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('domain/phases/service', () => {
  const tag = makeTag();
  let db;
  let adminId;
  let customerId;
  let projectId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'a');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  async function getAuditRowsFor(action) {
    const r = await sql`
      SELECT * FROM audit_log
       WHERE action = ${action} AND metadata->>'tag' = ${tag}
       ORDER BY ts ASC
    `.execute(db);
    return r.rows;
  }

  it('create writes a not_started phase + admin-only audit + admin digest fan-out', async () => {
    const { phaseId } = await phasesService.create(
      db,
      { projectId, customerId, label: '1' },
      { ...baseCtx(tag), actorType: 'admin' },
      { adminId },
    );
    const row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.label).toBe('1');
    expect(row.status).toBe('not_started');
    expect(row.display_order).toBe(100);

    const auditRows = await getAuditRowsFor('phase.created');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].visible_to_customer).toBe(false);
    expect(auditRows[0].metadata.customerId).toBe(customerId);
    expect(auditRows[0].metadata.projectId).toBe(projectId);
    expect(auditRows[0].metadata.phaseId).toBe(phaseId);
  });

  it('changeStatus not_started → in_progress writes started_at, customer-visible audit, customer digest fan-out', async () => {
    const { phaseId } = await phasesService.create(db, { projectId, customerId, label: '2' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.status).toBe('in_progress');
    expect(row.started_at).not.toBeNull();
    expect(row.completed_at).toBeNull();

    const auditRows = await getAuditRowsFor('phase.status_changed');
    const lastForThisPhase = auditRows.filter(a => a.metadata.phaseId === phaseId).pop();
    expect(lastForThisPhase.visible_to_customer).toBe(true);
    expect(lastForThisPhase.metadata.from).toBe('not_started');
    expect(lastForThisPhase.metadata.to).toBe('in_progress');

    // Customer digest item — recipient_type is 'customer_user' per CHECK
    // constraint in migrations/0010_digest_and_payments.sql.
    const digestRows = await sql`
      SELECT * FROM pending_digest_items
       WHERE event_type = 'phase.status_changed'
         AND recipient_type = 'customer_user'
         AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(digestRows.rows.length).toBeGreaterThan(0);
  });

  it('changeStatus in_progress → done writes completed_at; → in_progress again clears it', async () => {
    const { phaseId } = await phasesService.create(db, { projectId, customerId, label: '3' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'done' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    let row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.completed_at).not.toBeNull();
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.completed_at).toBeNull();
  });

  it('does not overwrite an explicit started_at when transitioning to in_progress', async () => {
    const { phaseId } = await phasesService.create(db, { projectId, customerId, label: 'explicit-start' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await sql`UPDATE project_phases
                SET started_at = '2024-01-15 10:00:00+00'::timestamptz
              WHERE id = ${phaseId}::uuid`.execute(db);

    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.started_at.toISOString()).toMatch(/^2024-01-15/);
    expect(row.completed_at).toBeNull();
  });

  it('does not overwrite an explicit completed_at when transitioning to done', async () => {
    const { phaseId } = await phasesService.create(db, { projectId, customerId, label: 'explicit-done' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await sql`UPDATE project_phases
                SET started_at = '2024-02-01 10:00:00+00'::timestamptz,
                    completed_at = '2024-04-30 18:00:00+00'::timestamptz
              WHERE id = ${phaseId}::uuid`.execute(db);

    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'done' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.completed_at.toISOString()).toMatch(/^2024-04-30/);
  });

  it('changeStatus → not_started is admin-only audit (visible_to_customer = false)', async () => {
    const { phaseId } = await phasesService.create(db, { projectId, customerId, label: '4' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'not_started' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const auditRows = await getAuditRowsFor('phase.status_changed');
    const lastForThisPhase = auditRows.filter(a => a.metadata.phaseId === phaseId).pop();
    expect(lastForThisPhase.metadata.to).toBe('not_started');
    expect(lastForThisPhase.visible_to_customer).toBe(false);
  });

  it('rename on an in_progress phase writes a customer-visible audit row', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'rename-vis');
    const p = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'old' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId: p.phaseId, customerId: ctx.customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.rename(db, { phaseId: p.phaseId, customerId: ctx.customerId },
      { label: 'renamed' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const auditRows = await getAuditRowsFor('phase.renamed');
    const last = auditRows.filter(r => r.metadata.phaseId === p.phaseId).pop();
    expect(last.visible_to_customer).toBe(true);
    expect(last.metadata.oldLabel).toBe('old');
    expect(last.metadata.newLabel).toBe('renamed');
  });

  it('rename with duplicate label rejects', async () => {
    const a = await phasesService.create(db, { projectId, customerId, label: '5' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.create(db, { projectId, customerId, label: '6' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await expect(
      phasesService.rename(db, { phaseId: a.phaseId, customerId },
        { label: '6' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId }),
    ).rejects.toThrow();
  });

  it('reorder swaps display_order with neighbour and writes admin-only audit', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'reorder');
    const a = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'A' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const b = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'B' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.reorder(db, { phaseId: a.phaseId, customerId: ctx.customerId },
      { direction: 'down' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await phasesRepo.listPhasesByProject(db, ctx.projectId);
    expect(rows.map(r => r.label)).toEqual(['B', 'A']);

    const auditRows = await getAuditRowsFor('phase.reordered');
    const last = auditRows.filter(r => r.metadata.phaseId === a.phaseId).pop();
    expect(last.visible_to_customer).toBe(false);
  });

  describe('setPhaseDates', () => {
    it('writes both dates when provided', async () => {
      const ctx = await makeCustomerAndProject(db, tag, 'sd1');
      const { phaseId } = await phasesService.create(db,
        { projectId: ctx.projectId, customerId: ctx.customerId, label: 'X' },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });

      await phasesService.setPhaseDates(db,
        { phaseId, customerId: ctx.customerId },
        { startedAt: new Date('2024-03-01T00:00:00Z'),
          completedAt: new Date('2024-04-15T00:00:00Z') },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });

      const row = await phasesRepo.findPhaseById(db, phaseId);
      expect(row.started_at.toISOString()).toMatch(/^2024-03-01/);
      expect(row.completed_at.toISOString()).toMatch(/^2024-04-15/);
    });

    it('clears a date when null is passed', async () => {
      const ctx = await makeCustomerAndProject(db, tag, 'sd2');
      const { phaseId } = await phasesService.create(db,
        { projectId: ctx.projectId, customerId: ctx.customerId, label: 'Y' },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });
      await phasesService.setPhaseDates(db,
        { phaseId, customerId: ctx.customerId },
        { startedAt: new Date('2024-01-01T00:00:00Z'), completedAt: null },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });

      await phasesService.setPhaseDates(db,
        { phaseId, customerId: ctx.customerId },
        { startedAt: null, completedAt: null },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });

      const row = await phasesRepo.findPhaseById(db, phaseId);
      expect(row.started_at).toBeNull();
      expect(row.completed_at).toBeNull();
    });

    it('rejects when phase belongs to a different customer (CROSS_CUSTOMER)', async () => {
      const a = await makeCustomerAndProject(db, tag, 'sd3a');
      const b = await makeCustomerAndProject(db, tag, 'sd3b');
      const { phaseId } = await phasesService.create(db,
        { projectId: a.projectId, customerId: a.customerId, label: 'Z' },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });

      await expect(
        phasesService.setPhaseDates(db,
          { phaseId, customerId: b.customerId },
          { startedAt: new Date(), completedAt: null },
          { ...baseCtx(tag), actorType: 'admin' }, { adminId })
      ).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
    });
  });

  describe('setPhaseOrder', () => {
    it('moves a phase to a target index, renumbering siblings 0..N-1', async () => {
      const ctx = await makeCustomerAndProject(db, tag, 'so1');
      const a = (await phasesService.create(db,
        { projectId: ctx.projectId, customerId: ctx.customerId, label: 'A' },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId })).phaseId;
      const b = (await phasesService.create(db,
        { projectId: ctx.projectId, customerId: ctx.customerId, label: 'B' },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId })).phaseId;
      const c = (await phasesService.create(db,
        { projectId: ctx.projectId, customerId: ctx.customerId, label: 'C' },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId })).phaseId;

      await phasesService.setPhaseOrder(db,
        { phaseId: c, customerId: ctx.customerId },
        { targetIndex: 0 },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });

      const rows = await sql`SELECT id::text AS id, display_order
                               FROM project_phases
                              WHERE project_id = ${ctx.projectId}::uuid
                              ORDER BY display_order`.execute(db);
      expect(rows.rows.map(r => r.id)).toEqual([c, a, b]);
      expect(rows.rows.map(r => r.display_order)).toEqual([0, 1, 2]);
    });

    it('rejects targetIndex out of range', async () => {
      const ctx = await makeCustomerAndProject(db, tag, 'so2');
      const a = (await phasesService.create(db,
        { projectId: ctx.projectId, customerId: ctx.customerId, label: 'A' },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId })).phaseId;
      await expect(
        phasesService.setPhaseOrder(db,
          { phaseId: a, customerId: ctx.customerId },
          { targetIndex: 5 },
          { ...baseCtx(tag), actorType: 'admin' }, { adminId })
      ).rejects.toMatchObject({ code: 'PHASE_ORDER_OUT_OF_RANGE' });
    });

    it('rejects when phase belongs to a different customer', async () => {
      const a = await makeCustomerAndProject(db, tag, 'so3a');
      const b = await makeCustomerAndProject(db, tag, 'so3b');
      const phaseInA = (await phasesService.create(db,
        { projectId: a.projectId, customerId: a.customerId, label: 'X' },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId })).phaseId;
      await expect(
        phasesService.setPhaseOrder(db,
          { phaseId: phaseInA, customerId: b.customerId },
          { targetIndex: 0 },
          { ...baseCtx(tag), actorType: 'admin' }, { adminId })
      ).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
    });
  });

  it('delete on a customer-visible phase writes a customer-visible audit; on not_started phase writes admin-only audit', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'del');
    const visible = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'V' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId: visible.phaseId, customerId: ctx.customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.delete(db, { phaseId: visible.phaseId, customerId: ctx.customerId },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const hidden = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'H' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.delete(db, { phaseId: hidden.phaseId, customerId: ctx.customerId },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const auditRows = await getAuditRowsFor('phase.deleted');
    const visibleAudit = auditRows.find(r => r.metadata.phaseLabel === 'V');
    const hiddenAudit = auditRows.find(r => r.metadata.phaseLabel === 'H');
    expect(visibleAudit.visible_to_customer).toBe(true);
    expect(hiddenAudit.visible_to_customer).toBe(false);
  });
});
