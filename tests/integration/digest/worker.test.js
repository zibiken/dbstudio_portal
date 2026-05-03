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

describe.skipIf(skip)('digest worker — debounce cadence (10-min idle, 60-min cap)', () => {
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

  async function scheduleRow(recipientId) {
    const r = await sql`
      SELECT due_at, oldest_item_at FROM digest_schedules WHERE recipient_id = ${recipientId}::uuid
    `.execute(db);
    return r.rows[0] ?? null;
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

  it('first event schedules due_at to now + 10 min and anchors oldest_item_at to now', async () => {
    const admin = await makeAdmin('a');
    await clearForRecipient(admin.id);

    const now = new Date('2026-05-01T08:00:00Z');
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — New document: x.pdf`,
    }, { now });

    const row = await scheduleRow(admin.id);
    expect(row).toBeTruthy();
    expect(new Date(row.due_at).toISOString()).toBe('2026-05-01T08:10:00.000Z');
    expect(new Date(row.oldest_item_at).toISOString()).toBe('2026-05-01T08:00:00.000Z');
    expect(await pendingItemCount(admin.id)).toBe(1);

    await clearForRecipient(admin.id);
  });

  it('second event 5 min later slides due_at to second-event + 10 min (idle reset); oldest_item_at unchanged', async () => {
    const admin = await makeAdmin('b');
    await clearForRecipient(admin.id);

    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'invoice.uploaded',
      title: `${tag} — INV-001`,
    }, { now: new Date('2026-05-01T09:00:00Z') });
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'action_required', eventType: 'nda.created',
      title: `${tag} — New NDA`,
    }, { now: new Date('2026-05-01T09:05:00Z') });

    const row = await scheduleRow(admin.id);
    expect(new Date(row.due_at).toISOString()).toBe('2026-05-01T09:15:00.000Z');
    expect(new Date(row.oldest_item_at).toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(await pendingItemCount(admin.id)).toBe(2);

    await clearForRecipient(admin.id);
  });

  it('60-min cap: an event 65 min after the first leaves due_at clamped at oldest_item_at + 60 min', async () => {
    const admin = await makeAdmin('c');
    await clearForRecipient(admin.id);

    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — first.pdf`,
    }, { now: new Date('2026-05-01T10:00:00Z') });
    // 65 min later — naive idle reset would push due_at to 11:15, but the cap
    // forces it to oldest_item_at + 60 min = 11:00.
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'invoice.uploaded',
      title: `${tag} — late.pdf`,
    }, { now: new Date('2026-05-01T11:05:00Z') });

    const row = await scheduleRow(admin.id);
    expect(new Date(row.due_at).toISOString()).toBe('2026-05-01T11:00:00.000Z');
    expect(new Date(row.oldest_item_at).toISOString()).toBe('2026-05-01T10:00:00.000Z');

    await clearForRecipient(admin.id);
  });

  it('two events for the same recipient share one schedule + one pending item per event type', async () => {
    const admin = await makeAdmin('d');
    await clearForRecipient(admin.id);

    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'invoice.uploaded',
      title: `${tag} — INV-002`,
    }, { now: new Date('2026-05-01T12:00:00Z') });
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'action_required', eventType: 'nda.created',
      title: `${tag} — Another NDA`,
    }, { now: new Date('2026-05-01T12:01:00Z') });

    expect(await pendingItemCount(admin.id)).toBe(2);
    const r = await sql`
      SELECT COUNT(*)::int AS c FROM digest_schedules WHERE recipient_id = ${admin.id}::uuid
    `.execute(db);
    expect(r.rows[0].c).toBe(1);

    await clearForRecipient(admin.id);
  });

  it('tick BEFORE due_at does not fire; tick AFTER due_at drains and clears', async () => {
    const admin = await makeAdmin('e');
    await clearForRecipient(admin.id);

    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — y.pdf`,
    }, { now: new Date('2026-05-01T13:00:00Z') });
    // due_at = 13:10. Tick at 13:05 — schedule must remain.
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T13:05:00Z') });
    expect(await scheduleRow(admin.id)).toBeTruthy();
    expect(await pendingItemCount(admin.id)).toBe(1);

    // Tick at 13:11 — should claim, drain, and clear.
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T13:11:00Z') });
    expect(await scheduleRow(admin.id)).toBeNull();
    expect(await pendingItemCount(admin.id)).toBe(0);

    await clearForRecipient(admin.id);
  });

  it('skip-if-empty: items retracted before fire drop the schedule on tick', async () => {
    const admin = await makeAdmin('f');
    await clearForRecipient(admin.id);

    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — z.pdf`,
    }, { now: new Date('2026-05-01T14:00:00Z') });
    await sql`DELETE FROM pending_digest_items WHERE recipient_id = ${admin.id}::uuid`.execute(db);

    expect(await pendingItemCount(admin.id)).toBe(0);
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T14:11:00Z') });
    expect(await scheduleRow(admin.id)).toBeNull();

    await clearForRecipient(admin.id);
  });
});
