import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession } from '../../lib/auth/middleware.js';
import { listProjectsByCustomer } from '../../domain/projects/repo.js';

export function registerCustomerProjectsRoutes(app) {
  app.get('/customer/projects', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;

    const userR = await sql`
      SELECT customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
    `.execute(app.db);
    const customerId = userR.rows[0]?.customer_id;
    if (!customerId) return reply.redirect('/', 302);

    const projects = await listProjectsByCustomer(app.db, customerId);
    return renderCustomer(req, reply, 'customer/projects/list', {
      title: 'Projects',
      projects,
    });
  });
}
