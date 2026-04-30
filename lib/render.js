import ejs from 'ejs';
import path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { euDate, euDateTime } from './dates.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS_DIR = path.join(ROOT, 'views');

// Read portal version from package.json once at module load. The footer
// component renders this value alongside the dbstudio.one links so we can
// quickly tell what's deployed.
const PORTAL_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '';
  } catch (_) {
    return '';
  }
})();

// Globals injected into every EJS view. Keep this list small and stable;
// callers shouldn't have to opt in. euDate/euDateTime live here so the
// portal's web pages display dates in the same DD/MM/YYYY (Atlantic/Canary)
// format as transactional emails — see lib/dates.js.
const VIEW_GLOBALS = Object.freeze({ euDate, euDateTime, portalVersion: PORTAL_VERSION });

async function renderInLayout(req, reply, layout, template, locals, defaultTitle) {
  const body = await ejs.renderFile(path.join(VIEWS_DIR, `${template}.ejs`), {
    ...VIEW_GLOBALS,
    ...locals,
    nonce: req.cspNonce,
  });
  // Flow ALL locals into the layout too so chrome-level locals
  // (hero / activeNav / mainWidth / user / customer / sectionLabel /
  // vaultLockedBanner) reach the layout partials. body wins over any
  // local accidentally named "body".
  const html = await ejs.renderFile(path.join(VIEWS_DIR, `layouts/${layout}.ejs`), {
    ...VIEW_GLOBALS,
    ...locals,
    nonce: req.cspNonce,
    title: locals.title ?? defaultTitle,
    body,
  });
  reply.type('text/html').send(html);
}

export function renderPublic(req, reply, template, locals = {}) {
  return renderInLayout(req, reply, 'public', template, locals, 'DB Studio Portal');
}

export function renderAdmin(req, reply, template, locals = {}) {
  return renderInLayout(req, reply, 'admin', template, locals, 'Admin · DB Studio Portal');
}

export function renderCustomer(req, reply, template, locals = {}) {
  return renderInLayout(req, reply, 'customer', template, locals, 'DB Studio Portal');
}
