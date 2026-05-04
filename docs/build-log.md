# DB Studio Portal — build log

Chronological record of shipped work. Each entry is a one-paragraph summary
with commit references; full diffs live in git. Items move here from
`docs/superpowers/follow-ups.md` when they ship, per that file's tracking
convention.

---

## Phase D — operator feedback batch (2026-05-01)

NDA gate + customer waiting page (`8a03fb0`, `9bfa1c0`). Type C short-answer
questionnaire — `customer_questions` table + admin/customer surfaces + 3
digest events (`513167a`, `c474bfc`, `e7c7a80`). "Cleaned up" dashboard
banner (admin credential.deleted → customer banner with dismissal,
`0a60777`). Test-pollution cleanup: shared helper + global teardown +
one-time script (`d810703`, `46df916`, `c6995af`).

## Phase E — Phase D operator feedback closure (2026-05-01)

Customer credential-eye toggle (`70c0d0e`). Bento card alignment on
customer dashboard (`4b7ef81`). Admin credential decryption + step-up
route + customer/admin copy honesty (`4473d36`, `70f7429`, `461bbc0`,
`ad9e1b9`). Reset-success-page typo softening (`ad9e1b9`).
verifyLogin → first-attempt sign-in regression test + 2FA bucket-isolation
annotation (`ad9e1b9`). Closed all 5 items from the Phase D operator
feedback batch and the M7-deferred admin credential view UI.

## Phase F — digest rework + customer view-with-decrypt (2026-05-02 → 03)

Digest cadence rework: twice-daily fires (08:00 + 17:00 Atlantic/Canary),
skip-if-empty at fire time. `lib/digest-cadence.js` (`nextDigestFire`),
`domain/digest/repo.upsertSchedule` simplified, sliding 10/60-min window
retired (`6d57456`, `e8d301e`, `01cc97f`).

Digest content rework: natural-language verbs, recipient-aware copy
(admin/customer split), count-aware singular/plural for COALESCING_EVENTS,
dynamic subject line via `digestSubject` + per-row `subjectOverride`
plumbed through `enqueue` + `renderTemplate`, per-customer grouping for
admin digest, `humanDate` per-line labels, deep-link honouring, dual-mode
(`prefers-color-scheme: light`) email CSS (`bf472ff`, `3e937d2`, `40f142a`,
`3f1973a`).

Reveal credentials page consistency: `views/admin/credentials/show.ejs`
rewritten to resource-type pattern (eyebrow `ADMIN · CUSTOMERS`, title
`Credential`, subtitle `<customer> · <provider>`, status pills in actions
slot) (`b058414`).

Detail-page layout pattern checker: `scripts/check-detail-pattern.js`
(advisory, non-blocking) wired into `scripts/run-tests.sh` (`2c551ef`,
`3548056`).

Customer-questions UI completion: admin list/detail pages, customer list
page, `Questions` tab in `_admin-customer-tabs`, `Questions` entry in
`_sidebar-customer`, header rewrites on existing `new.ejs` and `show.ejs`
(`1d0afb1`).

Customer-side view-with-decrypt UI (M9.X partial): `service.viewByCustomer`
mirrors `view()` for the customer actor (vault-unlock gate, customer-visible
audit, admin-only fan-out), customer step-up route + view, customer
credentials show + reveal route, list page label now links to detail,
honest copy (`a2f1c1c`).

Test count: 657 → 704 passing / 3 skipped / 0 failing.
Migration ledger unchanged at `0011_phase_d`.

## Phase G — phases + checklists (2026-05-03)

