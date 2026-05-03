# DB Studio Portal — follow-ups (post-M9)

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

### ✅ Shipped post-Phase-G — phases + checklists (2026-05-03)

- Migration `0013_phases_and_checklists.sql` (two new tables, UUIDv7 PKs, DEFERRABLE order constraint).
- New domain modules `domain/phases/` and `domain/phase-checklists/` (raw-SQL repo + transactional service per existing convention).
- 10 admin POST routes (`routes/admin/project-phases.js` + `routes/admin/phase-checklist-items.js`), all CSRF + admin-session gated, defense-in-depth cross-customer/cross-project/cross-phase ownership checks.
- Admin UI extension on `views/admin/projects/detail.ejs` (CSP-strict, no inline JS, accessible labels, `<details>`-confirmed deletes).
- Brand-new customer detail page at `views/customer/projects/show.ejs` + `GET /customer/projects/:projectId` route, scoped by `requireCustomerSession` + `requireNdaSigned` + customer ownership clause.
- Audit + digest fan-out wired with `visible_to_customer` baked at write time per design Decision 8 (admins always see; customers see iff `phaseVisible(parent)` AND `item.visible_to_customer`).
- 10 new entries in `lib/digest-strings.js` (en/nl/es, recipient-aware) + `phase_checklist.toggled` added to `COALESCING_EVENTS`.
- Tests: phases repo (9), phases service (8), checklist repo (7), checklist service (6), coalescing (1), end-to-end happy-path (1) — 32 new tests; full suite 740 passing / 3 skipped (was 708 baseline before this feature).

Spec: `docs/superpowers/specs/2026-05-03-phases-checklists-design.md`
Plan: `docs/superpowers/plans/2026-05-03-phases-checklists-implementation.md`
Commits: `94c6449`, `2b76ec5`, `f4383b0`, `f5806ea`, `af92182` (Phase A); `964b6a7`, `70c39a9`, `9474d77` (Phase B); `b9b687d`, `c49f50e`, `ba1ef7e`, `aa7b96a`, `e8e67af` (Phase C); `384daab`, `b927d74` (Phase D); `3fda5b5`, `e25b87f`, `1ee6fd0` (Phase E); `a469efb` (Phase F).

**Open follow-ups (deferred, non-blocking):**
- **Coalescing key gap — `phase_checklist.toggled` collapses across phases, not per-phase** (spec Decision 5 deviation). `domain/digest/repo.js:findCoalescable` keys on `(recipientType, recipientId, eventType, customerId)` — `phaseId` is NOT in the key. A customer with two active phases that get toggles in the same window collapses into ONE digest line carrying the first phase's `phaseLabel` and `count` aggregated across phases. Real-world impact small (most projects have one active phase at a time) and the existing coalescing test only exercises one phase so the gap was not caught. Fix path: extend `findCoalescable` to accept an optional event-type-keyed extra discriminator (e.g. `phaseId` for `phase_checklist.toggled`), or add per-event-type coalescing keys server-side. Until then, the rendered phaseLabel sticks to the first event in the window because `pluraliseTitle` (`lib/digest.js:64`) prefers `existing.metadata?.vars`.
- **Route-level integration tests for phases/checklists admin POSTs** — Codex flagged the parity gap with Phase B onwards. CSRF rejection, UUID validation, and cross-tenant guards are exercised by code paths in production but not in CI. Add `tests/integration/phases/routes.test.js` and `tests/integration/phase-checklists/routes.test.js`.
- **N+1 in admin project detail GET** — `Promise.all(phases.map(listItemsByPhase))` is O(phases). Acceptable for the current admin tool; replace with a single JOIN if a project ever crosses ~30 phases.
- **`notFound` in phase routes returns JSON, not styled EJS** — minor UX inconsistency with the rest of the admin surface (`routes/admin/project-phases.js`, `routes/admin/phase-checklist-items.js`). Returns `{error:'not_found'}` instead of the styled `admin/customers/not-found` page.
- **303 vs 302 redirect inconsistency** — phase routes use 303 (POST → GET pattern), older admin POSTs use 302. Pick one convention project-wide.
- **`flashFromError` swallows non-PHASE_* errors** — e.g. `'label required'` collapses to "Something went wrong; please try again." Add a `PhaseLabelInvalidError` class with code `PHASE_LABEL_INVALID` and surface it.
- **`<details>` delete pattern lacks `aria-expanded` management** — Kimi flagged; the native `<details>` toggle handles ARIA but screen readers may not announce it consistently. Consider a button + dialog pattern for destructive actions.
- **Status pill color mapping is non-obvious** — `done → paid (green)`, `blocked → pending (amber)`, `in_progress → active (blue)`. Customers may not parse the mapping intuitively. Either rename pill modifiers or add semantic-status modifiers (`status-pill--phase-done`, etc.).

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
- `emails/{en,nl,es}/digest.ejs` — rendered HTML structure. Per-customer grouping for admin digests goes here.

