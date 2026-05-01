import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { recordForDigest } from '../../../lib/digest.js';
import { tickOnce } from '../../../domain/digest/worker.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Note on parallel-test isolation: tickOnce.fired and email_outbox.count are
// poor scope-of-truth here because (a) other tests fan out to listActiveAdmins
// which includes our admin, (b) tests/integration/email-outbox/worker.test.js
// sweeps email_outbox in beforeAll. Our scope-safe assertions key off the
// schedule + pending_digest_items state for our specific admin.id between
// tick boundaries.

describe.skipIf(skip)('digest worker — twice-daily fixed cadence', () => {
  let db;
  const tag = `digest_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const adminIds = [];

  async function makeAdmin(suffix) {
    const id = uuidv7();
    const email = `${tag}+${suffix}@example.test`;
    await sql`
      INSERT INTO admins (id, email, name)
      VALUES (${id}::uuid, ${email}, ${'Test ' + suffix})
    `.execute(db);
    adminIds.push(id);
    return { id, email, locale: 'en' };
  }

  async function clearForRecipient(recipientId) {
    await sql`DELETE FROM pending_digest_items WHERE recipient_id = ${recipientId}::uuid`.execute(db);
    await sql`DELETE FROM digest_schedules    WHERE recipient_id = ${recipientId}::uuid`.execute(db);
  }

  async function pendingItemCount(recipientId) {
    const r = await sql`
      SELECT COUNT(*)::int AS c FROM pending_digest_items WHERE recipient_id = ${recipientId}::uuid
    `.execute(db);
    return r.rows[0].c;
  }

  async function scheduleDueAt(recipientId) {
    const r = await sql`
      SELECT due_at FROM digest_schedules WHERE recipient_id = ${recipientId}::uuid
    `.execute(db);
    return r.rows[0]?.due_at ?? null;
  }

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (!db) return;
    await pruneTestPollution(db, { recipientIds: adminIds });
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await db.destroy();
  });

  it('event at 09:00 Canary schedules due_at to 17:00 same day', async () => {
    const admin = await makeAdmin('a');
    await clearForRecipient(admin.id);

    // 08:00 UTC == 09:00 WEST on 2026-05-01
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — New document: x.pdf`,
    }, { now: new Date('2026-05-01T08:00:00Z') });

    // Schedule due_at should be 17:00 WEST same day = 16:00 UTC.
    const due = await scheduleDueAt(admin.id);
    expect(due).toBeTruthy();
    expect(new Date(due).toISOString()).toBe('2026-05-01T16:00:00.000Z');

    // Pending item is queued for our admin.
    expect(await pendingItemCount(admin.id)).toBe(1);

    await clearForRecipient(admin.id);
  });

  it('event at 18:00 Canary schedules due_at to 08:00 next day', async () => {
    const admin = await makeAdmin('b');
    await clearForRecipient(admin.id);

    // 17:00 UTC == 18:00 WEST on 2026-05-01.
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — New document: y.pdf`,
    }, { now: new Date('2026-05-01T17:00:00Z') });

    // Schedule due_at should be 08:00 WEST next day = 07:00 UTC.
    const due = await scheduleDueAt(admin.id);
    expect(due).toBeTruthy();
    expect(new Date(due).toISOString()).toBe('2026-05-02T07:00:00.000Z');

    // Tick BEFORE the scheduled fire — schedule must remain.
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T17:01:00Z') });
    expect(await scheduleDueAt(admin.id)).toBeTruthy();
    expect(await pendingItemCount(admin.id)).toBe(1);

    await clearForRecipient(admin.id);
  });

  it('two events for the same recipient share one schedule + one pending item per event', async () => {
    const admin = await makeAdmin('c');
    await clearForRecipient(admin.id);

    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'invoice.uploaded',
      title: `${tag} — INV-001`,
    }, { now: new Date('2026-05-01T08:00:00Z') });
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'action_required', eventType: 'nda.created',
      title: `${tag} — New NDA`,
    }, { now: new Date('2026-05-01T14:00:00Z') });

    // Two distinct event types => two pending items.
    expect(await pendingItemCount(admin.id)).toBe(2);
    // One schedule row regardless (upsert).
    const r = await sql`
      SELECT COUNT(*)::int AS c FROM digest_schedules WHERE recipient_id = ${admin.id}::uuid
    `.execute(db);
    expect(r.rows[0].c).toBe(1);

    await clearForRecipient(admin.id);
  });

  it('skip-if-empty: items retracted before fire drop the schedule on tick', async () => {
    const admin = await makeAdmin('d');
    await clearForRecipient(admin.id);

    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — z.pdf`,
    }, { now: new Date('2026-05-01T08:00:00Z') });
    // Simulate a retraction.
    await sql`DELETE FROM pending_digest_items WHERE recipient_id = ${admin.id}::uuid`.execute(db);

    expect(await pendingItemCount(admin.id)).toBe(0);
    // Tick at fire time — claim+drain finds 0 items, drops the schedule row.
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T16:01:00Z') });
    expect(await scheduleDueAt(admin.id)).toBeNull();

    await clearForRecipient(admin.id);
  });
});