Migration `0013_phases_and_checklists.sql` (two new tables, UUIDv7 PKs,
DEFERRABLE order constraint). New domain modules `domain/phases/` and
`domain/phase-checklists/` (raw-SQL repo + transactional service per
existing convention). 10 admin POST routes (`routes/admin/project-phases.js`
+ `routes/admin/phase-checklist-items.js`), all CSRF + admin-session
gated, defense-in-depth cross-customer/cross-project/cross-phase ownership
checks. Admin UI extension on `views/admin/projects/detail.ejs` (CSP-strict,
no inline JS, accessible labels, `<details>`-confirmed deletes). Brand-new
customer detail page at `views/customer/projects/show.ejs` +
`GET /customer/projects/:projectId` route, scoped by `requireCustomerSession`
+ `requireNdaSigned` + customer ownership clause. Audit + digest fan-out
wired with `visible_to_customer` baked at write time per design Decision 8
(admins always see; customers see iff `phaseVisible(parent)` AND
`item.visible_to_customer`). 10 new entries in `lib/digest-strings.js`
(en/nl/es, recipient-aware) + `phase_checklist.toggled` added to
`COALESCING_EVENTS`.

Tests: phases repo (9), phases service (8), checklist repo (7), checklist
service (6), coalescing (1), end-to-end happy-path (1) — 32 new tests;
full suite 740 passing / 3 skipped (was 708 baseline before this feature).

Spec: `docs/superpowers/specs/2026-05-03-phases-checklists-design.md`
Plan: `docs/superpowers/plans/2026-05-03-phases-checklists-implementation.md`

Phase A commits: `94c6449`, `2b76ec5`, `f4383b0`, `f5806ea`, `af92182`.
Phase B: `964b6a7`, `70c39a9`, `9474d77`. Phase C: `b9b687d`, `c49f50e`,
`ba1ef7e`, `aa7b96a`, `e8e67af`. Phase D: `384daab`, `b927d74`. Phase E:
`3fda5b5`, `e25b87f`, `1ee6fd0`. Phase F: `a469efb`.

## Bundles 1–5 — review-deferred cleanup (2026-05-03)

**Bundle 1** — Coalescing key gap closed: `domain/digest/repo.js:findCoalescable`
takes optional `metadataMatch`; `lib/digest.js` exports
`COALESCING_DISCRIMINATORS` keying `phase_checklist.toggled` on `phaseId`.
Phase routes' `notFound` now renders styled EJS instead of JSON.
`flashFromError` taxonomy: added `PhaseLabelInvalidError`,
`PhaseDirectionInvalidError`, `ItemLabelInvalidError`. LIKE underscore
escaping in `lib/audit-query.js` and `lib/activity-feed.js` via
`escapeLikePrefix(p)`. `scripts/i18n-audit.js` regex backreference bug
fixed. TOCTOU note added inline in `routes/customer/credentials.js` delete.

**Bundle 2** — Route-level integration tests for phases/checklists:
`tests/integration/phases/routes.test.js` (8 tests) +
`tests/integration/phase-checklists/routes.test.js` (5 tests) covering
CSRF, UUID validation, cross-customer/project/phase 404s, the styled
not-found, and typed-error → flash mapping.

**Bundle 3** — `<details>` delete pattern a11y: visible text now reads
`Delete <label>…`, inner form has `aria-label`. Status pill semantic
modifiers `.status-pill--phase-{not-started,in-progress,blocked,done}`
in `public/styles/app.src.css`; `views/admin/projects/detail.ejs` and
`views/customer/projects/show.ejs` emit them directly.

**Bundle 4** — Customer-side credential edit: `GET/POST
/customer/credentials/:id/edit` invoke `updateByCustomer`; empty payload
leaves the secret untouched. `views/customer/credentials/edit.ejs` + edit
button on show page. Admin credential-edit UI: `GET/POST
/admin/customers/:cid/credentials/:credId/edit` invoke `updateByAdmin`;
unconditional step-up gate; `STEP_UP_REQUIRED` 302s to `/admin/step-up`
with return URL. `views/admin/credentials/edit.ejs` + 5 HTTP tests.

