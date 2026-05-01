# Codex Final Code Review
**Timestamp:** 2026-05-01T22:34:01Z
**Repository:** /opt/dbstudio_portal
**Review type:** Final code review (correctness, security, architecture, edge cases)

## Codex CLI Detected
The `codex` command is available. To run this review via Codex CLI:
```
codex "# Codex Final Code Review
**Timestamp:** 2026-05-01T22:28:27Z
**Repository:** /opt/dbstudio_portal
**Review type:** Final code review (correctness, security, architecture, edge cases)"
```
Or use the Claude Code Codex plugin (/review command) if configured.


---

## Review Prompt

Please perform a thorough final code review of the following changes.

**Repository:** /opt/dbstudio_portal
**Timestamp:** 2026-05-01T22:34:01Z

### Scope of Review

You are the final code reviewer. Review for:
- **Correctness** — logic errors, wrong assumptions, off-by-one, type errors
- **Bugs** — edge cases, null handling, race conditions, error paths
- **Security** — injection, XSS, CSRF, auth bypass, secret exposure, insecure defaults
- **Maintainability** — readability, naming, complexity, dead code, duplication
- **Architecture** — design decisions, coupling, separation of concerns
- **Tests** — missing tests, weak assertions, test coverage gaps
- **Performance** — N+1 queries, unnecessary work, memory leaks
- **Migrations** — backward compatibility, data safety, rollback safety
- **Deployment risks** — breaking changes, environment assumptions, config dependencies
- **Regressions** — unintended side effects on existing behavior
- **Requirements alignment** — does the implementation match the stated goal?

### What to NOT review (handled separately)
- UI/UX design, visual layout, accessibility — reviewed by Kimi
- Brand copy, marketing text — out of scope

### Recent Commits
```
96326a7 docs(phase-f): mark phase F shipped; record commit refs in roadmap
a2f1c1c feat(phase-f): customer-side view-with-decrypt UI
1d0afb1 feat(phase-f): customer-questions UI completion
3548056 chore(phase-f): wire advisory checker into run-tests.sh
2c551ef chore(phase-f): add advisory detail-page pattern checker
b058414 feat(phase-f): align reveal-credentials page to resource-type pattern
3f1973a feat(phase-f): redesign digest body with grouping, dates, deep links
40f142a feat(phase-f): dynamic digest subject with action/FYI counts
3e937d2 feat(phase-f): rewrite digest strings with natural verbs and recipient-aware copy
bf472ff feat(phase-f): add humanDate helper for digest line dates
```

### Changed Files
```
docs/superpowers/follow-ups.md
domain/customers/service.js
lib/customer-summary.js
public/styles/app.src.css
.reviews/codex-code-review.md
.reviews/codex-review-prompt.md
.reviews/kimi-design-review.md
routes/admin/customer-questions.js
routes/customer/credentials.js
routes/customer/questions.js
routes/public/login-2fa.js
routes/public/login.js
tests/integration/customer-summary/summary.test.js
tests/integration/customers/verifyLogin.test.js
views/customer/questions/show.ejs
```

### Git Diff
```diff
diff --git a/docs/superpowers/follow-ups.md b/docs/superpowers/follow-ups.md
index 482929f..d5e1d4d 100644
--- a/docs/superpowers/follow-ups.md
+++ b/docs/superpowers/follow-ups.md
@@ -9,6 +9,19 @@ live and which can ship as v1.0 + post-launch work.
 
 ## ROADMAP STATUS (2026-05-01)
 
+### ✅ Shipped in Phase F
+
+- **Digest cadence rework** — fixed twice-daily fires (08:00 + 17:00 Atlantic/Canary), skip-if-empty at fire time. `lib/digest-cadence.js` (`nextDigestFire`), `domain/digest/repo.upsertSchedule` simplified, sliding 10/60-min window retired. Commits `6d57456`, `e8d301e`, `01cc97f`.
+- **Digest content rework** — natural-language verbs, recipient-aware copy (admin/customer split), count-aware singular/plural for COALESCING_EVENTS, dynamic subject line via `digestSubject` + per-row `subjectOverride` plumbed through `enqueue` + `renderTemplate`, per-customer grouping for admin digest, `humanDate` per-line labels, deep-link honouring, dual-mode (`prefers-color-scheme: light`) email CSS. Commits `bf472ff`, `3e937d2`, `40f142a`, `3f1973a`.
+- **Reveal credentials page consistency** — `views/admin/credentials/show.ejs` rewritten to resource-type pattern (eyebrow `ADMIN · CUSTOMERS`, title `Credential`, subtitle `<customer> · <provider>`, status pills in actions slot). Commit `b058414`.
+- **Detail-page layout pattern checker** — `scripts/check-detail-pattern.js` (advisory, non-blocking) wired into `scripts/run-tests.sh`. Commits `2c551ef`, `3548056`.
+- **Customer-questions UI completion** — admin list / detail pages, customer list page, `Questions` tab in `_admin-customer-tabs`, `Questions` entry in `_sidebar-customer`, header rewrites on existing `new.ejs` and `show.ejs`. Commit `1d0afb1`.
+- **Customer-side view-with-decrypt UI (M9.X partial)** — `service.viewByCustomer` mirrors `view()` for the customer actor (vault-unlock gate, customer-visible audit, admin-only fan-out), customer step-up route + view, customer credentials show + reveal route, list page label now links to detail, honest copy. Commit `a2f1c1c`.
+
+Test count: baseline 657 passing → Phase F final 704 passing / 3 skipped / 0 failing.
+Migration ledger unchanged at `0011_phase_d` (no schema change).
+Advisory linter has 2 pre-existing out-of-scope warnings (`customers/detail.ejs`, `projects/detail.ejs`).
+
 ### ✅ Shipped in Phase D
 
 - NDA gate (`customers.nda_signed_at` + `/customer/waiting`) — `8a03fb0`, `9bfa1c0`
@@ -26,7 +39,7 @@ live and which can ship as v1.0 + post-launch work.
 
 That fully closes the "Phase D operator feedback batch (2026-05-01)" section below (all 5 items) + the "Admin credential view UI (M7 deferred minor)" section. Those entries are kept below as historical record but should NOT be re-actioned.
 
-### 🟡 Next on the roadmap (Phase F)
+### ~~🟡 Next on the roadmap (Phase F)~~ — SHIPPED (see Phase F section above)
 
 **Digest email copy / layout / grouping rework.** Originates from the operator's original Phase D handoff (`docs/superpowers/2026-05-01-phase-d-handoff.md`, "Independent issue surfaced 2026-05-01"). The operator received a real digest email containing 23+ lines of test-fixture-flavoured noise; the test pollution itself was fixed in Phase D, but the underlying readability problems with the live digest emails are a separate ship.
 

```

