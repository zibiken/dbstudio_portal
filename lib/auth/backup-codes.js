import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../crypto/hash.js';

export const NUM_CODES = 8;
const HALF_LEN = 5;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no I/O/0/1

function genCode() {
  const buf = randomBytes(HALF_LEN * 2);
  let s = '';
  for (let i = 0; i < buf.length; i++) s += ALPHABET[buf[i] & 0x1f];
  return s.slice(0, HALF_LEN) + '-' + s.slice(HALF_LEN);
}

export async function generateBackupCodes() {
  const codes = [];
  while (codes.length < NUM_CODES) {
    const c = genCode();
    if (!codes.includes(c)) codes.push(c);
  }
  const stored = await Promise.all(
    codes.map(async (c) => ({ hash: await hashPassword(c), consumed_at: null })),
  );
  return { codes, stored };
}

export async function verifyAndConsume(stored, plaintext) {
  for (let i = 0; i < stored.length; i++) {
    if (stored[i].consumed_at) continue;
    if (await verifyPassword(stored[i].hash, plaintext)) {
      const updated = stored.map((s, j) =>
        j === i ? { ...s, consumed_at: new Date().toISOString() } : s,
      );
      return { ok: true, stored: updated };
    }
  }
  return { ok: false, stored };
}
