import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import * as crService from '../../domain/credential-requests/service.js';
import {
  findCredentialRequestById,
  listForCustomer,
} from '../../domain/credential-requests/repo.js';
import { findCustomerById } from '../../domain/customers/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_FIELD_TYPES = ['text', 'secret', 'url', 'note'];

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

function makeCtx(req, session) {
  return {
    actorType: 'admin',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    audit: {},
  };
}

// Parses the per-row indexed shape from the new-request form (M7 review M2):
//   field_count, field_name_<i>, field_label_<i>, field_type_<i>, field_required_<i>
// Indexed (rather than parallel-array) so unchecked checkboxes don't desync
// the required-flag from the name/label/type triple — checkboxes that
// aren't ticked simply omit field_required_<i> from the body and we read
// `required: false` for that row. field_count is a hidden input written
// by the EJS so we can iterate without trusting form-key enumeration.
// Returns [] for malformed/missing input; service.createByAdmin rejects
// "fields must be a non-empty array" and the route re-renders with the
// error.
function parseFieldsFromBody(body) {
  const out = [];
  const count = Number.parseInt(body?.field_count ?? '', 10);
  if (!Number.isFinite(count) || count < 1) return out;
  for (let i = 0; i < count; i += 1) {
    const name = (body[`field_name_${i}`] ?? '').toString().trim();
    if (!name) continue;
    out.push({
      name,
      label: (body[`field_label_${i}`] ?? '').toString().trim(),
      type: (body[`field_type_${i}`] ?? 'text').toString(),
      required: body[`field_required_${i}`] === 'on',
    });
  }
  return out;
}

export function registerAdminCredentialRequestsRoutes(app) {
  app.get('/admin/customers/:cid/credential-requests', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const cid = req.params?.cid;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    if (!customer) return notFound(req, reply);
    const requests = await listForCustomer(app.db, cid);
    return renderAdmin(req, reply, 'admin/credential-requests/list', {
      title: `Credential requests · ${customer.razon_social}`,
      customer,
      requests,
      mainWidth: 'wide',
      ...customerChrome(customer, 'credential-requests'),
    });
  });

  app.get('/admin/customers/:cid/credential-requests/new', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const cid = req.params?.cid;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    if (!customer) return notFound(req, reply);
    return renderAdmin(req, reply, 'admin/credential-requests/new', {
      title: 'New credential request',
      customer,
      csrfToken: await reply.generateCsrf(),
      form: null,
      fieldTypes: ALLOWED_FIELD_TYPES,
      mainWidth: 'wide',
      ...customerChrome(customer, 'credential-requests'),
    });
  });

  app.post('/admin/customers/:cid/credential-requests',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;
      const cid = req.params?.cid;
      if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
      const customer = await findCustomerById(app.db, cid);
      if (!customer) return notFound(req, reply);

      const body = req.body ?? {};
      const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
      const fields = parseFieldsFromBody(body);
      const rerenderErr = (err) => {
        reply.code(422);
        return renderAdmin(req, reply, 'admin/credential-requests/new', {
          title: 'New credential request',
          customer,
          csrfToken: reply.generateCsrf(),
          form: { provider, fields },
          fieldTypes: ALLOWED_FIELD_TYPES,
          error: err?.message ?? String(err),
          mainWidth: 'wide',
          ...customerChrome(customer, 'credential-requests'),
        });
      };

      let requestId;
      try {
        const r = await crService.createByAdmin(app.db, {
          adminId: session.user_id,
          customerId: cid,
          provider,
          fields,
        }, makeCtx(req, session));
        requestId = r.requestId;
      } catch (err) {
        return rerenderErr(err);
      }
      reply.redirect(`/admin/customers/${cid}/credential-requests/${requestId}`, 302);
    });

  app.get('/admin/customers/:cid/credential-requests/:id', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const { cid, id } = req.params ?? {};
    if (!UUID_RE.test(cid) || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    const request = await findCredentialRequestById(app.db, id);
    if (!customer || !request || request.customer_id !== cid) return notFound(req, reply);
    return renderAdmin(req, reply, 'admin/credential-requests/detail', {
      title: `Credential request · ${request.provider}`,
      customer,
      request,
      csrfToken: await reply.generateCsrf(),
      mainWidth: 'wide',
      ...customerChrome(customer, 'credential-requests'),
    });
  });

  app.post('/admin/customers/:cid/credential-requests/:id/cancel',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;
      const { cid, id } = req.params ?? {};
      if (!UUID_RE.test(cid) || !UUID_RE.test(id)) return notFound(req, reply);
      const customer = await findCustomerById(app.db, cid);
      const request = await findCredentialRequestById(app.db, id);
      if (!customer || !request || request.customer_id !== cid) return notFound(req, reply);

      try {
        await crService.cancelByAdmin(app.db, {
          adminId: session.user_id, requestId: id,
        }, makeCtx(req, session));
      } catch (err) {
        reply.code(422);
        return renderAdmin(req, reply, 'admin/credential-requests/detail', {
          title: `Credential request · ${request.provider}`,
          customer,
          request,
          csrfToken: await reply.generateCsrf(),
          error: err.message,
          mainWidth: 'wide',
          ...customerChrome(customer, 'credential-requests'),
        });
      }
      reply.redirect(`/admin/customers/${cid}/credential-requests/${id}`, 302);
    });
}