### Framework Context
```json
{
  "name": "dbstudio-portal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": "20.19.6"
  },
  "scripts": {
    "start": "node server.js",
    "start:pdf": "node pdf-service.js",
    "build": "node scripts/build.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint .",
    "typecheck": "tsc -p jsconfig.json --noEmit",
    "migrate": "node migrations/runner.js",
    "db:codegen": "kysely-codegen --url \"$DATABASE_URL\" --out-file lib/db/types.d.ts --include-pattern 'public.*' --camel-case"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^4.1.5",
    "autoprefixer": "^10.5.0",
    "eslint": "^10.2.1",
    "kysely-codegen": "^0.20.0",
    "postcss": "^8.5.12",
    "prettier": "^3.8.3",
    "tailwindcss": "^3.4.19",
    "typescript": "^6.0.3",
    "vitest": "^4.1.5"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/csrf-protection": "^7.1.0",
    "@fastify/formbody": "^8.0.2",
    "@fastify/multipart": "^10.0.0",
    "@fastify/sensible": "^6.0.4",
    "@fastify/static": "^9.1.3",
    "@fastify/view": "^11.1.1",
    "@simplewebauthn/server": "^13.3.0",
    "argon2": "^0.44.0",
    "ejs": "^5.0.2",
    "fastify": "^5.8.5",
    "fastify-plugin": "^5.1.0",
    "file-type": "^21.3.4",
    "i18next": "^26.0.8",
    "i18next-fs-backend": "^2.6.5",
    "kysely": "^0.28.16",
    "mustache": "^4.2.0",
    "otplib": "^13.4.0",
    "pdf-parse": "^1.1.4",
    "pg": "^8.20.0",
    "pino": "^10.3.1",
    "pino-pretty": "^13.1.3",
    "puppeteer": "^24.42.0",
    "qrcode": "^1.5.4",
    "uuid": "^14.0.0",
    "zod": "^4.3.6"
  }
}
```

### File Contents
### docs/superpowers/follow-ups.md\n```\n# DB Studio Portal — follow-ups (post-M9)

This file captures work that touches v1 acceptance items but is
deliberately NOT in M9's "land it" scope. The §11 acceptance dry-run
walks each item below and decides per case which are blockers for go-
live and which can ship as v1.0 + post-launch work.

---

## ROADMAP STATUS (2026-05-01)

### ✅ Shipped in Phase F

- **Digest cadence rework** — fixed twice-daily fires (08:00 + 17:00 Atlantic/Canary), skip-if-empty at fire time. `lib/digest-cadence.js` (`nextDigestFire`), `domain/digest/repo.upsertSchedule` simplified, sliding 10/60-min window retired. Commits `6d57456`, `e8d301e`, `01cc97f`.
- **Digest content rework** — natural-language verbs, recipient-aware copy (admin/customer split), count-aware singular/plural for COALESCING_EVENTS, dynamic subject line via `digestSubject` + per-row `subjectOverride` plumbed through `enqueue` + `renderTemplate`, per-customer grouping for admin digest, `humanDate` per-line labels, deep-link honouring, dual-mode (`prefers-color-scheme: light`) email CSS. Commits `bf472ff`, `3e937d2`, `40f142a`, `3f1973a`.
- **Reveal credentials page consistency** — `views/admin/credentials/show.ejs` rewritten to resource-type pattern (eyebrow `ADMIN · CUSTOMERS`, title `Credential`, subtitle `<customer> · <provider>`, status pills in actions slot). Commit `b058414`.
- **Detail-page layout pattern checker** — `scripts/check-detail-pattern.js` (advisory, non-blocking) wired into `scripts/run-tests.sh`. Commits `2c551ef`, `3548056`.
- **Customer-questions UI completion** — admin list / detail pages, customer list page, `Questions` tab in `_admin-customer-tabs`, `Questions` entry in `_sidebar-customer`, header rewrites on existing `new.ejs` and `show.ejs`. Commit `1d0afb1`.
- **Customer-side view-with-decrypt UI (M9.X partial)** — `service.viewByCustomer` mirrors `view()` for the customer actor (vault-unlock gate, customer-visible audit, admin-only fan-out), customer step-up route + view, customer credentials show + reveal route, list page label now links to detail, honest copy. Commit `a2f1c1c`.

