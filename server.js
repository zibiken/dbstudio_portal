import Fastify from 'fastify';
import view from '@fastify/view';
import staticPlugin from '@fastify/static';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
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
import secureHeaders from './lib/secure-headers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function build({ skipSafetyCheck = false } = {}) {
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

  const app = Fastify({ loggerInstance: log, trustProxy: '127.0.0.1', disableRequestLogging: false });
  app.decorate('db', db);
  app.decorate('env', env);

  await app.register(sensible);
  await app.register(cookie, { secret: env.SESSION_SIGNING_SECRET });
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

  app.get('/', async (req, reply) => {
    const html = await ejs.renderFile(
      path.join(__dirname, 'views/layouts/public.ejs'),
      {
        nonce: req.cspNonce,
        title: 'DB Studio Portal',
        body: await ejs.renderFile(path.join(__dirname, 'views/public/coming-soon.ejs'))
      }
    );
    reply.type('text/html').send(html);
  });

  app.addHook('onClose', async () => { await db.destroy(); });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const app = await build();
  await app.listen({ port: env.PORT, host: env.HOST });
}
