import argon2 from 'argon2';
import { createHash } from 'node:crypto';

const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password) {
  return argon2.hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function sha1Hex(input) {
  return createHash('sha1').update(input).digest('hex');
}

export async function hibpHasBeenPwned(password, fetchImpl = fetch) {
  const sha = sha1Hex(password).toUpperCase();
  const prefix = sha.slice(0, 5);
  const suffix = sha.slice(5);
  const r = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { 'Add-Padding': 'true' },
  });
  const text = await r.text();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [hashSuffix] = line.split(':');
    if (hashSuffix && hashSuffix === suffix) return true;
  }
  return false;
}
