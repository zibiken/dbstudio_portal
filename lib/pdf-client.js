import { createConnection } from 'node:net';

// 60s default — multi-page NDAs (M8.7) plus a Chromium cold-start can run
// 5-15s on first render. Caller can override for shorter probe paths.
export function renderPdf({ socketPath, html, options, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buf = '';
    let settled = false;

    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(new Error('pdf-client timeout'));
    }, timeoutMs);

    conn.on('data', (d) => { buf += d.toString('utf8'); });
    conn.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        const resp = JSON.parse(buf);
        if (resp.ok) {
          resolve({ ok: true, pdf: Buffer.from(resp.pdfBase64, 'base64'), sha256: resp.sha256 });
        } else {
          resolve({ ok: false, error: resp.error, field: resp.field, message: resp.message, length: resp.length });
        }
      } catch (e) {
        reject(new Error(`pdf-client bad response: ${e.message}`));
      }
    });
    conn.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(e);
    });

    conn.write(JSON.stringify({ html, options }) + '\n');
    conn.end();
  });
}
