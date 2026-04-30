import fp from 'fastify-plugin';
import { generateNonce, buildCspHeader } from './csp.js';

// Returns the security-header set we want on EVERY response. The Fastify
// onSend hook applies these to the normal reply path; routes that
// reply.hijack() (e.g. streamed CSV exports) must call applySecureHeadersRaw
// on their `reply.raw` BEFORE writing the first byte, otherwise the
// onSend hook does not fire and the response ships missing HSTS / nosniff
// / X-Frame-Options / Referrer-Policy / Permissions-Policy.
//
// CSP is intentionally NOT included for hijacked binary/text-stream
// responses (a CSV download is not an executing context). If a future
// hijack site is HTML, set CSP explicitly with a per-request nonce.
export function buildBaseSecurityHeaders() {
  return {
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  };
}

export function applySecureHeadersRaw(raw) {
  for (const [k, v] of Object.entries(buildBaseSecurityHeaders())) {
    raw.setHeader(k, v);
  }
}

async function secureHeaders(app) {
  app.addHook('onRequest', async (req, reply) => {
    if (process.env.NODE_ENV === 'production') {
      const proto = req.headers['x-forwarded-proto'];
      if (proto && proto !== 'https') {
        return reply.code(400).send({ error: 'https_required' });
      }
    }
    req.cspNonce = generateNonce();
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', buildCspHeader(req.cspNonce ?? ''));
    for (const [k, v] of Object.entries(buildBaseSecurityHeaders())) {
      reply.header(k, v);
    }
    return payload;
  });
}

export default fp(secureHeaders);
