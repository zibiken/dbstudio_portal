import { describe, it, expect, vi } from 'vitest';
import {
  sessionCookieOptions,
  setSessionCookie,
  clearSessionCookie,
  readSession,
  SESSION_COOKIE_NAME,
} from '../../../lib/auth/middleware.js';

describe('auth/middleware', () => {
  describe('sessionCookieOptions', () => {
    it('marks the cookie secure only in production', () => {
      expect(sessionCookieOptions({ NODE_ENV: 'production' })).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax', signed: true });
      expect(sessionCookieOptions({ NODE_ENV: 'development' })).toMatchObject({ secure: false });
      expect(sessionCookieOptions({ NODE_ENV: 'test' })).toMatchObject({ secure: false });
    });
  });

  describe('setSessionCookie / clearSessionCookie', () => {
    it('uses the sid cookie name and the env-aware options', () => {
      const reply = { setCookie: vi.fn(), clearCookie: vi.fn() };
      setSessionCookie(reply, 'abc123', { NODE_ENV: 'production' });
      expect(reply.setCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, 'abc123', expect.objectContaining({ secure: true, signed: true }));

      clearSessionCookie(reply, { NODE_ENV: 'production' });
      expect(reply.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, expect.objectContaining({ secure: true }));
    });
  });

  describe('readSession', () => {
    const app = { db: {} };

    it('returns null when no sid cookie is present', async () => {
      const req = { cookies: {} };
      expect(await readSession(app, req)).toBeNull();
    });

    it('returns null when the cookie is present but unsignCookie says invalid', async () => {
      const req = {
        cookies: { [SESSION_COOKIE_NAME]: 'tampered' },
        unsignCookie: vi.fn(() => ({ valid: false, value: null })),
      };
      expect(await readSession(app, req)).toBeNull();
      expect(req.unsignCookie).toHaveBeenCalledWith('tampered');
    });
  });
});