Test count: baseline 657 passing → Phase F final 704 passing / 3 skipped / 0 failing.
Migration ledger unchanged at `0011_phase_d` (no schema change).
Advisory linter has 2 pre-existing out-of-scope warnings (`customers/detail.ejs`, `projects/detail.ejs`).

### ✅ Shipped in Phase D

- NDA gate (`customers.nda_signed_at` + `/customer/waiting`) — `8a03fb0`, `9bfa1c0`
- Type C short-answer questionnaire (`customer_questions` table + admin/customer surfaces + 3 digest events) — `513167a`, `c474bfc`, `e7c7a80`
- "Cleaned up" dashboard banner (admin credential.deleted → customer banner with dismissal) — `0a60777`
- Test-pollution cleanup (shared helper + global teardown + one-time script) — `d810703`, `46df916`, `c6995af`

### ✅ Shipped in Phase E

- **Customer credential-eye toggle** — `70c0d0e` (Phase D batch item 1)
- **Bento card alignment on customer dashboard** — `4b7ef81` (Phase D batch item 2)
- **Admin credential decryption** + step-up route + customer/admin copy honesty — `4473d36`, `70f7429`, `461bbc0`, `ad9e1b9` (Phase D batch item 3)
- **Reset-success-page typo softening** — `ad9e1b9` (Phase D batch item 4)
- **verifyLogin → first-attempt sign-in regression test** + 2FA bucket-isolation annotation — `ad9e1b9` (Phase D batch item 5)

That fully closes the "Phase D operator feedback batch (2026-05-01)" section below (all 5 items) + the "Admin credential view UI (M7 deferred minor)" section. Those entries are kept below as historical record but should NOT be re-actioned.

### ~~🟡 Next on the roadmap (Phase F)~~ — SHIPPED (see Phase F section above)

**Digest email copy / layout / grouping rework.** Originates from the operator's original Phase D handoff (`docs/superpowers/2026-05-01-phase-d-handoff.md`, "Independent issue surfaced 2026-05-01"). The operator received a real digest email containing 23+ lines of test-fixture-flavoured noise; the test pollution itself was fixed in Phase D, but the underlying readability problems with the live digest emails are a separate ship.

Concrete items the operator flagged at the time (verbatim):

- *"`<companyName> added 1 credential` → '<companyName> uploaded a new credential to their vault' reads better"*
- *"the current admin digest has no visual grouping per customer when multiple customers were active"*
- *"no timestamps on items — a date or 'today / yesterday' hint would help context"*
- *"the 'subject' is generic ('Activity update from DB Studio Portal') — ranges like '5 things to action, 12 FYI' would tell the reader what's inside before they open"*
- *"'Sign in to see the full timeline' is fine but the link target is generic — could deep-link to the activity feed"*
- *"visual hierarchy: today, items are a flat bulleted list; for admin digests with 20+ lines this is overwhelming"*

Specific copy/format reworks the operator suggested:

- Drop the visible internal IDs (test pollution leaked these — but real customer names like "Solbizz Canarias S.L.U." are also long; consider truncation or boldening).
- Group admin digest items by customer with a small sub-heading.
- Show counts per customer in the header ("Acme Corp — 4 items").
- Use natural-language verbs: "uploaded", "viewed", "marked …", "fully paid".
- Date stamps on each line (or "Today", "Yesterday", "2 days ago" using the recipient's locale).
- Subject line should reflect content: "1 action required, 4 updates from DB Studio Portal".
- Render time: test on Gmail, Apple Mail, Outlook web — current email is dark-themed; some clients normalise to light mode and the lists may break.

**Files to look at first when picking up:**
- `lib/digest-strings.js` — title strings per locale + event type. Soft-target for the copy rewrite.
- `domain/digest/worker.js` — locals fan-out. Adding timestamps/grouping means the worker passes more locals.
- `emails/{en,nl,es}/digest\n```\n\n### domain/customers/service.js\n```\nimport { randomBytes, createHash } from 'node:crypto';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import {
  generateDek, wrapDek, unwrapDek, encrypt, decrypt,
} from '../../lib/crypto/envelope.js';
import { hashPassword, verifyPassword, hibpHasBeenPwned as defaultHibp, SENTINEL_HASH } from '../../lib/crypto/hash.js';
import { generateBackupCodes, verifyAndConsume } from '../../lib/auth/backup-codes.js';
import { verify as verifyTotp } from '../../lib/auth/totp.js';
import { createSession, stepUp } from '../../lib/auth/session.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
import { listActiveCustomerUsers } from '../../lib/digest-fanout.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import { insertCustomer, insertCustomerUser, updateCustomer as repoUpdateCustomer } from './repo.js';

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;

function generateInviteToken() {
  return randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function audit(db, ctx, action, { customerId, metadata = {} } = {}) {
  return writeAudit(db, {
    actorType: ctx?.actorType ?? 'system',
    actorId: ctx?.actorId ?? null,
    action,
    targetType: 'customer',
    targetId: customerId ?? null,
    metadata: { ...(ctx?.audit ?? {}), ...metadata },
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  });
}

function trimTrailingSlashes(s) {
  return typeof s === 'string' ? s.replace(/\/+$/, '') : '';
}

function requirePortalBaseUrl(ctx, callerName) {
  const url = trimTrailingSlashes(ctx?.portalBaseUrl ?? process.env.PORTAL_BASE_URL ?? '');
  if (!url) {
    throw new Error(`${callerName} requires portalBaseUrl (ctx.portalBaseUrl or PORTAL_BASE_URL env)`);
  }
  return url;
}

function requireKek(ctx, callerName) {
  const kek = ctx?.kek;
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error(`${callerName} requires ctx.kek (32-byte Buffer from app.kek)`);
  }
  return kek;
}

