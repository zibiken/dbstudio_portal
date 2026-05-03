import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import { decrypt } from '../../lib/crypto/envelope.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { stepUp } from '../../lib/auth/session.js';
import { unlockVault } from '../../lib/auth/vault-lock.js';
import { checkLockout, recordFail, reset as resetBucket } from '../../lib/auth/rate-limit.js';
import { writeAudit } from '../../lib/audit.js';

const ALLOWED_RETURN_RE = /^\/customer\/[A-Za-z0-9\-_./?=&%]*$/;
const STEPUP_LIMIT = 5;
const STEPUP_WINDOW_MS = 15 * 60_000;
const STEPUP_LOCKOUT_MS = 30 * 60_000;

// Mirrors routes/admin/step-up: sanitise ?return= to a /customer/* path,
// reject external schemes / traversal / recursive return chains.
function sanitiseReturn(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '/customer/dashboard';
  if (raw.includes('://')) return '/customer/dashboard';
  if (raw.includes('..')) return '/customer/dashboard';
  if (/[?&]return=/i.test(raw)) return '/customer/dashboard';
  if (raw.startsWith('//')) return '/customer/dashboard';
  if (!ALLOWED_RETURN_RE.test(raw)) return '/customer/dashboard';
  return raw;
}

async function loadCustomerUserTotp(db, customerUserId) {
  const r = await sql`
    SELECT totp_secret_enc, totp_iv, totp_tag
      FROM customer_users
     WHERE id = ${customerUserId}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

export function registerCustomerStepUpRoutes(app) {
  app.get('/customer/step-up', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const safeReturn = sanitiseReturn(req.query?.return ?? '/customer/dashboard');
    return renderCustomer(req, reply, 'customer/step-up', {
      title: "Confirm it's you",
      csrfToken: await reply.generateCsrf(),
      returnTo: safeReturn,
      activeNav: null,
      mainWidth: 'wide',
    });
  });

  app.post('/customer/step-up', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const safeReturn = sanitiseReturn(req.body?.return ?? '/customer/dashboard');
    const bucket = `step-up:customer:${session.user_id}`;

    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      reply.code(429);
      return renderCustomer(req, reply, 'customer/step-up', {
        title: "Confirm it's you",
        csrfToken: await reply.generateCsrf(),
        returnTo: safeReturn,
        error: 'Too many attempts. Try again later.',
        activeNav: null,
        mainWidth: 'wide',
      });
    }

    const cuTotp = await loadCustomerUserTotp(app.db, session.user_id);
    let ok = false;
    if (cuTotp?.totp_secret_enc && app.kek) {
      const secret = decrypt(
        { ciphertext: cuTotp.totp_secret_enc, iv: cuTotp.totp_iv, tag: cuTotp.totp_tag },
        app.kek,
      ).toString('utf8');
      const code = String(req.body?.totp_code ?? '').trim();
      ok = code.length > 0 && verifyTotp(secret, code);
    }

    if (!ok) {
      await recordFail(app.db, bucket, {
        limit: STEPUP_LIMIT,
        windowMs: STEPUP_WINDOW_MS,
        lockoutMs: STEPUP_LOCKOUT_MS,
      });
      reply.code(422);
      return renderCustomer(req, reply, 'customer/step-up', {
        title: "Confirm it's you",
        csrfToken: await reply.generateCsrf(),
        returnTo: safeReturn,
        error: 'Authenticator code is invalid or expired. Try again with a fresh code.',
        activeNav: null,
        mainWidth: 'wide',
      });
    }

    await stepUp(app.db, session.id);
    await unlockVault(app.db, session.id);
    await resetBucket(app.db, bucket);

    await writeAudit(app.db, {
      actorType: 'customer',
      actorId: session.user_id,
      action: 'customer.step_up',
      metadata: { return: safeReturn },
      visibleToCustomer: false,
      ip: req.ip ?? null,
    });

    return reply.redirect(safeReturn, 302);
  });
}
