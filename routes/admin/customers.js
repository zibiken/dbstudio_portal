import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import * as customersService from '../../domain/customers/service.js';
import {
  findCustomerById,
  listCustomers,
  listCustomerUsersByCustomer,
} from '../../domain/customers/repo.js';

const PER_PAGE_DEFAULT = 25;
const PER_PAGE_MAX = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampInt(value, lo, hi, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function buildQs(params) {
  // Used by list.ejs to render pagination links without losing the search
  // query string. Skip empty values so the URL stays clean.
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    out.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

export function registerAdminCustomerRoutes(app) {
  app.get('/admin/customers', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const q = typeof req.query?.q === 'string' ? req.query.q : '';
    const perPage = clampInt(req.query?.per_page, 1, PER_PAGE_MAX, PER_PAGE_DEFAULT);
    const page = clampInt(req.query?.page, 1, 1_000_000, 1);
    const offset = (page - 1) * perPage;

    const { rows, total } = await listCustomers(app.db, { q, limit: perPage, offset });
    const totalPages = Math.max(1, Math.ceil(total / perPage));

    return renderAdmin(req, reply, 'admin/customers/list', {
      title: 'Customers',
      rows,
      total,
      page,
      perPage,
      totalPages,
      q,
      qs: buildQs,
    });
  });

  app.get('/admin/customers/new', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    return renderAdmin(req, reply, 'admin/customers/new', {
      title: 'New customer',
      csrfToken: await reply.generateCsrf(),
      form: null,
    });
  });

  app.post('/admin/customers', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const body = req.body ?? {};
    const razonSocial = typeof body.razon_social === 'string' ? body.razon_social.trim() : '';
    const nif = typeof body.nif === 'string' && body.nif.trim() !== '' ? body.nif.trim() : null;
    const domicilio = typeof body.domicilio === 'string' && body.domicilio.trim() !== ''
      ? body.domicilio.trim()
      : null;
    const primaryName = typeof body.primary_user_name === 'string'
      ? body.primary_user_name.trim()
      : '';
    const primaryEmail = typeof body.primary_user_email === 'string'
      ? body.primary_user_email.trim()
      : '';

    const errors = [];
    if (!razonSocial) errors.push('Razon social is required.');
    if (!primaryName) errors.push('Primary user name is required.');
    if (!primaryEmail) errors.push('Primary user email is required.');

    if (errors.length > 0) {
      reply.code(422);
      return renderAdmin(req, reply, 'admin/customers/new', {
        title: 'New customer',
        csrfToken: await reply.generateCsrf(),
        form: { razon_social: razonSocial, nif, domicilio, primary_user_name: primaryName, primary_user_email: primaryEmail },
        error: errors.join(' '),
      });
    }

    let result;
    try {
      result = await customersService.create(
        app.db,
        {
          razonSocial,
          nif,
          domicilio,
          primaryUser: { name: primaryName, email: primaryEmail },
        },
        {
          actorType: 'admin',
          actorId: session.user_id,
          ip: req.ip ?? null,
          userAgentHash: null,
          portalBaseUrl: app.env.PORTAL_BASE_URL,
          kek: app.kek,
          audit: {},
        },
      );
    } catch (err) {
      reply.code(422);
      return renderAdmin(req, reply, 'admin/customers/new', {
        title: 'New customer',
        csrfToken: await reply.generateCsrf(),
        form: { razon_social: razonSocial, nif, domicilio, primary_user_name: primaryName, primary_user_email: primaryEmail },
        error: /unique|duplicate/i.test(err.message)
          ? 'A customer or user with these details already exists.'
          : 'Could not create customer. Try again.',
      });
    }

    const baseUrl = app.env.PORTAL_BASE_URL.replace(/\/+$/, '');
    const customer = await findCustomerById(app.db, result.customerId);
    return renderAdmin(req, reply, 'admin/customers/created', {
      title: 'Customer created',
      customer,
      primaryUser: { name: primaryName, email: primaryEmail },
      invite: {
        url: `${baseUrl}/customer/welcome/${result.inviteToken}`,
        expiresAt: new Date(Date.now() + customersService.INVITE_TTL_MS).toISOString(),
      },
    });
  });

  app.get('/admin/customers/:id', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      reply.code(404);
      return renderAdmin(req, reply, 'admin/customers/not-found', { title: 'Not found' });
    }

    const customer = await findCustomerById(app.db, id);
    if (!customer) {
      reply.code(404);
      return renderAdmin(req, reply, 'admin/customers/not-found', { title: 'Not found' });
    }

    const users = await listCustomerUsersByCustomer(app.db, customer.id);
    return renderAdmin(req, reply, 'admin/customers/detail', {
      title: customer.razon_social,
      customer,
      users,
    });
  });
}