export async function create(
  db,
  { razonSocial, nif = null, domicilio = null, primaryUser },
  ctx = {},
) {
  const baseUrl = requirePortalBaseUrl(ctx, 'customers.create');
  const kek = requireKek(ctx, 'customers.create');

  const customerId = uuidv7();
  const primaryUserId = uuidv7();
  const inviteToken = generateInviteToken();
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const dek = generateDek();
  const wrapped = wrapDek(dek, kek);

  await db.transaction().execute(async (tx) => {
    await insertCustomer(tx, {
      id: customerId,
      razonSocial,
      nif,
      domicilio,
      dekCiphertext: wrapped.ciphertext,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
    });
    await insertCustomerUser(tx, {
      id: primaryUserId,
      customerId,
      email: primaryUser.email,
      name: primaryUser.name,
      inviteTokenHash,
      inviteExpiresAt,
    });
    await audit(tx, ctx, 'customer.created', {
      customerId,
      metadata: {
        razonSocial,
        primaryUserId,
        primaryUserEmail: primaryUser.email,
      },
    });
    await enqueueEmail(tx, {
      idempotencyKey: `customer_welcome:${customerId}`,
      toAddress: primaryUser.email,
      template: 'customer-invitation',
      locals: {
        recipientName: primaryUser.name,
        inviteUrl: `${baseUrl}/customer/welcome/${inviteToken}`,
        expiresAt: inviteExpiresAt.toISOString(),
      },
    });
  });

  return { customerId, primaryUserId, inviteToken };
}

// Mints a fresh invite token on an existing customer_user row + emails
// a reset link. Mirrors admins.requestPasswordReset:
// - Always neutral on the public surface (POST /reset always renders
//   the same "Check your email" page) — no enumeration.
// - When the email matches an active customer_user, this writes
//   customer.password_reset_requested + enqueues a customer-pw-reset
//   email pointing at /customer/welcome/<token>. The customer onboarding
//   handler already consumes invite_token_hash and re-enrols password +
//   TOTP atomically — same path as first-time setup.
// - Otherwise audits customer.password_reset_requested_unknown.
//
// Suspended / archived customers don't receive a reset link — the
// account state already blocks login.
export async function requestCustomerPasswordReset(db, { email }, ctx = {}) {
  const baseUrl = requirePortalBaseUrl(ctx, 'customers.requestPasswordReset');
  const safeEmail = typeof email === 'string' ? email.slice(0, 320) : null;

  const r = await sql`
    SELECT cu.id AS user_id, cu.customer_id, cu.email::text AS email, cu.name,
           c.status AS customer_status
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.email = ${email}::citext
     LIMIT 1
  `.execute(db);
  const row = r.rows[0];

  if (!row || row.customer_status !== 'active') {
    await writeAudit(db, {
      actorType: ctx?.actorType ?? 'system',
      actorId: ctx?.actorId ?? null,
      action: 'customer.password_reset_requested_unknown',
      targetType: 'customer_user',
      targetId: row?.user_id ?? null,
      metadata: {
        email: safeEmail,
        ...(ctx?.audit ?? {}),
        ...(row && row.customer_status !== 'active' ? { customer_status: row.customer_status } : {}),
      },
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });
    return { inviteToken: null };
  }

  const inviteToken = generateInviteToken();
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await db.transaction().execute(async (tx) => {
    await sql`
      UPDATE customer_users
         SET invite_token_hash = ${inviteTokenHash},
             invite_expires_at = ${inviteEx\n```\n\n### lib/customer-summary.js\n```\n// Customer dashboard summary aggregator.
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
}\n```\n\n### public/styles/app.src.css\n```\n@import './tokens.css';

/* ---- Marketing globals (vendored from /opt/dbstudio/src/styles/global.css on 2026-04-30) ---- */

*, *::before, *::after { box-sizing: border-box; }

html {
  -webkit-text-size-adjust: 100%;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  scroll-behavior: smooth;
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}

body {
  margin: 0;
  background: var(--bg-light);
  color: var(--fg-on-light);
  font-family: var(--f-body);
  font-size: var(--f-md);
  line-height: var(--lh-body);
  letter-spacing: var(--ls-body);
  font-feature-settings: 'ss01', 'ss02';
}

body.public { background: var(--bg-dark); color: var(--fg-on-dark); }

h1, h2, h3, h4 {
  font-family: var(--f-display);
  font-weight: 700;
  line-height: var(--lh-head);
  letter-spacing: var(--ls-head);
  margin: 0 0 var(--s-4);
}

h1 { font-size: var(--f-5xl); line-height: var(--lh-display); letter-spacing: var(--ls-display); font-weight: 900; }
h2 { font-size: var(--f-4xl); }
h3 { font-size: var(--f-3xl); }
h4 { font-size: var(--f-2xl); }

p { margin: 0 0 var(--s-4); }
a { color: inherit; text-decoration-color: currentColor; text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--c-gold); }

button { font: inherit; color: inherit; cursor: pointer; }

img, video, svg, picture { max-width: 100%; height: auto; display: block; }

:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: 2px;
}

