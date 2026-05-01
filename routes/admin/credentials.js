import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { listCredentialsByCustomer } from '../../domain/credentials/repo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(req, reply) {
  reply.code(404);
  return renderAdmin(req, reply, 'admin/customers/not-found', {
    title: 'Not found',
    activeNav: 'customers',
    mainWidth: 'content',
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

// Admin-side credentials surface is METADATA ONLY by design (M7 spec §2.4):
// the credential payload is encrypted with the customer's DEK, which the
// server never holds in cleartext outside the customer's own request scope.
// This route lists labels/providers/timestamps so operators can see what
// the customer has stored, flag stale entries via "needs update", or open a
// matching credential request — but it never decrypts or surfaces the
// secret itself. The customer's own portal is the only path that reveals.
export function registerAdminCredentialsRoutes(app) {
  app.get('/admin/customers/:id/credentials', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    const rows = await listCredentialsByCustomer(app.db, id);
    return renderAdmin(req, reply, 'admin/credentials/list', {
      title: 'Credentials · ' + customer.razon_social,
      customer,
      rows,
      mainWidth: 'wide',
      ...customerChrome(customer, 'credentials'),
    });
  });
}
