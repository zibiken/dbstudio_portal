import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import { listActivityForCustomer } from '../../lib/activity-feed.js';

const PER_PAGE_DEFAULT = 50;
const PER_PAGE_MAX = 200;

const ACTION_GROUPS = Object.freeze({
  profile: ['customer_user.', 'customer.'],
  credentials: ['credential.', 'credential_request.'],
  documents: ['document.'],
  invoices: ['invoice.'],
  ndas: ['nda.'],
  projects: ['project.'],
});

function clampInt(value, lo, hi, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function parseSinceUntil(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  // Accept YYYY-MM-DD (input type=date) or full ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00Z`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function customerIdFor(app, session) {
  const r = await sql`
    SELECT customer_id::text AS customer_id, name, email
      FROM customer_users WHERE id = ${session.user_id}::uuid
  `.execute(app.db);
  return r.rows[0] ?? null;
}

export function registerCustomerActivityRoutes(app) {
  app.get('/customer/activity', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;
    const userRow = await customerIdFor(app, session);
    if (!userRow) return reply.redirect('/', 302);

    const filterRaw = typeof req.query?.filter === 'string' ? req.query.filter : 'all';
    const filter = Object.prototype.hasOwnProperty.call(ACTION_GROUPS, filterRaw) ? filterRaw : 'all';
    const since = parseSinceUntil(typeof req.query?.since === 'string' ? req.query.since : '');
    const until = parseSinceUntil(typeof req.query?.until === 'string' ? req.query.until : '');
    const limit = clampInt(req.query?.limit, 1, PER_PAGE_MAX, PER_PAGE_DEFAULT);

    const events = await listActivityForCustomer(app.db, userRow.customer_id, {
      actionPrefixes: filter === 'all' ? null : ACTION_GROUPS[filter],
      since: since ?? undefined,
      until: until ?? undefined,
      limit,
    });

    return renderCustomer(req, reply, 'customer/activity', {
      title: 'Activity',
      events,
      filter,
      since: typeof req.query?.since === 'string' ? req.query.since : '',
      until: typeof req.query?.until === 'string' ? req.query.until : '',
      limit,
      filterOptions: [
        { value: 'all', label: 'Everything' },
        { value: 'profile', label: 'Profile & account' },
        { value: 'credentials', label: 'Credentials' },
        { value: 'documents', label: 'Documents' },
        { value: 'invoices', label: 'Invoices' },
        { value: 'ndas', label: 'NDAs' },
        { value: 'projects', label: 'Projects' },
      ],
      activeNav: 'activity',
      mainWidth: 'wide',
      sectionLabel: 'ACTIVITY',
    });
  });
}
