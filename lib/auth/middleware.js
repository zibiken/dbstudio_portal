import { sql } from 'kysely';
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
//
// Defence in depth on top of revokeCustomerSessions: even with a session
// row that somehow escaped the suspend/archive revoke (e.g. an in-flight
// onboarding completion that interleaved with the suspend tx, or a
// future bug), the customer-side surfaces are still off-limits while
// status != 'active'. One PK-bounded JOIN per request.
export async function requireCustomerSession(app, req, reply) {
  const session = await readSession(app, req);
  if (!session || session.user_type !== 'customer' || !session.step_up_at) {
    reply.redirect('/', 302);
    return null;
  }
  const r = await sql`
    SELECT c.status, c.nda_signed_at
      FROM customers c
      JOIN customer_users cu ON cu.customer_id = c.id
     WHERE cu.id = ${session.user_id}::uuid
  `.execute(app.db);
  if (r.rows[0]?.status !== 'active') {
    reply.redirect('/', 302);
    return null;
  }
  // Phase D — surface nda_signed_at on the session so feature routes can
  // call requireNdaSigned(req, reply, session) without a second SELECT.
  session.nda_signed_at = r.rows[0]?.nda_signed_at ?? null;
  return session;
}

// Phase D NDA gate. Routes that require a recorded signed NDA call this
// after requireCustomerSession; allowlisted routes (profile, onboarding,
// waiting) simply don't call it. Pages 302 to /customer/waiting; APIs
// (path starts with /api/) return 403 nda_required.
//
// Returns true when the gate passes; false when blocked (caller should
// return without doing further work — the redirect/response is already
// sent on `reply`).
export function requireNdaSigned(req, reply, session) {
  if (session?.nda_signed_at) return true;
  const path = (req.raw?.url ?? req.url ?? '').split('?')[0];
  if (path.startsWith('/api/')) {
    reply.code(403).send({ error: 'nda_required' });
  } else {
    reply.redirect('/customer/waiting', 302);
  }
  return false;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
