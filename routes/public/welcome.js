import { sql } from 'kysely';
import { renderPublic } from '../../lib/render.js';
import { deriveEnrolSecret, otpauthUri } from '../../lib/auth/totp-enrol.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { computeDeviceFingerprint } from '../../lib/auth/session.js';
import { setSessionCookie } from '../../lib/auth/middleware.js';
import * as adminsService from '../../domain/admins/service.js';
import { renderTotpQrSvg } from '../../lib/qr.js';

const ISSUER = 'DB Studio Portal';

async function findInvitedAdmin(db, token) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const r = await sql`
    SELECT id, email, invite_consumed_at, invite_expires_at
      FROM admins
     WHERE invite_token_hash = ${hash}
  `.execute(db);
  const row = r.rows[0];
  if (!row) return { error: 'invalid' };
  if (row.invite_consumed_at) return { error: 'consumed' };
  if (new Date(row.invite_expires_at).getTime() <= Date.now()) return { error: 'expired' };
  return { admin: row };
}

export function registerWelcomeRoutes(app, { mountPath = '/welcome', title = 'Welcome to DB Studio Portal' } = {}) {
  app.get(`${mountPath}/:token`, async (req, reply) => {
    const { token } = req.params;
    const found = await findInvitedAdmin(app.db, token);
    if (found.error) {
      // Don't issue a CSRF cookie on a probe of an invalid token.
      reply.code(410).type('text/html');
      return renderPublic(req, reply, 'public/welcome-invalid', {
        title,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: 'This link has expired', lead: null },
      });
    }

    const enrolSecret = deriveEnrolSecret(token, app.env.SESSION_SIGNING_SECRET);
    const uri = otpauthUri(found.admin.email, ISSUER, enrolSecret);
    const qrSvg = await renderTotpQrSvg(uri, { label: `TOTP enrolment for ${found.admin.email}` });
    return renderPublic(req, reply, 'public/welcome', {
      title,
      action: `${mountPath}/${encodeURIComponent(token)}`,
      submitLabel: 'Finish setup',
      csrfToken: await reply.generateCsrf(),
      enrolSecret,
      qrSvg,
      hero: { eyebrow: 'DB STUDIO PORTAL', title: `Welcome, ${found.admin.email}`, lead: 'Set a password and register an authenticator app to finish setup.' },
    });
  });

  app.post(`${mountPath}/:token`, { preHandler: app.csrfProtection }, async (req, reply) => {
    const { token } = req.params;
    const { password, totp_code: totpCode } = req.body ?? {};

    const found = await findInvitedAdmin(app.db, token);
    if (found.error) {
      reply.code(found.error === 'expired' ? 410 : 400).type('text/html');
      return renderPublic(req, reply, 'public/welcome-invalid', {
        title,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: 'This link has expired', lead: null },
      });
    }

    const enrolSecret = deriveEnrolSecret(token, app.env.SESSION_SIGNING_SECRET);
    if (typeof password !== 'string' || password.length < 12 || !verifyTotp(enrolSecret, String(totpCode ?? ''))) {
      reply.code(422);
      const uri = otpauthUri(found.admin.email, ISSUER, enrolSecret);
      const qrSvg = await renderTotpQrSvg(uri, { label: `TOTP enrolment for ${found.admin.email}` });
      return renderPublic(req, reply, 'public/welcome', {
        title,
        action: `${mountPath}/${encodeURIComponent(token)}`,
        submitLabel: 'Finish setup',
        csrfToken: await reply.generateCsrf(),
        enrolSecret,
        qrSvg,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: `Welcome, ${found.admin.email}`, lead: 'Set a password and register an authenticator app to finish setup.' },
        error: 'Check your password (≥12 chars) and the six-digit code from your authenticator.',
      });
    }

    const ctx = {
      actorType: 'admin',
      actorId: found.admin.id,
      ip: req.ip ?? null,
      userAgentHash: null,
      hibpHasBeenPwned: app.hibpHasBeenPwned,
    };

    let codes, sid;
    try {
      ({ codes, sid } = await adminsService.completeWelcome(
        app.db,
        {
          token,
          newPassword: password,
          totpSecret: enrolSecret,
          kek: app.kek,
          sessionIp: req.ip ?? null,
          sessionDeviceFingerprint: computeDeviceFingerprint(req.headers['user-agent'], req.ip),
        },
        ctx,
      ));
    } catch (err) {
      reply.code(422);
      const uri = otpauthUri(found.admin.email, ISSUER, enrolSecret);
      const qrSvg = await renderTotpQrSvg(uri, { label: `TOTP enrolment for ${found.admin.email}` });
      return renderPublic(req, reply, 'public/welcome', {
        title,
        action: `${mountPath}/${encodeURIComponent(token)}`,
        submitLabel: 'Finish setup',
        csrfToken: await reply.generateCsrf(),
        enrolSecret,
        qrSvg,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: `Welcome, ${found.admin.email}`, lead: 'Set a password and register an authenticator app to finish setup.' },
        error: /breach|compromised|pwned/i.test(err.message)
          ? 'That password appears in a known data breach. Choose a different one.'
          : 'Could not complete enrolment. Try again.',
      });
    }

    // The admin proved both factors in this single POST — mint the cookie
    // here so the post-backup-codes click lands them inside the admin
    // surface instead of bouncing through /login again.
    setSessionCookie(reply, sid, app.env);

    return renderPublic(req, reply, 'public/2fa-enrol', {
      title: 'Save your backup codes',
      codes,
      hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Save your backup codes', lead: 'Each code works once. Store them in your password manager.' },
    });
  });
}
