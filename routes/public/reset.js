import { sql } from 'kysely';
import { renderPublic } from '../../lib/render.js';
import { checkLockout, recordFail } from '../../lib/auth/rate-limit.js';
import { clusterKeyForResetEmail } from '../../lib/auth/email-cluster.js';
import { computeDeviceFingerprint } from '../../lib/auth/session.js';
import { setSessionCookie } from '../../lib/auth/middleware.js';
import * as adminsService from '../../domain/admins/service.js';
import * as customersService from '../../domain/customers/service.js';

// Password reset flow.
//
//   GET  /reset                → email form
//   POST /reset                → mints a fresh invite-token row on the
//                                matching admin OR customer (or no-ops
//                                if no match). Always renders the same
//                                neutral "Check your email" page —
//                                no enumeration of either user-type.
//
//   GET  /reset/:token         → admin reset surface. Renders
//                                public/reset-set with a password
//                                field + TOTP-or-backup field. NO QR:
//                                this is a reset, not a first-time
//                                enrolment. The user's existing
//                                authenticator entry continues to work
//                                and we verify proof-of-possession
//                                from it. Refuses if the token is
//                                unknown, consumed, or the admin has
//                                no totp_secret_enc yet (in that case
//                                the user must walk /welcome instead
//                                — first-time setup is a different
//                                flow).
//   POST /reset/:token         → calls adminsService.completePasswordReset.
//                                Sets the new password, leaves
//                                totp_secret_enc + backup_codes
//                                untouched, mints a session + step-up,
//                                redirects to /admin/customers.
//
//   GET/POST /customer/reset/:token → mirror for customer_users via
//                                customersService.completePasswordReset.
//                                On success redirects to
//                                /customer/dashboard.
//
// /welcome/:token (first-time) and /customer/welcome/:token (first-
// time) live in routes/public/welcome.js and routes/customer/onboarding.js
// respectively — those flows enrol fresh TOTP and are NOT used for
// reset. Reset is a strictly password-only operation.

const RESET_LIMIT = 5;
const RESET_WINDOW_MS = 15 * 60_000;
const RESET_LOCKOUT_MS = 30 * 60_000;

async function findAdminByResetToken(db, token) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const r = await sql`
    SELECT id, email, totp_secret_enc, invite_consumed_at, invite_expires_at
      FROM admins
     WHERE invite_token_hash = ${hash}
  `.execute(db);
  const row = r.rows[0];
  if (!row) return { error: 'invalid' };
  if (row.invite_consumed_at) return { error: 'consumed' };
  if (new Date(row.invite_expires_at).getTime() <= Date.now()) return { error: 'expired' };
  if (!row.totp_secret_enc) return { error: 'not-enrolled' };
  return { admin: row };
}

async function findCustomerUserByResetToken(db, token) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const r = await sql`
    SELECT cu.id AS user_id, cu.email::text AS email, cu.totp_secret_enc,
           cu.invite_consumed_at, cu.invite_expires_at,
           c.status AS customer_status
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.invite_token_hash = ${hash}
  `.execute(db);
  const row = r.rows[0];
  if (!row) return { error: 'invalid' };
  if (row.invite_consumed_at) return { error: 'consumed' };
  if (new Date(row.invite_expires_at).getTime() <= Date.now()) return { error: 'expired' };
  if (row.customer_status !== 'active') return { error: 'inactive' };
  if (!row.totp_secret_enc) return { error: 'not-enrolled' };
  return { user: row };
}

function invalidLink(req, reply, title) {
  reply.code(410).type('text/html');
  return renderPublic(req, reply, 'public/welcome-invalid', {
    title,
    hero: { eyebrow: 'DB STUDIO PORTAL', title: 'This link has expired', lead: null },
  });
}

function renderResetForm(req, reply, { action, title, error = null, csrfToken }) {
  return renderPublic(req, reply, 'public/reset-set', {
    title,
    action,
    csrfToken,
    error,
    hero: {
      eyebrow: 'DB STUDIO PORTAL',
      title: 'Set a new password',
      lead: 'Choose a new password and confirm with a code from your authenticator app (or one of your unconsumed backup codes). Your existing authenticator entry continues to work — this only changes the password.',
    },
  });
}

