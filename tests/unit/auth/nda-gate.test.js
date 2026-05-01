import { describe, it, expect, vi } from 'vitest';
import { requireNdaSigned } from '../../../lib/auth/middleware.js';

function fakeReq(url) {
  return { raw: { url }, url };
}
function fakeReply() {
  const code = vi.fn().mockReturnThis();
  const send = vi.fn().mockReturnThis();
  const redirect = vi.fn().mockReturnThis();
  return { code, send, redirect };
}

describe('requireNdaSigned', () => {
  it('returns true when session.nda_signed_at is set', () => {
    const req = fakeReq('/customer/dashboard');
    const reply = fakeReply();
    const ok = requireNdaSigned(req, reply, { nda_signed_at: new Date() });
    expect(ok).toBe(true);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.redirect).not.toHaveBeenCalled();
  });

  it('redirects HTML pages to /customer/waiting when gated', () => {
    const req = fakeReq('/customer/dashboard');
    const reply = fakeReply();
    const ok = requireNdaSigned(req, reply, { nda_signed_at: null });
    expect(ok).toBe(false);
    expect(reply.redirect).toHaveBeenCalledWith('/customer/waiting', 302);
  });

  it('returns 403 nda_required for /api/* routes when gated', () => {
    const req = fakeReq('/api/customer/credentials');
    const reply = fakeReply();
    const ok = requireNdaSigned(req, reply, { nda_signed_at: null });
    expect(ok).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'nda_required' });
  });

  it('redirects (not 403s) when path has query string', () => {
    const req = fakeReq('/customer/dashboard?ref=email');
    const reply = fakeReply();
    requireNdaSigned(req, reply, { nda_signed_at: null });
    expect(reply.redirect).toHaveBeenCalledWith('/customer/waiting', 302);
  });

  it('null session is treated as gated', () => {
    const req = fakeReq('/customer/dashboard');
    const reply = fakeReply();
    const ok = requireNdaSigned(req, reply, null);
    expect(ok).toBe(false);
    expect(reply.redirect).toHaveBeenCalled();
  });
});
