import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import { listProjectsByCustomer } from '../../domain/projects/repo.js';
import { listPhasesByProject } from '../../domain/phases/repo.js';
import { listItemsByPhase } from '../../domain/phase-checklists/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerCustomerProjectsRoutes(app) {
  app.get('/customer/projects', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const userR = await sql`
      SELECT customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
    `.execute(app.db);
    const customerId = userR.rows[0]?.customer_id;
    if (!customerId) return reply.redirect('/', 302);

    const projects = await listProjectsByCustomer(app.db, customerId);
    return renderCustomer(req, reply, 'customer/projects/list', {
      title: 'Projects',
      projects,
      activeNav: 'projects',
      mainWidth: 'wide',
      sectionLabel: 'PROJECTS',
    });
  });

  app.get('/customer/projects/:projectId', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const projectId = req.params?.projectId;
    if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const userR = await sql`
      SELECT customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
    `.execute(app.db);
    const customerId = userR.rows[0]?.customer_id;
    if (!customerId) return reply.redirect('/', 302);

    const projectR = await sql`
      SELECT id::text AS id, name, objeto_proyecto, status, created_at
        FROM projects
       WHERE id = ${projectId}::uuid AND customer_id = ${customerId}::uuid
    `.execute(app.db);
    const project = projectR.rows[0];
    if (!project) return reply.code(404).send({ error: 'not_found' });

    // Customer-side filter (Decision 4): hide phases in not_started; show only
    // visible_to_customer items inside the remaining phases.
    const allPhases = await listPhasesByProject(app.db, projectId);
    const visiblePhases = allPhases.filter(p => p.status !== 'not_started');
    const phasesWithItems = await Promise.all(visiblePhases.map(async (p) => {
      const items = await listItemsByPhase(app.db, p.id);
      return { ...p, items: items.filter(i => i.visible_to_customer) };
    }));

    return renderCustomer(req, reply, 'customer/projects/show', {
      title: project.name,
      project,
      phases: phasesWithItems,
      activeNav: 'projects',
      mainWidth: 'wide',
      sectionLabel: 'PROJECTS',
    });
  });
}
