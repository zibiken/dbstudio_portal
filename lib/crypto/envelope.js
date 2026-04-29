import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;

export function generateDek() {
  return randomBytes(DEK_LEN);
}

export function encrypt(plaintext, key) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decrypt({ ciphertext, iv, tag }, key) {
  const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function wrapDek(dek, kek) {
  return encrypt(dek, kek);
}

export function unwrapDek(wrapped, kek) {
  return decrypt(wrapped, kek);
}
