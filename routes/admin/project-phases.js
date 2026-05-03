import { requireAdminSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { findProjectById } from '../../domain/projects/repo.js';
import { findPhaseById } from '../../domain/phases/repo.js';
import * as phasesService from '../../domain/phases/service.js';

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

function notFound(req, reply) {
  reply.code(404).send({ error: 'not_found' });
}

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
  if (err?.code === 'PHASE_LABEL_CONFLICT') return 'A phase with that label already exists.';
  if (err?.code === 'PHASE_REORDER_EDGE')   return 'That phase is already at the edge.';
  if (err?.code === 'PHASE_INVALID_STATUS') return 'Invalid status.';
  if (err?.code === 'PHASE_NOT_FOUND')      return 'Phase not found.';
  return 'Something went wrong; please try again.';
}

async function loadGuards(app, req, reply) {
  const session = await requireAdminSession(app, req, reply);
  if (!session) return null;
  const { customerId, projectId } = req.params ?? {};
  if (!UUID_RE.test(customerId) || !UUID_RE.test(projectId)) { notFound(req, reply); return null; }
  const customer = await findCustomerById(app.db, customerId);
  if (!customer) { notFound(req, reply); return null; }
  const project = await findProjectById(app.db, projectId);
  if (!project || project.customer_id !== customerId) { notFound(req, reply); return null; }
  return { session, customer, project, adminId: session.user_id };
}

// Variant for routes with :phaseId — also resolves the phase row and 404s
// if it doesn't belong to the URL's project. Defense-in-depth against
// admin URL-tampering.
async function loadGuardsWithPhase(app, req, reply) {
  const base = await loadGuards(app, req, reply);
  if (!base) return null;
  const phaseId = req.params?.phaseId;
  if (!UUID_RE.test(phaseId)) { notFound(req, reply); return null; }
  const phase = await findPhaseById(app.db, phaseId);
  if (!phase || phase.project_id !== base.project.id) { notFound(req, reply); return null; }
  return { ...base, phase };
}

export function registerAdminProjectPhasesRoutes(app) {
  app.post('/admin/customers/:customerId/projects/:projectId/phases',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const guards = await loadGuards(app, req, reply);
      if (!guards) return;
      const label = (req.body?.label || '').toString();
      try {
        await phasesService.create(
          app.db,
          { projectId: guards.project.id, customerId: guards.customer.id, label },
          ctxFromReq(req),
          { adminId: guards.adminId },
        );
      } catch (err) {
        return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
      }
      return back(reply, guards.customer.id, guards.project.id);
    });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/rename',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const guards = await loadGuardsWithPhase(app, req, reply);
      if (!guards) return;
      const label = (req.body?.label || '').toString();
      try {
        await phasesService.rename(
          app.db,
          { phaseId: guards.phase.id, customerId: guards.customer.id },
          { label },
          ctxFromReq(req),
          { adminId: guards.adminId },
        );
      } catch (err) {
        return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
      }
      return back(reply, guards.customer.id, guards.project.id);
    });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/status',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const guards = await loadGuardsWithPhase(app, req, reply);
      if (!guards) return;
      const newStatus = (req.body?.status || '').toString();
      try {
        await phasesService.changeStatus(
          app.db,
          { phaseId: guards.phase.id, customerId: guards.customer.id },
          { newStatus },
          ctxFromReq(req),
          { adminId: guards.adminId },
        );
      } catch (err) {
        return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
      }
      return back(reply, guards.customer.id, guards.project.id);
    });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/reorder',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const guards = await loadGuardsWithPhase(app, req, reply);
      if (!guards) return;
      const direction = (req.body?.direction || '').toString();
      try {
        await phasesService.reorder(
          app.db,
          { phaseId: guards.phase.id, customerId: guards.customer.id },
          { direction },
          ctxFromReq(req),
          { adminId: guards.adminId },
        );
      } catch (err) {
        return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
      }
      return back(reply, guards.customer.id, guards.project.id);
    });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/delete',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const guards = await loadGuardsWithPhase(app, req, reply);
      if (!guards) return;
      try {
        await phasesService.delete(
          app.db,
          { phaseId: guards.phase.id, customerId: guards.customer.id },
          ctxFromReq(req),
          { adminId: guards.adminId },
        );
      } catch (err) {
        return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
      }
      return back(reply, guards.customer.id, guards.project.id);
    });
}
