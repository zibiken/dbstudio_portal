import { describe, it, expect } from 'vitest';
import {
  generateSecret,
  generateToken,
  verify,
  keyuri,
} from '../../../lib/auth/totp.js';

const REF_EPOCH = 1_777_400_000; // fixed reference; 2026-04-28 16:53:20 UTC

describe('totp', () => {
  it('generateSecret returns a base32 string of recommended length', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThanOrEqual(16);
  });

  it('generateSecret produces a fresh secret each call', () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });

  it('verifies a token generated for the same epoch', () => {
    const secret = generateSecret();
    const token = generateToken(secret, { epoch: REF_EPOCH });
    expect(verify(secret, token, { epoch: REF_EPOCH })).toBe(true);
  });

  it('verifies a token from one window in the past (-30s)', () => {
    const secret = generateSecret();
    const token = generateToken(secret, { epoch: REF_EPOCH - 30 });
    expect(verify(secret, token, { epoch: REF_EPOCH })).toBe(true);
  });

  it('verifies a token from one window in the future (+30s)', () => {
    const secret = generateSecret();
    const token = generateToken(secret, { epoch: REF_EPOCH + 30 });
    expect(verify(secret, token, { epoch: REF_EPOCH })).toBe(true);
  });

  it('rejects a token from two windows in the past (-60s)', () => {
    const secret = generateSecret();
    const token = generateToken(secret, { epoch: REF_EPOCH - 60 });
    expect(verify(secret, token, { epoch: REF_EPOCH })).toBe(false);
  });

  it('rejects a token from two windows in the future (+60s)', () => {
    const secret = generateSecret();
    const token = generateToken(secret, { epoch: REF_EPOCH + 60 });
    expect(verify(secret, token, { epoch: REF_EPOCH })).toBe(false);
  });

  it('rejects a wrong token', () => {
    const secret = generateSecret();
    expect(verify(secret, '000000', { epoch: REF_EPOCH })).toBe(false);
  });

  it('rejects a malformed token (non-numeric)', () => {
    const secret = generateSecret();
    expect(verify(secret, 'abcdef', { epoch: REF_EPOCH })).toBe(false);
  });

  it('rejects a malformed token (wrong length)', () => {
    const secret = generateSecret();
    expect(verify(secret, '123', { epoch: REF_EPOCH })).toBe(false);
  });

  it('verify and generate use Date.now() when epoch is omitted', () => {
    const secret = generateSecret();
    const token = generateToken(secret);
    expect(verify(secret, token)).toBe(true);
  });

  it('keyuri returns an otpauth:// url with issuer and label', () => {
    const u = keyuri('admin@example.com', 'DB Studio Portal', generateSecret());
    expect(u.startsWith('otpauth://totp/')).toBe(true);
    expect(u).toContain('issuer=DB%20Studio%20Portal');
    expect(u).toContain('admin%40example.com');
  });
});