.skip-link {
  position: absolute;
  top: -40px;
  left: var(--s-4);
  background: var(--c-obsidian);
  color: var(--c-ivory);
  padding: var(--s-2) var(--s-4);
  border-radius: var(--radius-btn);
  text-decoration: none;
  z-index: 1000;
  transition: top 150ms ease;
}
.skip-link:focus { top: var(--s-4); }

.container {
  width: 100%;
  max-width: var(--container);
  margin-inline: auto;
  padding-inline: var(--s-6);
}
@media (min-width: 768px) { .container { padding-inline: var(--s-8); } }
@media (min-width: 1024px) { .container { padding-inline: var(--s-12); } }

.section { padding-block: var(--s-16); }
@media (min-width: 768px)  { .section { padding-block: var(--s-24); } }
@media (min-width: 1024px) { .section { padding-block: var(--s-40); } }

.section--dark      { background: var(--bg-dark);      color: var(--fg-on-dark); }
.section--dark-alt  { background: var(--bg-dark-alt);  color: var(--fg-on-dark); }
.section--light     { background: var(--bg-light);     color: var(--fg-on-light); }
.section--light-alt { background: var(--bg-light-alt); color: var(--fg-on-light); }

.eyebrow {
  display: inline-block;
  font-family: var(--f-mono);
  text-transform: uppercase;
  font-size: var(--f-xs);
  letter-spacing: var(--ls-upper);
  color: var(--fg-on-dark-muted);
  margin-bottom: var(--s-4);
}
.section--light .eyebrow,
body:not(.public) .eyebrow { color: var(--fg-on-light-muted); }

.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0);
  white-space: nowrap; border: 0;
}

/* ---- M11 component styles ---- */

/* _eyebrow uses the .eyebrow rule from the global resets — no extra style needed. */

/* _alert */
.alert {
  display: flex;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--radius-card);
  border-left: 4px solid var(--c-slate);
  background: var(--bg-light-alt);
  color: var(--fg-on-light);
  margin-block: var(--s-3);
}
.alert--info    { border-left-color: var(--c-ice); }
.alert--success { border-left-color: var(--c-success); }
.alert--warn    { border-left-color: var(--c-warn); }
.alert--error   { border-left-color: var(--c-error); }
.alert--sticky  { position: sticky; top: 0; z-index: 50; }
.alert__body    { flex: 1; }

