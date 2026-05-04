import { sql } from 'kysely';
import { renderAdmin, renderPublic } from '../../lib/render.js';
import { readSession, requireAdminSession, clearSessionCookie } from '../../lib/auth/middleware.js';
import { deriveEnrolSecret, otpauthUri } from '../../lib/auth/totp-enrol.js';
import { checkLockout, recordFail, reset as resetBucket } from '../../lib/auth/rate-limit.js';
import * as adminsService from '../../domain/admins/service.js';

const TOTP_ISSUER = 'DB Studio Portal';
const TOTP_REGEN_SALT = ':admin-2fa-totp-regen';

// M9 review I2 — rate limits, mirroring the customer side.
const RL_PASSWORD = { limit: 5, windowMs: 15 * 60_000, lockoutMs: 30 * 60_000 };
const RL_EMAIL_REQUEST = { limit: 3, windowMs: 60 * 60_000, lockoutMs: 60 * 60_000 };
const RL_EMAIL_VERIFY = { limit: 5, windowMs: 5 * 60_000, lockoutMs: 30 * 60_000 };
const RL_TOTP_REGEN = { limit: 5, windowMs: 5 * 60_000, lockoutMs: 30 * 60_000 };
const RL_BACKUP_REGEN = { limit: 5, windowMs: 15 * 60_000, lockoutMs: 30 * 60_000 };
const RL_EMAIL_REVERT = { limit: 5, windowMs: 60 * 60_000, lockoutMs: 60 * 60_000 };

async function loadProfile(app, session) {
  const r = await sql`
    SELECT id::text AS id, email, name FROM admins WHERE id = ${session.user_id}::uuid
  `.execute(app.db);
  return r.rows[0] ?? null;
}

async function loadInflightEmailChange(app, session) {
  const r = await sql`
    SELECT id::text AS id, new_email, verify_expires_at
      FROM email_change_requests
     WHERE user_type = 'admin'
       AND user_id = ${session.user_id}::uuid
       AND verified_at IS NULL AND cancelled_at IS NULL
     ORDER BY created_at DESC LIMIT 1
  `.execute(app.db);
  return r.rows[0] ?? null;
}

function makeCtx(req, session, app) {
  return {
    actorType: 'admin',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    audit: {},
    portalBaseUrl: app.env.PORTAL_BASE_URL,
  };
}

async function renderIndex(req, reply, app, session, extra = {}) {
  const profile = await loadProfile(app, session);
  // 303: helper is called from POST handlers too (name/password/email),
  // so the bounce can be a POST → GET redirect. 303 is correct in both
  // GET and POST callers (browsers do GET on /login regardless).
  if (!profile) return reply.redirect('/login', 303);
  const inflight = await loadInflightEmailChange(app, session);
  return renderAdmin(req, reply, 'admin/profile/index', {
    title: 'Profile',
    profile,
    inflight,
    csrfToken: await reply.generateCsrf(),
    activeNav: 'profile',
    mainWidth: 'wide',
    sectionLabel: 'ADMIN · PROFILE',
    ...extra,
  });
}

