import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';

const ALLOWED_RETURN_RE = /^\/admin\/[A-Za-z0-9\-_./?=&%]*$/;

// Sanitise the ?return= query param to an internal /admin/* path.
// Rejects external schemes, scheme-relative URLs, traversal, and recursive
// ?return= chains. Falls back to '/admin/' when the input doesn't match a
// strict /admin/ prefix.
function sanitiseReturn(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '/admin/';
  if (raw.includes('://')) return '/admin/';
  if (raw.includes('..')) return '/admin/';
  if (/[?&]return=/i.test(raw)) return '/admin/';
  if (raw.startsWith('//')) return '/admin/';
  if (!ALLOWED_RETURN_RE.test(raw)) return '/admin/';
  return raw;
}

export function registerAdminStepUpRoutes(app) {
  app.get('/admin/step-up', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const safeReturn = sanitiseReturn(req.query?.return ?? '/admin/');
    return renderAdmin(req, reply, 'admin/step-up', {
      title: "Confirm it's you",
      csrfToken: await reply.generateCsrf(),
      returnTo: safeReturn,
      activeNav: null,
      mainWidth: 'content',
      sectionLabel: 'ADMIN · STEP-UP',
    });
  });
}
