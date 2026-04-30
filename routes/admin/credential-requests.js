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
  return renderAdmin(req, reply, 'admin/customers/not-found', { title: 'Not found' });
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

// Parses the indexed-form-field shape used by the new-request form:
//   field_name[0], field_label[0], field_type[0], field_required[0],
//   field_name[1], ...
// Falls through with empty arrays — service.createByAdmin then rejects
// "fields must be a non-empty array" and the route re-renders with the
// error.
function parseFieldsFromBody(body) {
  const out = [];
  const names = body.field_name;
  if (!names) return out;
  const arr = Array.isArray(names) ? names : [names];
  for (let i = 0; i < arr.length; i += 1) {
    const get = (k) => {
      const v = body[k];
      if (v === undefined || v === null) return undefined;
      return Array.isArray(v) ? v[i] : (i === 0 ? v : undefined);
    };
    const name = (get('field_name') ?? '').toString().trim();
    if (!name) continue;
    out.push({
      name,
      label: (get('field_label') ?? '').toString().trim(),
      type: (get('field_type') ?? 'text').toString(),
      required: get('field_required') === 'on' || get('field_required') === 'true',
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
        });
      }
      reply.redirect(`/admin/customers/${cid}/credential-requests/${id}`, 302);
    });
}
