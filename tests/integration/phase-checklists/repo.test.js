import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesRepo from '../../../domain/phases/repo.js';
import * as checklistRepo from '../../../domain/phase-checklists/repo.js';
import { makeTag, makeCustomerAndProject, cleanupByTag } from '../phases/_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('domain/phase-checklists/repo', () => {
  const tag = makeTag();
  let db;
  let phaseId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    const ctx = await makeCustomerAndProject(db, tag, 'cl');
    phaseId = uuidv7();
    await phasesRepo.insertPhase(db, {
      id: phaseId, projectId: ctx.projectId, label: '1', displayOrder: 100,
      status: 'in_progress', startedAt: new Date(), completedAt: null,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  it('listItemsByPhase empty for fresh phase', async () => {
    expect(await checklistRepo.listItemsByPhase(db, phaseId)).toEqual([]);
  });

  it('insertItem + findItemById + listItemsByPhase ordered', async () => {
    const a = uuidv7(), b = uuidv7(), c = uuidv7();
    await checklistRepo.insertItem(db, { id: a, phaseId, label: 'A', displayOrder: 200, visibleToCustomer: true });
    await checklistRepo.insertItem(db, { id: b, phaseId, label: 'B', displayOrder: 100, visibleToCustomer: true });
    await checklistRepo.insertItem(db, { id: c, phaseId, label: 'C', displayOrder: 300, visibleToCustomer: false });
    const rows = await checklistRepo.listItemsByPhase(db, phaseId);
    expect(rows.map(r => r.label)).toEqual(['B', 'A', 'C']);
    expect(rows[2].visible_to_customer).toBe(false);
  });

  it('findMaxItemDisplayOrder', async () => {
    expect(await checklistRepo.findMaxItemDisplayOrder(db, phaseId)).toBe(300);
  });

  it('updateItemLabel', async () => {
    const id = uuidv7();
    await checklistRepo.insertItem(db, { id, phaseId, label: 'old', displayOrder: 1000, visibleToCustomer: true });
    await checklistRepo.updateItemLabel(db, id, 'new');
    expect((await checklistRepo.findItemById(db, id)).label).toBe('new');
  });

  it('setItemVisibility flips the flag', async () => {
    const id = uuidv7();
    await checklistRepo.insertItem(db, { id, phaseId, label: 'v', displayOrder: 1100, visibleToCustomer: true });
    await checklistRepo.setItemVisibility(db, id, false);
    expect((await checklistRepo.findItemById(db, id)).visible_to_customer).toBe(false);
  });

  it('setItemDone writes done_at + done_by_admin_id; passing null clears them', async () => {
    const id = uuidv7();
    await checklistRepo.insertItem(db, { id, phaseId, label: 'd', displayOrder: 1200, visibleToCustomer: true });
    const adminId = uuidv7();
    await sql`
      INSERT INTO admins (id, email, name, password_hash, totp_secret_enc)
      VALUES (${adminId}::uuid, ${'doneby+' + tag + '@example.com'}, ${'X'}, ${'x'}, ${'x'})
    `.execute(db);
    const doneAt = new Date('2026-05-03T13:00:00Z');
    await checklistRepo.setItemDone(db, id, { doneAt, doneByAdminId: adminId });
    let row = await checklistRepo.findItemById(db, id);
    expect(row.done_at?.toISOString()).toBe(doneAt.toISOString());
    expect(row.done_by_admin_id).toBe(adminId);
    await checklistRepo.setItemDone(db, id, { doneAt: null, doneByAdminId: null });
    row = await checklistRepo.findItemById(db, id);
    expect(row.done_at).toBeNull();
    expect(row.done_by_admin_id).toBeNull();
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
  });

  it('deleteItem removes the row', async () => {
    const id = uuidv7();
    await checklistRepo.insertItem(db, { id, phaseId, label: 'x', displayOrder: 1300, visibleToCustomer: true });
    await checklistRepo.deleteItem(db, id);
    expect(await checklistRepo.findItemById(db, id)).toBeNull();
  });
});
