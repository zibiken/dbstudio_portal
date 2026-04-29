import { renderTemplate } from '../../lib/email-templates.js';
import { claim, markFailed, markSent } from './repo.js';

const DEFAULT_TICK_MS = 5_000;

export async function tickOnce({ db, mailer, log, batchSize = 10 }) {
  return await db.transaction().execute(async (tx) => {
    const claimed = await claim(tx, { batchSize });
    if (claimed.length === 0) return { claimed: 0, sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    for (const row of claimed) {
      try {
        const { subject, body } = renderTemplate(
          row.template,
          row.locale ?? 'en',
          row.locals ?? {},
        );
        const result = await mailer.send({
          to: row.to_address,
          subject,
          html: body,
          idempotencyKey: row.idempotency_key,
        });
        log?.info?.(
          { outboxId: row.id, providerId: result?.providerId ?? null },
          'outbox.sent',
        );
        await markSent(tx, { id: row.id });
        sent++;
      } catch (e) {
        log?.warn?.(
          {
            outboxId: row.id,
            err: { message: e?.message, retryable: !!e?.retryable, status: e?.status },
          },
          'outbox.send_failed',
        );
        await markFailed(tx, {
          id: row.id,
          retryable: !!e?.retryable,
          attempts: Number(row.attempts),
          errorMessage: String(e?.message ?? 'unknown'),
        });
        failed++;
      }
    }
    return { claimed: claimed.length, sent, failed };
  });
}

export function startWorker(deps) {
  const intervalMs = deps.intervalMs ?? DEFAULT_TICK_MS;
  const interval = setInterval(() => {
    tickOnce(deps).catch((e) => {
      deps.log?.error?.({ err: { message: e?.message, stack: e?.stack } }, 'outbox.tick_error');
    });
  }, intervalMs);
  if (typeof interval.unref === 'function') interval.unref();
  return () => clearInterval(interval);
}
