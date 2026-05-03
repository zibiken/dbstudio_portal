import { requireAdminSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { findProjectById } from '../../domain/projects/repo.js';
import { findPhaseById } from '../../domain/phases/repo.js';
import { findItemById } from '../../domain/phase-checklists/repo.js';
import * as checklistService from '../../domain/phase-checklists/service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ctxFromReq(req) {
  return {
    actorType: 'admin',
    audit: {},
    ip: req.ip,
    userAgentHash: req.headers['user-agent']
      ? req.headers['user-agent'].slice(0, 64)
      : null,
  };
}

function notFound(req, reply) { reply.code(404).send({ error: 'not_found' }); }

function back(reply, customerId, projectId, flash) {
  if (flash) {
    return reply.redirect(
      `/admin/customers/${customerId}/projects/${projectId}?phaseError=${encodeURIComponent(flash)}`,
      303,
    );
  }
  return reply.redirect(`/admin/customers/${customerId}/projects/${projectId}`, 303);
}

function flashFromError(err) {
  if (err?.code === 'ITEM_NOT_FOUND')   return 'Checklist item not found.';
  if (err?.code === 'ITEM_PARENT_GONE') return 'Parent phase no longer exists.';
  if (err?.code === 'PHASE_NOT_FOUND')  return 'Phase not found.';
  return 'Something went wrong; please try again.';
}

async function loadPhaseGuards(app, req, reply) {
  const session = await requireAdminSession(app, req, reply);
  if (!session) return null;
  const { customerId, projectId, phaseId } = req.params ?? {};
  if (!UUID_RE.test(customerId) || !UUID_RE.test(projectId) || !UUID_RE.test(phaseId)) {
    notFound(req, reply); return null;
  }
  const customer = await findCustomerById(app.db, customerId);
  if (!customer) { notFound(req, reply); return null; }
  const project = await findProjectById(app.db, projectId);
  if (!project || project.customer_id !== customerId) { notFound(req, reply); return null; }
  const phase = await findPhaseById(app.db, phaseId);
  if (!phase || phase.project_id !== projectId) { notFound(req, reply); return null; }
  return { session, customer, project, phase, adminId: session.user_id };
}

async function loadItemGuards(app, req, reply) {
  const base = await loadPhaseGuards(app, req, reply);
  if (!base) return null;
  const itemId = req.params?.itemId;
  if (!UUID_RE.test(itemId)) { notFound(req, reply); return null; }
  const item = await findItemById(app.db, itemId);
  if (!item || item.phase_id !== base.phase.id) { notFound(req, reply); return null; }
  return { ...base, itemId, item };
}

export function registerAdminPhaseChecklistItemsRoutes(app) {
  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadPhaseGuards(app, req, reply);
      if (!g) return;
      const label = (req.body?.label || '').toString();
      const visibleToCustomer = req.body?.visibleToCustomer === 'true';
      try {
        await checklistService.create(
          app.db,
          { phaseId: g.phase.id, customerId: g.customer.id },
          { label, visibleToCustomer },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items/:itemId/rename',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadItemGuards(app, req, reply);
      if (!g) return;
      const label = (req.body?.label || '').toString();
      try {
        await checklistService.rename(
          app.db,
          { itemId: g.itemId, customerId: g.customer.id },
          { label },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items/:itemId/visibility',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadItemGuards(app, req, reply);
      if (!g) return;
      const visibleToCustomer = req.body?.visibleToCustomer === 'true';
      try {
        await checklistService.setVisibility(
          app.db,
          { itemId: g.itemId, customerId: g.customer.id },
          { visibleToCustomer },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items/:itemId/toggle',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadItemGuards(app, req, reply);
      if (!g) return;
      const done = req.body?.done === 'true';
      try {
        await checklistService.toggleDone(
          app.db,
          { itemId: g.itemId, customerId: g.customer.id },
          { done },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items/:itemId/delete',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadItemGuards(app, req, reply);
      if (!g) return;
      try {
        await checklistService.delete(
          app.db,
          { itemId: g.itemId, customerId: g.customer.id },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });
}
