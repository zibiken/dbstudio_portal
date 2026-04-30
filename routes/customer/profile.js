import { sql } from 'kysely';
import { renderCustomer, renderPublic } from '../../lib/render.js';
import { requireCustomerSession, clearSessionCookie } from '../../lib/auth/middleware.js';
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

async function loadInflightEmailChange(app, session) {
  const r = await sql`
    SELECT id::text AS id, new_email, verify_expires_at
      FROM email_change_requests
     WHERE user_type = 'customer_user'
       AND user_id = ${session.user_id}::uuid
       AND verified_at IS NULL
       AND cancelled_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
  `.execute(app.db);
  return r.rows[0] ?? null;
}

function makeCtx(req, session, app) {
  return {
    actorType: 'customer',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    audit: {},
    portalBaseUrl: app.env.PORTAL_BASE_URL,
  };
}

async function renderIndex(req, reply, app, session, extra = {}) {
  const profile = await loadProfile(app, session);
  if (!profile) return reply.redirect('/', 302);
  const inflight = await loadInflightEmailChange(app, session);
  return renderCustomer(req, reply, 'customer/profile/index', {
    title: 'Profile',
    profile,
    inflight,
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
        makeCtx(req, session, app),
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

  app.post('/customer/profile/email', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const newEmail = typeof req.body?.new_email === 'string' ? req.body.new_email : '';

    try {
      await customerUsersService.requestEmailChange(
        app.db,
        { customerUserId: session.user_id, newEmail },
        makeCtx(req, session, app),
      );
    } catch (err) {
      reply.code(422);
      return renderIndex(req, reply, app, session, {
        emailError: err.message,
        emailDraft: newEmail,
      });
    }
    reply.redirect('/customer/profile?email_change=requested', 302);
  });

  app.get('/customer/profile/email/verify/:token', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    return renderCustomer(req, reply, 'customer/profile/email-verify', {
      title: 'Confirm new email address',
      token: req.params.token,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/customer/profile/email/verify/:token', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    try {
      await customerUsersService.verifyEmailChange(
        app.db,
        { token: req.params.token },
        makeCtx(req, session, app),
      );
    } catch (err) {
      reply.code(422);
      return renderCustomer(req, reply, 'customer/profile/email-verify', {
        title: 'Confirm new email address',
        token: req.params.token,
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    reply.redirect('/customer/profile?email_change=verified', 302);
  });

  // Revert is intentionally not session-gated: the link arrives by email
  // because the previous account holder doesn't recognise the change. They
  // may have already lost their session (expected, in a hostile change).
  // The token IS the proof of authorisation.
  app.get('/customer/profile/email/revert/:token', async (_req, reply) => {
    return renderPublic(_req, reply, 'customer/profile/email-revert', {
      title: 'Revert email change',
      token: _req.params.token,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/customer/profile/email/revert/:token', { preHandler: app.csrfProtection }, async (req, reply) => {
    try {
      await customerUsersService.revertEmailChange(
        app.db,
        { token: req.params.token },
        {
          actorType: 'customer',
          ip: req.ip ?? null,
          userAgentHash: null,
          audit: {},
          portalBaseUrl: app.env.PORTAL_BASE_URL,
        },
      );
    } catch (err) {
      reply.code(422);
      return renderPublic(req, reply, 'customer/profile/email-revert', {
        title: 'Revert email change',
        token: req.params.token,
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    // Sessions for that user have all been revoked inside the tx — wipe
    // the cookie too so the in-flight browser is sent back to the login
    // surface cleanly.
    clearSessionCookie(reply, app.env);
    return renderPublic(req, reply, 'customer/profile/email-revert-done', {
      title: 'Email change reverted',
    });
  });
}
