import argon2 from 'argon2';
import { createHash } from 'node:crypto';

const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

// Pre-computed argon2id hash of an unguessable random string. Used by
// verifyPassword to do a fixed-cost comparison when the caller has no
// real hash to verify against, so a missing-user / missing-password
// branch takes the same wall-clock time as a real verify and does not
// leak existence via timing.
export const SENTINEL_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$VW7Cqw5fdCemai1mHc4Y7A$214EYZ9W1on3D8yllrlJ/Sp+M8ie+tFTXCtXv+qjIws';

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
