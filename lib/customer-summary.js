// Customer dashboard summary aggregator.
//
// One Postgres call returning per-section count + latestAt + unreadCount
// for the customer dashboard's bento grid (T17). Cached behind
// `Cache-Control: private, max-age=15` on the dashboard route — short
// enough to feel live, cheap enough not to hammer the DB.
//
// Six sections, each with a deterministic shape:
//   { count: number, latestAt: Date|null, unreadCount: number }
//
// Per-section semantics:
//
//   ndas
//     count       all NDAs on file for this customer
//     latestAt    MAX(generated_at)
//     unreadCount drafts awaiting signature (signed_document_id IS NULL)
//
//   documents
//     count       all documents except category='nda-draft' (drafts are
//                 admin-only; all other categories are customer-visible,
//                 matching what the /customer/documents list renders)
//     latestAt    MAX(uploaded_at) over the same filter
//     unreadCount 0 — no per-document seen tracking at v1.0; placeholder
//                 for a future read-receipt column.
//
//   credentials
//     count       all credentials on file
//     latestAt    MAX(updated_at)
//     unreadCount admin-flagged needs_update = true (the admin has asked
//                 the customer to refresh the value)
//
//   credentialRequests
//     count       all requests on file
//     latestAt    MAX(updated_at)
//     unreadCount status = 'open' (awaiting customer action)
//
//   invoices
//     count       all invoices on file
//     latestAt    MAX(created_at) — invoices have no updated_at
//     unreadCount status = 'open' (admin-side: unpaid; the customer
//                 dashboard treats this as "needs attention")
//
//   projects
//     count       all projects on file (any status)
//     latestAt    MAX(updated_at)
//     unreadCount 0 — no per-project unread surface; projects are a
//                 stable reference, not a notification stream.
//
// One round-trip with a single SELECT and per-section scalar subqueries.
// Each subquery is bounded by an index on (customer_id, …) which exists
// for every table aggregated here (see migrations/0001_init.sql), so
// EXPLAIN reports index-only scans for the typical small-customer case.

import { sql } from 'kysely';

export async function getCustomerDashboardSummary(db, { customerId } = {}) {
  if (!customerId || typeof customerId !== 'string') {
    throw new Error('getCustomerDashboardSummary: customerId required');
  }

  const r = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM ndas WHERE customer_id = ${customerId}::uuid)
        AS ndas_count,
      (SELECT MAX(generated_at) FROM ndas WHERE customer_id = ${customerId}::uuid)
        AS ndas_latest,
      (SELECT COUNT(*)::int FROM ndas WHERE customer_id = ${customerId}::uuid AND signed_document_id IS NULL)
        AS ndas_unread,

      (SELECT COUNT(*)::int FROM documents WHERE customer_id = ${customerId}::uuid AND category <> 'nda-draft')
        AS docs_count,
      (SELECT MAX(uploaded_at) FROM documents WHERE customer_id = ${customerId}::uuid AND category <> 'nda-draft')
        AS docs_latest,

      (SELECT COUNT(*)::int FROM credentials WHERE customer_id = ${customerId}::uuid)
        AS cred_count,
      (SELECT MAX(updated_at) FROM credentials WHERE customer_id = ${customerId}::uuid)
        AS cred_latest,
      (SELECT COUNT(*)::int FROM credentials WHERE customer_id = ${customerId}::uuid AND needs_update = TRUE)
        AS cred_unread,

      (SELECT COUNT(*)::int FROM credential_requests WHERE customer_id = ${customerId}::uuid)
        AS creq_count,
      (SELECT MAX(updated_at) FROM credential_requests WHERE customer_id = ${customerId}::uuid)
        AS creq_latest,
      (SELECT COUNT(*)::int FROM credential_requests WHERE customer_id = ${customerId}::uuid AND status = 'open')
        AS creq_unread,

      (SELECT COUNT(*)::int FROM invoices WHERE customer_id = ${customerId}::uuid)
        AS inv_count,
      (SELECT MAX(created_at) FROM invoices WHERE customer_id = ${customerId}::uuid)
        AS inv_latest,
      (SELECT COUNT(*)::int FROM invoices WHERE customer_id = ${customerId}::uuid AND status = 'open')
        AS inv_unread,

      (SELECT COUNT(*)::int FROM projects WHERE customer_id = ${customerId}::uuid)
        AS prj_count,
      (SELECT MAX(updated_at) FROM projects WHERE customer_id = ${customerId}::uuid)
        AS prj_latest
  `.execute(db);

  const row = r.rows[0] ?? {};
  const toDate = (v) => (v == null ? null : (v instanceof Date ? v : new Date(v)));

  return {
    ndas: {
      count: row.ndas_count ?? 0,
      latestAt: toDate(row.ndas_latest),
      unreadCount: row.ndas_unread ?? 0,
    },
    documents: {
      count: row.docs_count ?? 0,
      latestAt: toDate(row.docs_latest),
      unreadCount: 0,
    },
    credentials: {
      count: row.cred_count ?? 0,
      latestAt: toDate(row.cred_latest),
      unreadCount: row.cred_unread ?? 0,
    },
    credentialRequests: {
      count: row.creq_count ?? 0,
      latestAt: toDate(row.creq_latest),
      unreadCount: row.creq_unread ?? 0,
    },
    invoices: {
      count: row.inv_count ?? 0,
      latestAt: toDate(row.inv_latest),
      unreadCount: row.inv_unread ?? 0,
    },
    projects: {
      count: row.prj_count ?? 0,
      latestAt: toDate(row.prj_latest),
      unreadCount: 0,
    },
  };
}
