import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import * as invoicesService from '../../domain/invoices/service.js';
import * as documentsService from '../../domain/documents/service.js';
import { findCustomerById } from '../../domain/customers/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NEXT_STATUSES = {
  open: ['paid', 'void'],
  paid: ['open'],
  void: ['open'],
};

function notFound(req, reply) {
  reply.code(404);
  return renderAdmin(req, reply, 'admin/customers/not-found', {
    title: 'Not found',
    activeNav: 'customers',
    mainWidth: 'content',
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

function ctxFromSession(app, req, session) {
  return {
    actorType: 'admin',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    portalBaseUrl: app.env.PORTAL_BASE_URL,
    audit: {},
  };
}

export function registerAdminInvoicesRoutes(app) {
  // Per-customer list — anchors the navigation off the customer detail page.
  app.get('/admin/customers/:id/invoices', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    const rows = await invoicesService.listForCustomer(app.db, id);
    return renderAdmin(req, reply, 'admin/invoices/list', {
      title: `Invoices · ${customer.razon_social}`,
      customer,
      rows,
      mainWidth: 'wide',
      ...customerChrome(customer, 'invoices'),
    });
  });

  app.get('/admin/customers/:id/invoices/new', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    return renderAdmin(req, reply, 'admin/invoices/new', {
      title: 'Upload invoice',
      customer,
      csrfToken: await reply.generateCsrf(),
      form: null,
      mainWidth: 'wide',
      ...customerChrome(customer, 'invoices'),
    });
  });

  app.post(
    '/admin/customers/:id/invoices',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;

      const customerId = req.params?.id;
      if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) return notFound(req, reply);

      // Multipart contract: text fields BEFORE the file (matches M6's
      // upload route — by the time `part.type === 'file'` lands we have
      // every metadata field). Fields submitted after the file are
      // ignored.
      let invoiceNumber = '';
      let amountCents = '';
      let currency = 'EUR';
      let issuedOn = '';
      let dueOn = '';
      let notes = null;
      let documentId = null;

      const ctx = ctxFromSession(app, req, session);

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (documentId) {
              part.file.resume();
              throw new Error('only one file per invoice');
            }
            const r = await documentsService.uploadForCustomer(
              app.db,
              {
                customerId,
                category: 'invoice',
                originalFilename: part.filename,
                declaredMime: part.mimetype || null,
                stream: part.file,
              },
              ctx,
            );
            documentId = r.documentId;
          } else if (part.fieldname === 'invoice_number') {
            invoiceNumber = String(part.value);
          } else if (part.fieldname === 'amount_cents') {
            amountCents = String(part.value);
          } else if (part.fieldname === 'currency') {
            currency = String(part.value).toUpperCase();
          } else if (part.fieldname === 'issued_on') {
            issuedOn = String(part.value);
          } else if (part.fieldname === 'due_on') {
            dueOn = String(part.value);
          } else if (part.fieldname === 'notes') {
            const v = String(part.value);
            notes = v.trim() === '' ? null : v;
          }
        }
      } catch (err) {
        const customer = await findCustomerById(app.db, customerId);
        if (!customer) return notFound(req, reply);
        reply.code(422);
        return renderAdmin(req, reply, 'admin/invoices/new', {
          title: 'Upload invoice',
          customer,
          csrfToken: await reply.generateCsrf(),
          form: { invoice_number: invoiceNumber, amount_cents: amountCents, currency, issued_on: issuedOn, due_on: dueOn, notes },
          error: err.message,
          mainWidth: 'wide',
          ...customerChrome(customer, 'invoices'),
        });
      }

      if (!documentId) {
        const customer = await findCustomerById(app.db, customerId);
        if (!customer) return notFound(req, reply);
        reply.code(422);
        return renderAdmin(req, reply, 'admin/invoices/new', {
          title: 'Upload invoice',
          customer,
          csrfToken: await reply.generateCsrf(),
          form: { invoice_number: invoiceNumber, amount_cents: amountCents, currency, issued_on: issuedOn, due_on: dueOn, notes },
          error: 'No file received.',
          mainWidth: 'wide',
          ...customerChrome(customer, 'invoices'),
        });
      }

      try {
        const r = await invoicesService.create(app.db, {
          adminId: session.user_id,
          customerId,
          documentId,
          invoiceNumber,
          amountCents: Number(amountCents),
          currency,
          issuedOn,
          dueOn,
          notes,
        }, ctx);
        reply.redirect(`/admin/invoices/${r.invoiceId}`, 302);
      } catch (err) {
        const customer = await findCustomerById(app.db, customerId);
        if (!customer) return notFound(req, reply);
        reply.code(422);
        return renderAdmin(req, reply, 'admin/invoices/new', {
          title: 'Upload invoice',
          customer,
          csrfToken: await reply.generateCsrf(),
          form: { invoice_number: invoiceNumber, amount_cents: amountCents, currency, issued_on: issuedOn, due_on: dueOn, notes },
          error: err.message,
          mainWidth: 'wide',
          ...customerChrome(customer, 'invoices'),
        });
      }
    },
  );

  app.get('/admin/invoices/:id', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);

    const row = await invoicesService.findById(app.db, id);
    if (!row) return notFound(req, reply);
    const customer = await findCustomerById(app.db, row.customer_id);
    if (!customer) return notFound(req, reply);

    return renderAdmin(req, reply, 'admin/invoices/detail', {
      title: `Invoice ${row.invoice_number}`,
      row,
      customer,
      csrfToken: await reply.generateCsrf(),
      nextStatuses: NEXT_STATUSES[row.status] ?? [],
      flash: typeof req.query?.flash === 'string' ? req.query.flash : null,
      mainWidth: 'wide',
      ...customerChrome(customer, 'invoices'),
    });
  });

  app.post(
    '/admin/invoices/:id/status',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;

      const id = req.params?.id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);

      const newStatus = req.body?.status;
      try {
        await invoicesService.setStatus(app.db, {
          adminId: session.user_id,
          invoiceId: id,
          newStatus,
        }, ctxFromSession(app, req, session));
        reply.redirect(`/admin/invoices/${id}?flash=Status%20updated`, 302);
      } catch (err) {
        if (err.code === 'INVOICE_NOT_FOUND') return notFound(req, reply);
        const row = await invoicesService.findById(app.db, id);
        const customer = row ? await findCustomerById(app.db, row.customer_id) : null;
        if (!row || !customer) return notFound(req, reply);
        reply.code(400);
        return renderAdmin(req, reply, 'admin/invoices/detail', {
          title: `Invoice ${row.invoice_number}`,
          row,
          customer,
          csrfToken: await reply.generateCsrf(),
          nextStatuses: NEXT_STATUSES[row.status] ?? [],
          error: err.message,
          mainWidth: 'wide',
          ...customerChrome(customer, 'invoices'),
        });
      }
    },
  );
}
