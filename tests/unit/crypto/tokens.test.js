import { describe, it, expect } from 'vitest';
import {
  sign,
  verify,
  signFileUrl,
  verifyFileUrl,
} from '../../../lib/crypto/tokens.js';

describe('tokens', () => {
  const secret = 'a'.repeat(64);

  describe('sign / verify', () => {
    it('round-trips a payload', () => {
      const t = sign({ id: 42 }, secret);
      const out = verify(t, secret);
      expect(out).toMatchObject({ id: 42 });
      expect(typeof out.exp).toBe('number');
    });

    it('rejects an expired token', () => {
      const t = sign({ id: 1 }, secret, { expSeconds: -1 });
      expect(() => verify(t, secret)).toThrow(/expired/);
    });

    it('rejects a tampered MAC', () => {
      const t = sign({ id: 1 }, secret);
      const bad = t.slice(0, -2) + 'xx';
      expect(() => verify(bad, secret)).toThrow();
    });

    it('rejects a tampered payload (signature no longer matches)', () => {
      const t = sign({ id: 1 }, secret);
      const [_part, mac] = t.split('.');
      const evilPart = Buffer.from(JSON.stringify({ id: 999, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
      const forged = `${evilPart}.${mac}`;
      expect(() => verify(forged, secret)).toThrow();
    });

    it('rejects a token signed with a different secret', () => {
      const t = sign({ id: 1 }, secret);
      expect(() => verify(t, 'b'.repeat(64))).toThrow();
    });

    it('rejects a malformed token (no dot)', () => {
      expect(() => verify('not-a-token', secret)).toThrow();
    });
  });

  describe('signFileUrl / verifyFileUrl', () => {
    it('produces a 60-second TTL file token verifiable round-trip', () => {
      const t = signFileUrl({ fileId: 'abc' }, secret);
      const out = verifyFileUrl(t, secret);
      expect(out.fileId).toBe('abc');
      expect(out.kind).toBe('file');
      // TTL: exp should be roughly now+60s
      const drift = out.exp - Math.floor(Date.now() / 1000);
      expect(drift).toBeGreaterThan(50);
      expect(drift).toBeLessThanOrEqual(60);
    });

    it('rejects a generic token (kind != file) on verifyFileUrl', () => {
      const generic = sign({ fileId: 'abc' }, secret);
      expect(() => verifyFileUrl(generic, secret)).toThrow(/kind/);
    });
  });
});
