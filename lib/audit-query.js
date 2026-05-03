import { sql } from 'kysely';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
// Streaming CSV uses a fixed page size to bound memory; the audit_log
// can grow large so we never SELECT the whole table at once.
const STREAM_PAGE = 500;

const HEADERS = [
  'ts', 'id', 'actor_type', 'actor_id', 'actor_email', 'action',
  'target_type', 'target_id', 'visible_to_customer', 'ip', 'metadata',
];

// Escape PG LIKE metacharacters so a prefix like 'admin.session_' matches
// the literal trailing underscore (not "any single character"). Without
// this, future actions like 'admin.sessionsRevoked' would slip through
// the 'admin_auth' filter even though they belong elsewhere (M9 review M3).
function escapeLikePrefix(p) {
  return p.replace(/[\\%_]/g, '\\$&');
}

function buildWhere({ tagFilter, actionPrefixes, actorType, actorId, since, until }) {
  const prefixes = Array.isArray(actionPrefixes) && actionPrefixes.length > 0
    ? actionPrefixes.map((p) => `${escapeLikePrefix(p)}%`)
    : null;
  return {
    prefixes,
    actorType: actorType ?? null,
    actorId: actorId ?? null,
    since: since ? new Date(since) : null,
    until: until ? new Date(until) : null,
    tagFilter: tagFilter ?? null,
  };
}

function selectClause() {
  return sql`
    a.id::text          AS id,
    a.ts                AS ts,
    a.actor_type        AS actor_type,
    a.actor_id::text    AS actor_id,
    a.action            AS action,
    a.target_type       AS target_type,
    a.target_id::text   AS target_id,
    a.metadata          AS metadata,
    a.visible_to_customer AS visible_to_customer,
    host(a.ip)          AS ip,
    a.user_agent_hash   AS user_agent_hash,
    COALESCE(ad.email, cu.email) AS actor_email,
    COALESCE(ad.name,  cu.name)  AS actor_name
  `;
}

// Page through audit rows newest-first. The cursor is the last row's id
// (a UUIDv7, so id ordering matches insertion-time ordering); we order
// by (ts DESC, id DESC) and seek with id < cursor to avoid the
// microsecond-precision pitfall of carrying a JS-Date round-tripped ts
// (PG stores µs, JS Date is ms — equality on a truncated ts skips rows).
export async function listAuditPage(db, opts = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit ?? DEFAULT_LIMIT) | 0), MAX_LIMIT);
  const w = buildWhere(opts);
  // Strict UUID format — the looser /^[0-9a-f-]{36}$/i would accept e.g.
  // 36 dashes, which then 500's at PG's ::uuid cast. Match the canonical
  // 8-4-4-4-12 hex shape (M9 review M4).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const cursorId = typeof opts.cursor === 'string' && UUID_RE.test(opts.cursor)
    ? opts.cursor
    : null;

  const r = await sql`
    SELECT ${selectClause()}
      FROM audit_log a
      LEFT JOIN admins ad
             ON a.actor_type = 'admin' AND ad.id = a.actor_id
      LEFT JOIN customer_users cu
             ON a.actor_type = 'customer' AND cu.id = a.actor_id
     WHERE (${w.prefixes}::text[] IS NULL OR a.action LIKE ANY(${w.prefixes}::text[]))
       AND (${w.actorType}::text IS NULL OR a.actor_type = ${w.actorType}::text)
       AND (${w.actorId}::text IS NULL OR a.actor_id = ${w.actorId}::uuid)
       AND (${w.since}::timestamptz IS NULL OR a.ts >= ${w.since}::timestamptz)
       AND (${w.until}::timestamptz IS NULL OR a.ts <= ${w.until}::timestamptz)
       AND (${w.tagFilter}::text IS NULL OR a.metadata->>'tag' = ${w.tagFilter}::text)
       AND (${cursorId}::text IS NULL OR a.id < ${cursorId}::uuid)
     ORDER BY a.ts DESC, a.id DESC
     LIMIT ${limit + 1}
  `.execute(db);

  const rows = r.rows.slice(0, limit);
  const hasMore = r.rows.length > limit;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? last.id : null;
  return { rows, nextCursor };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (typeof value === 'string') s = value;
  else if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (/[",\n\r]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowToCsvLine(row) {
  return [
    row.ts instanceof Date ? row.ts.toISOString() : row.ts,
    row.id,
    row.actor_type,
    row.actor_id,
    row.actor_email,
    row.action,
    row.target_type,
    row.target_id,
    row.visible_to_customer ? 'true' : 'false',
    row.ip,
    row.metadata,
  ].map(csvEscape).join(',') + '\n';
}

// Streamed CSV export — yields chunks the route can pipe to the response
// without buffering the whole result set in memory. Pages internally with
// (ts, id) cursor matching listAuditPage's order so an export of N rows
// runs N/STREAM_PAGE bounded round-trips.
export async function* streamAuditCsv(db, opts = {}) {
  yield HEADERS.join(',') + '\n';
  let cursor = null;
  for (;;) {
    const page = await listAuditPage(db, { ...opts, limit: STREAM_PAGE, cursor });
    for (const row of page.rows) {
      yield rowToCsvLine(row);
    }
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}
