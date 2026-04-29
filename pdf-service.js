// Sub-service entrypoint for portal-pdf.service.
// Receives JSON-line {html, options} on a Unix socket; replies {ok,pdfBase64,sha256} or {ok:false,error,...}.
// No DB access, no secrets, no network egress (RestrictAddressFamilies=AF_UNIX in the unit).
import { createServer } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';

const SOCK = process.env.PDF_SERVICE_SOCKET || '/run/portal-pdf.sock';
const A4_HEIGHT_PX = 1123; // 297mm @ 96dpi

let browser;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
    });
  }
  return browser;
}

async function render({ html, options }) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    if (scrollHeight > A4_HEIGHT_PX) {
      const offending = await page.evaluate(() => {
        const fields = ['domicilio', 'razon_social', 'nif', 'objeto_proyecto'];
        let worst = null; let worstLen = 0;
        for (const f of fields) {
          const el = document.querySelector(`[data-field="${f}"]`);
          const len = el ? (el.textContent || '').length : 0;
          if (len > worstLen) { worst = f; worstLen = len; }
        }
        return { field: worst, length: worstLen };
      });
      return { ok: false, error: 'overflow', field: offending.field, length: offending.length };
    }

    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: 0, ...(options || {}) });
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    return { ok: true, pdfBase64: pdf.toString('base64'), sha256 };
  } finally {
    await page.close();
  }
}

if (existsSync(SOCK)) unlinkSync(SOCK);
const server = createServer((conn) => {
  let buf = '';
  conn.on('data', (d) => { buf += d.toString('utf8'); });
  conn.on('end', async () => {
    try {
      const req = JSON.parse(buf);
      const resp = await render(req);
      conn.end(JSON.stringify(resp) + '\n');
    } catch (e) {
      conn.end(JSON.stringify({ ok: false, error: 'crash', message: String(e.message) }) + '\n');
    }
  });
});

server.listen(SOCK, () => {
  process.stdout.write(`portal-pdf listening on ${SOCK}\n`);
});

const shutdown = async () => {
  try { if (browser) await browser.close(); } catch {}
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
