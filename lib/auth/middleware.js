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

export const SESSION_COOKIE_NAME = COOKIE_NAME;
