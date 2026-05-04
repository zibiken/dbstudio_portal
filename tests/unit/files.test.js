import { describe, it, expect } from 'vitest';
import {
  STORAGE_ROOT,
  MAX_FILE_BYTES,
  MAX_CUSTOMER_BYTES,
  storagePath,
  safeFilename,
  assertSize,
  assertCustomerQuota,
  mimeFromMagic,
  signDownloadToken,
  verifyDownloadToken,
} from '../../lib/files.js';
import { sign } from '../../lib/crypto/tokens.js';

const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const FILE = '22222222-2222-2222-2222-222222222222';

describe('files', () => {
  describe('constants', () => {
    it('STORAGE_ROOT is /var/lib/portal/storage', () => {
      expect(STORAGE_ROOT).toBe('/var/lib/portal/storage');
    });

    it('MAX_FILE_BYTES is 50 MiB (binary)', () => {
      expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
    });

    it('MAX_CUSTOMER_BYTES is 5 GiB (binary)', () => {
      expect(MAX_CUSTOMER_BYTES).toBe(5 * 1024 * 1024 * 1024);
    });
  });

  describe('storagePath', () => {
    it('builds /var/lib/portal/storage/<customerId>/<fileId>.<ext>', () => {
      const p = storagePath(CUSTOMER, FILE, 'pdf');
      expect(p).toBe(`${STORAGE_ROOT}/${CUSTOMER}/${FILE}.pdf`);
    });

    it('lowercases the extension', () => {
      expect(storagePath(CUSTOMER, FILE, 'PDF')).toBe(
        `${STORAGE_ROOT}/${CUSTOMER}/${FILE}.pdf`
      );
    });

    it('strips a leading dot from the extension', () => {
      expect(storagePath(CUSTOMER, FILE, '.pdf')).toBe(
        `${STORAGE_ROOT}/${CUSTOMER}/${FILE}.pdf`
      );
    });

    it('rejects a customerId containing a path separator', () => {
      expect(() => storagePath('a/b', FILE, 'pdf')).toThrow();
      expect(() => storagePath('a\\b', FILE, 'pdf')).toThrow();
    });

    it('rejects a customerId containing parent-traversal segments', () => {
      expect(() => storagePath('..', FILE, 'pdf')).toThrow();
      expect(() => storagePath('a..', FILE, 'pdf')).toThrow();
    });

    it('rejects a fileId containing a path separator', () => {
      expect(() => storagePath(CUSTOMER, 'a/b', 'pdf')).toThrow();
      expect(() => storagePath(CUSTOMER, 'a\\b', 'pdf')).toThrow();
    });

    it('rejects an extension containing a path separator', () => {
      expect(() => storagePath(CUSTOMER, FILE, 'pdf/etc')).toThrow();
      expect(() => storagePath(CUSTOMER, FILE, 'pdf\\etc')).toThrow();
    });

    it('rejects a NUL byte anywhere in the inputs', () => {
      expect(() => storagePath(`${CUSTOMER}\0`, FILE, 'pdf')).toThrow();
      expect(() => storagePath(CUSTOMER, `${FILE}\0`, 'pdf')).toThrow();
      expect(() => storagePath(CUSTOMER, FILE, 'pdf\0')).toThrow();
    });

    it('rejects empty inputs', () => {
      expect(() => storagePath('', FILE, 'pdf')).toThrow();
      expect(() => storagePath(CUSTOMER, '', 'pdf')).toThrow();
      expect(() => storagePath(CUSTOMER, FILE, '')).toThrow();
    });

    it('resolves to a path strictly under STORAGE_ROOT', () => {
      // belt-and-braces: even if every individual check above slipped, the
      // resolved path must live inside the storage tree.
      const p = storagePath(CUSTOMER, FILE, 'pdf');
      expect(p.startsWith(`${STORAGE_ROOT}/`)).toBe(true);
      expect(p).not.toContain('/..');
    });
  });

  describe('safeFilename', () => {
    it('returns just the basename when given a POSIX path', () => {
      expect(safeFilename('/etc/passwd')).toBe('passwd');
      expect(safeFilename('../../etc/passwd')).toBe('passwd');
      expect(safeFilename('a/b/c/report.pdf')).toBe('report.pdf');
    });

    it('returns just the basename when given a Windows-style path', () => {
      expect(safeFilename('C:\\Users\\Admin\\evil.exe')).toBe('evil.exe');
      expect(safeFilename('..\\..\\secret.txt')).toBe('secret.txt');
    });

    it('NFC-normalises the unicode form', () => {
      // 'cafe' + combining acute → composed 'café'
      const decomposed = 'café.pdf';
      const composed = 'café.pdf';
      expect(safeFilename(decomposed)).toBe(composed);
      // already-composed input is preserved
      expect(safeFilename(composed)).toBe(composed);
    });

    it('strips control characters and NUL bytes', () => {
      expect(safeFilename('file\0name.pdf')).toBe('filename.pdf');
      expect(safeFilename('abc.txt')).toBe('abc.txt');
      // newlines and tabs are control characters too
      expect(safeFilename('line1\nline2.txt')).toBe('line1line2.txt');
      expect(safeFilename('tab\tted.txt')).toBe('tabted.txt');
    });

    it('preserves spaces, accented characters, and emoji', () => {
      expect(safeFilename('Mi documento — versión 2 ✨.pdf'))
        .toBe('Mi documento — versión 2 ✨.pdf');
    });

    it('rejects an empty string', () => {
      expect(() => safeFilename('')).toThrow();
    });

    it('rejects a name that becomes empty after sanitisation', () => {
      expect(() => safeFilename('/')).toThrow();
      expect(() => safeFilename('\0\0')).toThrow();
      expect(() => safeFilename('../../')).toThrow();
    });

    it('rejects a non-string input', () => {
      expect(() => safeFilename(null)).toThrow();
      expect(() => safeFilename(undefined)).toThrow();
      expect(() => safeFilename(42)).toThrow();
    });
  });

  describe('assertSize', () => {
    it('accepts at the 50 MiB boundary', () => {
      expect(() => assertSize(MAX_FILE_BYTES)).not.toThrow();
    });

    it('accepts a small file', () => {
      expect(() => assertSize(1024)).not.toThrow();
    });

    it('rejects 1 byte over 50 MiB', () => {
      expect(() => assertSize(MAX_FILE_BYTES + 1)).toThrow();
    });

    it('rejects negative sizes', () => {
      expect(() => assertSize(-1)).toThrow();
    });

    it('rejects non-integer / non-number inputs', () => {
      expect(() => assertSize(NaN)).toThrow();
      expect(() => assertSize(1.5)).toThrow();
      expect(() => assertSize('100')).toThrow();
    });
  });

  describe('assertCustomerQuota', () => {
    it('accepts cumulative usage at the 5 GiB boundary', () => {
      expect(() => assertCustomerQuota(MAX_CUSTOMER_BYTES - 1, 1)).not.toThrow();
      expect(() => assertCustomerQuota(0, MAX_CUSTOMER_BYTES)).not.toThrow();
    });

    it('rejects 1 byte over 5 GiB cumulative', () => {
      expect(() => assertCustomerQuota(MAX_CUSTOMER_BYTES - 1, 2)).toThrow();
      expect(() => assertCustomerQuota(MAX_CUSTOMER_BYTES, 1)).toThrow();
    });

    it('accepts a fresh customer adding a small file', () => {
      expect(() => assertCustomerQuota(0, 1024)).not.toThrow();
    });

    it('rejects negative current or new bytes', () => {
      expect(() => assertCustomerQuota(-1, 100)).toThrow();
      expect(() => assertCustomerQuota(0, -1)).toThrow();
    });

    it('rejects non-integer inputs', () => {
      expect(() => assertCustomerQuota(NaN, 100)).toThrow();
      expect(() => assertCustomerQuota(0, 1.5)).toThrow();
    });
  });

  describe('mimeFromMagic', () => {
    it('detects a PDF buffer from its magic bytes', async () => {
      const buf = Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        Buffer.alloc(64, 0x20), // padding to give file-type enough to chew on
      ]);
      const out = await mimeFromMagic(buf);
      expect(out).not.toBeNull();
      expect(out.mime).toBe('application/pdf');
      expect(out.ext).toBe('pdf');
    });

    it('detects a PNG buffer from its magic bytes', async () => {
      // Minimal PNG: 8-byte signature + IHDR chunk len + 'IHDR' + 13-byte data + crc.
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdrLen = Buffer.from([0x00, 0x00, 0x00, 0x0d]);
      const ihdr = Buffer.from('IHDR');
      const ihdrData = Buffer.alloc(13, 0); // 4 width + 4 height + 5 misc
      const crc = Buffer.alloc(4, 0);
      const buf = Buffer.concat([sig, ihdrLen, ihdr, ihdrData, crc]);
      const out = await mimeFromMagic(buf);
      expect(out).not.toBeNull();
      expect(out.mime).toBe('image/png');
      expect(out.ext).toBe('png');
    });

    it('returns null for unrecognised bytes', async () => {
      const buf = Buffer.from('plain text — definitely not a known binary format');
      const out = await mimeFromMagic(buf);
      expect(out).toBeNull();
    });

    it('detects a PDF whose %PDF- signature is preceded by leading bytes (email forwards / print drivers)', async () => {
      // Real-world PDFs from email forwards land in the inbox with a
      // few hundred bytes of email-style headers prepended before the
      // actual %PDF- signature. file-type's strict offset-0 check
      // misses these; our fallback scans the first 1024 bytes.
      const leading = Buffer.from(
        'date: Mon, 04 May 2026 07:09:53 +0200\r\n'
        + 'from: invoices@example.com\r\n'
        + 'subject: Your invoice\r\n'
        + '\r\n',
      );
      const buf = Buffer.concat([
        leading,
        Buffer.from('%PDF-1.4\n'),
        Buffer.alloc(64, 0x20),
      ]);
      const out = await mimeFromMagic(buf);
      expect(out).not.toBeNull();
      expect(out.mime).toBe('application/pdf');
      expect(out.ext).toBe('pdf');
    });

    it('does NOT accept a PDF signature beyond the 1024-byte scan window', async () => {
      // Bound the permissive scan: a %PDF- signature buried 2 KiB
      // deep is suspicious (almost certainly not a real PDF) and
      // should be rejected.
      const buf = Buffer.concat([
        Buffer.alloc(2048, 0x20),
        Buffer.from('%PDF-1.4\n'),
      ]);
      const out = await mimeFromMagic(buf);
      expect(out).toBeNull();
    });
  });

  describe('signDownloadToken / verifyDownloadToken', () => {
    const secret = 'a'.repeat(64);

    it('round-trips a fileId', () => {
      const token = signDownloadToken({ fileId: FILE }, secret);
      const out = verifyDownloadToken(token, secret);
      expect(out.fileId).toBe(FILE);
    });

    it('issues a 60-second TTL (spec §2.7)', () => {
      const token = signDownloadToken({ fileId: FILE }, secret);
      const out = verifyDownloadToken(token, secret);
      const drift = out.exp - Math.floor(Date.now() / 1000);
      expect(drift).toBeGreaterThan(50);
      expect(drift).toBeLessThanOrEqual(60);
    });

    it('rejects an expired token', () => {
      // Construct a deliberately-stale token via the underlying primitive,
      // then prove verifyDownloadToken refuses it.
      const stale = sign({ fileId: FILE, kind: 'file' }, secret, { expSeconds: -1 });
      expect(() => verifyDownloadToken(stale, secret)).toThrow(/expired/);
    });

    it('rejects a tampered MAC', () => {
      const token = signDownloadToken({ fileId: FILE }, secret);
      const bad = token.slice(0, -2) + 'xx';
      expect(() => verifyDownloadToken(bad, secret)).toThrow();
    });

    it('rejects a forged payload (signature no longer matches)', () => {
      const token = signDownloadToken({ fileId: FILE }, secret);
      const [, mac] = token.split('.');
      const evilPart = Buffer.from(
        JSON.stringify({ fileId: 'attacker', kind: 'file', exp: Math.floor(Date.now() / 1000) + 600 })
      ).toString('base64url');
      const forged = `${evilPart}.${mac}`;
      expect(() => verifyDownloadToken(forged, secret)).toThrow();
    });

    it('rejects a token signed with a different secret', () => {
      const token = signDownloadToken({ fileId: FILE }, secret);
      expect(() => verifyDownloadToken(token, 'b'.repeat(64))).toThrow();
    });

    it('rejects a generic (non-file-kind) token', () => {
      // A plain sign() token without kind:'file' must not pass file verification.
      const generic = sign({ fileId: FILE }, secret);
      expect(() => verifyDownloadToken(generic, secret)).toThrow(/kind/);
    });

    it('rejects a malformed token', () => {
      expect(() => verifyDownloadToken('not-a-token', secret)).toThrow();
    });
  });
});
