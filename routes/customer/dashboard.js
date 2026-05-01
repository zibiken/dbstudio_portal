import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { getCustomerDashboardSummary } from '../../lib/customer-summary.js';
import * as cqRepo from '../../domain/customer-questions/repo.js';

export function registerCustomerDashboardRoutes(app) {
  app.get('/customer/dashboard', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const userR = await sql`
      SELECT id, email, name, customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
    `.execute(app.db);
    const user = userR.rows[0];
    if (!user) return reply.redirect('/', 302);

    const customer = await findCustomerById(app.db, user.customer_id);
    const summary = await getCustomerDashboardSummary(app.db, { customerId: user.customer_id });
    const openQuestions = await cqRepo.listOpenForCustomer(app.db, user.customer_id);

    // Dashboard is per-user data — never shared. 15s is short enough to
    // feel live (typing on a sibling tab and switching back), long
    // enough to absorb back-button hits without a fresh DB round-trip.
    reply.header('Cache-Control', 'private, max-age=15');

    return renderCustomer(req, reply, 'customer/dashboard', {
      title: 'Your portal',
      user,
      customer,
      summary,
      openQuestions,
      activeNav: 'dashboard',
      mainWidth: 'wide',
      sectionLabel: customer.razon_social.toUpperCase(),
    });
  });
}
