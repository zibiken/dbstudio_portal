import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession } from '../../lib/auth/middleware.js';
import * as crService from '../../domain/credential-requests/service.js';
import {
  findCredentialRequestById,
  listForCustomer,
} from '../../domain/credential-requests/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function customerIdFor(app, session) {
  const r = await sql`
    SELECT customer_id::text AS customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
  `.execute(app.db);
  return r.rows[0]?.customer_id ?? null;
}

function notFound(req, reply) {
  reply.code(404);
  return renderCustomer(req, reply, 'customer/credential-requests/not-found', {
    title: 'Not found',
  });
}

function makeCtx(req, session, app) {
  return {
    actorType: 'customer',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    audit: {},
    kek: app.kek,
  };
}

export function registerCustomerCredentialRequestsRoutes(app) {
  app.get('/customer/credential-requests', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const customerId = await customerIdFor(app, session);
    if (!customerId) return notFound(req, reply);
    const requests = await listForCustomer(app.db, customerId);
    return renderCustomer(req, reply, 'customer/credential-requests/list', {
      title: 'Credential requests',
      requests,
    });
  });

  app.get('/customer/credential-requests/:id', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const customerId = await customerIdFor(app, session);
    if (!customerId) return notFound(req, reply);
    const id = req.params?.id;
    if (!UUID_RE.test(id)) return notFound(req, reply);
    const request = await findCredentialRequestById(app.db, id);
    if (!request || request.customer_id !== customerId) return notFound(req, reply);
    return renderCustomer(req, reply, 'customer/credential-requests/detail', {
      title: `Credential request · ${request.provider}`,
      request,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/customer/credential-requests/:id/fulfil',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireCustomerSession(app, req, reply);
      if (!session) return;
      const customerId = await customerIdFor(app, session);
      if (!customerId) return notFound(req, reply);
      const id = req.params?.id;
      if (!UUID_RE.test(id)) return notFound(req, reply);
      const request = await findCredentialRequestById(app.db, id);
      if (!request || request.customer_id !== customerId) return notFound(req, reply);

      const body = req.body ?? {};
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const payload = {};
      for (const f of request.fields) {
        const v = body[`field__${f.name}`];
        if (typeof v === 'string') payload[f.name] = v;
      }

      try {
        await crService.fulfilByCustomer(app.db, {
          customerUserId: session.user_id,
          requestId: id,
          payload,
          label: label || `${request.provider}`,
        }, makeCtx(req, session, app));
      } catch (err) {
        reply.code(422);
        return renderCustomer(req, reply, 'customer/credential-requests/detail', {
          title: `Credential request · ${request.provider}`,
          request,
          csrfToken: await reply.generateCsrf(),
          error: err.message,
          form: { label, payload },
        });
      }
      reply.redirect(`/customer/credential-requests/${id}`, 302);
    });

  app.post('/customer/credential-requests/:id/not-applicable',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireCustomerSession(app, req, reply);
      if (!session) return;
      const customerId = await customerIdFor(app, session);
      if (!customerId) return notFound(req, reply);
      const id = req.params?.id;
      if (!UUID_RE.test(id)) return notFound(req, reply);
      const request = await findCredentialRequestById(app.db, id);
      if (!request || request.customer_id !== customerId) return notFound(req, reply);

      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      try {
        await crService.markNotApplicableByCustomer(app.db, {
          customerUserId: session.user_id,
          requestId: id,
          reason,
        }, makeCtx(req, session, app));
      } catch (err) {
        reply.code(422);
        return renderCustomer(req, reply, 'customer/credential-requests/detail', {
          title: `Credential request · ${request.provider}`,
          request,
          csrfToken: await reply.generateCsrf(),
          error: err.message,
          form: { reason },
        });
      }
      reply.redirect(`/customer/credential-requests/${id}`, 302);
    });
}
