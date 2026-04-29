import { requireCustomerSession } from '../../lib/auth/middleware.js';
import { findDocumentById } from '../../domain/documents/repo.js';
import { findCustomerUserById } from '../../domain/customers/repo.js';
import { signDownloadToken } from '../../lib/files.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerCustomerDocumentsRoutes(app) {
  app.get('/customer/documents/:id/download', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      reply.code(404);
      return { error: 'not found' };
    }

    const doc = await findDocumentById(app.db, id);
    if (!doc) {
      reply.code(404);
      return { error: 'not found' };
    }

    const me = await findCustomerUserById(app.db, session.user_id);
    if (!me || doc.customer_id !== me.customer_id) {
      reply.code(403);
      return { error: 'forbidden' };
    }

    const token = signDownloadToken({ fileId: doc.id }, app.env.FILE_URL_SIGNING_SECRET);
    reply.redirect(`/files/${token}`, 302);
  });
}
