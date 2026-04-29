import { describe, it, expect } from 'vitest';
import { loadKek } from '../../../lib/crypto/kek.js';
import { writeFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tmpKey(bytes, mode = 0o400) {
  const dir = mkdtempSync(join(tmpdir(), 'kek-'));
  const p = join(dir, 'master.key');
  writeFileSync(p, bytes);
  chmodSync(p, mode);
  return { path: p, dir };
}

describe('loadKek', () => {
  it('returns the 32 bytes verbatim when file is exactly 32 bytes and mode 0400', () => {
    const { path, dir } = tmpKey(Buffer.alloc(32, 0xab));
    try {
      const k = loadKek(path);
      expect(k).toEqual(Buffer.alloc(32, 0xab));
      expect(k.length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when file size is not 32 bytes', () => {
    const { path, dir } = tmpKey(Buffer.alloc(16));
    try {
      expect(() => loadKek(path)).toThrow(/32 bytes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when mode is looser than 0400 (e.g. 0440)', () => {
    const { path, dir } = tmpKey(Buffer.alloc(32), 0o440);
    try {
      expect(() => loadKek(path)).toThrow(/mode/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the file does not exist', () => {
    expect(() => loadKek('/nonexistent/master.key')).toThrow();
  });
});
