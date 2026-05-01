import { describe, it, expect, vi } from 'vitest';
import { makeMailer } from '../../../lib/email.js';

describe('makeMailer dev hold', () => {
  it('does NOT call fetch when devHold=true', async () => {
    const fetch = vi.fn();
    const log = { info: vi.fn() };
    const m = makeMailer({ apiKey: 'k', fromEmail: 'a@b', fromName: 'X', fetch, devHold: true, log });
    const r = await m.send({ to: 't@x', subject: 's', html: '<p/>', idempotencyKey: 'k1' });
    expect(r.ok).toBe(true);
    expect(r.held).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('calls fetch when devHold=false (default)', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 202, headers: { get: () => 'mid' } });
    const m = makeMailer({ apiKey: 'k', fromEmail: 'a@b', fromName: 'X', fetch });
    const r = await m.send({ to: 't@x', subject: 's', html: '<p/>', idempotencyKey: 'k1' });
    expect(r.ok).toBe(true);
    expect(r.held).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
