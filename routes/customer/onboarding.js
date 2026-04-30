import { sql } from 'kysely';
import { renderPublic, renderCustomer } from '../../lib/render.js';
import { deriveEnrolSecret, otpauthUri } from '../../lib/auth/totp-enrol.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { computeDeviceFingerprint } from '../../lib/auth/session.js';
import { setSessionCookie, requireCustomerSession } from '../../lib/auth/middleware.js';
import * as customersService from '../../domain/customers/service.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { renderTotpQrSvg } from '../../lib/qr.js';

const ISSUER = 'DB Studio Portal';
const TITLE = 'Welcome to your DB Studio portal';

async function findInvitedCustomerUser(db, token) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const r = await sql`
    SELECT cu.id, cu.email, cu.name, cu.invite_consumed_at, cu.invite_expires_at,
           c.id AS customer_id, c.razon_social
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.invite_token_hash = ${hash}
  `.execute(db);
  const row = r.rows[0];
  if (!row) return { error: 'invalid' };
  if (row.invite_consumed_at) return { error: 'consumed' };
  if (new Date(row.invite_expires_at).getTime() <= Date.now()) return { error: 'expired' };
  return { user: row };
}

export function registerCustomerOnboardingRoutes(app, { mountPath = '/customer/welcome' } = {}) {
  app.get(`${mountPath}/profile`, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;

    const userR = await sql`
      SELECT id, email, name, customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
    `.execute(app.db);
    const user = userR.rows[0];
    if (!user) return reply.redirect('/', 302);
    const customer = await findCustomerById(app.db, user.customer_id);

    return renderCustomer(req, reply, 'customer/onboarding/profile-review', {
      title: 'Confirm your profile',
      csrfToken: await reply.generateCsrf(),
      user,
      customer,
      activeNav: 'profile',
      mainWidth: 'content',
      sectionLabel: customer ? customer.razon_social.toUpperCase() : 'PORTAL',
    });
  });

  app.post(`${mountPath}/profile`, { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    reply.redirect('/customer/dashboard', 302);
  });

  app.get(`${mountPath}/:token`, async (req, reply) => {
    const { token } = req.params;
    const found = await findInvitedCustomerUser(app.db, token);
    if (found.error) {
      reply.code(410).type('text/html');
      return renderPublic(req, reply, 'customer/onboarding/welcome-invalid', {
        title: TITLE,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: 'This link has expired', lead: null },
      });
    }

    const enrolSecret = deriveEnrolSecret(token, app.env.SESSION_SIGNING_SECRET);
    const uri = otpauthUri(found.user.email, ISSUER, enrolSecret);
    const qrSvg = await renderTotpQrSvg(uri, { label: `TOTP enrolment for ${found.user.email}` });
    return renderPublic(req, reply, 'customer/onboarding/set-password', {
      title: TITLE,
      action: `${mountPath}/${encodeURIComponent(token)}`,
      csrfToken: await reply.generateCsrf(),
      enrolSecret,
      qrSvg,
      razonSocial: found.user.razon_social,
      hero: { eyebrow: 'DB STUDIO PORTAL', title: `Welcome, ${found.user.name}`, lead: `${found.user.razon_social}. Set a password and register an authenticator app to finish setup.` },
    });
  });

  app.post(`${mountPath}/:token`, { preHandler: app.csrfProtection }, async (req, reply) => {
    const { token } = req.params;
    const { password, totp_code: totpCode } = req.body ?? {};

    const found = await findInvitedCustomerUser(app.db, token);
    if (found.error) {
      reply.code(found.error === 'expired' ? 410 : 400).type('text/html');
      return renderPublic(req, reply, 'customer/onboarding/welcome-invalid', {
        title: TITLE,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: 'This link has expired', lead: null },
      });
    }

    const enrolSecret = deriveEnrolSecret(token, app.env.SESSION_SIGNING_SECRET);
    if (typeof password !== 'string' || password.length < 12 || !verifyTotp(enrolSecret, String(totpCode ?? ''))) {
      reply.code(422);
      const uri = otpauthUri(found.user.email, ISSUER, enrolSecret);
      const qrSvg = await renderTotpQrSvg(uri, { label: `TOTP enrolment for ${found.user.email}` });
      return renderPublic(req, reply, 'customer/onboarding/set-password', {
        title: TITLE,
        action: `${mountPath}/${encodeURIComponent(token)}`,
        csrfToken: await reply.generateCsrf(),
        enrolSecret,
        qrSvg,
        razonSocial: found.user.razon_social,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: `Welcome, ${found.user.name}`, lead: `${found.user.razon_social}. Set a password and register an authenticator app to finish setup.` },
        error: 'Check your password (≥12 chars) and the six-digit code from your authenticator.',
      });
    }

    const ctx = {
      actorType: 'customer',
      actorId: found.user.id,
      ip: req.ip ?? null,
      userAgentHash: null,
      hibpHasBeenPwned: app.hibpHasBeenPwned,
    };

    let result;
    try {
      result = await customersService.completeCustomerWelcome(
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
      );
    } catch (err) {
      reply.code(422);
      const uri = otpauthUri(found.user.email, ISSUER, enrolSecret);
      const qrSvg = await renderTotpQrSvg(uri, { label: `TOTP enrolment for ${found.user.email}` });
      return renderPublic(req, reply, 'customer/onboarding/set-password', {
        title: TITLE,
        action: `${mountPath}/${encodeURIComponent(token)}`,
        csrfToken: await reply.generateCsrf(),
        enrolSecret,
        qrSvg,
        razonSocial: found.user.razon_social,
        hero: { eyebrow: 'DB STUDIO PORTAL', title: `Welcome, ${found.user.name}`, lead: `${found.user.razon_social}. Set a password and register an authenticator app to finish setup.` },
        error: /breach|compromised|pwned/i.test(err.message)
          ? 'That password appears in a known data breach. Choose a different one.'
          : 'Could not complete enrolment. Try again.',
      });
    }

    // The session was created inside completeCustomerWelcome's
    // transaction; we just attach the cookie. This is the user's first
    // device — they proved both factors in this single POST, so no
    // separate /login + /login/2fa hop.
    setSessionCookie(reply, result.sid, app.env);

    return renderPublic(req, reply, 'customer/onboarding/backup-codes', {
      title: 'Save your backup codes',
      codes: result.codes,
      hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Save your backup codes', lead: 'Each code works once. Store them in your password manager.' },
    });
  });
}
