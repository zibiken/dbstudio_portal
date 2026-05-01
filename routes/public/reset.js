import { registerWelcomeRoutes } from './welcome.js';
import { renderPublic } from '../../lib/render.js';
import { checkLockout, recordFail } from '../../lib/auth/rate-limit.js';
import * as adminsService from '../../domain/admins/service.js';
import * as customersService from '../../domain/customers/service.js';

// Mounts /reset/:token (the post-email reset flow — same handler as
// /welcome/:token via registerWelcomeRoutes), and adds GET + POST /reset
// for the "forgot my password — please email me a link" entry point.
//
//   GET  /reset       → email form (single field, neutral copy)
//   POST /reset       → tries admin lookup first via
//                       adminsService.requestPasswordReset (enqueues an
//                       admin-pw-reset email pointing at /reset/<token>);
//                       then customer lookup via
//                       customersService.requestCustomerPasswordReset
//                       (enqueues a customer-pw-reset email pointing at
//                       /customer/welcome/<token>). Both render the same
//                       neutral success page — no enumeration of either
//                       admin or customer email addresses.
//   GET  /reset/:token → admin reset surface — registerWelcomeRoutes,
//                       hits the existing welcome-style set-password +
//                       2FA-re-enrol form. Customer tokens are NOT
//                       valid here (this handler only consults the
//                       admins table); the customer-pw-reset email
//                       points the customer at /customer/welcome/<token>
//                       which is the customer-side equivalent.
const RESET_LIMIT = 5;
const RESET_WINDOW_MS = 15 * 60_000;
const RESET_LOCKOUT_MS = 30 * 60_000;

export function registerResetRoutes(app) {
  registerWelcomeRoutes(app, { mountPath: '/reset', title: 'Reset your password' });

  app.get('/reset', async (req, reply) => {
    return renderPublic(req, reply, 'public/reset-request', {
      title: 'Reset your password',
      csrfToken: await reply.generateCsrf(),
      hero: {
        eyebrow: 'DB STUDIO PORTAL',
        title: 'Reset your password',
        lead: 'Enter the email on your admin account. If it matches, we\'ll send you a single-use link to set a new password.',
      },
    });
  });

  app.post('/reset', { preHandler: app.csrfProtection }, async (req, reply) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const ipKey = `reset:ip:${req.ip ?? 'unknown'}`;
    const emailKey = `reset:email:${email.toLowerCase()}`;

    const [ipLock, emailLock] = await Promise.all([
      checkLockout(app.db, ipKey),
      checkLockout(app.db, emailKey),
    ]);
    if (ipLock.locked || emailLock.locked) {
      reply.code(429);
      return renderPublic(req, reply, 'public/reset-request', {
        title: 'Reset your password',
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Try again later.',
        hero: {
          eyebrow: 'DB STUDIO PORTAL',
          title: 'Reset your password',
          lead: 'Enter the email on your admin account.',
        },
      });
    }

    // Always run BOTH service paths so the wall-clock cost looks the
    // same whether the email matches an admin, a customer, or
    // nothing — no enumeration of either user-type. Each service
    // path no-ops (writes its own _unknown audit row) when the
    // address doesn't match.
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
      } catch (_) { /* never leak which type the address matched */ }
      try {
        await customersService.requestCustomerPasswordReset(app.db, { email }, { ...ctx, kek: app.kek });
      } catch (_) { /* never leak which type the address matched */ }
    }
    await Promise.all([
      recordFail(app.db, ipKey,    { limit: RESET_LIMIT, windowMs: RESET_WINDOW_MS, lockoutMs: RESET_LOCKOUT_MS }),
      recordFail(app.db, emailKey, { limit: RESET_LIMIT, windowMs: RESET_WINDOW_MS, lockoutMs: RESET_LOCKOUT_MS }),
    ]);

    return renderPublic(req, reply, 'public/reset-sent', {
      title: 'Check your email',
      hero: {
        eyebrow: 'DB STUDIO PORTAL',
        title: 'Check your email',
        lead: 'If the address matches an admin account, a single-use reset link is on its way. The link expires in 7 days.',
      },
    });
  });
}