**Suggested next step:** brainstorm Phase F via `superpowers:brainstorming`. Likely splits into sub-decisions: (a) subject-line content scheme, (b) per-customer grouping shape for admin digest, (c) date/locale label scheme, (d) light-mode mail-client compatibility audit, (e) deep-link strategy.

### 🟡 Other queued items (not Phase F-blocking)

- **Customer-side view-with-decrypt UI** ("Vault view-with-decrypt (M9.X partial)" below) — the customer reading their own stored secret with re-2FA. Same `service.view` path with an `actor_type='customer'` branch. Smaller follow-up; can fold into Phase F brainstorm or stand alone.
- **Admin credential-edit UI** (M7 deferred minor) — admins can already create/fulfil via credential-requests; "edit existing credential" is a nice-to-have.
- **i18n localisation grind** (~620 strings) — see section below.
- **Accessibility pass** (axe-core + skip-link + heading-order) — see section below.
- M3 / M5 / M6 / M7 / M8 / M9 / M10 review-deferred items below.

---

## i18n localisation (spec §2.11 / plan Task 9.5)

`scripts/i18n-audit.js` reports **620 candidate offenders across 79 files**
as of the M9 → M10 checkpoint (every user-visible string in the EJS views
+ route layer flowing through raw template literals instead of `t()`).

**Status:** the audit script lands; the localisation grind does not.

**Why deferred:**
- v1 ships EN-only per spec §2.11 + §4 ("§19 i18n — scaffolded, EN-only ships").
- No `t()` exists in the codebase yet — there is no i18next set-up,
  no `locales/en/<namespace>.json`, no integration in `lib/render.js`.
- A full i18n pass requires (a) i18next + i18next-fs-backend wired
  through render.js with per-request language resolution from
  `customer_users.language` / `admins.language` (already in schema),
  (b) one JSON namespace per route group, (c) ~620 hand-edits to
  replace literals with `t('key.path', { … })`, (d) tests for missing-key
  handling.
- Scoped honestly, that is multi-day work. Doing it badly (sed replacing
  600 strings without per-string review) would produce a worse v1 than
  the EN-only one we have now.

**Concrete next step:** open a v1.1 feature branch that
1. Adds `lib/i18n.js` (i18next + i18next-fs-backend, namespace per
   route group), wires `t()` into `lib/render.js` view globals.
2. Adds `locales/en/{public,admin,customer,emails}.json` populated
   by mechanically running `scripts/i18n-audit.js` and lifting each
   string into its namespace.
3. Adds `locales/es/` as empty placeholders.
4. Adds a CI gate: `scripts/i18n-audit.js` exit non-zero if any
   offenders remain.

Until then, the §11 acceptance line "no hardcoded strings remain" is
acknowledged as not green and tracked here.

---

## Accessibility pass (plan Task 9.6)

**Status:** scaffolding pending. The portal already uses semantic HTML
(form labels with `for=`, table headers, role="alert" on errors,
ARIA-labelled brand link), and the design tokens hit AA contrast on
`--color-ink-900` against `--color-bg`. The `cancel-link` underline +
focus styles are inherited from the global `a:focus` rule.

**Not yet done:**
- A real axe-core run against each main view (login, welcome, dashboard,
  customer/documents, customer/credentials, customer/profile, customer/
  activity, admin/customers, admin/audit). The plan calls for one commit
  per view family.
- Skip-link from the brand header to `<main>`.
- Heading-order audit (some pages currently jump h1 → h3).
- Focus traps for any modal-style flows (currently none — confirmation
  pages are linear, but the credential delete uses `confirm()` which is
  not great a11y).

**Next step:** install `axe-core` + `puppeteer-core` already in the
tree, write `scripts/a11y-check.js` that loads each main view via
`app.inject()` and runs axe on the rendered HTML in a jsdom, fix any
violations of impact ≥ 'serious'. CI gate.

---

## Vault view-with-decrypt (M9.X partial)

