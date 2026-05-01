// Phase B (cadence reworked in Phase F): domain-side helper that records
// a digestable event. The helper either inserts a fresh
// pending_digest_items row or — for events in COALESCING_EVENTS where a
// matching row already exists for the recipient — updates the existing
// row's title and metadata.count instead. After either path, it upserts
// the recipient's digest_schedules.due_at to the next configured fire
// slot (08:00 / 17:00 Atlantic/Canary).

import * as defaultRepo from '../domain/digest/repo.js';
import { nextDigestFire } from './digest-cadence.js';
import { titleFor } from './digest-strings.js';

export const COALESCING_EVENTS = new Set([
  'document.uploaded',
  'document.downloaded',
  'credential.viewed',
  'credential.created',
]);

function pluraliseTitle(eventType, oldTitle, count, vars, locale) {
  // Phase F: when callers pass vars + locale (stored on the row's metadata),
  // re-render via titleFor so plural strings stay in sync with singular.
  // Otherwise fall back to the Phase B hardcoded plurals (legacy callers).
  if (vars && locale) {
    return titleFor(eventType, locale, { ...vars, count });
  }
  const map = {
    'document.uploaded':   () => `${count} new documents`,
    'document.downloaded': () => `${count} document downloads`,
    'credential.viewed':   () => `DB Studio viewed ${count} credentials`,
    'credential.created':  () => `${count} new credentials`,
  };
  const fn = map[eventType];
  return fn ? fn() : `${oldTitle} (+${count - 1} more)`;
}

export async function recordForDigest(tx, item, opts = {}) {
  const repo = opts.repo ?? defaultRepo;
  const now = opts.now ?? new Date();
  const dueAt = nextDigestFire(now);

  if (COALESCING_EVENTS.has(item.eventType)) {
    const existing = await repo.findCoalescable(tx, {
      recipientType: item.recipientType,
      recipientId:   item.recipientId,
      eventType:     item.eventType,
      customerId:    item.customerId ?? null,
    });
    if (existing) {
      const prevCount = Number(existing.metadata?.count ?? 1);
      const nextCount = prevCount + 1;
      // Prefer caller's fresh vars/locale (this insert) over the existing
      // row's stored copy — vars rarely change but if they do, we honour
      // the most recent. Both paths fall through to titleFor when present.
      const renderVars  = item.vars   ?? existing.metadata?.vars;
      const renderLocale = item.locale ?? existing.metadata?.locale;
      await repo.updateCoalesced(tx, {
        id: existing.id,
        title: pluraliseTitle(item.eventType, existing.title, nextCount, renderVars, renderLocale),
        detail: existing.detail,
        metadata: {
          ...(existing.metadata ?? {}),
          count: nextCount,
          ...(renderVars ? { vars: renderVars } : {}),
          ...(renderLocale ? { locale: renderLocale } : {}),
        },
      });
      await repo.upsertSchedule(tx, {
        recipientType: item.recipientType,
        recipientId:   item.recipientId,
        dueAt,
      });
      return { coalesced: true, id: existing.id };
    }
  }

  const id = await repo.insertItem(tx, {
    recipientType: item.recipientType,
    recipientId:   item.recipientId,
    customerId:    item.customerId ?? null,
    bucket:        item.bucket,
    eventType:     item.eventType,
    title:         item.title,
    detail:        item.detail ?? null,
    linkPath:      item.linkPath ?? null,
    metadata:      {
      count: 1,
      ...(item.metadata ?? {}),
      ...(item.vars   ? { vars:   item.vars }   : {}),
      ...(item.locale ? { locale: item.locale } : {}),
    },
  });
  await repo.upsertSchedule(tx, {
    recipientType: item.recipientType,
    recipientId:   item.recipientId,
    dueAt,
  });
  return { coalesced: false, id };
}
