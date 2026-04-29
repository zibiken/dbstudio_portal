import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { tickOnce, startWorker } from '../../../domain/email-outbox/worker.js';
import { enqueue } from '../../../domain/email-outbox/repo.js';

const skip = !process.env.RUN_DB_TESTS;

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const baseLocals = {
  adminName: 'Op',
  recipientName: 'Rec',
  message: 'hi',
  portalUrl: 'https://example.test/portal',
};

describe.skipIf(skip)('email-outbox/worker', () => {
  let db;
  const tag = `outbox_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tagAddr = (s) => `${tag}+${s}@example.test`;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
  });

  it('claims and sends queued rows; markSent on 202; idempotency keys preserved exactly', async () => {
    const keys = ['k1', 'k2', 'k3'].map((k) => `${tag}-${k}`);
    for (let i = 0; i < 3; i++) {
      await enqueue(db, {
        idempotencyKey: keys[i],
        toAddress: tagAddr(`a${i}`),
        template: 'generic-admin-message',
        locals: baseLocals,
      });
    }

    const sendCalls = [];
    const mailer = {
      send: vi.fn(async (args) => {
        sendCalls.push(args);
        return { ok: true, providerId: 'ms-' + args.idempotencyKey };
      }),
    };

    // batchSize=3: this case asserts multi-row claim semantics; the worker's
    // default batchSize=1 (post review I3) is exercised by the other tests
    // and by the live service.
    const result = await tickOnce({ db, mailer, log: silentLog, batchSize: 3 });

    expect(mailer.send).toHaveBeenCalledTimes(3);
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);

    const rows = await sql`
      SELECT idempotency_key, to_address, status, sent_at, attempts, last_error
        FROM email_outbox
       WHERE to_address LIKE ${tag + '%'}
       ORDER BY idempotency_key
    `.execute(db);

    expect(rows.rows.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    expect(rows.rows.map((r) => r.idempotency_key).sort()).toEqual([...keys].sort());
    expect(rows.rows.every((r) => r.sent_at !== null)).toBe(true);
    expect(rows.rows.every((r) => r.last_error === null)).toBe(true);
    expect(rows.rows.every((r) => Number(r.attempts) === 1)).toBe(true);

    expect(sendCalls.map((c) => c.idempotencyKey).sort()).toEqual([...keys].sort());
    for (const call of sendCalls) {
      expect(call.subject).toMatch(/A message from DB Studio/);
      expect(typeof call.html).toBe('string');
      expect(call.html.length).toBeGreaterThan(0);
      expect(call.to).toMatch(/^outbox_test_/);
    }
  });

  it('on retryable failure: status flips back to queued with exponential backoff and last_error populated', async () => {
    const key = `${tag}-retry`;
    await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('r'),
      template: 'generic-admin-message',
      locals: baseLocals,
    });

    const before = Date.now();
    const err = Object.assign(new Error('mailersend retryable'), { retryable: true, status: 503 });
    const mailer = { send: vi.fn(async () => { throw err; }) };

    const result = await tickOnce({ db, mailer, log: silentLog });
    const after = Date.now();

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);

    const r = await sql`
      SELECT status, attempts, send_after, last_error, idempotency_key
        FROM email_outbox WHERE idempotency_key = ${key}
    `.execute(db);

    expect(r.rows[0].status).toBe('queued');
    expect(Number(r.rows[0].attempts)).toBe(1);
    // backoff = min(2^1 * 60_000, 3_600_000) = 120_000 ms
    const sa = new Date(r.rows[0].send_after).getTime();
    expect(sa).toBeGreaterThanOrEqual(before + 120_000 - 2000);
    expect(sa).toBeLessThanOrEqual(after + 120_000 + 2000);
    expect(r.rows[0].last_error).toMatch(/mailersend retryable/);
    expect(r.rows[0].idempotency_key).toBe(key); // never rewritten on retry
  });

  it('re-claims a previously failed-retryable row after send_after has passed', async () => {
    const key = `${tag}-reretry`;
    await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('rr'),
      template: 'generic-admin-message',
      locals: baseLocals,
    });

    const failMailer = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('ms 503'), { retryable: true });
      }),
    };
    await tickOnce({ db, mailer: failMailer, log: silentLog });

    // Force send_after into the past so the next tick can re-claim.
    await sql`
      UPDATE email_outbox SET send_after = now() - INTERVAL '1 hour'
       WHERE idempotency_key = ${key}
    `.execute(db);

    const okMailer = { send: vi.fn(async () => ({ ok: true, providerId: 'ok' })) };
    await tickOnce({ db, mailer: okMailer, log: silentLog });

    const r = await sql`
      SELECT status, attempts, sent_at, last_error, idempotency_key
        FROM email_outbox WHERE idempotency_key = ${key}
    `.execute(db);

    expect(r.rows[0].status).toBe('sent');
    expect(Number(r.rows[0].attempts)).toBe(2);
    expect(r.rows[0].sent_at).not.toBeNull();
    expect(r.rows[0].last_error).toBeNull();
    expect(r.rows[0].idempotency_key).toBe(key); // preserved across retry + send
    expect(okMailer.send).toHaveBeenCalledTimes(1);
  });

  it('caps at 5 attempts: a retryable failure on the 5th attempt becomes status=failed', async () => {
    const key = `${tag}-cap`;
    await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('c'),
      template: 'generic-admin-message',
      locals: baseLocals,
    });
    // Pre-position to attempts=4 so the next claim raises it to 5 (the cap).
    await sql`
      UPDATE email_outbox
         SET attempts = 4, status = 'queued', send_after = now() - INTERVAL '1 hour'
       WHERE idempotency_key = ${key}
    `.execute(db);

    const mailer = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('ms 503'), { retryable: true });
      }),
    };
    await tickOnce({ db, mailer, log: silentLog });

    const r = await sql`
      SELECT status, attempts, last_error
        FROM email_outbox WHERE idempotency_key = ${key}
    `.execute(db);

    expect(r.rows[0].status).toBe('failed');
    expect(Number(r.rows[0].attempts)).toBe(5);
    expect(r.rows[0].last_error).toBeTruthy();

    // A subsequent tick must NOT pick it up (attempts < 5 in WHERE).
    mailer.send.mockClear();
    // Even with send_after in the past, the cap should prevent re-claim.
    await sql`
      UPDATE email_outbox SET send_after = now() - INTERVAL '1 hour'
       WHERE idempotency_key = ${key}
    `.execute(db);
    await tickOnce({ db, mailer, log: silentLog });
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('on non-retryable failure: status=failed, attempts=1, last_error populated', async () => {
    const key = `${tag}-perm`;
    await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('p'),
      template: 'generic-admin-message',
      locals: baseLocals,
    });

    const mailer = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('mailersend 422'), { retryable: false, status: 422 });
      }),
    };
    await tickOnce({ db, mailer, log: silentLog });

    const r = await sql`
      SELECT status, attempts, last_error
        FROM email_outbox WHERE idempotency_key = ${key}
    `.execute(db);

    expect(r.rows[0].status).toBe('failed');
    expect(Number(r.rows[0].attempts)).toBe(1);
    expect(r.rows[0].last_error).toMatch(/mailersend 422/);
  });

  it('drops sensitive token-bearing locals (code + URL keys) after a successful send while preserving the rest', async () => {
    const key = `${tag}-scrub`;
    await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('s'),
      template: 'generic-admin-message',
      locals: {
        ...baseLocals,
        code: '123456',
        welcomeUrl: 'https://portal.example.test/welcome/aaa',
        resetUrl: 'https://portal.example.test/reset/bbb',
        inviteUrl: 'https://portal.example.test/welcome/ccc',
        verifyUrl: 'https://portal.example.test/verify/ddd',
        revertUrl: 'https://portal.example.test/revert/eee',
      },
    });

    const mailer = { send: vi.fn(async () => ({ ok: true, providerId: 'ok' })) };
    await tickOnce({ db, mailer, log: silentLog });

    const r = await sql`
      SELECT locals FROM email_outbox WHERE idempotency_key = ${key}
    `.execute(db);

    // Every token-bearing key must be gone — these are bearer credentials
    // and the email_outbox row outlives the send (kept for forensics).
    for (const k of ['code', 'welcomeUrl', 'resetUrl', 'inviteUrl', 'verifyUrl', 'revertUrl']) {
      expect(r.rows[0].locals[k], `${k} should be scrubbed`).toBeUndefined();
      expect(k in r.rows[0].locals, `${k} key should be gone`).toBe(false);
    }
    // Non-token locals stay so an operator can still tell who the row was for.
    expect(r.rows[0].locals.recipientName).toBe('Rec');
    expect(r.rows[0].locals.adminName).toBe('Op');
  });

  it('does not claim rows with send_after in the future', async () => {
    const key = `${tag}-future`;
    await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('f'),
      template: 'generic-admin-message',
      locals: baseLocals,
    });
    await sql`
      UPDATE email_outbox SET send_after = now() + INTERVAL '1 hour'
       WHERE idempotency_key = ${key}
    `.execute(db);

    const mailer = { send: vi.fn(async () => ({ ok: true })) };
    const result = await tickOnce({ db, mailer, log: silentLog });

    expect(mailer.send).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);

    const r = await sql`SELECT status FROM email_outbox WHERE idempotency_key = ${key}`.execute(db);
    expect(r.rows[0].status).toBe('queued');
  });

  it('startWorker returns a stop function that clears the interval', () => {
    const fakeMailer = { send: vi.fn() };
    const stop = startWorker({ db, mailer: fakeMailer, log: silentLog, intervalMs: 60_000 });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('startWorker fires tickOnce on each interval and recovers from a thrown error', async () => {
    // Enqueue one row so the interval callback actually does work.
    const key = `${tag}-iv`;
    await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('iv'),
      template: 'generic-admin-message',
      locals: baseLocals,
    });

    const errors = [];
    const log = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: (obj, msg) => { errors.push({ obj, msg }); },
    };

    // Fake DB whose .transaction().execute() throws on the first call (covers
    // the catch branch in startWorker), then defers to the real db on the
    // second call (covers the happy path).
    let calls = 0;
    const flakyDb = {
      transaction: () => ({
        execute: async (fn) => {
          calls++;
          if (calls === 1) throw new Error('forced tick failure');
          return await db.transaction().execute(fn);
        },
      }),
    };
    const mailer = { send: vi.fn(async () => ({ ok: true, providerId: 'p' })) };

    vi.useFakeTimers();
    try {
      const stop = startWorker({ db: flakyDb, mailer, log, intervalMs: 1000 });
      try {
        // Trigger first tick → throws → caught by startWorker → log.error.
        await vi.advanceTimersByTimeAsync(1000);
        // Trigger second tick → real db → row is sent.
        await vi.advanceTimersByTimeAsync(1000);
      } finally {
        stop();
      }
    } finally {
      vi.useRealTimers();
    }

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].msg).toBe('outbox.tick_error');
    expect(errors[0].obj.err.message).toBe('forced tick failure');

    const r = await sql`SELECT status FROM email_outbox WHERE idempotency_key = ${key}`.execute(db);
    expect(r.rows[0].status).toBe('sent');
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it('enqueue is idempotent on the same idempotency_key (ON CONFLICT DO NOTHING)', async () => {
    const key = `${tag}-idem`;
    const id1 = await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('i'),
      template: 'generic-admin-message',
      locals: baseLocals,
    });
    const id2 = await enqueue(db, {
      idempotencyKey: key,
      toAddress: tagAddr('i'),
      template: 'generic-admin-message',
      locals: baseLocals,
    });
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
    expect(id2).toBeNull();
    const r = await sql`SELECT count(*)::int AS c FROM email_outbox WHERE idempotency_key = ${key}`.execute(db);
    expect(r.rows[0].c).toBe(1);
  });
});
