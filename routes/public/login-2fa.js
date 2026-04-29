import { sql } from 'kysely';
import { renderPublic } from '../../lib/render.js';
import { readSession, clearSessionCookie } from '../../lib/auth/middleware.js';
import { stepUp } from '../../lib/auth/session.js';
import { checkLockout, recordFail, reset as resetBucket } from '../../lib/auth/rate-limit.js';
import { decrypt } from '../../lib/crypto/envelope.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { findById } from '../../domain/admins/repo.js';
import * as adminsService from '../../domain/admins/service.js';
import { writeAudit } from '../../lib/audit.js';

const TWOFA_LIMIT = 5;
const TWOFA_WINDOW_MS = 5 * 60_000;
const TWOFA_LOCKOUT_MS = 30 * 60_000;

function totpSecretOf(admin, kek) {
  if (!admin.totp_secret_enc) return null;
  return decrypt(
    { ciphertext: admin.totp_secret_enc, iv: admin.totp_iv, tag: admin.totp_tag },
    kek,
  ).toString('utf8');
}

export function registerLogin2faRoutes(app) {
  app.get('/login/2fa', async (req, reply) => {
    const session = await readSession(app, req);
    if (!session) return reply.redirect('/login', 302);

    return renderPublic(req, reply, 'public/2fa-challenge', {
      title: 'Two-factor authentication',
      csrfToken: await reply.generateCsrf(),
    });
  });

  app.post('/login/2fa', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await readSession(app, req);
    if (!session) return reply.redirect('/login', 302);

    const bucket = `2fa:${session.id}`;
    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      // Half-authenticated session is now untrustworthy — drop it so the
      // attacker has to re-pass the password gate too.
      await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${session.id}`.execute(app.db);
      clearSessionCookie(reply, app.env);
      reply.code(429);
      return renderPublic(req, reply, 'public/2fa-challenge', {
        title: 'Two-factor authentication',
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Sign in again later.',
      });
    }

    const { method, totp_code: totpCode, backup_code: backupCode } = req.body ?? {};
    const admin = await findById(app.db, session.user_id);
    if (!admin) return reply.redirect('/login', 302);

    let ok = false;
    if (method === 'totp' && typeof totpCode === 'string') {
      const secret = totpSecretOf(admin, app.kek);
      ok = !!secret && verifyTotp(secret, totpCode);
    } else if (method === 'backup' && typeof backupCode === 'string') {
      const r = await adminsService.consumeBackupCode(
        app.db,
        { adminId: admin.id, code: backupCode.trim() },
        { actorType: 'admin', actorId: admin.id, ip: req.ip ?? null },
      );
      ok = r.ok;
    }

    if (!ok) {
      await recordFail(app.db, bucket, {
        limit: TWOFA_LIMIT,
        windowMs: TWOFA_WINDOW_MS,
        lockoutMs: TWOFA_LOCKOUT_MS,
      });
      await writeAudit(app.db, {
        actorType: 'admin',
        actorId: admin.id,
        action: 'admin.2fa_failed',
        metadata: { method: method ?? null },
        ip: req.ip ?? null,
      });
      reply.code(401);
      return renderPublic(req, reply, 'public/2fa-challenge', {
        title: 'Two-factor authentication',
        csrfToken: await reply.generateCsrf(),
        error: 'Code did not match. Try again or use a backup code.',
      });
    }

    await resetBucket(app.db, bucket);
    await stepUp(app.db, session.id);
    await writeAudit(app.db, {
      actorType: 'admin',
      actorId: admin.id,
      action: 'admin.2fa_ok',
      metadata: { method },
      ip: req.ip ?? null,
    });
    await writeAudit(app.db, {
      actorType: 'admin',
      actorId: admin.id,
      action: 'admin.login_success',
      metadata: { method },
      ip: req.ip ?? null,
    });
    await adminsService.noticeLoginDevice(
      app.db,
      {
        adminId: admin.id,
        fingerprint: session.device_fingerprint,
        toAddress: admin.email,
        excludeSessionId: session.id,
      },
      { actorType: 'admin', actorId: admin.id, ip: req.ip ?? null },
    );
    reply.redirect('/', 302);
  });
}
