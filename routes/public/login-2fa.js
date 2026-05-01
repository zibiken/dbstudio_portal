import { sql } from 'kysely';
import { renderPublic } from '../../lib/render.js';
import { readSession, clearSessionCookie } from '../../lib/auth/middleware.js';
import { stepUp } from '../../lib/auth/session.js';
import { checkLockout, recordFail, reset as resetBucket } from '../../lib/auth/rate-limit.js';
import { decrypt, unwrapDek } from '../../lib/crypto/envelope.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { verifyAndConsume } from '../../lib/auth/backup-codes.js';
import { findById } from '../../domain/admins/repo.js';
import * as adminsService from '../../domain/admins/service.js';
import { writeAudit } from '../../lib/audit.js';

const TWOFA_LIMIT = 5;
const TWOFA_WINDOW_MS = 5 * 60_000;
const TWOFA_LOCKOUT_MS = 30 * 60_000;

function totpSecretFrom(row, kek) {
  if (!row?.totp_secret_enc) return null;
  return decrypt(
    { ciphertext: row.totp_secret_enc, iv: row.totp_iv, tag: row.totp_tag },
    kek,
  ).toString('utf8');
}

const HERO = { eyebrow: 'DB STUDIO PORTAL', title: 'Verify it\'s you', lead: 'Enter the 6-digit code from your authenticator.' };

