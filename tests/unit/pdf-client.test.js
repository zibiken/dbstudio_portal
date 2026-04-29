import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPdf } from '../../lib/pdf-client.js';

let socketPath; let server; let dir;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pdfsock-'));
  socketPath = join(dir, 'pdf.sock');
  server = createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => { buf += d.toString('utf8'); });
    conn.on('end', () => {
      try {
        const req = JSON.parse(buf);
        if (req.html && req.html.includes('FAIL')) {
          conn.end(JSON.stringify({ ok: false, error: 'overflow', field: 'domicilio', length: 4321 }) + '\n');
        } else {
          conn.end(JSON.stringify({ ok: true, pdfBase64: Buffer.from('PDFDATA').toString('base64'), sha256: 'deadbeef' }) + '\n');
        }
      } catch {
        conn.end(JSON.stringify({ ok: false, error: 'bad-json' }) + '\n');
      }
    });
  });
  await new Promise((r) => server.listen(socketPath, r));
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('renderPdf', () => {
  it('returns PDF bytes + sha on success', async () => {
    const r = await renderPdf({ socketPath, html: '<h1>hi</h1>', options: { format: 'A4' } });
    expect(r.ok).toBe(true);
    expect(r.pdf).toEqual(Buffer.from('PDFDATA'));
    expect(r.sha256).toBe('deadbeef');
  });

  it('returns structured overflow error', async () => {
    const r = await renderPdf({ socketPath, html: 'FAIL overflow check', options: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('overflow');
    expect(r.field).toBe('domicilio');
  });

  it('rejects when socket does not exist', async () => {
    await expect(renderPdf({ socketPath: '/nonexistent/sock', html: 'x', options: {} }))
      .rejects.toThrow();
  });
});
