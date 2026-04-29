import { describe, it, expect } from 'vitest';
import {
  generateBackupCodes,
  verifyAndConsume,
  NUM_CODES,
} from '../../../lib/auth/backup-codes.js';

describe('backup-codes', () => {
  it('generates 8 codes by default', async () => {
    const { codes, stored } = await generateBackupCodes();
    expect(codes).toHaveLength(NUM_CODES);
    expect(NUM_CODES).toBe(8);
    expect(stored).toHaveLength(NUM_CODES);
  });

  it('codes are formatted as two 5-char halves with a single dash', async () => {
    const { codes } = await generateBackupCodes();
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    }
  });

  it('codes are unique across the set', async () => {
    const { codes } = await generateBackupCodes();
    expect(new Set(codes).size).toBe(NUM_CODES);
  });

  it('stored entries hold an argon2id hash and a null consumed_at', async () => {
    const { stored } = await generateBackupCodes();
    for (const s of stored) {
      expect(s.hash.startsWith('$argon2id$')).toBe(true);
      expect(s.consumed_at).toBeNull();
    }
  });

  it('verifyAndConsume returns ok and marks consumed_at on first use', async () => {
    const { codes, stored } = await generateBackupCodes();
    const r = await verifyAndConsume(stored, codes[0]);
    expect(r.ok).toBe(true);
    expect(r.stored[0].consumed_at).toBeTruthy();
    // Other codes untouched
    expect(r.stored[1].consumed_at).toBeNull();
  });

  it('rejects re-use of an already-consumed code', async () => {
    const { codes, stored } = await generateBackupCodes();
    const after = await verifyAndConsume(stored, codes[0]);
    const second = await verifyAndConsume(after.stored, codes[0]);
    expect(second.ok).toBe(false);
    expect(second.stored).toEqual(after.stored);
  });

  it('rejects an unknown code', async () => {
    const { stored } = await generateBackupCodes();
    const r = await verifyAndConsume(stored, 'XXXXX-XXXXX');
    expect(r.ok).toBe(false);
    expect(r.stored).toEqual(stored);
  });

  it('does not mutate the input stored array', async () => {
    const { codes, stored } = await generateBackupCodes();
    const before = JSON.parse(JSON.stringify(stored));
    await verifyAndConsume(stored, codes[3]);
    expect(stored).toEqual(before);
  });

  it('regenerate (re-call generateBackupCodes) yields fresh codes that the old hashes do not verify', async () => {
    const a = await generateBackupCodes();
    const b = await generateBackupCodes();
    // Old plaintexts should not validate against new hashes.
    const r = await verifyAndConsume(b.stored, a.codes[0]);
    expect(r.ok).toBe(false);
  });
});
