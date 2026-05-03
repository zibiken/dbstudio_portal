import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import * as credentialsService from '../../domain/credentials/service.js';
import { listCredentialsByCustomer, findCredentialById } from '../../domain/credentials/repo.js';
import { listProjectsByCustomer } from '../../domain/projects/repo.js';
import { isVaultUnlocked } from '../../lib/auth/vault-lock.js';

const UUID_RE_INNER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseProjectId(raw) {
  // Form posts an empty string for "Company-wide". Normalize to null;
  // reject any malformed UUID shape.
  if (raw === undefined || raw === null || raw === '' || raw === '__none__') return null;
  if (typeof raw !== 'string' || !UUID_RE_INNER.test(raw)) {
    throw new Error('Invalid project selection.');
  }
  return raw;
}

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
    if (!requireNdaSigned(req, reply, session)) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);
    const [credentials, projects] = await Promise.all([
      listCredentialsByCustomer(app.db, scope.customer_id),
      listProjectsByCustomer(app.db, scope.customer_id),
    ]);
    return renderCustomer(req, reply, 'customer/credentials/list', {
      title: 'Credentials',
      scope,
      credentials,
      projects,
      csrfToken: await reply.generateCsrf(),
      activeNav: 'credentials',
      mainWidth: 'wide',
      sectionLabel: 'CREDENTIALS',
    });
  });

  app.get('/customer/credentials/new', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);
    const projects = await listProjectsByCustomer(app.db, scope.customer_id);
    return renderCustomer(req, reply, 'customer/credentials/new', {
      title: 'Add a credential',
      scope,
      form: null,
      projects,
      csrfToken: await reply.generateCsrf(),
      activeNav: 'credentials',
      mainWidth: 'wide',
      sectionLabel: 'CREDENTIALS',
    });
  });

  app.post('/customer/credentials', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
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

    let projectId;
    try {
      projectId = parseProjectId(body.project_id);
    } catch (err) {
      const projects = await listProjectsByCustomer(app.db, scope.customer_id);
      reply.code(422);
      return renderCustomer(req, reply, 'customer/credentials/new', {
        title: 'Add a credential',
        scope, projects,
        csrfToken: await reply.generateCsrf(),
        error: err.message,
        form: { provider, label, payload, projectId: body.project_id ?? null },
      });
    }

    const renderForm = async (errorMsg) => {
      const projects = await listProjectsByCustomer(app.db, scope.customer_id);
      reply.code(422);
      return renderCustomer(req, reply, 'customer/credentials/new', {
        title: 'Add a credential',
        scope, projects,
        csrfToken: await reply.generateCsrf(),
        error: errorMsg,
        form: { provider, label, payload, projectId },
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
          projectId,
        },
        makeCtx(req, session, app),
      );
    } catch (err) {
      return renderForm(err.message);
    }
    reply.redirect('/customer/credentials', 302);
  });

  // GET /customer/credentials/:id/edit — render the edit form.
  // Customer-side edit covers the LABEL + PAYLOAD overwrite path. Project
  // scope keeps its dedicated /scope route to preserve an audit-trail
  // distinction between "moved between projects" and "rotated the secret".
  app.get('/customer/credentials/:id/edit', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);
    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) { reply.code(404).send(); return; }
    const credential = await findCredentialById(app.db, id);
    if (!credential || credential.customer_id !== scope.customer_id) {
      reply.code(404).send();
      return;
    }
    return renderCustomer(req, reply, 'customer/credentials/edit', {
      title: 'Edit credential',
      scope,
      credential,
      form: null,
      csrfToken: await reply.generateCsrf(),
      activeNav: 'credentials',
      mainWidth: 'wide',
      sectionLabel: 'CREDENTIALS',
    });
  });

  // POST /customer/credentials/:id/edit — apply label + (optional) full-
  // payload overwrite. Empty payload section leaves the secret untouched.
  app.post('/customer/credentials/:id/edit', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);
    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) { reply.code(404).send(); return; }
    const credential = await findCredentialById(app.db, id);
    if (!credential || credential.customer_id !== scope.customer_id) {
      reply.code(404).send();
      return;
    }

    const body = req.body ?? {};
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const fieldCount = Number.parseInt(String(body.field_count ?? '0'), 10) || 0;
    const payload = {};
    for (let i = 0; i < fieldCount; i++) {
      const k = typeof body[`field_name_${i}`] === 'string' ? body[`field_name_${i}`].trim() : '';
      const v = typeof body[`field_value_${i}`] === 'string' ? body[`field_value_${i}`] : '';
      if (k && v !== '') payload[k] = v;
    }
    const hasPayload = Object.keys(payload).length > 0;

    const renderForm = async (errorMsg) => {
      reply.code(422);
      return renderCustomer(req, reply, 'customer/credentials/edit', {
        title: 'Edit credential',
        scope,
        credential,
        form: { label },
        error: errorMsg,
        csrfToken: await reply.generateCsrf(),
        activeNav: 'credentials',
        mainWidth: 'wide',
        sectionLabel: 'CREDENTIALS',
      });
    };

    if (!label) {
      return renderForm('Label is required.');
    }

    try {
      await credentialsService.updateByCustomer(
        app.db,
        {
          customerUserId: session.user_id,
          credentialId: id,
          label,
          ...(hasPayload ? { payload } : {}),
        },
        makeCtx(req, session, app),
      );
    } catch (err) {
      return renderForm(err.message || 'Could not save the credential.');
    }
    reply.redirect(`/customer/credentials/${id}`, 303);
  });

  // POST /customer/credentials/:id/scope — change project scope only.
  app.post('/customer/credentials/:id/scope', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) { reply.code(404).send(); return; }
    const cred = await findCredentialById(app.db, id);
    if (!cred || cred.customer_id !== scope.customer_id) { reply.code(404).send(); return; }

    let projectId;
    try { projectId = parseProjectId(req.body?.project_id); }
    catch {
      return reply.redirect('/customer/credentials/' + id + '?scope_error=invalid', 302);
    }

    try {
      await credentialsService.updateByCustomer(
        app.db,
        { customerUserId: session.user_id, credentialId: id, projectId },
        makeCtx(req, session, app),
      );
    } catch (err) {
      if (err.code === 'PROJECT_SCOPE') {
        return reply.redirect('/customer/credentials/' + id + '?scope_error=cross-customer', 302);
      }
      throw err;
    }
    reply.redirect('/customer/credentials/' + id, 302);
  });

  app.get('/customer/credentials/:id', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      reply.code(404).send();
      return;
    }
    const credential = await findCredentialById(app.db, id);
    if (!credential || credential.customer_id !== scope.customer_id) {
      reply.code(404).send();
      return;
    }

    const mode = req.query?.mode;
    let payload = null;
    let decryptError = null;

    if (mode === 'reveal') {
      const unlocked = await isVaultUnlocked(app.db, session.id);
      if (!unlocked) {
        const ret = encodeURIComponent(`/customer/credentials/${id}?mode=reveal`);
        return reply.redirect(`/customer/step-up?return=${ret}`, 302);
      }
      try {
        const r = await credentialsService.viewByCustomer(app.db, {
          customerUserId: session.user_id,
          sessionId:      session.id,
          credentialId:   id,
        }, { ip: req.ip ?? null, userAgentHash: null, kek: app.kek });
        payload = r.payload;
      } catch (err) {
        if (err?.code === 'STEP_UP_REQUIRED') {
          const ret = encodeURIComponent(`/customer/credentials/${id}?mode=reveal`);
          return reply.redirect(`/customer/step-up?return=${ret}`, 302);
        }
        if (err?.code === 'DECRYPT_FAILURE') {
          decryptError = 'Could not decrypt this credential. Engineering has been notified.';
        } else {
          throw err;
        }
      }
    }

    const projects = await listProjectsByCustomer(app.db, scope.customer_id);
    const scopeError = typeof req.query?.scope_error === 'string' ? req.query.scope_error : '';
    return renderCustomer(req, reply, 'customer/credentials/show', {
      title: 'Credential',
      scope,
      credential,
      payload,
      decryptError,
      revealed: mode === 'revealed',
      projects,
      scopeError,
      csrfToken: await reply.generateCsrf(),
      activeNav: 'credentials',
      mainWidth: 'wide',
      sectionLabel: 'CREDENTIALS',
    });
  });

  app.post('/customer/credentials/:id/reveal', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      reply.code(404).send();
      return;
    }
    return reply.redirect(`/customer/credentials/${id}?mode=reveal`, 302);
  });

  app.post('/customer/credentials/:id/delete', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const scope = await customerScopeFor(app, session);
    if (!scope) return reply.redirect('/', 302);
    const id = req.params?.id;
    if (!UUID_RE.test(id)) return reply.code(404).send();

    // Belt-and-braces — domain method also runs assertCustomerUserBelongsTo.
    // The pre-check reads outside the deleteByCustomer tx, so a theoretical
    // TOCTOU exists if some future feature ever reassigns customer_id (which
    // it can't today: the schema's RESTRICT FK on credentials.customer_id
    // forbids it and no service method moves credentials between customers).
    // The authoritative gate is inside the service; this read is purely
    // defence-in-depth for the 404 surface (M9 review M10).
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
