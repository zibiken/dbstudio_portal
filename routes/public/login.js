import { renderPublic } from '../../lib/render.js';
import { checkLockout, recordFail, reset as resetBucket } from '../../lib/auth/rate-limit.js';
import { createSession, computeDeviceFingerprint } from '../../lib/auth/session.js';
import { setSessionCookie } from '../../lib/auth/middleware.js';
import * as adminsService from '../../domain/admins/service.js';
import * as customersService from '../../domain/customers/service.js';
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
      hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Sign in', lead: 'Use your work email and password.' },
    });
  });

  app.post('/login', { preHandler: app.csrfProtection }, async (req, reply) => {
    const { email, password } = req.body ?? {};
    const ipKey = ipBucket(req);
    const emailKey = emailBucket(email);

    // Lock if EITHER bucket is over.
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
        hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Sign in', lead: 'Use your work email and password.' },
      });
    }

    const hasCredentials = typeof email === 'string' && typeof password === 'string';

    // Run both lookups in parallel so timing is constant regardless of
    // which table matches. Each service always runs argon2 (SENTINEL_HASH
    // on miss), so neither branch is measurably faster than the other.
    const [admin, customerCandidate] = hasCredentials
      ? await Promise.all([
          adminsService.verifyLogin(app.db, { email, password }),
          customersService.verifyLogin(app.db, { email, password }),
        ])
      : [null, null];

    // Admin takes precedence if both somehow match (email collision would
    // require the same address to exist in both tables, which the schema
    // does not prevent but operations policy forbids).
    const customer = !admin ? customerCandidate : null;

    if (!admin && !customer) {
      await Promise.all([
        recordFail(app.db, ipKey, { limit: LIMIT, windowMs: WINDOW_MS, lockoutMs: LOCKOUT_MS }),
        recordFail(app.db, emailKey, { limit: LIMIT, windowMs: WINDOW_MS, lockoutMs: LOCKOUT_MS }),
      ]);
      await writeAudit(app.db, {
        actorType: 'system',
        action: 'login_failed',
        metadata: { email: typeof email === 'string' ? email : null },
        ip: req.ip ?? null,
      });
      reply.code(401);
      return renderPublic(req, reply, 'public/login', {
        title: 'Sign in',
        csrfToken: await reply.generateCsrf(),
        error: GENERIC_ERROR,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Sign in', lead: 'Use your work email and password.' },
      });
    }

    await Promise.all([resetBucket(app.db, ipKey), resetBucket(app.db, emailKey)]);
    const fingerprint = computeDeviceFingerprint(req.headers['user-agent'], req.ip);

    if (admin) {
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
      return reply.redirect('/login/2fa', 302);
    }

    // Customer path — same half-auth session, same 2FA gate.
    const sid = await createSession(app.db, {
      userType: 'customer',
      userId: customer.id,
      ip: req.ip ?? null,
      deviceFingerprint: fingerprint,
    });
    setSessionCookie(reply, sid, app.env);
    await writeAudit(app.db, {
      actorType: 'customer',
      actorId: customer.id,
      action: 'customer.login_password_verified',
      metadata: {},
      ip: req.ip ?? null,
    });
    return reply.redirect('/login/2fa', 302);
  });
}
