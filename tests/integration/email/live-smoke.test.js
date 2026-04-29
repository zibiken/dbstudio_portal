import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { makeMailer } from '../../../lib/email.js';
import { enqueue } from '../../../domain/email-outbox/repo.js';
import { tickOnce } from '../../../domain/email-outbox/worker.js';

const skip = !process.env.RUN_LIVE_EMAIL;

const log = {
  info: (obj, msg) => console.log('[info]', msg, JSON.stringify(obj)),
  warn: (obj, msg) => console.warn('[warn]', msg, JSON.stringify(obj)),
  error: (obj, msg) => console.error('[error]', msg, JSON.stringify(obj)),
  debug: () => {},
};

describe.skipIf(skip)('email/live-smoke (RUN_LIVE_EMAIL=1)', () => {
  let db;
  let mailer;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the live smoke');
    if (!process.env.MAILERSEND_API_KEY) throw new Error('MAILERSEND_API_KEY is required for the live smoke');
    if (!process.env.MAILERSEND_FROM_EMAIL) throw new Error('MAILERSEND_FROM_EMAIL is required for the live smoke');
    db = createDb({ connectionString: process.env.DATABASE_URL });
    mailer = makeMailer({
      apiKey: process.env.MAILERSEND_API_KEY,
      fromEmail: process.env.MAILERSEND_FROM_EMAIL,
      fromName: process.env.MAILERSEND_FROM_NAME ?? 'DB Studio Portal',
    });
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  it(
    'end-to-end: enqueue → worker → MailerSend → status=sent (operator confirms inbox)',
    async () => {
      const idempotencyKey = `live-smoke:${Date.now()}`;
      const toAddress = 'bram@roxiplus.es';

      const id = await enqueue(db, {
        idempotencyKey,
        toAddress,
        template: 'generic-admin-message',
        locals: {
          adminName: 'Portal smoke test',
          recipientName: 'Operator',
          message: `Live-smoke run at ${new Date().toISOString()}. If you can read this in your inbox, the M4 pipeline is wired end-to-end.`,
          portalUrl: 'https://portal.dbstudio.one/',
        },
      });
      console.log('[live-smoke] enqueued', { id, idempotencyKey, toAddress });

      const result = await tickOnce({ db, mailer, log, batchSize: 1 });
      console.log('[live-smoke] tickOnce result', result);
      expect(result.claimed).toBeGreaterThanOrEqual(1);

      const r = await sql`
        SELECT status, sent_at, last_error, attempts
          FROM email_outbox WHERE idempotency_key = ${idempotencyKey}
      `.execute(db);
      console.log('[live-smoke] row state', r.rows[0]);

      expect(r.rows[0].status).toBe('sent');
      expect(r.rows[0].sent_at).not.toBeNull();
      expect(r.rows[0].last_error).toBeNull();
      expect(Number(r.rows[0].attempts)).toBe(1);

      console.log(
        '[live-smoke] OK — operator: confirm inbox arrival at',
        toAddress,
        'and that DKIM/SPF pass.',
      );
    },
    30_000,
  );
});
