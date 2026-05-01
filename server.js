import Fastify from 'fastify';
import view from '@fastify/view';
import staticPlugin from '@fastify/static';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import csrfProtection from '@fastify/csrf-protection';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { sql } from 'kysely';

import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createDb } from './config/db.js';
import { runSafetyCheck } from './lib/safety-check.js';
import { loadKek } from './lib/crypto/kek.js';
import { hibpHasBeenPwned as defaultHibp } from './lib/crypto/hash.js';
import { makeMailer } from './lib/email.js';
import { startWorker as startOutboxWorker } from './domain/email-outbox/worker.js';
import secureHeaders from './lib/secure-headers.js';
import { registerWelcomeRoutes } from './routes/public/welcome.js';
import { registerLoginRoutes } from './routes/public/login.js';
import { registerLogin2faRoutes } from './routes/public/login-2fa.js';
import { registerLogoutRoutes } from './routes/public/logout.js';
import { registerResetRoutes } from './routes/public/reset.js';
import { registerAdminIndexRoute } from './routes/admin/_index.js';
import { registerAdminCustomerRoutes } from './routes/admin/customers.js';
import { registerAdminProfileRoutes } from './routes/admin/profile.js';
import { registerAdminAuditRoutes } from './routes/admin/audit.js';
import { registerAdminDocumentsRoutes } from './routes/admin/documents.js';
import { registerCustomerOnboardingRoutes } from './routes/customer/onboarding.js';
import { registerCustomerDashboardRoutes } from './routes/customer/dashboard.js';
import { registerCustomerProfileRoutes } from './routes/customer/profile.js';
import { registerCustomerActivityRoutes } from './routes/customer/activity.js';
import { registerCustomerCredentialsRoutes } from './routes/customer/credentials.js';
import { registerCustomerDocumentsRoutes } from './routes/customer/documents.js';
import { registerCustomerProjectsRoutes } from './routes/customer/projects.js';
import { registerAdminProjectsRoutes } from './routes/admin/projects.js';
import { registerAdminCredentialsRoutes } from './routes/admin/credentials.js';
import { registerAdminCredentialRequestsRoutes } from './routes/admin/credential-requests.js';
import { registerCustomerCredentialRequestsRoutes } from './routes/customer/credential-requests.js';
import { registerAdminInvoicesRoutes } from './routes/admin/invoices.js';
import { registerCustomerInvoicesRoutes } from './routes/customer/invoices.js';
import { registerAdminNdasRoutes } from './routes/admin/ndas.js';
import { registerCustomerNdasRoutes } from './routes/customer/ndas.js';
import { registerPublicFilesRoutes } from './routes/public/files.js';
import { MAX_FILE_BYTES } from './lib/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portalVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '';
  } catch (_) {
    return '';
  }
})();

