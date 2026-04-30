import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import { listAuditPage, streamAuditCsv } from '../../lib/audit-query.js';
import { applySecureHeadersRaw } from '../../lib/secure-headers.js';

const PER_PAGE_DEFAULT = 100;
const PER_PAGE_MAX = 500;

const FILTER_GROUPS = Object.freeze({
  all: null,
  admin_auth: ['admin.login_', 'admin.2fa_', 'admin.password_', 'admin.session_', 'admin.logged_out_', 'admin.new_device_'],
  admin_profile: ['admin.name_', 'admin.email_change_'],
  customers: ['customer.', 'customer_user.'],
  credentials: ['credential.', 'credential_request.'],
  documents: ['document.'],
  invoices: ['invoice.'],
  ndas: ['nda.'],
  projects: ['project.'],
});

const ACTOR_TYPES = Object.freeze(['admin', 'customer', 'system']);

function clampInt(value, lo, hi, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function parseSinceUntil(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00Z`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildOpts(req, { withLimit = true } = {}) {
  const filterRaw = typeof req.query?.filter === 'string' ? req.query.filter : 'all';
  const filter = Object.prototype.hasOwnProperty.call(FILTER_GROUPS, filterRaw) ? filterRaw : 'all';
  const actorRaw = typeof req.query?.actor === 'string' ? req.query.actor : '';
  const actorType = ACTOR_TYPES.includes(actorRaw) ? actorRaw : null;
  const since = parseSinceUntil(typeof req.query?.since === 'string' ? req.query.since : '');
  const until = parseSinceUntil(typeof req.query?.until === 'string' ? req.query.until : '');
  const limit = withLimit
    ? clampInt(req.query?.limit, 1, PER_PAGE_MAX, PER_PAGE_DEFAULT)
    : undefined;
  const cursor = typeof req.query?.cursor === 'string' ? req.query.cursor : null;
  const opts = {
    actionPrefixes: FILTER_GROUPS[filter],
    actorType,
    since: since ?? undefined,
    until: until ?? undefined,
    cursor: cursor ?? undefined,
  };
  if (withLimit) opts.limit = limit;
  return { opts, filter, actorType, since: req.query?.since ?? '', until: req.query?.until ?? '', limit };
}

export function registerAdminAuditRoutes(app) {
  app.get('/admin/audit', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const { opts, filter, actorType, since, until, limit } = buildOpts(req);
    const page = await listAuditPage(app.db, opts);
    return renderAdmin(req, reply, 'admin/audit/index', {
      title: 'Audit log',
      events: page.rows,
      nextCursor: page.nextCursor,
      filter,
      actorType: actorType ?? '',
      since,
      until,
      limit,
      filterOptions: [
        { value: 'all', label: 'Everything' },
        { value: 'admin_auth', label: 'Admin auth' },
        { value: 'admin_profile', label: 'Admin profile' },
        { value: 'customers', label: 'Customers + customer users' },
        { value: 'credentials', label: 'Credentials' },
        { value: 'documents', label: 'Documents' },
        { value: 'invoices', label: 'Invoices' },
        { value: 'ndas', label: 'NDAs' },
        { value: 'projects', label: 'Projects' },
      ],
      actorOptions: [
        { value: '', label: 'Any' },
        { value: 'admin', label: 'Admins' },
        { value: 'customer', label: 'Customers' },
        { value: 'system', label: 'System' },
      ],
      currentQueryString: req.url.split('?')[1] ?? '',
    });
  });

  // Streamed CSV export. The audit_log can grow large; we deliberately
  // page via the same cursor as the HTML view and write each row to the
  // raw socket so memory stays bounded regardless of result-set size.
  app.get('/admin/audit-export.csv', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const { opts } = buildOpts(req, { withLimit: false });
    const filename = `audit_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store');

    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = 200;
    // hijack() bypasses the onSend hook in lib/secure-headers — re-apply the
    // base security set on the raw socket BEFORE the first chunk so HSTS /
    // nosniff / X-Frame-Options / Referrer-Policy / Permissions-Policy are
    // present on this response too (M9 review I1).
    applySecureHeadersRaw(raw);
    raw.setHeader('content-type', 'text/csv; charset=utf-8');
    raw.setHeader('content-disposition', `attachment; filename="${filename}"`);
    raw.setHeader('cache-control', 'no-store');
    try {
      for await (const chunk of streamAuditCsv(app.db, opts)) {
        if (!raw.write(chunk)) {
          await new Promise((res) => raw.once('drain', res));
        }
      }
      raw.end();
    } catch (err) {
      app.log.error({ err }, 'audit-export stream failed');
      raw.destroy(err);
    }
  });
}
