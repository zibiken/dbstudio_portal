import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession } from '../../lib/auth/middleware.js';
import * as customerUsersService from '../../domain/customer-users/service.js';

async function loadProfile(app, session) {
  const r = await sql`
    SELECT cu.id::text AS id,
           cu.email,
           cu.name,
           cu.customer_id::text AS customer_id,
           c.razon_social,
           c.status AS customer_status
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.id = ${session.user_id}::uuid
  `.execute(app.db);
  return r.rows[0] ?? null;
}

function makeCtx(req, session) {
  return {
    actorType: 'customer',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    audit: {},
  };
}

async function renderIndex(req, reply, app, session, extra = {}) {
  const profile = await loadProfile(app, session);
  if (!profile) return reply.redirect('/', 302);
  return renderCustomer(req, reply, 'customer/profile/index', {
    title: 'Profile',
    profile,
    csrfToken: await reply.generateCsrf(),
    ...extra,
  });
}

export function registerCustomerProfileRoutes(app) {
  app.get('/customer/profile', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    return renderIndex(req, reply, app, session);
  });

  app.post('/customer/profile/name', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const name = typeof req.body?.name === 'string' ? req.body.name : '';

    try {
      await customerUsersService.updateName(
        app.db,
        { customerUserId: session.user_id, name },
        makeCtx(req, session),
      );
    } catch (err) {
      reply.code(422);
      return renderIndex(req, reply, app, session, {
        nameError: err.message,
        nameDraft: name,
      });
    }
    reply.redirect('/customer/profile', 302);
  });
}