export function registerAdminProfileRoutes(app) {
  app.get('/admin/profile', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    return renderIndex(req, reply, app, session);
  });

  app.post('/admin/profile/name', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    try {
      await adminsService.updateAdminName(
        app.db, { adminId: session.user_id, name }, makeCtx(req, session, app),
      );
    } catch (err) {
      reply.code(422);
      return renderIndex(req, reply, app, session, { nameError: err.message, nameDraft: name });
    }
    reply.redirect('/admin/profile', 303);
  });

  app.post('/admin/profile/password', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const bucket = `pw_change:admin:${session.user_id}`;
    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      reply.code(429);
      return renderIndex(req, reply, app, session, {
        passwordError: 'Too many attempts. Try again later.',
      });
    }
    const currentPassword = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
    const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
    try {
      await adminsService.changeAdminPassword(
        app.db,
        { adminId: session.user_id, currentPassword, newPassword, currentSessionId: session.id },
        { ...makeCtx(req, session, app), hibpHasBeenPwned: app.hibpHasBeenPwned },
      );
    } catch (err) {
      await recordFail(app.db, bucket, RL_PASSWORD);
      reply.code(422);
      return renderIndex(req, reply, app, session, {
        passwordError: /breach|compromised|pwned/i.test(err.message)
          ? 'That password appears in a known data breach. Choose a different one.'
          : err.message,
      });
    }
    await resetBucket(app.db, bucket);
    reply.redirect('/admin/profile?password_changed=1', 303);
  });

  app.post('/admin/profile/email', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const bucket = `email_change_req:admin:${session.user_id}`;
    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      reply.code(429);
      return renderIndex(req, reply, app, session, {
        emailError: 'Too many email-change attempts. Try again later.',
      });
    }
    const newEmail = typeof req.body?.new_email === 'string' ? req.body.new_email : '';
    try {
      await adminsService.requestAdminEmailChange(
        app.db, { adminId: session.user_id, newEmail }, makeCtx(req, session, app),
      );
    } catch (err) {
      await recordFail(app.db, bucket, RL_EMAIL_REQUEST);
      reply.code(422);
      return renderIndex(req, reply, app, session, { emailError: err.message, emailDraft: newEmail });
    }
    await recordFail(app.db, bucket, RL_EMAIL_REQUEST);
    reply.redirect('/admin/profile?email_change=requested', 303);
  });

  app.get('/admin/profile/email/verify/:token', async (req, reply) => {
    // I3 (M9 review): see routes/customer/profile.js for the rationale.
    // Surface the pending-email-verify hint on the sign-in surface
    // instead of a silent bounce.
    const raw = await readSession(app, req);
    if (!raw || raw.user_type !== 'admin' || !raw.step_up_at) {
      const ret = encodeURIComponent(`/admin/profile/email/verify/${req.params.token}`);
      return reply.redirect(`/login?email_verify_pending=1&return=${ret}`, 302);
    }
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    return renderAdmin(req, reply, 'admin/profile/email-verify', {
      title: 'Confirm new email address',
      token: req.params.token,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/admin/profile/email/verify/:token', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const bucket = `email_change_verify:admin:${session.user_id}`;
    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      reply.code(429);
      return renderAdmin(req, reply, 'admin/profile/email-verify', {
        title: 'Confirm new email address',
        token: req.params.token,
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Try again later.',
      });
    }
    try {
      await adminsService.verifyAdminEmailChange(
        app.db, { token: req.params.token }, makeCtx(req, session, app),
      );
    } catch (err) {
      await recordFail(app.db, bucket, RL_EMAIL_VERIFY);
      reply.code(422);
      return renderAdmin(req, reply, 'admin/profile/email-verify', {
        title: 'Confirm new email address',
        token: req.params.token,
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    await resetBucket(app.db, bucket);
    reply.redirect('/admin/profile?email_change=verified', 303);
  });

  // Revert is intentionally not session-gated: the link arrives at the
  // previous email address because the previous account holder doesn't
  // recognise the change.
  app.get('/admin/profile/email/revert/:token', async (req, reply) => {
    return renderPublic(req, reply, 'admin/profile/email-revert', {
      title: 'Revert email change',
      token: req.params.token,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/admin/profile/email/revert/:token', { preHandler: app.csrfProtection }, async (req, reply) => {
    const bucket = `email_change_revert:admin_ip:${req.ip ?? 'unknown'}`;
    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      reply.code(429);
      return renderPublic(req, reply, 'admin/profile/email-revert', {
        title: 'Revert email change',
        token: req.params.token,
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Try again later.',
      });
    }
    try {
      await adminsService.revertAdminEmailChange(
        app.db, { token: req.params.token },
        { actorType: 'admin', ip: req.ip ?? null, userAgentHash: null, audit: {}, portalBaseUrl: app.env.PORTAL_BASE_URL },
      );
    } catch (err) {
      await recordFail(app.db, bucket, RL_EMAIL_REVERT);
      reply.code(422);
      return renderPublic(req, reply, 'admin/profile/email-revert', {
        title: 'Revert email change',
        token: req.params.token,
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    await resetBucket(app.db, bucket);
    clearSessionCookie(reply, app.env);
    return renderPublic(req, reply, 'admin/profile/email-revert-done', {
      title: 'Email change reverted',
    });
  });

  app.get('/admin/profile/2fa', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/login', 302);
    const newSecret = deriveEnrolSecret(session.id + TOTP_REGEN_SALT, app.env.SESSION_SIGNING_SECRET);
    return renderAdmin(req, reply, 'admin/profile/totp-regen', {
      title: 'Regenerate two-factor (TOTP)',
      profile,
      newSecret,
      otpauthUri: otpauthUri(profile.email, TOTP_ISSUER, newSecret),
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/admin/profile/2fa', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/login', 303);
    const newSecret = deriveEnrolSecret(session.id + TOTP_REGEN_SALT, app.env.SESSION_SIGNING_SECRET);
    const bucket = `totp_regen:admin:${session.user_id}`;
    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      reply.code(429);
      return renderAdmin(req, reply, 'admin/profile/totp-regen', {
        title: 'Regenerate two-factor (TOTP)',
        profile,
        newSecret,
        otpauthUri: otpauthUri(profile.email, TOTP_ISSUER, newSecret),
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Try again later.',
      });
    }
    const currentCode = typeof req.body?.current_code === 'string' ? req.body.current_code.trim() : '';
    const newCode = typeof req.body?.new_code === 'string' ? req.body.new_code.trim() : '';
    try {
      await adminsService.regenAdminTotpSelf(
        app.db,
        { adminId: session.user_id, currentCode, newSecret, newCode },
        { ...makeCtx(req, session, app), kek: app.kek },
      );
    } catch (err) {
      await recordFail(app.db, bucket, RL_TOTP_REGEN);
      reply.code(422);
      return renderAdmin(req, reply, 'admin/profile/totp-regen', {
        title: 'Regenerate two-factor (TOTP)',
        profile,
        newSecret,
        otpauthUri: otpauthUri(profile.email, TOTP_ISSUER, newSecret),
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    await resetBucket(app.db, bucket);
    reply.redirect('/admin/profile?totp_regenerated=1', 303);
  });

  app.get('/admin/profile/backup-codes', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/login', 302);
    return renderAdmin(req, reply, 'admin/profile/backup-codes-regen', {
      title: 'Regenerate backup codes',
      profile,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/admin/profile/backup-codes', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/login', 303);
    const bucket = `backup_regen:admin:${session.user_id}`;
    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      reply.code(429);
      return renderAdmin(req, reply, 'admin/profile/backup-codes-regen', {
        title: 'Regenerate backup codes',
        profile,
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Try again later.',
      });
    }
    const totpCode = typeof req.body?.totp_code === 'string' ? req.body.totp_code.trim() : '';
    const backupCode = typeof req.body?.backup_code === 'string' ? req.body.backup_code.trim() : '';
    let result;
    try {
      result = await adminsService.regenAdminBackupCodesSelf(
        app.db,
        {
          adminId: session.user_id,
          currentCode: totpCode || null,
          backupCode: backupCode || null,
        },
        { ...makeCtx(req, session, app), kek: app.kek },
      );
    } catch (err) {
      await recordFail(app.db, bucket, RL_BACKUP_REGEN);
      reply.code(422);
      return renderAdmin(req, reply, 'admin/profile/backup-codes-regen', {
        title: 'Regenerate backup codes',
        profile,
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    await resetBucket(app.db, bucket);
    return renderAdmin(req, reply, 'admin/profile/backup-codes-show', {
      title: 'Save your new backup codes',
      profile,
      codes: result.codes,
    });
  });

  app.get('/admin/profile/sessions', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const profile = await loadProfile(app, session);
    if (!profile) return reply.redirect('/login', 302);
    const sessions = await adminsService.listAdminSessions(
      app.db, { adminId: session.user_id, currentSessionId: session.id },
    );
    return renderAdmin(req, reply, 'admin/profile/sessions', {
      title: 'Active sessions',
      profile,
      sessions,
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/admin/profile/sessions/:sid/revoke', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const target = req.params?.sid;
    try {
      await adminsService.revokeAdminSession(
        app.db, { adminId: session.user_id, sessionId: target }, makeCtx(req, session, app),
      );
    } catch {
      reply.code(404);
      const profile = await loadProfile(app, session);
      return renderAdmin(req, reply, 'admin/profile/sessions', {
        title: 'Active sessions',
        profile,
        sessions: await adminsService.listAdminSessions(
          app.db, { adminId: session.user_id, currentSessionId: session.id },
        ),
        csrfToken: await reply.generateCsrf(),
        error: 'That session is no longer active.',
      });
    }
    if (target === session.id) {
      clearSessionCookie(reply, app.env);
      return reply.redirect('/login', 303);
    }
    reply.redirect('/admin/profile/sessions', 303);
  });

  app.post('/admin/profile/sessions/revoke-all', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const includeCurrent = req.body?.include_current === '1' || req.body?.include_current === 'on';
    await adminsService.revokeAllAdminSessions(
      app.db,
      { adminId: session.user_id, exceptSessionId: includeCurrent ? null : session.id },
      makeCtx(req, session, app),
    );
    if (includeCurrent) {
      clearSessionCookie(reply, app.env);
      return reply.redirect('/login', 303);
    }
    reply.redirect('/admin/profile/sessions', 303);
  });
}
