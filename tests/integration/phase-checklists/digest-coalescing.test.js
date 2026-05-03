import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesService from '../../../domain/phases/service.js';
import * as checklistService from '../../../domain/phase-checklists/service.js';
import { makeTag, makeAdmin, makeCustomerAndProject, baseCtx, cleanupByTag } from '../phases/_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('phase_checklist.toggled coalesces per phase per recipient', () => {
  const tag = makeTag();
  let db, adminId, customerId, projectId, phaseAId, phaseBId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'coal');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
    const phaseA = await phasesService.create(db, { projectId, customerId, label: 'P-A' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    phaseAId = phaseA.phaseId;
    await phasesService.changeStatus(db, { phaseId: phaseAId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const phaseB = await phasesService.create(db, { projectId, customerId, label: 'P-B' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    phaseBId = phaseB.phaseId;
    await phasesService.changeStatus(db, { phaseId: phaseBId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  it('three toggles within the window produce one coalesced digest row per recipient', async () => {
    const items = [];
    for (let i = 0; i < 3; i++) {
      const it = await checklistService.create(db, { phaseId: phaseAId, customerId },
        { label: `i${i}`, visibleToCustomer: true },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });
      items.push(it.itemId);
    }
    for (const id of items) {
      await checklistService.toggleDone(db, { itemId: id, customerId }, { done: true },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    }

    const customerRows = await sql`
      SELECT * FROM pending_digest_items
       WHERE event_type = 'phase_checklist.toggled'
         AND recipient_type = 'customer_user'
         AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(customerRows.rows).toHaveLength(1);
    expect(Number(customerRows.rows[0].metadata.count)).toBe(3);
    expect(customerRows.rows[0].title).toMatch(/3 checklist items updated/i);
  });

  it('toggles in two distinct phases keep distinct rows per phase per recipient', async () => {
    // Reset any rows the prior test left behind for this tag — coalescing
    // would otherwise pick them up. cleanupByTag drops them at suite-end;
    // here we only need the fan-out window to be empty.
    await sql`DELETE FROM pending_digest_items WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql`DELETE FROM digest_schedules WHERE recipient_id IN (
      SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM digest_schedules WHERE recipient_id IN (
      SELECT id FROM admins WHERE email LIKE ${tag + '%'}
    )`.execute(db);

    const itemA1 = (await checklistService.create(db, { phaseId: phaseAId, customerId },
      { label: 'a1', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId })).itemId;
    const itemA2 = (await checklistService.create(db, { phaseId: phaseAId, customerId },
      { label: 'a2', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId })).itemId;
    const itemB1 = (await checklistService.create(db, { phaseId: phaseBId, customerId },
      { label: 'b1', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId })).itemId;

    // Drop the create-side fan-out from the window — we're testing
    // toggle coalescing per phase, not creates.
    await sql`DELETE FROM pending_digest_items
                WHERE event_type = 'phase_checklist.created'
                  AND metadata->>'tag' = ${tag}`.execute(db);

    await checklistService.toggleDone(db, { itemId: itemA1, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.toggleDone(db, { itemId: itemB1, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.toggleDone(db, { itemId: itemA2, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const customerRows = await sql`
      SELECT metadata->>'phaseId' AS phase_id,
             metadata->>'count' AS count_str,
             title
        FROM pending_digest_items
       WHERE event_type = 'phase_checklist.toggled'
         AND recipient_type = 'customer_user'
         AND metadata->>'tag' = ${tag}
       ORDER BY metadata->>'phaseId'
    `.execute(db);

    expect(customerRows.rows).toHaveLength(2);
    const byPhase = Object.fromEntries(customerRows.rows.map(r => [r.phase_id, r]));
    expect(Number(byPhase[phaseAId].count_str)).toBe(2);
    expect(Number(byPhase[phaseBId].count_str)).toBe(1);
    expect(byPhase[phaseAId].title).toMatch(/P-A/);
    expect(byPhase[phaseBId].title).toMatch(/P-B/);
  });
});