**Bundle 5** — `axe-core` JSDOM mode behind `RUN_A11Y_AXE=1`; baseline 0
serious/critical on `/login`, `/reset`. `scripts/a11y-check.js`
`checkNoConfirm` rule forbids `onsubmit="return confirm(...)"` in EJS;
known sites (customer credentials list per-row delete, admin customers
detail archive button) converted to `<details>`/`<summary>`.
`scripts/a11y-check.js` wired into `scripts/run-tests.sh` advisory.
M3 defence-in-depth: `cancelByAdmin` and `markNeedsUpdate` take
`customerId` and throw `CrossCustomerError`. M5 audit metadata index:
migration `0014_audit_metadata_customer_index.sql` (PG default LIKE
escape, partial index on `visible_to_customer`). M6 controlled error
vocabulary: admin credential-requests cancel handler + customer
credentials delete handler map known service errors with safe-copy
fallback. I3 email-verify session-bounce UX: GETs check session
manually, redirect to `/login?email_verify_pending=1&return=<verify-url>`
on miss; login renders info banner;
`tests/integration/auth/email-verify-bounce.test.js` (3 tests).

Migration ledger now at 14.

## Password-reset enumeration UX — option (a) + inline typo hint (shipped)

`views/public/reset-sent.ejs:4` carries the option (a) generic copy plus
the option (b) inline typo hint: "If your address is registered with us,
we've sent a reset link. Single-use, expires in 7 days. If nothing arrives
within a few minutes, double-check the address you entered (typos are
common — e.g. .com vs .eu) or check your spam folder." Option (c) was
deferred; (d) shipped 2026-05-04 (see next section). Option (c) remains
in `follow-ups.md`.

## v1 acceptance bundle — accessibility + 303 sweep + reset typo cluster (2026-05-04)

Five-phase bundle that closes most of the remaining v1 acceptance
items in one ship. Codex review hit a usage limit during phase B2;
Sonnet provided the backup APPROVE WITH CHANGES verdict and the
follow-up doc fixes were applied before tagging the bundle shipped.

**Authenticated-route axe-core coverage (`4e99d16`).** New
`tests/integration/a11y/authenticated-routes.test.js` runs axe-core
via JSDOM against seven authenticated views (admin customers list,
admin audit, admin profile, customer dashboard, customer credentials
list, customer activity, customer profile) using the existing
fixture-login machinery — admin via `/login` + `/login/2fa` and
customer via `completeCustomerWelcome` + `signCookie`. Asserts no
impact ≥ serious / critical violations on any route. JSDOM skips the
canvas-dependent `color-contrast` rule; that gap is covered by the
static checker.

**Static input-label false-positive fix (`f164799`).** The static
input-label check in `scripts/a11y-check.js` was building its
`labelTargets` set from raw EJS source while scanning input ids on
the EJS-stripped source. Dynamic-id pairs like
`<label for="phase-label-<%= p.id %>">` / `<input id="phase-label-<%= p.id %>">`
captured `phase-label-<%= p.id %>` (raw) on one side and
`phase-label-_%= p.id %_` (stripped) on the other, never reconciling.
Moved the strip step earlier so both label-target collection and
input-id matching run against the same stripped source. Closed 12
false-positive offenders (3 in `views/admin/credential-requests/new.ejs`,
1 in `views/components/_input.ejs`, 4 in
`views/components/_phase-row.ejs`, 4 in
`views/customer/credential-requests/detail.ejs`) and added one real
fix: `aria-label="Phase status"` on the `<select>` inside the
noscript fallback form in `views/components/_phase-row.ejs`.

**Blocking a11y gate (`25d83b2`).** `scripts/run-tests.sh` no longer
swallows non-zero exits from the a11y check; sets `RUN_A11Y_AXE=1` +
`RUN_A11Y_AXE_BLOCKING=1` so the wrapper aborts on any static offender
or any impact ≥ 'serious' axe violation on `/login` + `/reset`.
Escape hatches: `A11Y_STATIC_ADVISORY=1` keeps static failures
non-fatal; drop `RUN_A11Y_AXE_BLOCKING=1` to make axe advisory.
Both gates report 0 violations across the codebase.