The customer vault landed list / create / delete only. Viewing the
decrypted payload requires a customer-side vault-unlock flow:
1. GET `/customer/credentials/:id` — if `isVaultUnlocked(sid)` false,
   render a re-2FA prompt; on success call `vault-lock.unlockVault(sid)`
   then render the credential.
2. The `view` domain method (currently admin-only) must gain a
   customer-actor branch that writes a `credential.viewed` audit with
   `actor_type='customer'` (the existing audit assumes admin).
3. Same for edit — `updateByCustomer` exists but the route + form do
   not.

Scope: roughly half a day. Not blocking go-live because the M7
credential-request workflow already lets admins fulfil credentials
on behalf of customers; the customer-vault is operator-side
forensic-trail material in v1.

---

## ~~Admin credential view UI (M7 deferred minor)~~ — SHIPPED in Phase E

> **Status: SHIPPED 2026-05-01** at commits `4473d36` (step-up route), `70f7429` (POST + lockout), `461bbc0` (admin detail page). Customer-visible audit + Phase B `credential.viewed` digest fan-out fire on every reveal.

`domain/credentials/service.view` exists with the trust-contract audit,
but no admin route renders it. Admin credential-management today is
through the credential-request workflow only. v1 ships without admin-side
inline credential viewing.

Scope: small — mirror the customer-side vault-unlock flow on the admin
side using `isStepped` / `stepUp`.

---

## M8 review-deferred minors that did not land in M9

- M3 — defence-in-depth `customerId` arg on `cancelByAdmin` /
  `markNeedsUpdate`. Today the routes assert via `findCredentialRequestById`
  + `customer_id` check; the service methods themselves trust the route.
- M6 — `routes/admin/credential-requests` renders `err.message` verbatim
  on validation errors. Should map to a controlled error vocabulary.

---

## M7 review-deferred items

- Tests for the HTTP layer of `routes/admin/credential-requests` and
  `routes/customer/credential-requests` (today these are at ~7-9%
  coverage; service-layer is the gate).

---

## M9 → M10 review-deferred items

These came out of the M9 → M10 code review. The Important findings I1
(security headers on hijack) and I2 (rate-limits on profile mutations)
landed in the review-fix bundle; the items below stay in v1.1 unless
the operator escalates one.

### I3 — email-verify route session-bounce UX (Important, not security)

`/customer/profile/email/verify/:token` and `/admin/profile/email/
verify/:token` require an authenticated session. A user who opens the
verify link in a fresh browser (the common case — different device than
they requested from) gets bounced to `/login` with their **old** email,
which is confusing.

**Fix paths** (decide in v1.1):
- (a) Make the verify route session-less. The token IS the proof; this
  matches the rationale on the revert side. Slight downside: anyone with
  the token can verify, including a network observer who intercepted the
  email — but they'd already be in the user's mailbox.
- (b) Keep the gate but render a clear inline message on the bounce
  ("sign in with your current email address — we'll complete the
  switch after").

(b) is the lower-blast-radius choice.

### M3 — LIKE pattern underscore wildcards in routes/admin/audit.js + routes/customer/activity.js

`'admin.session_'` becomes `'admin.session_%'` — PG `_` is "any single
character". Today no action name violates the convention (every action
uses literal `_` between segments), but a future
`admin.sessionsRevoked`-style action would be matched unexpectedly.

**Fix:** escape underscores in the prefix list or document the
convention as a comment + lint check. v1.1.

### M5 — audit_log `metadata->>'customerId'` index

The customer activity feed OR-joins `metadata->>'customerId' = X`
against `target_type='customer' AND target_id=X`. There's no expression
index supporting the metadata path; once `audit_log` grows, every
customer-activity page-load scans the table.

**Fix (v1.1, a few months in):**
```sql
CREATE INDEX idx_audit_metadata_customer
  ON audit_log ((metadata->>'customerId'))
  WHERE visible_to_customer;
```

### M6 — raw `err.message` in routes/customer/credentials.js delete error path

Same anti-pattern as the M8-review-deferred M6 (admin credential-
requests). Today the only reachable messages are
`CredentialNotFoundError` and `CrossCustomerError`, both of which the
route already 404's pre-service. Defensive-only. v1.1: add a controlled
error vocabulary mapping `err.code` → customer-safe label.

### M7 (M9 review) — TOTP regen view shows the otpauth URI as text