export function registerResetRoutes(app) {
  // ── Entry: ask for an email, send a reset link ──────────────────────

  app.get('/reset', async (req, reply) => {
    return renderPublic(req, reply, 'public/reset-request', {
      title: 'Reset your password',
      csrfToken: await reply.generateCsrf(),
      hero: {
        eyebrow: 'DB STUDIO PORTAL',
        title: 'Reset your password',
        lead: 'Enter the email on your account. If it matches, we\'ll send you a single-use link to set a new password.',
      },
    });
  });

  app.post('/reset', { preHandler: app.csrfProtection }, async (req, reply) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const ipKey = `reset:ip:${req.ip ?? 'unknown'}`;
    const emailKey = `reset:email:${email.toLowerCase()}`;
    // Levenshtein-1 cluster bucket: catches typo loops where each
    // attempt uses a slightly different non-existent email so the
    // per-exact-email bucket never accumulates. The cluster
    // representative is the lex-smallest email within edit-distance 1
    // of the current attempt across recent reset buckets.
    const clusterRep = email
      ? await clusterKeyForResetEmail(app.db, email, {
          windowMs: RESET_WINDOW_MS,
          lockoutMs: RESET_LOCKOUT_MS,
        })
      : 'unknown';
    const clusterKey = `reset:cluster:${clusterRep}`;

    const [ipLock, emailLock, clusterLock] = await Promise.all([
      checkLockout(app.db, ipKey),
      checkLockout(app.db, emailKey),
      checkLockout(app.db, clusterKey),
    ]);
    if (ipLock.locked || emailLock.locked || clusterLock.locked) {
      reply.code(429);
      return renderPublic(req, reply, 'public/reset-request', {
        title: 'Reset your password',
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Try again later.',
        hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Reset your password', lead: 'Enter the email on your account.' },
      });
    }

    if (email) {
      const ctx = {
        actorType: 'system',
        ip: req.ip ?? null,
        userAgentHash: null,
        audit: { source: 'public_reset_form' },
        portalBaseUrl: app.env.PORTAL_BASE_URL,
      };
      try {
        await adminsService.requestPasswordReset(app.db, { email }, ctx);
      } catch (_) { /* never leak which type matched */ }
      try {
        await customersService.requestCustomerPasswordReset(app.db, { email }, { ...ctx, kek: app.kek });
      } catch (_) { /* never leak which type matched */ }
    }
    await Promise.all([
      recordFail(app.db, ipKey,      { limit: RESET_LIMIT, windowMs: RESET_WINDOW_MS, lockoutMs: RESET_LOCKOUT_MS }),
      recordFail(app.db, emailKey,   { limit: RESET_LIMIT, windowMs: RESET_WINDOW_MS, lockoutMs: RESET_LOCKOUT_MS }),
      recordFail(app.db, clusterKey, { limit: RESET_LIMIT, windowMs: RESET_WINDOW_MS, lockoutMs: RESET_LOCKOUT_MS }),
    ]);

    return renderPublic(req, reply, 'public/reset-sent', {
      title: 'Check your email',
      hero: {
        eyebrow: 'DB STUDIO PORTAL',
        title: 'Check your email',
        lead: 'If the address matches an account, a single-use reset link is on its way. The link expires in 7 days.',
      },
    });
  });

  // ── Admin reset: /reset/:token ──────────────────────────────────────

  app.get('/reset/:token', async (req, reply) => {
    const found = await findAdminByResetToken(app.db, req.params.token);
    if (found.error) return invalidLink(req, reply, 'Reset your password');
    return renderResetForm(req, reply, {
      action: `/reset/${encodeURIComponent(req.params.token)}`,
      title: 'Set a new password',
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/reset/:token', { preHandler: app.csrfProtection }, async (req, reply) => {
    const { token } = req.params;
    const body = req.body ?? {};
    const password = typeof body.password === 'string' ? body.password : '';
    const totpCode = typeof body.totp_code === 'string' ? body.totp_code.trim() : '';
    const backupCode = typeof body.backup_code === 'string' ? body.backup_code.trim() : '';

    if (password.length < 12) {
      reply.code(422);
      return renderResetForm(req, reply, {
        action: `/reset/${encodeURIComponent(token)}`,
        title: 'Set a new password',
        csrfToken: await reply.generateCsrf(),
        error: 'Password must be at least 12 characters.',
      });
    }
    if (!totpCode && !backupCode) {
      reply.code(422);
      return renderResetForm(req, reply, {
        action: `/reset/${encodeURIComponent(token)}`,
        title: 'Set a new password',
        csrfToken: await reply.generateCsrf(),
        error: 'Enter a 6-digit code from your authenticator OR an unconsumed backup code.',
      });
    }

    let result;
    try {
      result = await adminsService.completePasswordReset(
        app.db,
        {
          token,
          newPassword: password,
          totpCode: totpCode || null,
          backupCode: backupCode || null,
          kek: app.kek,
          sessionIp: req.ip ?? null,
          sessionDeviceFingerprint: computeDeviceFingerprint(req.headers['user-agent'], req.ip),
        },
        { actorType: 'admin', ip: req.ip ?? null, userAgentHash: null },
      );
    } catch (err) {
      reply.code(422);
      return renderResetForm(req, reply, {
        action: `/reset/${encodeURIComponent(token)}`,
        title: 'Set a new password',
        csrfToken: await reply.generateCsrf(),
        error: /breach|compromised|pwned/i.test(err.message)
          ? 'That password appears in a known data breach. Choose a different one.'
          : err.message,
      });
    }

    setSessionCookie(reply, result.sid, app.env);
    reply.redirect('/admin/customers', 302);
  });

  // ── Customer reset: /customer/reset/:token ──────────────────────────

  app.get('/customer/reset/:token', async (req, reply) => {
    const found = await findCustomerUserByResetToken(app.db, req.params.token);
    if (found.error) return invalidLink(req, reply, 'Reset your password');
    return renderResetForm(req, reply, {
      action: `/customer/reset/${encodeURIComponent(req.params.token)}`,
      title: 'Set a new password',
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/customer/reset/:token', { preHandler: app.csrfProtection }, async (req, reply) => {
    const { token } = req.params;
    const body = req.body ?? {};
    const password = typeof body.password === 'string' ? body.password : '';
    const totpCode = typeof body.totp_code === 'string' ? body.totp_code.trim() : '';
    const backupCode = typeof body.backup_code === 'string' ? body.backup_code.trim() : '';

    if (password.length < 12) {
      reply.code(422);
      return renderResetForm(req, reply, {
        action: `/customer/reset/${encodeURIComponent(token)}`,
        title: 'Set a new password',
        csrfToken: await reply.generateCsrf(),
        error: 'Password must be at least 12 characters.',
      });
    }
    if (!totpCode && !backupCode) {
      reply.code(422);
      return renderResetForm(req, reply, {
        action: `/customer/reset/${encodeURIComponent(token)}`,
        title: 'Set a new password',
        csrfToken: await reply.generateCsrf(),
        error: 'Enter a 6-digit code from your authenticator OR an unconsumed backup code.',
      });
    }

    let result;
    try {
      result = await customersService.completePasswordReset(
        app.db,
        {
          token,
          newPassword: password,
          totpCode: totpCode || null,
          backupCode: backupCode || null,
          kek: app.kek,
          sessionIp: req.ip ?? null,
          sessionDeviceFingerprint: computeDeviceFingerprint(req.headers['user-agent'], req.ip),
        },
        { actorType: 'customer', ip: req.ip ?? null, userAgentHash: null },
      );
    } catch (err) {
      reply.code(422);
      return renderResetForm(req, reply, {
        action: `/customer/reset/${encodeURIComponent(token)}`,
        title: 'Set a new password',
        csrfToken: await reply.generateCsrf(),
        error: /breach|compromised|pwned/i.test(err.message)
          ? 'That password appears in a known data breach. Choose a different one.'
          : err.message,
      });
    }

    setSessionCookie(reply, result.sid, app.env);
    reply.redirect('/customer/dashboard', 302);
  });
}
