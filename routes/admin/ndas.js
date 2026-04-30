import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import * as ndasService from '../../domain/ndas/service.js';
import * as documentsService from '../../domain/documents/service.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { listProjectsByCustomer } from '../../domain/projects/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(req, reply) {
  reply.code(404);
  return renderAdmin(req, reply, 'admin/customers/not-found', { title: 'Not found' });
}

function ctxFromSession(app, req, session) {
  return {
    actorType: 'admin',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    audit: {},
    pdfSocketPath: app.env.PDF_SERVICE_SOCKET,
  };
}

export function registerAdminNdasRoutes(app) {
  app.get('/admin/customers/:id/ndas', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    const rows = await ndasService.listNdasForAdmin(app.db, id);
    return renderAdmin(req, reply, 'admin/ndas/list', {
      title: `NDAs · ${customer.razon_social}`,
      customer,
      rows,
    });
  });

  app.get('/admin/customers/:id/ndas/new', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    const projects = await listProjectsByCustomer(app.db, id);
    const missingFields = computeMissingNdaFields(customer);

    return renderAdmin(req, reply, 'admin/ndas/new', {
      title: 'Generate NDA draft',
      customer,
      projects,
      missingFields,
      csrfToken: await reply.generateCsrf(),
      error: null,
    });
  });

  app.post(
    '/admin/customers/:id/ndas',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;

      const customerId = req.params?.id;
      if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) return notFound(req, reply);

      const projectId = typeof req.body?.project_id === 'string' && UUID_RE.test(req.body.project_id)
        ? req.body.project_id
        : null;
      if (!projectId) {
        const customer = await findCustomerById(app.db, customerId);
        if (!customer) return notFound(req, reply);
        const projects = await listProjectsByCustomer(app.db, customerId);
        reply.code(422);
        return renderAdmin(req, reply, 'admin/ndas/new', {
          title: 'Generate NDA draft',
          customer,
          projects,
          missingFields: computeMissingNdaFields(customer),
          csrfToken: await reply.generateCsrf(),
          error: 'Pick a project.',
        });
      }

      try {
        const r = await ndasService.generateDraft(app.db, {
          adminId: session.user_id,
          projectId,
        }, ctxFromSession(app, req, session));
        reply.redirect(`/admin/ndas/${r.ndaId}`, 302);
      } catch (err) {
        const customer = await findCustomerById(app.db, customerId);
        if (!customer) return notFound(req, reply);
        const projects = await listProjectsByCustomer(app.db, customerId);
        const isClientError = err.status && err.status < 500;
        reply.code(isClientError ? 422 : 500);
        return renderAdmin(req, reply, 'admin/ndas/new', {
          title: 'Generate NDA draft',
          customer,
          projects,
          missingFields: computeMissingNdaFields(customer),
          csrfToken: await reply.generateCsrf(),
          error: err.message,
        });
      }
    },
  );

  for (const kind of ['signed', 'audit']) {
    const category = kind === 'signed' ? 'nda-signed' : 'nda-audit';

    app.post(
      `/admin/ndas/:id/upload-${kind}`,
      { preHandler: app.csrfProtection },
      async (req, reply) => {
        const session = await requireAdminSession(app, req, reply);
        if (!session) return;

        const id = req.params?.id;
        if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);

        const nda = await ndasService.findNdaById(app.db, id);
        if (!nda) return notFound(req, reply);

        // Multipart contract — text fields BEFORE the file. We don't
        // need any text fields here, but the iterator pattern matches
        // the M6 upload route and keeps the CSRF check inline.
        let documentId = null;
        const ctx = ctxFromSession(app, req, session);
        try {
          for await (const part of req.parts()) {
            if (part.type === 'file') {
              if (documentId) {
                part.file.resume();
                throw new Error('only one file per upload');
              }
              const r = await documentsService.uploadForCustomer(
                app.db,
                {
                  customerId: nda.customer_id,
                  projectId: nda.project_id,
                  category,
                  originalFilename: part.filename,
                  declaredMime: part.mimetype || null,
                  stream: part.file,
                  // M8 review I2: keep the raw upload audit admin-only;
                  // the customer-facing milestone is the subsequent
                  // nda.signed_uploaded / nda.audit_trail_uploaded audit
                  // (written by attachUploadedDocument with
                  // visible_to_customer=true). If that follow-up tx
                  // fails, no orphan customer-visible event leaks
                  // through to the M9 activity feed.
                  visibleToCustomer: false,
                },
                ctx,
              );
              documentId = r.documentId;
            }
          }
        } catch (err) {
          return await renderDetailWithError(req, reply, app, id, err.message);
        }

        if (!documentId) {
          return await renderDetailWithError(req, reply, app, id, 'No file received.');
        }

        try {
          await ndasService.attachUploadedDocument(app.db, {
            adminId: session.user_id,
            ndaId: id,
            documentId,
            kind,
          }, ctx);
        } catch (err) {
          return await renderDetailWithError(req, reply, app, id, err.message);
        }

        reply.redirect(`/admin/ndas/${id}`, 302);
      },
    );
  }

  app.get('/admin/ndas/:id', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);

    const nda = await ndasService.findNdaWithDocs(app.db, id);
    if (!nda) return notFound(req, reply);
    const customer = await findCustomerById(app.db, nda.customer_id);
    if (!customer) return notFound(req, reply);

    return renderAdmin(req, reply, 'admin/ndas/detail', {
      title: `NDA · ${customer.razon_social}`,
      nda,
      customer,
      csrfToken: await reply.generateCsrf(),
    });
  });
}

async function renderDetailWithError(req, reply, app, ndaId, error) {
  const nda = await ndasService.findNdaWithDocs(app.db, ndaId);
  if (!nda) return notFound(req, reply);
  const customer = await findCustomerById(app.db, nda.customer_id);
  if (!customer) return notFound(req, reply);
  reply.code(422);
  return renderAdmin(req, reply, 'admin/ndas/detail', {
    title: `NDA · ${customer.razon_social}`,
    nda,
    customer,
    csrfToken: await reply.generateCsrf(),
    error,
  });
}

function computeMissingNdaFields(customer) {
  const required = [
    ['nif', customer.nif],
    ['domicilio', customer.domicilio],
    ['representante_nombre', customer.representante_nombre],
    ['representante_dni', customer.representante_dni],
    ['representante_cargo', customer.representante_cargo],
  ];
  return required.filter(([_k, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k);
}
