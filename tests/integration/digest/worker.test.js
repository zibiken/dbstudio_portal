import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { recordForDigest } from '../../../lib/digest.js';
import { tickOnce } from '../../../domain/digest/worker.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

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
    await sql`DELETE FROM email_outbox        WHERE to_address LIKE ${tag + '%'}`.execute(db);
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

  async function emailCountFor(email) {
    const r = await sql`SELECT COUNT(*)::int AS c FROM email_outbox WHERE to_address = ${email}`.execute(db);
    return r.rows[0].c;
  }

  it('event recorded at 09:00 Canary fires at 17:00 Canary same day (skip-if-empty otherwise)', async () => {
    const admin = await makeAdmin('a');
    await clearForRecipient(admin.id);

    // 08:00 UTC == 09:00 WEST on 2026-05-01
    const morning = new Date('2026-05-01T08:00:00Z');
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — New document: x.pdf`,
    }, { now: morning });

    // Tick at 16:30 Canary (15:30 UTC) — too early for our schedule (due 16:00 UTC)
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T15:30:00Z') });
    expect(await emailCountFor(admin.email)).toBe(0);

    // Tick at 17:01 Canary (16:01 UTC) — our schedule fires
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T16:01:00Z') });
    expect(await emailCountFor(admin.email)).toBe(1);

    await clearForRecipient(admin.id);
  });

  it('event recorded at 18:00 Canary fires at 08:00 next day Canary', async () => {
    const admin = await makeAdmin('b');
    await clearForRecipient(admin.id);

    // 17:00 UTC == 18:00 WEST on 2026-05-01
    const evening = new Date('2026-05-01T17:00:00Z');
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — New document: y.pdf`,
    }, { now: evening });

    // Tick at 18:01 Canary same day — too early
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T17:01:00Z') });
    expect(await emailCountFor(admin.email)).toBe(0);

    // Tick at 08:01 Canary next day (07:01 UTC WEST)
    await tickOnce({ db, log: silentLog, now: new Date('2026-05-02T07:01:00Z') });
    expect(await emailCountFor(admin.email)).toBe(1);

    await clearForRecipient(admin.id);
  });

  it('two events 6 hours apart for the same recipient produce ONE email at next fire', async () => {
    const admin = await makeAdmin('c');
    await clearForRecipient(admin.id);

    // 08:00 UTC and 14:00 UTC on 2026-05-01 — both before 16:00 UTC fire
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — a.pdf`,
    }, { now: new Date('2026-05-01T08:00:00Z') });
    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'action_required', eventType: 'nda.created',
      title: `${tag} — New NDA`,
    }, { now: new Date('2026-05-01T14:00:00Z') });

    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T16:01:00Z') });
    expect(await emailCountFor(admin.email)).toBe(1);

    await clearForRecipient(admin.id);
  });

  it('skip-if-empty: items retracted between record and fire produce no email', async () => {
    const admin = await makeAdmin('d');
    await clearForRecipient(admin.id);

    await recordForDigest(db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: `${tag} — z.pdf`,
    }, { now: new Date('2026-05-01T08:00:00Z') });
    // Manually drain to simulate retraction
    await sql`DELETE FROM pending_digest_items WHERE recipient_id = ${admin.id}::uuid`.execute(db);

    await tickOnce({ db, log: silentLog, now: new Date('2026-05-01T16:01:00Z') });
    expect(await emailCountFor(admin.email)).toBe(0);

    await clearForRecipient(admin.id);
  });
});
