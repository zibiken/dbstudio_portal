import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesService from '../../../domain/phases/service.js';
import * as checklistService from '../../../domain/phase-checklists/service.js';
import { listActivityForCustomer } from '../../../lib/activity-feed.js';
import { makeTag, makeAdmin, makeCustomerAndProject, baseCtx, cleanupByTag } from './_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('phases + checklists end-to-end', () => {
  const tag = makeTag();
  let db, adminId, customerId, projectId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'e2e');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  it('full lifecycle: create phase → open → checklist toggle → done → customer activity feed', async () => {
    // 1. Admin creates phase 1 (not_started — invisible to customer).
    const p1 = await phasesService.create(db, { projectId, customerId, label: '1' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    // 2. Admin pre-populates checklist while phase is not_started — also invisible.
    const i1 = await checklistService.create(db, { phaseId: p1.phaseId, customerId },
      { label: 'Spec the schema', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const i2 = await checklistService.create(db, { phaseId: p1.phaseId, customerId },
      { label: 'Internal review', visibleToCustomer: false },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    // Customer activity feed: nothing yet.
    let feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    expect(feed.filter(r => r.action.startsWith('phase'))).toHaveLength(0);

    // 3. Admin opens the phase.
    await phasesService.changeStatus(db, { phaseId: p1.phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    // Customer NOW sees: phase.status_changed (to in_progress).
    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const statusChanges = feed.filter(r => r.action === 'phase.status_changed');
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0].metadata.to).toBe('in_progress');

    // 4. Admin toggles a customer-visible item done.
    await checklistService.toggleDone(db, { itemId: i1.itemId, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    // Toggle the admin-only item done — must NOT appear in customer feed.
    await checklistService.toggleDone(db, { itemId: i2.itemId, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const toggles = feed.filter(r => r.action === 'phase_checklist.toggled');
    expect(toggles).toHaveLength(1);
    expect(toggles[0].metadata.itemLabel).toBe('Spec the schema');

    // 5. Admin marks phase done.
    await phasesService.changeStatus(db, { phaseId: p1.phaseId, customerId },
      { newStatus: 'done' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    // Feed is ordered DESC (newest first) — use [0] for most recent.
    const finalStatusChange = feed.filter(r => r.action === 'phase.status_changed')[0];
    expect(finalStatusChange.metadata.to).toBe('done');

    // 6. Admin reverts to in_progress (still customer-visible).
    await phasesService.changeStatus(db, { phaseId: p1.phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const reopened = feed.filter(r => r.action === 'phase.status_changed' && r.metadata.from === 'done')[0];
    expect(reopened).toBeTruthy();
    expect(reopened.metadata.to).toBe('in_progress');

    // 7. Admin reverts all the way to not_started — customer must NOT see it.
    await phasesService.changeStatus(db, { phaseId: p1.phaseId, customerId },
      { newStatus: 'not_started' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const toNotStarted = feed.filter(r => r.action === 'phase.status_changed' && r.metadata.to === 'not_started');
    expect(toNotStarted).toHaveLength(0); // admin-only audit
  });
});
