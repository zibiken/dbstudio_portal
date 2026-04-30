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
import { registerAdminCredentialRequestsRoutes } from './routes/admin/credential-requests.js';
import { registerCustomerCredentialRequestsRoutes } from './routes/customer/credential-requests.js';
import { registerAdminInvoicesRoutes } from './routes/admin/invoices.js';
import { registerCustomerInvoicesRoutes } from './routes/customer/invoices.js';
import { registerAdminNdasRoutes } from './routes/admin/ndas.js';
import { registerCustomerNdasRoutes } from './routes/customer/ndas.js';
import { registerPublicFilesRoutes } from './routes/public/files.js';
import { MAX_FILE_BYTES } from './lib/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  const app = Fastify({ loggerInstance: log, trustProxy: '127.0.0.1', disableRequestLogging: false });
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
    defaultContext: { env: { PORTAL_BASE_URL: env.PORTAL_BASE_URL } },
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
  });
  const stopOutboxWorker = startOutboxWorker({ db: app.db, mailer, log: app.log });
  app.addHook('onClose', async () => { stopOutboxWorker(); });

  await app.listen({ port: env.PORT, host: env.HOST });
}
