import { requireAdminSession } from '../../lib/auth/middleware.js';

export function registerAdminIndexRoute(app) {
  app.get('/admin', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    return reply.redirect('/admin/customers', 302);
  });
}
