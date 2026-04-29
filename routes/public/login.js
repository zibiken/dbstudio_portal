import { renderPublic } from '../../lib/render.js';
import { checkLockout, recordFail, reset as resetBucket } from '../../lib/auth/rate-limit.js';
import { createSession, computeDeviceFingerprint } from '../../lib/auth/session.js';
import { setSessionCookie } from '../../lib/auth/middleware.js';
import * as adminsService from '../../domain/admins/service.js';
import { writeAudit } from '../../lib/audit.js';

const LIMIT = 5;
const WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 30 * 60_000;

const GENERIC_ERROR = 'Email or password is incorrect.';

function ipBucket(req) {
  return `login:ip:${req.ip ?? 'unknown'}`;
}

function emailBucket(email) {
  return `login:email:${(email ?? '').trim().toLowerCase()}`;
}

export function registerLoginRoutes(app) {
  app.get('/login', async (req, reply) => {
    return renderPublic(req, reply, 'public/login', {
      title: 'Sign in',
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/login', { preHandler: app.csrfProtection }, async (req, reply) => {
    const { email, password } = req.body ?? {};
    const ipKey = ipBucket(req);
    const emailKey = emailBucket(email);

    // Lock if EITHER bucket is over: ip-only protects against single-source
    // brute force; email-only protects the account from distributed attacks
    // through rotating IPs.
    const [ipLock, emailLock] = await Promise.all([
      checkLockout(app.db, ipKey),
      checkLockout(app.db, emailKey),
    ]);
    if (ipLock.locked || emailLock.locked) {
      reply.code(429);
      return renderPublic(req, reply, 'public/login', {
        title: 'Sign in',
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Try again later.',
      });
    }

    const admin = typeof email === 'string' && typeof password === 'string'
      ? await adminsService.verifyLogin(app.db, { email, password })
      : null;

    if (!admin) {
      await Promise.all([
        recordFail(app.db, ipKey, { limit: LIMIT, windowMs: WINDOW_MS, lockoutMs: LOCKOUT_MS }),
        recordFail(app.db, emailKey, { limit: LIMIT, windowMs: WINDOW_MS, lockoutMs: LOCKOUT_MS }),
      ]);
      await writeAudit(app.db, {
        actorType: 'system',
        action: 'admin.login_failed',
        metadata: { email: typeof email === 'string' ? email : null },
        ip: req.ip ?? null,
      });
      reply.code(401);
      return renderPublic(req, reply, 'public/login', {
        title: 'Sign in',
        csrfToken: await reply.generateCsrf(),
        error: GENERIC_ERROR,
      });
    }

    await Promise.all([resetBucket(app.db, ipKey), resetBucket(app.db, emailKey)]);
    const fingerprint = computeDeviceFingerprint(req.headers['user-agent'], req.ip);
    const sid = await createSession(app.db, {
      userType: 'admin',
      userId: admin.id,
      ip: req.ip ?? null,
      deviceFingerprint: fingerprint,
    });
    setSessionCookie(reply, sid, app.env);
    await writeAudit(app.db, {
      actorType: 'admin',
      actorId: admin.id,
      action: 'admin.login_password_verified',
      metadata: {},
      ip: req.ip ?? null,
    });

    reply.redirect('/login/2fa', 302);
  });
}
