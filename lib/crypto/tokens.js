import { createHmac, timingSafeEqual } from 'node:crypto';

const FILE_KIND = 'file';
const FILE_TTL_SECONDS = 60;
const DEFAULT_TTL_SECONDS = 600;

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64u(s) {
  return Buffer.from(s, 'base64url');
}

function macOf(part, secret) {
  return createHmac('sha256', secret).update(part).digest();
}

export function sign(payload, secret, { expSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expSeconds };
  const part = b64u(JSON.stringify(body));
  const mac = b64u(macOf(part, secret));
  return `${part}.${mac}`;
}

export function verify(token, secret) {
  const dot = token.indexOf('.');
  if (dot < 0) throw new Error('bad token');
  const part = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!part || !mac) throw new Error('bad token');

  const expected = macOf(part, secret);
  const actual = fromB64u(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('bad signature');
  }

  const body = JSON.parse(fromB64u(part).toString('utf8'));
  if (body.exp <= Math.floor(Date.now() / 1000)) throw new Error('expired');
  return body;
}

export function signFileUrl({ fileId }, secret) {
  return sign({ fileId, kind: FILE_KIND }, secret, { expSeconds: FILE_TTL_SECONDS });
}

export function verifyFileUrl(token, secret) {
  const body = verify(token, secret);
  if (body.kind !== FILE_KIND) throw new Error('wrong token kind');
  return body;
}