/* _button */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: var(--s-2);
  font-family: var(--f-body);
  font-weight: 600;
  border-radius: var(--radius-btn);
  border: 1px solid transparent;
  transition: background var(--dur-micro) var(--ease-expo),
              color      var(--dur-micro) var(--ease-expo),
              border     var(--dur-micro) var(--ease-expo),
              opacity    var(--dur-micro) var(--ease-expo);
  text-decoration: none;
  cursor: pointer;
}
.btn--md { padding: 14px 28px; font-size: var(--f-sm); font-weight: 600; }
.btn--sm { padding: 8px 16px; font-size: var(--f-xs); font-weight: 600; }
.btn--primary       { background: var(--c-moss); color: var(--fg-on-dark); border-color: var(--c-moss); }
.btn--primary:hover { background: var(--c-gold); border-color: var(--c-gold); color: var(--fg-on-light); }
.btn--secondary       { background: var(--c-ivory); color: var(--c-obsidian); border-color: var(--c-stone); }
.btn--secondary:hover { background: var(--c-pearl); }
.btn--ghost       { background: transparent; color: var(--c-obsidian); border-color: transparent; }
.btn--ghost:hover { text-decoration: underline; text-underline-offset: 3px; }
.btn--danger       { background: var(--c-error); color: var(--c-white); border-color: var(--c-error); }
.btn--danger:hover { background: #c12626; border-color: #c12626; }
.btn:disabled, .btn[aria-busy="true"] { opacity: 0.5; pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .btn { transition: none; }
}

/* _input */
.input-field { display: flex; flex-direction: column; gap: var(--s-2); margin-block: var(--s-3); }
.input-field__label   { font-size: var(--f-sm); font-weight: 600; color: var(--fg-on-light); }
.input-field__control { position: relative; display: flex; align-items: stretch; }
.input-field__control input {
  flex: 1;
  padding: 12px 14px;
  border: 1px solid var(--c-stone);
  border-radius: var(--radius-btn);
  background: var(--c-white);
  color: var(--fg-on-light);
  font-family: var(--f-body);
  font-size: var(--f-md);
  transition: border var(--dur-micro) var(--ease-expo);
}
.input-field__control input:focus {\n```\n\n### .reviews/codex-code-review.md\n```\n## Summary

Follow-up review of the DB Studio Portal after fixes applied to four issues flagged in the first review (2026-05-01). All four targeted fixes are verified correct. Two lower-priority issues from the first review remain open by design and are confirmed deferred, not forgotten. No new issues introduced by the fixes.

---

## Fix Verification

### Fix 1 — TOTP DEK unwrap (was Critical #1): VERIFIED CORRECT

**File:** `/opt/dbstudio_portal/routes/public/login-2fa.js` lines 127–145

The customer `SELECT` now JOINs `customers c ON c.id = cu.customer_id` and returns `c.dek_ciphertext, c.dek_iv, c.dek_tag`. Before calling `totpSecretFrom`, the handler calls:

```js
const dek = unwrapDek(
  { ciphertext: cu.dek_ciphertext, iv: cu.dek_iv, tag: cu.dek_tag },
  app.kek,
);
const secret = totpSecretFrom(cu, dek);
```

This matches the reference pattern at `domain/customer-users/service.js` lines 405–412 (step-up) and `domain/customers/service.js` lines 426 and 590 (`completeCustomerWelcome` / `completePasswordReset`). The `unwrapDek` signature `(wrapped, kek)` is correct per `/opt/dbstudio_portal/lib/crypto/envelope.js` line 29. The `totpSecretFrom` helper calls `decrypt({ciphertext, iv, tag}, kek)` internally, so passing the unwrapped DEK as the second argument produces the correct AES-GCM decryption.

The import line was also updated: `import { decrypt, unwrapDek } from '../../lib/crypto/envelope.js'` — both symbols are now present and used (`decrypt` inside `totpSecretFrom`, `unwrapDek` directly). No dead import.

Critical #1 is resolved.

---

### Fix 2 — Test assertion (was Important #3): VERIFIED CORRECT

**File:** `/opt/dbstudio_portal/tests/integration/customer-summary/summary.test.js` line 196

Assertion updated to `toBe(4)` with comment `// all except nda-draft: generic + nda-signed + 2×invoice`.

Arithmetic audit against the "busy customer" fixture:

| Call | Documents inserted | Category | Counted? |
|------|--------------------|----------|----------|
| `insertDocument(category: 'generic')` | 1 | generic | Yes |
| `insertInvoice` x2 (each calls `insertDocument(category: 'invoice')`) | 2 | invoice | Yes |
| `insertNda(signed: false)` | 1 | nda-draft | No (excluded) |
| `insertNda(signed: true)` | 2 (1 nda-draft + 1 nda-signed) | nda-draft / nda-signed | nda-draft excluded; nda-signed counted |

Total passing `category <> 'nda-draft'`: 1 + 2 + 1 = **4**. The assertion and its comment are both arithmetically correct.

Important #3 is resolved.

---

### Fix 3 — verifyLogin JOIN query (was Important #4): VERIFIED CORRECT

**File:** `/opt/dbstudio_portal/domain/customers/service.js` lines 524–540

The function is now a single parameterised Kysely `sql` template literal:

```js
const r = typeof email === 'string'
  ? await sql`
      SELECT cu.*, c.status AS customer_status
        FROM customer_users cu
        JOIN customers c ON c.id = cu.customer_id
       WHERE cu.email = ${email}::citext
    `.execute(db)
  : { rows: [] };
```

SQL injection safety: the email value is passed as a Kysely `sql` tagged template substitution, which always produces a parameterised `$1` placeholder. The `::citext` cast is applied server-side. The `typeof email === 'string'` guard prevents non-string values from reaching the query. The short-circuit to `{ rows: [] }` on non-string input means `SENTINEL_HASH` is still used for constant-time timing, preserving anti-enumeration behaviour. Type safety is correct — `c.status` is aliased to `customer_status` and the check `user.customer_status !== 'active'` on line 538 matches.

The `findCustomerUserByEmail` import has been fully removed from `domain/customers/service.js` (confirmed: no occurrence found in the file).

Important #4 is resolved.

---

### Fix 4 — noticeLoginDevice comment (was Important #6): VERIFIED

**File:** `/opt/dbstudio_portal/routes/public/login-2fa.js` line 197

Comment present: `// noticeLoginDevice (new-device email) is deferred for customer accounts — task #10.`

The comment is placed in the customer success path immediately where the admin path calls `adminsService.noticeLoginDevice`. This unambiguously communicates the omission is deliberate and tracked.

Important #6 is resolved.

---

## Remaining Open Issues From First Review

### Important #2 — Backup code update is outside a transaction (NOT addressed, deferred)

**File:** `/opt/dbstudio_portal/routes/public/login-2fa.js` lines 147–163

The customer backup-code path is structurally unchanged. `verifyAndConsume` runs in-memory, then a bare `UPDATE customer_users SET backup_codes = …` is issued outside a transaction, then `stepUp` is called in a second round-trip. A crash or connection drop between `UPDATE` and `stepUp` produces a consumed code with no session step-up. A concurrent request reading `backup_codes` before the `UPDATE` commits could consume the same code.

This is a pre-existing issue from the first review and was not targeted for this fix batch. It is documented here to ensure it remains tracked.

**Assessment:** Not a regression from these fixes. The risk window is narrow (millisecond-scale crash scenario). The asymmetry with the admin `consumeBackupCode` path (which uses `FOR UPDATE` + transaction) is the recommended fix when this is addressed.

---

### Important #5 — No integration tests for customers.verifyLogin (NOT addressed, deferred)

**File:** `/opt/dbstudio_portal/domain/customers/service.js`

`admins.verifyLogin` has a full integration test suite in `/opt/dbstudio_portal/tests/integration/admins/service.test.js` (lines 164–217, five cases covering happy path, wrong password, unknown email, timing, suspended status). The `customers` integration test directory (`tests/integration/customers/`) contains only `create.test.js`, `list.test.js`, and `transitions.test.js` — no `verifyLogin` coverage.

With the JOIN fix now in place this function is more complex and carries the status-gate logic that previously existed as a rac\n```\n\n### .reviews/codex-review-prompt.md\n```\n# Codex Final Code Review
**Timestamp:** 2026-05-01T22:28:27Z
**Repository:** /opt/dbstudio_portal
**Review type:** Final code review (correctness, security, architecture, edge cases)

## Codex CLI Detected
The `codex` command is available. To run this review via Codex CLI:
```
codex "# Codex Final Code Review
**Timestamp:** 2026-05-01T22:16:11Z
**Repository:** /opt/dbstudio_portal
**Review type:** Final code review (correctness, security, architecture, edge cases)"
```
Or use the Claude Code Codex plugin (/review command) if configured.


---

## Review Prompt

Please perform a thorough final code review of the following changes.

**Repository:** /opt/dbstudio_portal
**Timestamp:** 2026-05-01T22:28:27Z

### Scope of Review

You are the final code reviewer. Review for:
- **Correctness** — logic errors, wrong assumptions, off-by-one, type errors
- **Bugs** — edge cases, null handling, race conditions, error paths
- **Security** — injection, XSS, CSRF, auth bypass, secret exposure, insecure defaults
- **Maintainability** — readability, naming, complexity, dead code, duplication
- **Architecture** — design decisions, coupling, separation of concerns
- **Tests** — missing tests, weak assertions, test coverage gaps
- **Performance** — N+1 queries, unnecessary work, memory leaks
- **Migrations** — backward compatibility, data safety, rollback safety
- **Deployment risks** — breaking changes, environment assumptions, config dependencies
- **Regressions** — unintended side effects on existing behavior
- **Requirements alignment** — does the implementation match the stated goal?

### What to NOT review (handled separately)
- UI/UX design, visual layout, accessibility — reviewed by Kimi
- Brand copy, marketing text — out of scope

### Recent Commits
```
96326a7 docs(phase-f): mark phase F shipped; record commit refs in roadmap
a2f1c1c feat(phase-f): customer-side view-with-decrypt UI
1d0afb1 feat(phase-f): customer-questions UI completion
3548056 chore(phase-f): wire advisory checker into run-tests.sh
2c551ef chore(phase-f): add advisory detail-page pattern checker
b058414 feat(phase-f): align reveal-credentials page to resource-type pattern
3f1973a feat(phase-f): redesign digest body with grouping, dates, deep links
40f142a feat(phase-f): dynamic digest subject with action/FYI counts
3e937d2 feat(phase-f): rewrite digest strings with natural verbs and recipient-aware copy
bf472ff feat(phase-f): add humanDate helper for digest line dates
```

### Changed Files
```
docs/superpowers/follow-ups.md
domain/customers/service.js
lib/customer-summary.js
public/styles/app.src.css
.reviews/codex-code-review.md
.reviews/codex-review-prompt.md
.reviews/kimi-design-review.md
routes/admin/customer-questions.js
routes/customer/credentials.js
routes/customer/questions.js
routes/public/login-2fa.js
routes/public/login.js
tests/integration/customer-summary/summary.test.js
views/customer/questions/show.ejs
```

### Git Diff
```diff
diff --git a/docs/superpowers/follow-ups.md b/docs/superpowers/follow-ups.md
index 482929f..d5e1d4d 100644
--- a/docs/superpowers/follow-ups.md
+++ b/docs/superpowers/follow-ups.md
@@ -9,6 +9,19 @@ live and which can ship as v1.0 + post-launch work.
 
 ## ROADMAP STATUS (2026-05-01)
 
+### ✅ Shipped in Phase F
+
+- **Digest cadence rework** — fixed twice-daily fires (08:00 + 17:00 Atlantic/Canary), skip-if-empty at fire time. `lib/digest-cadence.js` (`nextDigestFire`), `domain/digest/repo.upsertSchedule` simplified, sliding 10/60-min window retired. Commits `6d57456`, `e8d301e`, `01cc97f`.
+- **Digest content rework** — natural-language verbs, recipient-aware copy (admin/customer split), count-aware singular/plural for COALESCING_EVENTS, dynamic subject line via `digestSubject` + per-row `subjectOverride` plumbed through `enqueue` + `renderTemplate`, per-customer grouping for admin digest, `humanDate` per-line labels, deep-link honouring, dual-mode (`prefers-color-scheme: light`) email CSS. Commits `bf472ff`, `3e937d2`, `40f142a`, `3f1973a`.
+- **Reveal credentials page consistency** — `views/admin/credentials/show.ejs` rewritten to resource-type pattern (eyebrow `ADMIN · CUSTOMERS`, title `Credential`, subtitle `<customer> · <provider>`, status pills in actions slot). Commit `b058414`.
+- **Detail-page layout pattern checker** — `scripts/check-detail-pattern.js` (advisory, non-blocking) wired into `scripts/run-tests.sh`. Commits `2c551ef`, `3548056`.
+- **Customer-questions UI completion** — admin list / detail pages, customer list page, `Questions` tab in `_admin-customer-tabs`, `Questions` entry in `_sidebar-customer`, header rewrites on existing `new.ejs` and `show.ejs`. Commit `1d0afb1`.
+- **Customer-side view-with-decrypt UI (M9.X partial)** — `service.viewByCustomer` mirrors `view()` for the customer actor (vault-unlock gate, customer-visible audit, admin-only fan-out), customer step-up route + view, customer credentials show + reveal route, list page label now links to detail, honest copy. Commit `a2f1c1c`.
+
+Test count: baseline 657 passing → Phase F final 704 passing / 3 skipped / 0 failing.
+Migration ledger unchanged at `0011_phase_d` (no schema change).
+Advisory linter has 2 pre-existing out-of-scope warnings (`customers/detail.ejs`, `projects/detail.ejs`).
+
 ### ✅ Shipped in Phase D
 
 - NDA gate (`customers.nda_signed_at` + `/customer/waiting`) — `8a03fb0`, `9bfa1c0`
@@ -26,7 +39,7 @@ live and which can ship as v1.0 + post-launch work.
 
 That fully closes the "Phase D operator feedback batch (2026-05-01)" section below (all 5 items) + the "Admin credential view UI (M7 deferred minor)" section. Those entries are kept below as historical record but should NOT be re-actioned.
 
-### 🟡 Next on the roadmap (Phase F)
+### ~~🟡 Next on the roadmap (Phase F)~~ — SHIPPED (see Phase F section above)
 
 **Digest email copy / layout / grouping rework.** Originates from the operator's original Phase D handoff (`docs/superpowers\n```\n\n### .reviews/kimi-design-review.md\n```\n# Kimi Design Review
**Timestamp:** 2026-05-01T22:08:23Z
**Repository:** /opt/dbstudio_portal
**Model:** kimi-k2.6

## Summary
This changeset introduces new CSS primitives for bare form elements (`.form-label`, `.form-textarea`), a customer waiting-page panel, and a dashboard “Questions for you” card/list pattern. It also updates the customer question detail page to use a standard `.form-actions` wrapper and bumps the tertiary skip button from `sm` to `md`.

## Blocking UI/UX Issues
None identified.

## Recommended Improvements
1. **Keyboard parity for hover cards** — `.customer-questions__item--open` gains a green border + shadow on `:hover` but not on `:focus-within`. Keyboard users tabbing through the list won’t get the same elevated affordance.
2. **Link arrow decoration** — The trailing arrow on `.customer-questions__link` is injected via `content: ' →'`. CSS-generated characters are sometimes announced by screen readers (e.g., “right arrow”). Moving the arrow into a `<span aria-hidden="true">→</span>` inside the link would eliminate that noise.
3. **Visual hierarchy check** — The skip button was bumped from `sm` to `md`. Verify that the primary “Submit answer” button in the same view is at least as prominent (ideally larger or same size with stronger fill contrast) so the tertiary action doesn’t visually compete.
4. **Definition-list resilience** — The waiting-page `dl` uses `grid-template-columns: max-content 1fr`. A long `dt` label can force the second column to become too narrow on small screens. Add a narrow-viewport fallback and `overflow-wrap` on `dd`.

## Accessibility Concerns
1. **Focus indicator consistency** — The new `.form-textarea` follows the existing pattern of `outline: none` on `:focus` + `outline` on `:focus-visible`. This is acceptable for modern browsers, but ensure the `border-color` shift to `--c-moss` is visible in Windows High Contrast / forced-colors mode (where `box-shadow` and `border-color` changes may be suppressed). A transparent `outline` fallback or media query for `forced-colors: active` would make this bulletproof.
2. **Color-only links** — The global link style removes underlines by default (relying on color). The waiting-page support link inherits this. While context helps, underlined links are safer for colorblind users.

## Mobile / Responsive Concerns
1. **Waiting-page grid overflow** — As noted above, `max-content` can push content off-screen on mobile if labels are long. A single-column stack below `480px` prevents horizontal overflow.
2. **Touch targets** — The dashboard question links use `display: block` with `padding: var(--s-3) var(--s-4)`. Assuming your spacing scale uses `≥12px`, the hit area should meet the 44×44dp guideline.

## Copy / Content Suggestions
- “Skip / I don’t know” is honest and clear. No changes needed.

## Suggested Implementation Notes
- Add `:focus-within` alongside `:hover` on `.customer-questions__item--open`.
- Add `overflow-wrap: break-word` to `.customer-waiting__panel dd`.
- Verify `.form-actions` has appropriate `margin-top` / `gap` rules elsewhere in the stylesheet so the skip form sits clearly separated from the primary answer form.

## Optional Patch
```diff
--- a/public/styles/app.src.css
+++ b/public/styles/app.src.css
@@ -1047,6 +1047,10 @@ body:not(.public) .eyebrow { color: var(--fg-on-light-muted); }
   border-color: var(--c-moss);
   box-shadow: 0 2px 8px rgba(47, 93, 80, 0.12);
 }
+.customer-questions__item--open:focus-within {
+  border-color: var(--c-moss);
+  box-shadow: 0 2px 8px rgba(47, 93, 80, 0.12);
+}
 .customer-questions__link {
   display: block;
   padding: var(--s-3) var(--s-4);
@@ -1061,6 +1065,19 @@ body:not(.public) .eyebrow { color: var(--fg-on-light-muted); }
   font-weight: 600;
 }
 
+/* Mobile: stack definition-list rows when labels are long */
+@media (\n```\n\n[Context limit reached]\n

---

## Required Output Format

```
## Summary
[2-3 sentence overview of what changed]

## Critical Issues (BLOCKING)
[Must fix before merge — bugs, security holes, data loss risks, broken auth]

## Important Issues (Recommended)
[Should fix — edge cases, test gaps, poor error handling, performance problems]

## Minor Issues (Optional)
[Nice to fix — naming, style, minor inefficiencies]

## Security Assessment
[Specific security concerns if any]

## Test Coverage Assessment
[What's tested, what's missing]

## Migration / Deployment Risk
[Any risks deploying this change]

## Final Verdict
[Must be exactly one of: APPROVE | APPROVE WITH CHANGES | BLOCK | UNAVAILABLE]
```
