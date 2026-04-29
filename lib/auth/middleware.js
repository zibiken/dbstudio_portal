import { loadSession } from './session.js';

const COOKIE_NAME = 'sid';

export function sessionCookieOptions(env) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    signed: true,
  };
}

export function setSessionCookie(reply, sid, env) {
  reply.setCookie(COOKIE_NAME, sid, sessionCookieOptions(env));
}

export function clearSessionCookie(reply, env) {
  reply.clearCookie(COOKIE_NAME, { path: '/', secure: env.NODE_ENV === 'production' });
}

export async function readSession(app, req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return await loadSession(app.db, unsigned.value);
}

// Gate for admin-only routes. Requires user_type='admin' AND a stepped-up
// session (step_up_at not null) — half-authenticated post-password /
// pre-2FA sessions are rejected so an attacker who somehow obtained the sid
// cookie before /login/2fa completed cannot reach admin surfaces.
export async function requireAdminSession(app, req, reply) {
  const session = await readSession(app, req);
  if (!session || session.user_type !== 'admin' || !session.step_up_at) {
    reply.redirect('/login', 302);
    return null;
  }
  return session;
}

// Gate for customer-only routes. Same posture as requireAdminSession but
// keyed to user_type='customer' and redirects to '/' (the customer login
// surface lands post-checkpoint; '/' is the public landing today).
export async function requireCustomerSession(app, req, reply) {
  const session = await readSession(app, req);
  if (!session || session.user_type !== 'customer' || !session.step_up_at) {
    reply.redirect('/', 302);
    return null;
  }
  return session;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
