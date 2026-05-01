// Phase B: domain-side helper that records a digestable event.
//
// The shape: caller passes in (tx, item, opts). The helper either inserts
// a fresh pending_digest_items row or — for events in COALESCING_EVENTS
// where a matching row already exists for the recipient — updates the
// existing row's title and metadata.count instead. After either path,
// it upserts the recipient's digest_schedules row so the debounce timer
// slides forward.
//
// The default 10-min sliding window with a 60-min hard cap means a
// digest fires no later than 60 min after the first pending item, even
// if events keep arriving.

import * as defaultRepo from '../domain/digest/repo.js';

export const COALESCING_EVENTS = new Set([
  'document.uploaded',
  'document.downloaded',
  'credential.viewed',
  'credential.created',
]);

function pluraliseTitle(eventType, oldTitle, count) {
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
  const windowMinutes = opts.windowMinutes ?? 10;
  const capMinutes    = opts.capMinutes    ?? 60;

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
      await repo.updateCoalesced(tx, {
        id: existing.id,
        title: pluraliseTitle(item.eventType, existing.title, nextCount),
        detail: existing.detail,
        metadata: { ...(existing.metadata ?? {}), count: nextCount },
      });
      await repo.upsertSchedule(tx, {
        recipientType: item.recipientType,
        recipientId:   item.recipientId,
        windowMinutes, capMinutes,
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
    metadata:      { count: 1, ...(item.metadata ?? {}) },
  });
  await repo.upsertSchedule(tx, {
    recipientType: item.recipientType,
    recipientId:   item.recipientId,
    windowMinutes, capMinutes,
  });
  return { coalesced: false, id };
}