**Status: re-classified as v1 / M11 work, no longer a v1.1 follow-up.**
The bootstrap-admin onboarding attempt at the close of M10-C surfaced
that the manual-only otpauth URI is unusable in practice — the operator
refused to onboard against it. Server-side SVG QR rendering moves into
M11 alongside the visual redesign. See
`docs/superpowers/specs/2026-04-30-m11-visual-redesign-design.md`.

### M8 — i18n localisation already tracked above (the §11 line-item).

### M9 (M9 review) — `scripts/i18n-audit.js` regex backreference bug

`JS_LITERAL_RE` includes a bare backtick in the prefix alternation, so
every `` `${...}` `` template literal matches as if it were a user-facing
string. The script's stated tolerance is "false positives accepted",
but the offender count (~620–640) is inflated. v1.1: drop the bare
backtick OR backreference the quote to ensure open == close.

### M10 (M9 review) — TOCTOU note on routes/customer/credentials.js delete

The pre-check `findCredentialById(app.db, id)` reads outside the tx that
`deleteByCustomer` opens. Theoretical TOCTOU: nothing today reassigns
`customer_id`, and the service's `assertCustomerUserBelongsTo` is the
authoritative check. Documenting that the outer read is intentional
defence-in-depth, not the gate. v1.1 if a future feature ever moves
credentials between customers (currently impossible — fkey is RESTRICT
on customer_id and there's no service method).

---

## ~~Phase D operator feedback batch (2026-05-01)~~ — ALL ITEMS SHIPPED IN PHASE E

> **Status: SHIPPED 2026-05-01.** All 5 items below closed by the Phase E ship. Section retained as historical record. See the "ROADMAP STATUS" block at the top of this file for commit references.

Four items surfaced after the Phase D plan was written. None block Phase D
implementation. They are tracked here for Phase E / a small-fixes bundle.

### 1. Customer credential-request form needs a show-password "eye" toggle (UX)

When a customer fills in a credential request, password-style fields are
masked with no way to verify what was typed. Result: typos go undetected
and the customer submits a wrong secret. Add a small eye-icon toggle next
to each `<input type="password">` to flip it to `type="text"` while held
or until clicked again. This is a 5-min UI fix on
`views/customer/credential-requests/show.ejs` (or whichever view owns the
fulfilment form). Defer to Phase E or a quick-fix bundle — no test impact
beyond a click-handler smoke check.

### 2. NDA box on the customer dashboard sits higher than the other panels (visual)

Investigate the dashboard panel grid in `views/customer/dashboard.ejs`
and the associated CSS. The NDA panel currently breaks the visual rhythm
because it has different padding / heading-margin / extra-spacing from
the other dashboard cards. Goal: every dashboard panel aligns to the
same baseline grid. Phase E.

### 3. Admin-side credential decryption is not wired up (functional / operationally blocking)

The customer-side copy on `/customer/credentials` reads:
> "Values are encrypted under your account vault key — DB Studio never
> sees plaintext on this side. Each credential view leaves an audit
> row in your Activity log."

This is misleading. The actual situation:
- The `domain/credentials/service.view` decryption path exists, with
  `KEK → unwrap DEK → GCM-decrypt payload`, vault-unlock gating, and a
  trust-contract audit (`credential.viewed` with `visible_to_customer=true`).
- **No admin route invokes it.** `routes/admin/credentials.js` is
  metadata-only by design (M7 spec §2.4). Admin sees label / provider /
  timestamps / "needs update" — never the secret.
- The customer-side view-with-decrypt UI is also unfinished. `view()`
  works for admin actors only today (per the existing
  "Vault view-with-decrypt (M9.X partial)" follow-up).

**Operational impact:** the credential-request workflow shipped on the
assumption admins can read what customers submit. They can't. Today the
operator workaround is to ask the customer to paste the secret somewhere
out-of-band, defeating the vault.

**Fix scope** (Phase E candidate, but real urgency):
- Wire `GET /admin/customers/:cid/credentials/:id` to call `service.view`
  with vault-unlock + step-up gating (mirror customer-side flow when it
  lands).
- Update the customer-side copy on `/customer/credentials` to be honest:
  *"Values are encrypted under your account vault key. DB Studio admins
  can decrypt them when actively viewing; every view leaves a record in
  your Activity log."* (Replace the misleading "DB Studio never sees
  plaintext" line.)
- Decide whether customer-side view-with-decrypt also lands in Phase E
  or stays deferred.

**Touchpoints** identified:
- `routes/admin/credentials.js` (currently 52 lines; add view route).
- New `views/admin/credentials/show.ejs`.
- `views/customer/credentials/list.ejs` (copy fix).
- Existing `tests/integration/credentials/*` to extend.

This supersedes the older "Admin credential view UI (M7 deferred minor)"
and "Vault view-with-decrypt (M9.X partial)" entries above — keep them
for context but treat this as the active item.

### 4. "Correct password" attempts counted as fails — verifyLogin investigation (functional)

Real incident 2026-05-01 ~12:58 WEST: the operator typed a password
for `info@brainzr.eu` they believed was correct, was rejected, reset
the password, tried again, was rejected, and after 5 total fails
their personal IP locked out for 30 minutes. **The lockout system
is working as designed** — `routes/public/login.js` correctly bucket
on the real client IP because `server.js:90` already configures
`trustProxy: ['127.0.0.1', '94.72.96.105']` (NPM at 94.72.96.105) and
honors `CF-Connecting-IP` from Cloudflare. No proxy / Fastify config
change needed.

The remaining mystery: **why were the supposedly-correct attempts
recorded as fails?** Possibilities, in order of likelihood:

- **(a) Browser-cached old password.** Most common: the operator's
  browser auto-filled an old saved password without it being visible.
  After a reset, the autofill keeps trying the old one. No bug.
- **(b) Mistype on a typo'd email.** 2 of the 5 fails were against
  `info@brainzr.com` (the operator-confirmed typo from item 4 of the
  earlier batch). Those would 100% fail because that account doesn't
  exist; the rate-limiter still counts them.
- **(c) Genuine `verifyLogin` mishandling of the freshly-reset hash.**
  Unlikely, but the post-reset `customer_users.password_hash` should
  be tested for verify-success in an integration test. If a test
  doesn't already exist for "after a successful password reset, the
  new password verifies", add one.
- **(d) 2FA failure path counted into the wrong bucket.** Look at
  `login-2fa.js` to confirm 2FA fails go into a `2fa:*` bucket, not
  `login:*`.

**Fix scope** (Phase E candidate; small):
- Add an integration test for "successful password-reset then sign-in
  with the new password verifies on the first attempt."
- Audit `login-2fa.js` to confirm bucket isolation.
- Consider a UX improvement: when the same IP has already incurred
  failures within the window, show a "Recent failures from this
  device — verify your password manager isn't using an old saved
  one" hint above the password field. Account-enumeration-safe (no
  email-existence leak).

