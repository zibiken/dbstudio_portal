import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  sha1Hex,
  hibpHasBeenPwned,
  SENTINEL_HASH,
} from '../../../lib/crypto/hash.js';

describe('hash', () => {
  describe('argon2id', () => {
    it('verifies the correct password', async () => {
      const h = await hashPassword('correct horse battery staple');
      expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    });

    it('rejects the wrong password', async () => {
      const h = await hashPassword('correct horse battery staple');
      expect(await verifyPassword(h, 'wrong')).toBe(false);
    });

    it('returns false (not throw) when given garbage hash', async () => {
      expect(await verifyPassword('not-an-argon2-hash', 'anything')).toBe(false);
    });

    it('produces a hash starting with $argon2id$', async () => {
      const h = await hashPassword('hello');
      expect(h.startsWith('$argon2id$')).toBe(true);
    });

    it('SENTINEL_HASH does not verify any plausible password (constant-time guard)', async () => {
      expect(await verifyPassword(SENTINEL_HASH, '')).toBe(false);
      expect(await verifyPassword(SENTINEL_HASH, 'password')).toBe(false);
      expect(await verifyPassword(SENTINEL_HASH, 'correct horse battery staple')).toBe(false);
    });
  });

  describe('sha1Hex', () => {
    it('returns 40-char lowercase hex', () => {
      const s = sha1Hex('password');
      expect(s).toMatch(/^[a-f0-9]{40}$/);
    });

    it('matches the known SHA-1 of "password"', () => {
      // Well-known: SHA-1("password") = 5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8
      expect(sha1Hex('password')).toBe('5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8');
    });
  });

  describe('hibpHasBeenPwned', () => {
    // SHA-1("password") = 5BAA6 + 1E4C9B93F3F0682250B6CF8331B7EE68FD8
    const PREFIX = '5BAA6';
    const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

    function fakeFetch(body) {
      return async (url) => {
        expect(url).toBe(`https://api.pwnedpasswords.com/range/${PREFIX}`);
        return { text: async () => body };
      };
    }

    it('returns true when the suffix is in the response', async () => {
      const body = `0000000000000000000000000000000000A:5\r\n${SUFFIX}:9999\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1`;
      expect(await hibpHasBeenPwned('password', fakeFetch(body))).toBe(true);
    });

    it('returns false when the suffix is not in the response', async () => {
      const body = `0000000000000000000000000000000000A:5\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1`;
      expect(await hibpHasBeenPwned('password', fakeFetch(body))).toBe(false);
    });

    it('returns false on empty response', async () => {
      expect(await hibpHasBeenPwned('password', fakeFetch(''))).toBe(false);
    });

    it('sends Add-Padding header', async () => {
      let seenHeaders;
      const fetchImpl = async (_url, opts) => {
        seenHeaders = opts?.headers;
        return { text: async () => '' };
      };
      await hibpHasBeenPwned('password', fetchImpl);
      expect(seenHeaders?.['Add-Padding']).toBe('true');
    });
  });
});
