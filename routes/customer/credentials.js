import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession } from '../../lib/auth/middleware.js';
import * as credentialsService from '../../domain/credentials/service.js';
import { listCredentialsByCustomer, findCredentialById } from '../../domain/credentials/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function customerScopeFor(app, session) {
  const r = await sql`
    SELECT cu.customer_id::text AS customer_id, c.razon_social, c.status
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.id = ${session.user_id}::uuid
  `.execute(app.db);
  return r.rows[0] ?? null;
}

function makeCtx(req, session, app) {
  return {
    actorType: 'customer',
    actorId: session.user_id,
    ip: req.ip ?? null,
    userAgentHash: null,
    audit: {},
    kek: app.kek,
  };
}

export function registerCustomerCredentialsRoutes(app) {
  app.get('/customer/credentials', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);
    const credentials = await listCredentialsByCustomer(app.db, scope.customer_id);
    return renderCustomer(req, reply, 'customer/credentials/list', {
      title: 'Credentials',
      scope,
      credentials,
      csrfToken: await reply.generateCsrf(),
      activeNav: 'credentials',
      mainWidth: 'wide',
      sectionLabel: 'CREDENTIALS',
    });
  });

  app.get('/customer/credentials/new', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);
    return renderCustomer(req, reply, 'customer/credentials/new', {
      title: 'Add a credential',
      scope,
      csrfToken: await reply.generateCsrf(),
      activeNav: 'credentials',
      mainWidth: 'wide',
      sectionLabel: 'CREDENTIALS',
    });
  });

  app.post('/customer/credentials', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);

    const body = req.body ?? {};
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';

    // Build payload from "field name + field value" pairs (indexed; matches
    // the M7 admin credential-request form pattern). Empty pair rows are
    // skipped silently.
    const fieldCount = Number.parseInt(String(body.field_count ?? '0'), 10) || 0;
    const payload = {};
    for (let i = 0; i < fieldCount; i++) {
      const k = typeof body[`field_name_${i}`] === 'string' ? body[`field_name_${i}`].trim() : '';
      const v = typeof body[`field_value_${i}`] === 'string' ? body[`field_value_${i}`] : '';
      if (k && v !== '') payload[k] = v;
    }

    const renderForm = async (errorMsg) => {
      reply.code(422);
      return renderCustomer(req, reply, 'customer/credentials/new', {
        title: 'Add a credential',
        scope,
        csrfToken: await reply.generateCsrf(),
        error: errorMsg,
        form: { provider, label, payload },
      });
    };

    if (Object.keys(payload).length === 0) {
      return renderForm('At least one field is required.');
    }

    try {
      await credentialsService.createByCustomer(
        app.db,
        {
          customerId: scope.customer_id,
          customerUserId: session.user_id,
          provider,
          label,
          payload,
        },
        makeCtx(req, session, app),
      );
    } catch (err) {
      return renderForm(err.message);
    }
    reply.redirect('/customer/credentials', 302);
  });

  app.post('/customer/credentials/:id/delete', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);
    const id = req.params?.id;
    if (!UUID_RE.test(id)) return reply.code(404).send();

    // Belt-and-braces — domain method also runs assertCustomerUserBelongsTo.
    const cred = await findCredentialById(app.db, id);
    if (!cred || cred.customer_id !== scope.customer_id) {
      return reply.code(404).send();
    }

    try {
      await credentialsService.deleteByCustomer(
        app.db,
        { customerUserId: session.user_id, credentialId: id },
        makeCtx(req, session, app),
      );
    } catch (err) {
      reply.code(422);
      const credentials = await listCredentialsByCustomer(app.db, scope.customer_id);
      return renderCustomer(req, reply, 'customer/credentials/list', {
        title: 'Credentials',
        scope,
        credentials,
        csrfToken: await reply.generateCsrf(),
        error: err.message,
      });
    }
    reply.redirect('/customer/credentials', 302);
  });
}
