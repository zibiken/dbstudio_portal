import { sql } from 'kysely';
import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import { decrypt } from '../../lib/crypto/envelope.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { stepUp } from '../../lib/auth/session.js';
import { unlockVault } from '../../lib/auth/vault-lock.js';
import { checkLockout, recordFail, reset as resetBucket } from '../../lib/auth/rate-limit.js';
import { writeAudit } from '../../lib/audit.js';

const ALLOWED_RETURN_RE = /^\/admin\/[A-Za-z0-9\-_./?=&%]*$/;
const STEPUP_LIMIT = 5;
const STEPUP_WINDOW_MS = 15 * 60_000;
const STEPUP_LOCKOUT_MS = 30 * 60_000;

// Sanitise the ?return= query param to an internal /admin/* path.
// Rejects external schemes, scheme-relative URLs, traversal, and recursive
// ?return= chains. Falls back to '/admin/' when the input doesn't match a
// strict /admin/ prefix.
function sanitiseReturn(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '/admin/';
  if (raw.includes('://')) return '/admin/';
  if (raw.includes('..')) return '/admin/';
  if (/[?&]return=/i.test(raw)) return '/admin/';
  if (raw.startsWith('//')) return '/admin/';
  if (!ALLOWED_RETURN_RE.test(raw)) return '/admin/';
  return raw;
}

async function loadAdminTotp(db, adminId) {
  const r = await sql`
    SELECT totp_secret_enc, totp_iv, totp_tag FROM admins WHERE id = ${adminId}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

export function registerAdminStepUpRoutes(app) {
  app.get('/admin/step-up', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const safeReturn = sanitiseReturn(req.query?.return ?? '/admin/');
    return renderAdmin(req, reply, 'admin/step-up', {
      title: "Confirm it's you",
      csrfToken: await reply.generateCsrf(),
      returnTo: safeReturn,
      activeNav: null,
      mainWidth: 'content',
      sectionLabel: 'ADMIN · STEP-UP',
    });
  });

  app.post('/admin/step-up', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const safeReturn = sanitiseReturn(req.body?.return ?? '/admin/');
    const bucket = `step-up:admin:${session.user_id}`;

    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      reply.code(429);
      return renderAdmin(req, reply, 'admin/step-up', {
        title: "Confirm it's you",
        csrfToken: await reply.generateCsrf(),
        returnTo: safeReturn,
        error: 'Too many attempts. Try again later.',
        activeNav: null,
        mainWidth: 'content',
        sectionLabel: 'ADMIN · STEP-UP',
      });
    }

    const adminTotp = await loadAdminTotp(app.db, session.user_id);
    let ok = false;
    if (adminTotp?.totp_secret_enc && app.kek) {
      const secret = decrypt(
        { ciphertext: adminTotp.totp_secret_enc, iv: adminTotp.totp_iv, tag: adminTotp.totp_tag },
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
      return renderAdmin(req, reply, 'admin/step-up', {
        title: "Confirm it's you",
        csrfToken: await reply.generateCsrf(),
        returnTo: safeReturn,
        error: 'Authenticator code is invalid or expired. Try again with a fresh code.',
        activeNav: null,
        mainWidth: 'content',
        sectionLabel: 'ADMIN · STEP-UP',
      });
    }

    await stepUp(app.db, session.id);
    await unlockVault(app.db, session.id);
    await resetBucket(app.db, bucket);

    await writeAudit(app.db, {
      actorType: 'admin',
      actorId: session.user_id,
      action: 'admin.step_up',
      metadata: { return: safeReturn },
      visibleToCustomer: false,
      ip: req.ip ?? null,
    });

    return reply.redirect(safeReturn, 302);
  });
}
