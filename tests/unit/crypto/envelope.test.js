import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  generateDek,
  encrypt,
  decrypt,
  wrapDek,
  unwrapDek,
} from '../../../lib/crypto/envelope.js';

describe('envelope', () => {
  const kek = randomBytes(32);

  it('generateDek returns a fresh 32-byte buffer each call', () => {
    const a = generateDek();
    const b = generateDek();
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });

  it('round-trips plaintext through DEK + KEK', () => {
    const dek = generateDek();
    const wrap = wrapDek(dek, kek);
    const enc = encrypt(Buffer.from('hello world'), dek);
    const unwrappedDek = unwrapDek(wrap, kek);
    const dec = decrypt(enc, unwrappedDek);
    expect(dec.toString('utf8')).toBe('hello world');
  });

  it('GCM auth-tag tamper is detected', () => {
    const dek = generateDek();
    const enc = encrypt(Buffer.from('hi'), dek);
    enc.tag[0] ^= 0xff;
    expect(() => decrypt(enc, dek)).toThrow();
  });

  it('ciphertext tamper is detected', () => {
    const dek = generateDek();
    const enc = encrypt(Buffer.from('hello'), dek);
    enc.ciphertext[0] ^= 0xff;
    expect(() => decrypt(enc, dek)).toThrow();
  });

  it('IV tamper is detected', () => {
    const dek = generateDek();
    const enc = encrypt(Buffer.from('hi'), dek);
    enc.iv[0] ^= 0xff;
    expect(() => decrypt(enc, dek)).toThrow();
  });

  it('unwrapping with the wrong KEK fails', () => {
    const dek = generateDek();
    const wrap = wrapDek(dek, kek);
    const otherKek = randomBytes(32);
    expect(() => unwrapDek(wrap, otherKek)).toThrow();
  });

  it('IVs are unique across encryptions of the same plaintext', () => {
    const dek = generateDek();
    const a = encrypt(Buffer.from('x'), dek);
    const b = encrypt(Buffer.from('x'), dek);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext) && a.tag.equals(b.tag)).toBe(false);
  });

  it('encrypt output shape: ciphertext, iv (12B), tag (16B)', () => {
    const dek = generateDek();
    const enc = encrypt(Buffer.from('payload'), dek);
    expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
    expect(enc.iv.length).toBe(12);
    expect(enc.tag.length).toBe(16);
  });

  it('handles empty plaintext', () => {
    const dek = generateDek();
    const enc = encrypt(Buffer.alloc(0), dek);
    expect(decrypt(enc, dek).length).toBe(0);
  });
});
