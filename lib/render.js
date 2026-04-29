import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');

export async function renderPublic(req, reply, template, locals = {}) {
  const body = await ejs.renderFile(path.join(VIEWS_DIR, `${template}.ejs`), {
    ...locals,
    nonce: req.cspNonce,
  });
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'layouts/public.ejs'), {
    nonce: req.cspNonce,
    title: locals.title ?? 'DB Studio Portal',
    body,
  });
  reply.type('text/html').send(html);
}
