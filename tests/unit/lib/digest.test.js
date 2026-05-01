import { describe, it, expect, vi } from 'vitest';
import { recordForDigest, COALESCING_EVENTS } from '../../../lib/digest.js';

describe('recordForDigest', () => {
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
    }, { repo });
    expect(repo.insertItem).toHaveBeenCalledOnce();
    expect(repo.updateCoalesced).not.toHaveBeenCalled();
    expect(repo.upsertSchedule).toHaveBeenCalledOnce();
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
    }, { repo });
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
    }, { repo });
    expect(repo.insertItem).toHaveBeenCalledOnce();
    expect(repo.updateCoalesced).not.toHaveBeenCalled();
  });
});
