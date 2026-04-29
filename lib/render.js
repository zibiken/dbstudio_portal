import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { euDate, euDateTime } from './dates.js';

const VIEWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');

// Globals injected into every EJS view. Keep this list small and stable;
// callers shouldn't have to opt in. euDate/euDateTime live here so the
// portal's web pages display dates in the same DD/MM/YYYY (Atlantic/Canary)
// format as transactional emails — see lib/dates.js.
const VIEW_GLOBALS = Object.freeze({ euDate, euDateTime });

async function renderInLayout(req, reply, layout, template, locals, defaultTitle) {
  const body = await ejs.renderFile(path.join(VIEWS_DIR, `${template}.ejs`), {
    ...VIEW_GLOBALS,
    ...locals,
    nonce: req.cspNonce,
  });
  const html = await ejs.renderFile(path.join(VIEWS_DIR, `layouts/${layout}.ejs`), {
    ...VIEW_GLOBALS,
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
