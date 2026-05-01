import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import { findDocumentById, listDocumentsByCustomer } from '../../domain/documents/repo.js';
import { findCustomerUserById } from '../../domain/customers/repo.js';
import { signDownloadToken } from '../../lib/files.js';
import { checkLockout, recordFail } from '../../lib/auth/rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Spec §2.6: 60 / minute per authenticated principal — see
// routes/admin/documents.js for the full rationale.
const SIGNED_URL_LIMIT = 60;
const SIGNED_URL_WINDOW_MS = 60_000;
const SIGNED_URL_LOCKOUT_MS = 60_000;

export function registerCustomerDocumentsRoutes(app) {
  app.get('/customer/documents', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const me = await findCustomerUserById(app.db, session.user_id);
    if (!me) return reply.redirect('/', 302);

    // Customer-side documents list: ALL categories belong to this customer,
    // but per M8.4 contract NDA drafts must never be visible. Filter them
    // out here as defence-in-depth on top of the download-route refusal —
    // a draft listed (even without a download link) would still leak the
    // existence of an unsigned NDA before the operator wants the customer
    // to see it.
    const all = await listDocumentsByCustomer(app.db, me.customer_id);
    const rows = all.filter((d) => d.category !== 'nda-draft');

    return renderCustomer(req, reply, 'customer/documents/list', {
      title: 'Documents',
      rows,
      activeNav: 'documents',
      mainWidth: 'wide',
      sectionLabel: 'DOCUMENTS',
    });
  });

  app.get('/customer/documents/:id/download', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      reply.code(404);
      return { error: 'not found' };
    }

    const rlKey = `signed_url:customer:${session.user_id}`;
    const lockout = await checkLockout(app.db, rlKey);
    if (lockout.locked) {
      reply.code(429);
      reply.header('retry-after', Math.max(1, Math.ceil(lockout.retryAfterMs / 1000)));
      return { error: 'too many requests' };
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

    // M8 Task 8.4: NDA drafts are admin-only. The customer must NEVER be
    // able to download a draft, even with a known UUID — this surface
    // refuses the category outright (defence-in-depth on top of the
    // audit-invisible draft generator). Customer-visible NDA documents
    // are 'nda-signed' and 'nda-audit', uploaded after the signed PDF
    // comes back from the operator's secure signing platform (Task 8.5).
    if (doc.category === 'nda-draft') {
      reply.code(404);
      return { error: 'not found' };
    }

    await recordFail(app.db, rlKey, {
      limit: SIGNED_URL_LIMIT,
      windowMs: SIGNED_URL_WINDOW_MS,
      lockoutMs: SIGNED_URL_LOCKOUT_MS,
    });
    const token = signDownloadToken({ fileId: doc.id }, app.env.FILE_URL_SIGNING_SECRET);
    reply.redirect(`/files/${token}`, 302);
  });
}
