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

function bucketKey(req, email) {
  const id = (email ?? '').trim().toLowerCase();
  return `login:${req.ip ?? 'unknown'}:${id}`;
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
    const key = bucketKey(req, email);

    const lock = await checkLockout(app.db, key);
    if (lock.locked) {
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
      await recordFail(app.db, key, { limit: LIMIT, windowMs: WINDOW_MS, lockoutMs: LOCKOUT_MS });
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

    await resetBucket(app.db, key);
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
