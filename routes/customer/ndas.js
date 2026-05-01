import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import * as ndasService from '../../domain/ndas/service.js';
import { findCustomerUserById } from '../../domain/customers/repo.js';

// M8 Task 8.6 — customer-side NDA list.
//
// The customer ONLY sees NDAs whose `signed_document_id` is populated
// (enforced by domain/ndas/repo.listNdasForCustomer's WHERE clause —
// drafts must never appear here per operator scope clarification
// 2026-04-30; the customer signs through the operator's secure signing
// platform and only views the signed copy + audit-trail in this portal).
//
// Per-row downloads go through the existing /customer/documents/:id
// /download path which:
//   - rate-limits signed-URL issuance to 60/min per principal
//   - refuses category='nda-draft' explicitly (M8.4 hardening)
//   - returns a single-use 60s signed URL (M6.3 plumbing)
//
// There is NO standalone detail page in v1 — the list shows enough
// metadata (project name, signature sha prefix, signed/audit-trail
// download links) for the customer to retrieve what they need. M9
// polish can split into list/detail if the table grows unwieldy.

export function registerCustomerNdasRoutes(app) {
  app.get('/customer/ndas', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const me = await findCustomerUserById(app.db, session.user_id);
    if (!me) {
      reply.code(404);
      return renderCustomer(req, reply, 'customer/ndas/list', {
        title: 'NDAs',
        rows: [],
        activeNav: 'ndas',
        mainWidth: 'wide',
        sectionLabel: 'NDAS',
      });
    }

    const rows = await ndasService.listNdasForCustomer(app.db, me.customer_id);
    return renderCustomer(req, reply, 'customer/ndas/list', {
      title: 'NDAs',
      rows,
      activeNav: 'ndas',
      mainWidth: 'wide',
      sectionLabel: 'NDAS',
    });
  });
}
