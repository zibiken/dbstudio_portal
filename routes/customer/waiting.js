import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';

// Phase D NDA-pending interstitial. Shown to a customer who has signed in
// but whose customers.nda_signed_at is still NULL (no signed NDA on file).
// Allowlisted out of the gate: this page itself, /customer/profile, and
// the public auth flows (logout, password reset, email-change verify).
export function registerCustomerWaitingRoutes(app) {
  app.get('/customer/waiting', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;

    if (session.nda_signed_at) {
      return reply.redirect('/customer/dashboard', 302);
    }

    const userR = await sql`
      SELECT id, email, name, customer_id
        FROM customer_users
       WHERE id = ${session.user_id}::uuid
    `.execute(app.db);
    const user = userR.rows[0];
    if (!user) return reply.redirect('/', 302);

    const customer = await findCustomerById(app.db, user.customer_id);

    return renderCustomer(req, reply, 'customer/waiting', {
      title: 'Waiting for NDA confirmation',
      user,
      customer,
      activeNav: null,
      mainWidth: 'content',
      sectionLabel: customer.razon_social.toUpperCase(),
    });
  });
}