export async function build({
  skipSafetyCheck = false,
  hibpHasBeenPwned = defaultHibp,
  kek: kekOverride = null,
} = {}) {
  const env = loadEnv();
  const log = createLogger({ level: env.LOG_LEVEL });
  const db = createDb({ connectionString: env.DATABASE_URL });

  if (!skipSafetyCheck) {
    const dbAdapter = {
      async fetchCurrent() {
        const r = await sql`SELECT current_database() as current_database, current_user as current_user`.execute(db);
        return r.rows[0];
      }
    };
    await runSafetyCheck({ fs, userInfo: os.userInfo, db: dbAdapter, env });
  }

  const kek = kekOverride ?? loadKek(env.MASTER_KEY_PATH);

  // Trust the loopback proxy (systemd-side health probes hit 127.0.0.1
   // directly) AND the Nginx Proxy Manager box at 94.72.96.105 (every
   // public request lands on the portal via NPM, which appends the
   // real client IP to X-Forwarded-For). Without 94.72.96.105 in the
   // list, Fastify discards XFF and req.ip falls back to NPM's IP for
   // every audited action.
   const TRUSTED_PROXIES = ['127.0.0.1', '94.72.96.105'];
   const app = Fastify({ loggerInstance: log, trustProxy: TRUSTED_PROXIES, disableRequestLogging: false });

   // Cloudflare sits in front of NPM. CF appends a CF-Connecting-IP
   // header carrying the real client IP, regardless of how many CF
   // edges relayed the request. NPM passes it through as a normal
   // header. Trusting it without checking the socket peer would let
   // any client spoof their IP — so we ONLY honor it when the socket
   // peer is a trusted proxy (NPM or loopback). When honored, it
   // overrides Fastify's req.ip so every downstream audit / rate-limit
   // / login-success record sees the true client IP. Falls back to
   // proxy-addr's XFF parsing (for clients hitting NPM without
   // Cloudflare in front).
   app.addHook('onRequest', async (req) => {
     const cfip = req.headers['cf-connecting-ip'];
     if (typeof cfip !== 'string' || cfip.length === 0 || cfip.length > 64) return;
     const peer = req.socket?.remoteAddress;
     const trusted = peer === '127.0.0.1' || peer === '::1'
       || peer === '94.72.96.105' || peer === '::ffff:94.72.96.105';
     if (!trusted) return;
     try {
       Object.defineProperty(req, 'ip', { value: cfip, writable: false, configurable: true });
     } catch (_) { /* if Fastify ever changes req.ip's descriptor, fall back to XFF */ }
   });
  app.decorate('db', db);
  app.decorate('env', env);
  app.decorate('kek', kek);
  app.decorate('hibpHasBeenPwned', hibpHasBeenPwned);

  await app.register(sensible);
  await app.register(cookie, { secret: env.SESSION_SIGNING_SECRET });
  await app.register(formbody);
  await app.register(csrfProtection, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: 'csrf',
    cookieOpts: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      signed: true,
    },
  });
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  });
  await app.register(secureHeaders);
  await app.register(view, {
    engine: { ejs },
    root: path.join(__dirname, 'views'),
    propertyName: 'view',
    defaultContext: { env: { PORTAL_BASE_URL: env.PORTAL_BASE_URL }, portalVersion },
    options: {
      filename: path.join(__dirname, 'views'),
      async: false
    }
  });
  await app.register(staticPlugin, {
    root: path.join(__dirname, 'public'),
    prefix: '/static/'
  });

  app.get('/health', async () => ({ ok: true, version: process.env.npm_package_version || '0.1.0' }));

  app.get('/favicon.ico', (_req, reply) => reply.sendFile('brand/favicon.ico'));
  app.get('/apple-touch-icon.png', (_req, reply) => reply.sendFile('brand/apple-touch-icon.png'));
  app.get('/site.webmanifest', (_req, reply) => reply.sendFile('brand/site.webmanifest'));

  app.get('/', async (_req, reply) => {
    reply.redirect('/login', 302);
  });

  registerWelcomeRoutes(app);
  registerLoginRoutes(app);
  registerLogin2faRoutes(app);
  registerLogoutRoutes(app);
  registerResetRoutes(app);
  registerAdminIndexRoute(app);
  registerAdminCustomerRoutes(app);
  registerAdminProfileRoutes(app);
  registerAdminAuditRoutes(app);
  registerAdminDocumentsRoutes(app);
  registerCustomerOnboardingRoutes(app);
  registerCustomerDashboardRoutes(app);
  registerCustomerProfileRoutes(app);
  registerCustomerActivityRoutes(app);
  registerCustomerCredentialsRoutes(app);
  registerCustomerDocumentsRoutes(app);
  registerCustomerProjectsRoutes(app);
  registerAdminProjectsRoutes(app);
  registerAdminCredentialsRoutes(app);
  registerAdminCredentialRequestsRoutes(app);
  registerCustomerCredentialRequestsRoutes(app);
  registerAdminInvoicesRoutes(app);
  registerCustomerInvoicesRoutes(app);
  registerAdminNdasRoutes(app);
  registerCustomerNdasRoutes(app);
  registerPublicFilesRoutes(app);

  app.addHook('onClose', async () => { await db.destroy(); });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const app = await build();

  const mailer = makeMailer({
    apiKey: env.MAILERSEND_API_KEY,
    fromEmail: env.MAILERSEND_FROM_EMAIL,
    fromName: env.MAILERSEND_FROM_NAME,
    devHold: process.env.PORTAL_EMAIL_DEV_HOLD === 'true',
    log: app.log,
  });
  const stopOutboxWorker = startOutboxWorker({ db: app.db, mailer, log: app.log });
  app.addHook('onClose', async () => { stopOutboxWorker(); });

  await app.listen({ port: env.PORT, host: env.HOST });
}
