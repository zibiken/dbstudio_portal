import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';

export function registerCustomerDashboardRoutes(app) {
  app.get('/customer/dashboard', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;

    const userR = await sql`
      SELECT id, email, name, customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
    `.execute(app.db);
    const user = userR.rows[0];
    if (!user) return reply.redirect('/', 302);

    const customer = await findCustomerById(app.db, user.customer_id);
    return renderCustomer(req, reply, 'customer/dashboard', {
      title: 'Your portal',
      user,
      customer,
    });
  });
}
