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
  let db, adminId, customerId, projectId, phaseId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'coal');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
    const phase = await phasesService.create(db, { projectId, customerId, label: 'P' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    phaseId = phase.phaseId;
    await phasesService.changeStatus(db, { phaseId, customerId },
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
      const it = await checklistService.create(db, { phaseId, customerId },
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
});
