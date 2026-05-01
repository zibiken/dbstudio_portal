// Phase B digest worker.
//
// Polls digest_schedules every 60s. For each row with due_at <= now(),
// claims it (FOR UPDATE SKIP LOCKED), drains the recipient's pending
// items, and either:
//   - enqueues a single 'digest' email into email_outbox (the existing
//     outbox worker takes it from there — same retry, idempotency, and
//     dev-hold paths as every other email)
//   - if the items list is empty (all retracted before fire), drops the
//     email entirely and deletes the schedule row.
//
// Locale comes from the recipient row at fire time, so a locale change
// between event-emit and digest-fire takes effect for the email subject
// and template.

import { sql } from 'kysely';
import * as repo from './repo.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
import { digestSubject } from '../../lib/digest-strings.js';

const DEFAULT_TICK_MS = 60_000;

async function loadRecipient(tx, { recipient_type, recipient_id }) {
  if (recipient_type === 'customer_user') {
    // customer_users has no status column; activeness is the parent
    // customer's status. Suspended/archived customers' users still get
    // their pending items drained (via the empty-drop path) but no email
    // is emitted because we filter on customers.status = 'active' here.
    const r = await sql`
      SELECT cu.id::text AS id, cu.name, cu.email, cu.locale
        FROM customer_users cu
        JOIN customers c ON c.id = cu.customer_id
       WHERE cu.id = ${recipient_id}::uuid AND c.status = 'active'
    `.execute(tx);
    return r.rows[0] ?? null;
  }
  const r = await sql`
    SELECT id::text AS id, name, email, locale
      FROM admins
     WHERE id = ${recipient_id}::uuid
  `.execute(tx);
  return r.rows[0] ?? null;
}

function groupBuckets(items) {
  const action = items.filter((i) => i.bucket === 'action_required');
  const fyi    = items.filter((i) => i.bucket === 'fyi');
  return { action, fyi };
}

export async function tickOnce({ db, log, batchSize = 25, now = new Date() }) {
  return await db.transaction().execute(async (tx) => {
    const claims = await repo.claimDue(tx, { batchSize, now });
    if (claims.length === 0) return { claimed: 0, fired: 0, dropped: 0 };

    let fired = 0, dropped = 0;
    for (const claim of claims) {
      const recipient = await loadRecipient(tx, claim);
      const items = await repo.drainItems(tx, {
        recipientType: claim.recipient_type,
        recipientId:   claim.recipient_id,
      });
      if (!recipient || items.length === 0) {
        await repo.clearSchedule(tx, {
          recipientType: claim.recipient_type,
          recipientId:   claim.recipient_id,
        });
        dropped++;
        continue;
      }
      const buckets = groupBuckets(items);
      // Phase F: subject is dynamic per recipient based on bucket counts.
      const subject = digestSubject(recipient.locale ?? 'en', {
        actionCount: buckets.action.length,
        fyiCount:    buckets.fyi.length,
      });
      const idempotencyKey = `digest:${claim.recipient_type}:${claim.recipient_id}:${new Date().toISOString()}`;
      await enqueueEmail(tx, {
        idempotencyKey,
        toAddress: recipient.email,
        template: 'digest',
        locale: recipient.locale ?? 'en',
        locals: {
          recipientName: recipient.name,
          isAdmin: claim.recipient_type === 'admin',
          actionItems: buckets.action,
          fyiItems:    buckets.fyi,
        },
        subjectOverride: subject,
      });
      await repo.clearSchedule(tx, {
        recipientType: claim.recipient_type,
        recipientId:   claim.recipient_id,
      });
      fired++;
    }
    log?.info?.({ claimed: claims.length, fired, dropped }, 'digest.tick');
    return { claimed: claims.length, fired, dropped };
  });
}

export function startWorker(deps) {
  const intervalMs = deps.intervalMs ?? DEFAULT_TICK_MS;
  const interval = setInterval(() => {
    tickOnce(deps).catch((e) => {
      deps.log?.error?.({ err: { message: e?.message, stack: e?.stack } }, 'digest.tick_error');
    });
  }, intervalMs);
  if (typeof interval.unref === 'function') interval.unref();
  return () => clearInterval(interval);
}