**Operator workaround when locked out:** clear the bucket directly:

```sql
DELETE FROM rate_limit_buckets WHERE key LIKE 'login:ip:<your-ip>%';
```

Lockout clears immediately. (30-minute natural decay also works.)

---



`/auth/password-reset` (and the equivalent admin path) returns the
same success page whether the entered email exists in the system or
not, by design — this prevents account-enumeration probes. Real-world
cost: 2026-05-01 the operator typed `info@brainzr.com` instead of
`info@brainzr.eu`, got a "we sent you a link" page, and waited for a
mail that was never going to arrive. No error surfaced.

**Trade-off space** (decide during Phase E brainstorm — bundle with
the digest copy/layout rework since both are email-UX):
- (a) Keep current behavior, but soften the wording: "If your address
  is registered, we've sent a link" (RFC 7613 / OWASP-cheatsheet style).
  Communicates the conditional without leaking which side is true.
- (b) On submit, show a confirm-the-domain-spelling step in the form
  ("Did you mean `…@dbstudio.one`?") for known-typo TLDs. Suggestion
  layer only; no enumeration.
- (c) Out-of-band: when a customer's actual address has been recently
  used and a typo'd variant is submitted (e.g. `.com` for `.eu`), send
  a one-line note to the actual address: "we received a reset request
  with a typo'd version of your address; if it was you, try again."
  Adds attack surface — defer.
- (d) Per-account rate-limit on reset submissions across address
  variants (Levenshtein-1) — reduces enumeration value without
  changing UX.

(a) is the cheap/safe baseline; (b) is the high-value low-risk add;
(c) only worth it if the operator wants to. (d) is an orthogonal
hardening regardless.

Scope: half a day for (a)+(b). Lives well in Phase E because the same
spec touches password-reset email copy + the digest copy/layout rework
+ the bounce-handling story (MailerSend soft-bounces from Phase D's
fixture pollution incident raise the same question of "what does the
operator/customer see when a mail can't reach the inbox").

---

Tracking convention: when an item ships, move its bullet into the
build-log + delete the line here.
