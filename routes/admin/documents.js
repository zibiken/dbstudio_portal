import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import * as documentsService from '../../domain/documents/service.js';
import { findDocumentById, listDocumentsByCustomer } from '../../domain/documents/repo.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { signDownloadToken } from '../../lib/files.js';
import { checkLockout, recordFail } from '../../lib/auth/rate-limit.js';

// Spec §2.6: signed-URL issuance is rate-limited to 60 per minute per
// authenticated principal. Single-use enforcement on the download token
// itself doesn't bound issuance, so without this gate an authenticated
// caller could spray issuance requests and balloon the consumption table
// + audit log.
const SIGNED_URL_LIMIT = 60;
const SIGNED_URL_WINDOW_MS = 60_000;
const SIGNED_URL_LOCKOUT_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(req, reply) {
  reply.code(404);
  return renderAdmin(req, reply, 'admin/customers/not-found', {
    title: 'Not found',
    activeNav: 'customers',
    mainWidth: 'wide',
    sectionLabel: 'ADMIN · CUSTOMERS',
  });
}

function customerChrome(customer, activeTab) {
  return {
    activeNav: 'customers',
    sectionLabel: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
    activeTab,
  };
}

export function registerAdminDocumentsRoutes(app) {
  app.get('/admin/customers/:id/documents', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    const rows = await listDocumentsByCustomer(app.db, id);
    return renderAdmin(req, reply, 'admin/documents/list', {
      title: 'Documents · ' + customer.razon_social,
      customer,
      rows,
      mainWidth: 'wide',
      ...customerChrome(customer, 'documents'),
    });
  });

  app.get('/admin/customers/:id/documents/new', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    return renderAdmin(req, reply, 'admin/documents/upload', {
      title: 'Upload document',
      customer,
      csrfToken: await reply.generateCsrf(),
      mainWidth: 'wide',
      ...customerChrome(customer, 'documents'),
    });
  });

  app.post(
    '/admin/customers/:id/documents',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;

      const id = req.params?.id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);

      // Multipart contract: the form puts text fields BEFORE the file
      // input, so by the time `part.type === 'file'` lands we already
      // have the category / project_id / parent_id captured. Fields
      // submitted after the file are ignored.
      let category = 'generic';
      let projectId = null;
      let parentId = null;
      let result = null;

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (result) {
              part.file.resume();
              throw new Error('only one file per upload');
            }
            result = await documentsService.uploadForCustomer(
              app.db,
              {
                customerId: id,
                projectId,
                parentId,
                category,
                originalFilename: part.filename,
                declaredMime: part.mimetype || null,
                stream: part.file,
              },
              {
                actorType: 'admin',
                actorId: session.user_id,
                ip: req.ip ?? null,
                userAgentHash: null,
                audit: {},
              },
            );
          } else if (part.fieldname === 'category') {
            category = String(part.value);
          } else if (part.fieldname === 'project_id') {
            projectId = part.value && UUID_RE.test(String(part.value)) ? String(part.value) : null;
          } else if (part.fieldname === 'parent_id') {
            parentId = part.value && UUID_RE.test(String(part.value)) ? String(part.value) : null;
          }
        }
      } catch (err) {
        const customer = await findCustomerById(app.db, id);
        if (!customer) return notFound(req, reply);
        reply.code(422);
        return renderAdmin(req, reply, 'admin/documents/upload', {
          title: 'Upload document',
          customer,
          csrfToken: await reply.generateCsrf(),
          error: err.message,
          mainWidth: 'wide',
          ...customerChrome(customer, 'documents'),
        });
      }

      if (!result) {
        const customer = await findCustomerById(app.db, id);
        if (!customer) return notFound(req, reply);
        reply.code(422);
        return renderAdmin(req, reply, 'admin/documents/upload', {
          title: 'Upload document',
          customer,
          csrfToken: await reply.generateCsrf(),
          error: 'No file received.',
          mainWidth: 'wide',
          ...customerChrome(customer, 'documents'),
        });
      }

      reply.redirect(`/admin/customers/${id}`, 303);
    },
  );

  app.get('/admin/documents/:id/download', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      reply.code(404);
      return { error: 'not found' };
    }

    const rlKey = `signed_url:admin:${session.user_id}`;
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

    await recordFail(app.db, rlKey, {
      limit: SIGNED_URL_LIMIT,
      windowMs: SIGNED_URL_WINDOW_MS,
      lockoutMs: SIGNED_URL_LOCKOUT_MS,
    });
    const token = signDownloadToken({ fileId: doc.id }, app.env.FILE_URL_SIGNING_SECRET);
    reply.redirect(`/files/${token}`, 302);
  });
}