export function registerLogin2faRoutes(app) {
  app.get('/login/2fa', async (req, reply) => {
    const session = await readSession(app, req);
    if (!session) return reply.redirect('/login', 302);

    return renderPublic(req, reply, 'public/2fa-challenge', {
      title: 'Two-factor authentication',
      csrfToken: await reply.generateCsrf(),
      hero: HERO,
    });
  });

  app.post('/login/2fa', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await readSession(app, req);
    if (!session) return reply.redirect('/login', 302);

    const bucket = `2fa:${session.id}`;
    const lock = await checkLockout(app.db, bucket);
    if (lock.locked) {
      await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${session.id}`.execute(app.db);
      clearSessionCookie(reply, app.env);
      reply.code(429);
      return renderPublic(req, reply, 'public/2fa-challenge', {
        title: 'Two-factor authentication',
        csrfToken: await reply.generateCsrf(),
        error: 'Too many attempts. Sign in again later.',
        hero: HERO,
      });
    }

    const { method, totp_code: totpCode, backup_code: backupCode } = req.body ?? {};

    // ── Admin path ──────────────────────────────────────────────────────
    if (session.user_type === 'admin') {
      const admin = await findById(app.db, session.user_id);
      if (!admin) return reply.redirect('/login', 302);

      let ok = false;
      if (method === 'totp' && typeof totpCode === 'string') {
        const secret = totpSecretFrom(admin, app.kek);
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
        await recordFail(app.db, bucket, { limit: TWOFA_LIMIT, windowMs: TWOFA_WINDOW_MS, lockoutMs: TWOFA_LOCKOUT_MS });
        await writeAudit(app.db, {
          actorType: 'admin', actorId: admin.id,
          action: 'admin.2fa_failed',
          metadata: { method: method ?? null },
          ip: req.ip ?? null,
        });
        reply.code(401);
        return renderPublic(req, reply, 'public/2fa-challenge', {
          title: 'Two-factor authentication',
          csrfToken: await reply.generateCsrf(),
          error: 'Code did not match. Try again or use a backup code.',
          hero: HERO,
        });
      }

      await resetBucket(app.db, bucket);
      await stepUp(app.db, session.id);
      await writeAudit(app.db, {
        actorType: 'admin', actorId: admin.id,
        action: 'admin.2fa_ok',
        metadata: { method },
        ip: req.ip ?? null,
      });
      await writeAudit(app.db, {
        actorType: 'admin', actorId: admin.id,
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
          recipientName: admin.name,
          ip: req.ip ?? '',
          userAgent: req.headers['user-agent'] ?? '',
          portalBaseUrl: app.env.PORTAL_BASE_URL,
          excludeSessionId: session.id,
        },
        { actorType: 'admin', actorId: admin.id, ip: req.ip ?? null },
      );
      return reply.redirect('/admin/customers', 302);
    }

    // ── Customer path ───────────────────────────────────────────────────
    if (session.user_type === 'customer') {
      const r = await sql`
        SELECT cu.id, cu.email, cu.totp_secret_enc, cu.totp_iv, cu.totp_tag,
               cu.backup_codes, cu.customer_id,
               c.dek_ciphertext, c.dek_iv, c.dek_tag
          FROM customer_users cu
          JOIN customers c ON c.id = cu.customer_id
         WHERE cu.id = ${session.user_id}::uuid
      `.execute(app.db);
      const cu = r.rows[0];
      if (!cu) return reply.redirect('/login', 302);

      let ok = false;
      if (method === 'totp' && typeof totpCode === 'string') {
        const dek = unwrapDek(
          { ciphertext: cu.dek_ciphertext, iv: cu.dek_iv, tag: cu.dek_tag },
          app.kek,
        );
        const secret = totpSecretFrom(cu, dek);
        ok = !!secret && verifyTotp(secret, totpCode);
      } else if (method === 'backup' && typeof backupCode === 'string') {
        // Re-read backup_codes inside a transaction with FOR UPDATE to prevent
        // two concurrent requests consuming the same backup code simultaneously.
        ok = await app.db.transaction().execute(async (tx) => {
          const lr = await sql`
            SELECT backup_codes FROM customer_users
             WHERE id = ${cu.id}::uuid
               FOR UPDATE
          `.execute(tx);
          const stored = lr.rows[0]?.backup_codes ?? [];
          const result = await verifyAndConsume(stored, backupCode.trim());
          if (!result.ok) return false;
          await sql`
            UPDATE customer_users
               SET backup_codes = ${JSON.stringify(result.stored)}::jsonb
             WHERE id = ${cu.id}::uuid
          `.execute(tx);
          await writeAudit(tx, {
            actorType: 'customer', actorId: cu.id,
            action: 'customer.backup_code_consumed',
            targetType: 'customer_user', targetId: cu.id,
            metadata: {},
            ip: req.ip ?? null,
          });
          return true;
        });
      }

      if (!ok) {
        await recordFail(app.db, bucket, { limit: TWOFA_LIMIT, windowMs: TWOFA_WINDOW_MS, lockoutMs: TWOFA_LOCKOUT_MS });
        await writeAudit(app.db, {
          actorType: 'customer', actorId: cu.id,
          action: 'customer.2fa_failed',
          metadata: { method: method ?? null },
          ip: req.ip ?? null,
        });
        reply.code(401);
        return renderPublic(req, reply, 'public/2fa-challenge', {
          title: 'Two-factor authentication',
          csrfToken: await reply.generateCsrf(),
          error: 'Code did not match. Try again or use a backup code.',
          hero: HERO,
        });
      }

      await resetBucket(app.db, bucket);
      await stepUp(app.db, session.id);
      await writeAudit(app.db, {
        actorType: 'customer', actorId: cu.id,
        action: 'customer.2fa_ok',
        metadata: { method },
        ip: req.ip ?? null,
      });
      await writeAudit(app.db, {
        actorType: 'customer', actorId: cu.id,
        action: 'customer.login_success',
        metadata: { method, via: 'login' },
        ip: req.ip ?? null,
      });
      // noticeLoginDevice (new-device email) is deferred for customer accounts — task #10.
      return reply.redirect('/customer/dashboard', 302);
    }

    // Unknown user_type — drop the session and send back to login.
    await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${session.id}`.execute(app.db);
    clearSessionCookie(reply, app.env);
    return reply.redirect('/login', 302);
  });
}
