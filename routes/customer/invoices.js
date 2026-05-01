import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import * as invoicesService from '../../domain/invoices/service.js';
import * as paymentsService from '../../domain/invoice-payments/service.js';
import { findCustomerUserById } from '../../domain/customers/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(req, reply) {
  reply.code(404);
  return renderCustomer(req, reply, 'customer/invoices/not-found', { title: 'Not found' });
}

export function registerCustomerInvoicesRoutes(app) {
  app.get('/customer/invoices', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const me = await findCustomerUserById(app.db, session.user_id);
    if (!me) return notFound(req, reply);

    const rows = await invoicesService.listForCustomer(app.db, me.customer_id);
    return renderCustomer(req, reply, 'customer/invoices/list', {
      title: 'Invoices',
      rows,
      activeNav: 'invoices',
      mainWidth: 'wide',
      sectionLabel: 'INVOICES',
    });
  });

  app.get('/customer/invoices/:id', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);

    const row = await invoicesService.findById(app.db, id);
    if (!row) return notFound(req, reply);

    const me = await findCustomerUserById(app.db, session.user_id);
    if (!me || row.customer_id !== me.customer_id) return notFound(req, reply);

    const payments = await paymentsService.listForInvoice(app.db, id);
    const paidCents = payments.reduce((s, p) => s + Number(p.amount_cents), 0);

    return renderCustomer(req, reply, 'customer/invoices/detail', {
      title: `Invoice ${row.invoice_number}`,
      row,
      payments,
      paidCents,
      activeNav: 'invoices',
      mainWidth: 'wide',
      sectionLabel: 'INVOICES',
    });
  });
}
