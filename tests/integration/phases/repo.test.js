import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesRepo from '../../../domain/phases/repo.js';
import { makeTag, makeCustomerAndProject, cleanupByTag } from './_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('domain/phases/repo', () => {
  const tag = makeTag();
  let db;
  let projectId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    const ctx = await makeCustomerAndProject(db, tag, 'a');
    projectId = ctx.projectId;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  it('listPhasesByProject returns empty array for a project with no phases', async () => {
    const rows = await phasesRepo.listPhasesByProject(db, projectId);
    expect(rows).toEqual([]);
  });

  it('insertPhase + findPhaseById round-trip', async () => {
    const id = uuidv7();
    await phasesRepo.insertPhase(db, {
      id, projectId, label: '1', displayOrder: 100, status: 'not_started',
      startedAt: null, completedAt: null,
    });
    const row = await phasesRepo.findPhaseById(db, id);
    expect(row.id).toBe(id);
    expect(row.label).toBe('1');
    expect(row.display_order).toBe(100);
    expect(row.status).toBe('not_started');
  });

  it('findMaxDisplayOrder returns 0 for empty project, then 100, then 200', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'b');
    expect(await phasesRepo.findMaxDisplayOrder(db, ctx.projectId)).toBe(0);
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '0', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    expect(await phasesRepo.findMaxDisplayOrder(db, ctx.projectId)).toBe(100);
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '1', displayOrder: 200, status: 'not_started', startedAt: null, completedAt: null });
    expect(await phasesRepo.findMaxDisplayOrder(db, ctx.projectId)).toBe(200);
  });

  it('listPhasesByProject orders by display_order ASC', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'c');
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '2', displayOrder: 300, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '0', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '1', displayOrder: 200, status: 'not_started', startedAt: null, completedAt: null });
    const rows = await phasesRepo.listPhasesByProject(db, ctx.projectId);
    expect(rows.map(r => r.label)).toEqual(['0', '1', '2']);
  });

  it('UNIQUE (project_id, label) rejects duplicate label', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'd');
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '0.5', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await expect(
      phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '0.5', displayOrder: 200, status: 'not_started', startedAt: null, completedAt: null })
    ).rejects.toThrow(/project_phases_label_unique/);
  });

  it('updatePhaseLabel updates the label', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'e');
    const id = uuidv7();
    await phasesRepo.insertPhase(db, { id, projectId: ctx.projectId, label: 'old', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.updatePhaseLabel(db, id, 'new');
    const row = await phasesRepo.findPhaseById(db, id);
    expect(row.label).toBe('new');
  });

  it('setPhaseStatus updates status + timestamps', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'f');
    const id = uuidv7();
    await phasesRepo.insertPhase(db, { id, projectId: ctx.projectId, label: '1', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    const startedAt = new Date('2026-05-03T12:00:00Z');
    await phasesRepo.setPhaseStatus(db, id, { status: 'in_progress', startedAt, completedAt: null });
    const row = await phasesRepo.findPhaseById(db, id);
    expect(row.status).toBe('in_progress');
    expect(row.started_at?.toISOString()).toBe(startedAt.toISOString());
    expect(row.completed_at).toBeNull();
  });

  it('deferred unique on (project_id, display_order) allows transactional swap', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'g');
    const idA = uuidv7();
    const idB = uuidv7();
    await phasesRepo.insertPhase(db, { id: idA, projectId: ctx.projectId, label: 'A', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.insertPhase(db, { id: idB, projectId: ctx.projectId, label: 'B', displayOrder: 200, status: 'not_started', startedAt: null, completedAt: null });
    await db.transaction().execute(async (tx) => {
      await phasesRepo.setPhaseDisplayOrder(tx, idA, 200);
      await phasesRepo.setPhaseDisplayOrder(tx, idB, 100);
    });
    const rows = await phasesRepo.listPhasesByProject(db, ctx.projectId);
    expect(rows.map(r => r.label)).toEqual(['B', 'A']);
  });

  it('deletePhase removes the row', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'h');
    const id = uuidv7();
    await phasesRepo.insertPhase(db, { id, projectId: ctx.projectId, label: '1', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.deletePhase(db, id);
    expect(await phasesRepo.findPhaseById(db, id)).toBeNull();
  });
});
