import { sql } from 'kysely';
import { renderCustomer, renderPublic } from '../../lib/render.js';
import { requireCustomerSession, clearSessionCookie } from '../../lib/auth/middleware.js';
import { deriveEnrolSecret, otpauthUri } from '../../lib/auth/totp-enrol.js';
import * as customerUsersService from '../../domain/customer-users/service.js';

const TOTP_ISSUER = 'DB Studio Portal';
const TOTP_REGEN_SALT = ':2fa-totp-regen';

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

  // 2FA TOTP regen — two-step flow.
  // Step 1: GET /customer/profile/2fa shows the new QR (derived from sid +
  // signing-secret so it survives a tab refresh) plus a single form
  // requiring (current-TOTP-code, new-TOTP-code). Step 2: POST verifies
  // both and swaps the secret. The pending secret never persists; if the
  // user logs out before confirming, the next regen attempt simply derives
  // a fresh one.
  app.get('/customer/profile/2fa', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/', 302);
    const newSecret = deriveEnrolSecret(session.id + TOTP_REGEN_SALT, app.env.SESSION_SIGNING_SECRET);
    return renderCustomer(req, reply, 'customer/profile/totp-regen', {
      title: 'Regenerate two-factor (TOTP)',
      profile,
      newSecret,
      otpauthUri: otpauthUri(profile.email, TOTP_ISSUER, newSecret),
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/customer/profile/2fa', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/', 302);
    const newSecret = deriveEnrolSecret(session.id + TOTP_REGEN_SALT, app.env.SESSION_SIGNING_SECRET);
    const currentCode = typeof req.body?.current_code === 'string' ? req.body.current_code.trim() : '';
    const newCode = typeof req.body?.new_code === 'string' ? req.body.new_code.trim() : '';

    try {
      await customerUsersService.regenTotp(
        app.db,
        { customerUserId: session.user_id, currentCode, newSecret, newCode },
        { ...makeCtx(req, session, app), kek: app.kek },
      );
    } catch (err) {
      reply.code(422);
      return renderCustomer(req, reply, 'customer/profile/totp-regen', {
        title: 'Regenerate two-factor (TOTP)',
        profile,
        newSecret,
        otpauthUri: otpauthUri(profile.email, TOTP_ISSUER, newSecret),
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    reply.redirect('/customer/profile?totp_regenerated=1', 302);
  });

  app.get('/customer/profile/sessions', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/', 302);
    const sessions = await customerUsersService.listSessions(
      app.db,
      { customerUserId: session.user_id, currentSessionId: session.id },
    );
    return renderCustomer(req, reply, 'customer/profile/sessions', {
      title: 'Active sessions',
      profile,
      sessions,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/customer/profile/sessions/:sid/revoke', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const target = req.params?.sid;
    try {
      await customerUsersService.revokeSession(
        app.db,
        { customerUserId: session.user_id, sessionId: target },
        makeCtx(req, session, app),
      );
    } catch {
      // Either not the user's session or already revoked — surface as 404
      // rather than leaking which.
      reply.code(404);
      return renderCustomer(req, reply, 'customer/profile/sessions', {
        title: 'Active sessions',
        profile: await loadProfile(app, session),
        sessions: await customerUsersService.listSessions(
          app.db,
          { customerUserId: session.user_id, currentSessionId: session.id },
        ),
        csrfToken: await reply.generateCsrf(),
        error: 'That session is no longer active.',
      });
    }
    if (target === session.id) {
      clearSessionCookie(reply, app.env);
      return reply.redirect('/', 302);
    }
    reply.redirect('/customer/profile/sessions', 302);
  });

  app.post('/customer/profile/sessions/revoke-all', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const includeCurrent = req.body?.include_current === '1' || req.body?.include_current === 'on';
    await customerUsersService.revokeAllSessions(
      app.db,
      {
        customerUserId: session.user_id,
        exceptSessionId: includeCurrent ? null : session.id,
      },
      makeCtx(req, session, app),
    );
    if (includeCurrent) {
      clearSessionCookie(reply, app.env);
      return reply.redirect('/', 302);
    }
    reply.redirect('/customer/profile/sessions', 302);
  });

  app.get('/customer/profile/backup-codes', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/', 302);
    return renderCustomer(req, reply, 'customer/profile/backup-codes-regen', {
      title: 'Regenerate backup codes',
      profile,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/customer/profile/backup-codes', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/', 302);
    const totpCode = typeof req.body?.totp_code === 'string' ? req.body.totp_code.trim() : '';
    const backupCode = typeof req.body?.backup_code === 'string' ? req.body.backup_code.trim() : '';

    let result;
    try {
      result = await customerUsersService.regenBackupCodes(
        app.db,
        {
          customerUserId: session.user_id,
          currentCode: totpCode || null,
          backupCode: backupCode || null,
        },
        { ...makeCtx(req, session, app), kek: app.kek },
      );
    } catch (err) {
      reply.code(422);
      return renderCustomer(req, reply, 'customer/profile/backup-codes-regen', {
        title: 'Regenerate backup codes',
        profile,
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    return renderCustomer(req, reply, 'customer/profile/backup-codes-show', {
      title: 'Save your new backup codes',
      profile,
      codes: result.codes,
    });
  });

  app.post('/customer/profile/password', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const currentPassword = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
    const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';

    try {
      await customerUsersService.changePassword(
        app.db,
        {
          customerUserId: session.user_id,
          currentPassword,
          newPassword,
          currentSessionId: session.id,
        },
        { ...makeCtx(req, session, app), hibpHasBeenPwned: app.hibpHasBeenPwned },
      );
    } catch (err) {
      reply.code(422);
      return renderIndex(req, reply, app, session, {
        passwordError: /breach|compromised|pwned/i.test(err.message)
          ? 'That password appears in a known data breach. Choose a different one.'
          : err.message,
      });
    }
    reply.redirect('/customer/profile?password_changed=1', 302);
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