**Admin POST → GET redirects 302 → 303 (`30943b9`).** Aligned the
admin route layer with the operator's "303 project-wide" decision.
Phase routes already used 303 via the POST → 303 → GET fragment-swap
pattern; the remaining 39 admin POST→GET redirects across 11 route
files now match. Touched: `routes/admin/credential-requests.js`,
`credentials.js`, `customer-questions.js`, `customers.js`,
`documents.js`, `invoices.js`, `ndas.js`, `profile.js`, `projects.js`,
`step-up.js`. The `credentials.js` sweep was a blanket replace_all
because three GET-handler step-up auth-gate redirects were textually
identical to their POST-handler counterparts; functional impact zero
(302 → 303 on an auth gate is a no-op since the user agent does GET
on `/admin/step-up` either way). GET handlers explicitly kept on 302:
`routes/admin/_index.js` (GET `/admin` → `/admin/customers`),
`routes/admin/profile.js` 5 GET-handler `/login` bounces,
`routes/admin/documents.js` signed-URL handoff to `/files/${token}`.
Test fixes: 12 assertions in 9 test files updated from
`.toBe(302)` to `.toBe(303)`; login-flow `lOk`/`cOk` 302s
deliberately untouched (`routes/public/login.js` +
`routes/public/login-2fa.js` are out of scope).

**Levenshtein-1 typo-cluster bucket on `/reset` (`97a8ed6`).** Closes
follow-up option (d) from the password-reset enumeration UX brainstorm.
The exact-email rate-limit bucket on `/reset` never accumulated across
typo loops because each typo (`info@brainzr.eu` vs `.com` vs `.co`)
keyed on a different bucket and reset fresh; the IP bucket caught the
single-IP 2026-05-01 incident, but a multi-IP typo loop could repeat
indefinitely. New module `lib/auth/email-cluster.js` exports
`withinOneEdit(a, b)` (linear-time Lev-1 boolean) and
`clusterKeyForResetEmail(db, email, { windowMs })` which returns the
lex-smallest email within Lev-1 of the current attempt across recent
`reset:email:*` buckets. Wired in `routes/public/reset.js` as
`reset:cluster:${rep}`, joining the existing ip + exact-email keys in
the `checkLockout` + `recordFail` flow with the same
`RESET_LIMIT/window/lockout` settings. Cluster lookup is server-side;
the rep never surfaces in the response, so no new enumeration vector.
Known tradeoff: when a new attempt finds a lex-smaller neighbour than
an existing cluster's rep, the rep can shift, fragmenting the cluster
across multiple bucket rows under pathological (descending-lex)
arrival orders. Acceptable for the threat model — typo-loop users
anchor on a stable seed, and an attacker has no incentive to fragment
their own bucket. Tests: `tests/unit/auth/email-cluster.test.js`
(10 unit tests covering substitution / single insertion / single
deletion / case-insensitivity / two-edit rejection / TLD typo cases)
and `tests/integration/auth/reset-typo-cluster.test.js` (2 tests:
star-pattern of 5 Lev-1 typos around a fixed anchor trips the cluster
bucket lockout on the 5th increment, returns 429 on the 6th attempt;
Lev-distance > 1 emails do not share a cluster bucket).

**Test count: 740 → 818 passing / 3 skipped / 0 failing.**

Reviews:
- DeepSeek: USE on B2; UNAVAILABLE on B1, D.
- Codex: APPROVE WITH CHANGES on B1; UNAVAILABLE on B2 onward (usage
  limit).
- Sonnet (backup reviewer): APPROVE WITH CHANGES on the consolidated
  bundle. Doc-hygiene fixes (this build-log entry + matching
  follow-ups.md cleanup) applied before tagging shipped.
