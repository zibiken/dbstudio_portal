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

export async function renderPublic(req, reply, template, locals = {}) {
  const body = await ejs.renderFile(path.join(VIEWS_DIR, `${template}.ejs`), {
    ...VIEW_GLOBALS,
    ...locals,
    nonce: req.cspNonce,
  });
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'layouts/public.ejs'), {
    ...VIEW_GLOBALS,
    nonce: req.cspNonce,
    title: locals.title ?? 'DB Studio Portal',
    body,
  });
  reply.type('text/html').send(html);
}
