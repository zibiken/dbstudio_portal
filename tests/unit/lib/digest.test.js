import { describe, it, expect, vi } from 'vitest';
import { recordForDigest, COALESCING_EVENTS } from '../../../lib/digest.js';

describe('recordForDigest', () => {
  const FIXED_NOW = new Date('2026-05-01T10:00:00Z');

  it('inserts a fresh item + upserts schedule when no coalescable row exists', async () => {
    const repo = {
      findCoalescable: vi.fn().mockResolvedValue(null),
      insertItem:      vi.fn().mockResolvedValue('id-1'),
      updateCoalesced: vi.fn(),
      upsertSchedule:  vi.fn(),
    };
    const result = await recordForDigest({}, {
      recipientType: 'customer_user',
      recipientId:   '11111111-1111-1111-1111-111111111111',
      bucket:        'fyi',
      eventType:     'invoice.uploaded',
      title:         'New invoice INV-001',
    }, { repo, now: FIXED_NOW });
    expect(repo.insertItem).toHaveBeenCalledOnce();
    expect(repo.updateCoalesced).not.toHaveBeenCalled();
    expect(repo.upsertSchedule).toHaveBeenCalledOnce();
    const upsertArg = repo.upsertSchedule.mock.calls[0][1];
    expect(upsertArg).toMatchObject({
      recipientType: 'customer_user',
      recipientId:   '11111111-1111-1111-1111-111111111111',
    });
    expect(upsertArg.dueAt).toBeInstanceOf(Date);
    expect(upsertArg.windowMinutes).toBeUndefined();
    expect(upsertArg.capMinutes).toBeUndefined();
    expect(result.coalesced).toBe(false);
  });

  it('coalesces when event is in COALESCING_EVENTS and a row exists', async () => {
    expect(COALESCING_EVENTS.has('document.uploaded')).toBe(true);
    const repo = {
      findCoalescable: vi.fn().mockResolvedValue({ id: 'old', title: 'New document: a.pdf', detail: null, metadata: { count: 1 } }),
      insertItem:      vi.fn(),
      updateCoalesced: vi.fn(),
      upsertSchedule:  vi.fn(),
    };
    await recordForDigest({}, {
      recipientType: 'customer_user',
      recipientId:   '11111111-1111-1111-1111-111111111111',
      bucket:        'fyi',
      eventType:     'document.uploaded',
      title:         'New document: b.pdf',
    }, { repo, now: FIXED_NOW });
    expect(repo.insertItem).not.toHaveBeenCalled();
    expect(repo.updateCoalesced).toHaveBeenCalledOnce();
    const arg = repo.updateCoalesced.mock.calls[0][1];
    expect(arg.metadata.count).toBe(2);
    expect(arg.title).toBe('2 new documents');
  });

  it('does NOT coalesce events outside COALESCING_EVENTS even if a row exists', async () => {
    const repo = {
      findCoalescable: vi.fn().mockResolvedValue({ id: 'old', title: 't', detail: null, metadata: {} }),
      insertItem:      vi.fn().mockResolvedValue('id-2'),
      updateCoalesced: vi.fn(),
      upsertSchedule:  vi.fn(),
    };
    await recordForDigest({}, {
      recipientType: 'admin',
      recipientId:   '22222222-2222-2222-2222-222222222222',
      bucket:        'action_required',
      eventType:     'nda.created',
      title:         'New NDA',
    }, { repo, now: FIXED_NOW });
    expect(repo.insertItem).toHaveBeenCalledOnce();
    expect(repo.updateCoalesced).not.toHaveBeenCalled();
  });

  it('passes the next digest fire (Date) as dueAt to upsertSchedule', async () => {
    const repo = {
      findCoalescable: vi.fn().mockResolvedValue(null),
      insertItem:      vi.fn().mockResolvedValue('id-3'),
      updateCoalesced: vi.fn(),
      upsertSchedule:  vi.fn(),
    };
    // 10:00 UTC == 11:00 WEST on 2026-05-01 -> next fire 17:00 WEST (16:00 UTC)
    await recordForDigest({}, {
      recipientType: 'admin',
      recipientId:   '33333333-3333-3333-3333-333333333333',
      bucket:        'fyi',
      eventType:     'invoice.uploaded',
      title:         'New invoice',
    }, { repo, now: new Date('2026-05-01T10:00:00Z') });
    const due = repo.upsertSchedule.mock.calls[0][1].dueAt;
    expect(due.toISOString()).toBe('2026-05-01T16:00:00.000Z');
  });
});
