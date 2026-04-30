// Sub-service entrypoint for portal-pdf.service.
// Receives JSON-line {html, options} on a Unix socket; replies {ok,pdfBase64,sha256} or {ok:false,error,...}.
// No DB access, no secrets, no network egress (RestrictAddressFamilies=AF_UNIX in the unit).
import { createServer } from 'node:net';
import { unlinkSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';

const SOCK = process.env.PDF_SERVICE_SOCKET || '/run/portal-pdf.sock';

let browser;

async function getBrowser() {
  if (!browser) {
    // Sandbox-friendly Chromium flags. The systemd unit grants write
    // access to /var/lib/portal-pdf (the portal-pdf user's $HOME) so
    // Chromium's crashpad helper can write its database under HOME/.config
    // without HOME / userDataDir overrides. ProtectHome=true still hides
    // /home + /root, so a Chromium RCE cannot reach the operator's home
    // dir or other system users.
    //
    // headless 'new' is the modern Puppeteer path (legacy `true` is
    // deprecated and prints no DevTools WS URL on stdout, which makes
    // Puppeteer's launch hang).
    browser = await puppeteer.launch({
      headless: 'new',
      // pipe=true uses fd-based IPC for the DevTools protocol instead of
      // discovering a WebSocket port from Chromium's stdout. Avoids the
      // "Timed out after 30000 ms while waiting for the WS endpoint URL
      // to appear in stdout!" handshake issue we hit when Puppeteer
      // reads Chromium's stdout from inside the systemd sandbox profile.
      pipe: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
        '--disable-gpu',
      ],
    });
  }
  return browser;
}

async function render({ html, options }) {
  // M8.7: continuation header on every page (slim grey rule + customer
  // name) + Página X de Y footer. Page 1's brand bar in the body sits
  // visually above the continuation header for additional page-1
  // distinction. Margins live in the template's @page rule.
  const continuationTitle = String((options && options.continuationTitle) || '')
    .replace(/[<>&"]/g, ' ');

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: 0,
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="width: 100%; padding: 0 25mm 0 25mm; box-sizing: border-box;
                    font-size: 8pt; color: #888;
                    font-family: 'Inter', system-ui, sans-serif;">
          <div style="border-top: 0.5pt solid #ccc; padding-top: 2mm;">
            Acuerdo de Confidencialidad — ${continuationTitle}
          </div>
        </div>
      `,
      footerTemplate: `
        <div style="width: 100%; padding: 0 25mm 0 25mm; box-sizing: border-box;
                    text-align: center;
                    font-size: 8pt; color: #888;
                    font-family: 'Inter', system-ui, sans-serif;">
          Página <span class="pageNumber"></span> de <span class="totalPages"></span>
        </div>
      `,
    });
    // Puppeteer 24+ returns a Uint8Array from page.pdf(); Uint8Array's
    // toString('base64') isn't base64-aware (returns the comma-joined
    // byte list), so wrap as Buffer before encoding/hashing.
    const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    return { ok: true, pdfBase64: buf.toString('base64'), sha256 };
  } finally {
    await page.close();
  }
}

if (existsSync(SOCK)) unlinkSync(SOCK);
// allowHalfOpen=true is REQUIRED. Protocol: client writes the request and
// half-closes (FIN), server reads to end, server writes reply and FINs.
// Without allowHalfOpen the server auto-FINs as soon as it receives the
// client's FIN, which closes its writable side BEFORE the async render()
// completes — the reply then silently drops and the client sees an empty
// socket close, surfacing as "Unexpected end of JSON input" on parse.
const server = createServer({ allowHalfOpen: true }, (conn) => {
  // The client may disappear mid-render (timeout in pdf-client.js
  // calling conn.destroy()). Without an error handler, the next time
  // the server tries to write its reply the EPIPE/ECONNRESET propagates
  // as an unhandled socket error and Node 20 kills the entire process —
  // which means a single slow render takes down portal-pdf.service.
  // Swallow the error: the connection is already gone, the response we
  // were about to write would land nowhere anyway.
  conn.on('error', () => { /* client gone; nothing useful to do here */ });
  let buf = '';
  conn.on('data', (d) => { buf += d.toString('utf8'); });
  conn.on('end', async () => {
    try {
      const req = JSON.parse(buf);
      const resp = await render(req);
      try { conn.end(JSON.stringify(resp) + '\n'); } catch { /* client gone */ }
    } catch (e) {
      try {
        conn.end(JSON.stringify({ ok: false, error: 'crash', message: String(e.message) }) + '\n');
      } catch { /* client gone */ }
    }
  });
});

server.listen(SOCK, () => {
  // Force 0660 (owner+group rw, no world). Node creates the socket with mode
  // 0777 & ~umask which can leave it 0770 even with UMask=0007 in the unit.
  chmodSync(SOCK, 0o660);
  process.stdout.write(`portal-pdf listening on ${SOCK}\n`);
});

const shutdown = async () => {
  try { if (browser) await browser.close(); } catch {}
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
