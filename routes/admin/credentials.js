import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { findCredentialById, listCredentialsByCustomer } from '../../domain/credentials/repo.js';
import { listProjectsByCustomer } from '../../domain/projects/repo.js';
import * as credentialsService from '../../domain/credentials/service.js';
import { isVaultUnlocked } from '../../lib/auth/vault-lock.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseProjectId(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === '__none__') return null;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    throw new Error('Invalid project selection.');
  }
  return raw;
}

function notFound(req, reply) {
  reply.code(404);
  return renderAdmin(req, reply, 'admin/customers/not-found', {
    title: 'Not found',
    activeNav: 'customers',
    mainWidth: 'wide',
    sectionLabel: 'ADMIN · CUSTOMERS',
  });
}

function customerChrome(customer, activeTab) {
  return {
    activeNav: 'customers',
    sectionLabel: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
    activeTab,
  };
}

// Admin-side credentials surface (Phase E):
//   - LIST stays metadata-only.
//   - DETAIL renders metadata; on ?mode=reveal the route calls
//     domain/credentials/service.view which gates on the sliding 5-min
//     vault-unlock window. When the vault is locked, the route 302s to
//     /admin/step-up?return=…?mode=reveal and the admin re-2FAs once.
//     Subsequent reveals within the window skip step-up.
//   - Every successful reveal writes a visible_to_customer audit row +
//     a Phase B `credential.viewed` digest event for the customer.
export function registerAdminCredentialsRoutes(app) {
  app.get('/admin/customers/:id/credentials', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    const [rows, projects] = await Promise.all([
      listCredentialsByCustomer(app.db, id),
      listProjectsByCustomer(app.db, id),
    ]);
    return renderAdmin(req, reply, 'admin/credentials/list', {
      title: 'Credentials · ' + customer.razon_social,
      customer,
      rows,
      projects,
      mainWidth: 'wide',
      ...customerChrome(customer, 'credentials'),
    });
  });

  app.get('/admin/customers/:id/credentials/:credId', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const cid = req.params?.id;
    const credId = req.params?.credId;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    if (typeof credId !== 'string' || !UUID_RE.test(credId)) return notFound(req, reply);

    const customer = await findCustomerById(app.db, cid);
    if (!customer) return notFound(req, reply);
    const credential = await findCredentialById(app.db, credId);
    if (!credential || credential.customer_id !== cid) return notFound(req, reply);

    const mode = req.query?.mode;
    let payload = null;
    let decryptError = null;

    if (mode === 'reveal') {
      const unlocked = await isVaultUnlocked(app.db, session.id);
      if (!unlocked) {
        const ret = encodeURIComponent(`/admin/customers/${cid}/credentials/${credId}?mode=reveal`);
        return reply.redirect(`/admin/step-up?return=${ret}`, 302);
      }
      try {
        const r = await credentialsService.view(app.db, {
          adminId: session.user_id,
          sessionId: session.id,
          credentialId: credId,
        }, { ip: req.ip ?? null, userAgentHash: null, audit: { source: 'admin-detail' }, kek: app.kek });
        payload = r.payload;
      } catch (err) {
        if (err?.name === 'StepUpRequiredError' || err?.code === 'STEP_UP_REQUIRED') {
          const ret = encodeURIComponent(`/admin/customers/${cid}/credentials/${credId}?mode=reveal`);
          return reply.redirect(`/admin/step-up?return=${ret}`, 302);
        }
        if (err?.name === 'DecryptFailureError' || err?.code === 'CREDENTIAL_DECRYPT_FAILED') {
          decryptError = 'Could not decrypt this credential. The forensic log has been updated; contact engineering to investigate.';
        } else {
          throw err;
        }
      }
    }

    const projects = await listProjectsByCustomer(app.db, cid);
    const scopeError = typeof req.query?.scope_error === 'string' ? req.query.scope_error : '';
    return renderAdmin(req, reply, 'admin/credentials/show', {
      title: 'Credential · ' + customer.razon_social,
      customer,
      credential,
      payload,
      decryptError,
      revealed: mode === 'revealed',
      projects,
      scopeError,
      csrfToken: await reply.generateCsrf(),
      mainWidth: 'wide',
      ...customerChrome(customer, 'credentials'),
    });
  });

  app.post('/admin/customers/:id/credentials/:credId/reveal', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const cid = req.params?.id;
    const credId = req.params?.credId;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    if (typeof credId !== 'string' || !UUID_RE.test(credId)) return notFound(req, reply);
    return reply.redirect(`/admin/customers/${cid}/credentials/${credId}?mode=reveal`, 302);
  });

  // GET /admin/customers/:id/credentials/:credId/edit — admin edit form
  // for label + payload overwrite. Step-up requirement is enforced at POST
  // time by updateByAdmin; the GET intentionally surfaces the form so the
  // admin can prep changes before stepping up.
  app.get('/admin/customers/:id/credentials/:credId/edit', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const cid = req.params?.id;
    const credId = req.params?.credId;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    if (typeof credId !== 'string' || !UUID_RE.test(credId)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    if (!customer) return notFound(req, reply);
    const credential = await findCredentialById(app.db, credId);
    if (!credential || credential.customer_id !== cid) return notFound(req, reply);
    return renderAdmin(req, reply, 'admin/credentials/edit', {
      title: 'Edit credential · ' + customer.razon_social,
      customer,
      credential,
      form: null,
      csrfToken: await reply.generateCsrf(),
      mainWidth: 'wide',
      ...customerChrome(customer, 'credentials'),
    });
  });

  // POST /admin/customers/:id/credentials/:credId/edit — apply label +
  // (optional) payload overwrite. Step-up gated by updateByAdmin; on
  // STEP_UP_REQUIRED we redirect to /admin/step-up with a return URL that
  // brings the admin back to the edit form.
  app.post('/admin/customers/:id/credentials/:credId/edit',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;
      const cid = req.params?.id;
      const credId = req.params?.credId;
      if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
      if (typeof credId !== 'string' || !UUID_RE.test(credId)) return notFound(req, reply);
      const customer = await findCustomerById(app.db, cid);
      if (!customer) return notFound(req, reply);
      const credential = await findCredentialById(app.db, credId);
      if (!credential || credential.customer_id !== cid) return notFound(req, reply);

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
        return renderAdmin(req, reply, 'admin/credentials/edit', {
          title: 'Edit credential · ' + customer.razon_social,
          customer,
          credential,
          form: { label },
          error: errorMsg,
          csrfToken: await reply.generateCsrf(),
          mainWidth: 'wide',
          ...customerChrome(customer, 'credentials'),
        });
      };

      if (!label) return renderForm('Label is required.');

      try {
        await credentialsService.updateByAdmin(app.db, {
          adminId: session.user_id,
          sessionId: session.id,
          credentialId: credId,
          label,
          ...(hasPayload ? { payload } : {}),
        }, { ip: req.ip ?? null, userAgentHash: null, audit: { source: 'admin-edit' }, kek: app.kek });
      } catch (err) {
        if (err?.code === 'STEP_UP_REQUIRED') {
          const ret = encodeURIComponent(`/admin/customers/${cid}/credentials/${credId}/edit`);
          return reply.redirect(`/admin/step-up?return=${ret}`, 302);
        }
        return renderForm(err.message || 'Could not save the credential.');
      }
      return reply.redirect(`/admin/customers/${cid}/credentials/${credId}`, 303);
    });

  // Admin-side scope change. Step-up gated via updateByAdmin (mirrors the
  // overwrite path). Customer-visible audit row + credential.project_changed
  // is fanned out by the service layer.
  app.post('/admin/customers/:id/credentials/:credId/scope', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const cid = req.params?.id;
    const credId = req.params?.credId;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    if (typeof credId !== 'string' || !UUID_RE.test(credId)) return notFound(req, reply);

    const credential = await findCredentialById(app.db, credId);
    if (!credential || credential.customer_id !== cid) return notFound(req, reply);

    let projectId;
    try { projectId = parseProjectId(req.body?.project_id); }
    catch {
      return reply.redirect(`/admin/customers/${cid}/credentials/${credId}?scope_error=invalid`, 302);
    }

    try {
      await credentialsService.updateByAdmin(app.db, {
        adminId: session.user_id,
        sessionId: session.id,
        credentialId: credId,
        projectId,
      }, { ip: req.ip ?? null, userAgentHash: null, audit: { source: 'admin-scope' }, kek: app.kek });
    } catch (err) {
      if (err?.code === 'STEP_UP_REQUIRED') {
        const ret = encodeURIComponent(`/admin/customers/${cid}/credentials/${credId}`);
        return reply.redirect(`/admin/step-up?return=${ret}`, 302);
      }
      if (err?.code === 'PROJECT_SCOPE') {
        return reply.redirect(`/admin/customers/${cid}/credentials/${credId}?scope_error=cross-customer`, 302);
      }
      throw err;
    }
    reply.redirect(`/admin/customers/${cid}/credentials/${credId}`, 302);
  });
}
