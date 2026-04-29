import fp from 'fastify-plugin';
import { generateNonce, buildCspHeader } from './csp.js';

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
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    return payload;
  });
}

export default fp(secureHeaders);
