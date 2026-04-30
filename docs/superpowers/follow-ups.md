# DB Studio Portal — follow-ups (post-M9)

This file captures work that touches v1 acceptance items but is
deliberately NOT in M9's "land it" scope. The §11 acceptance dry-run
walks each item below and decides per case which are blockers for go-
live and which can ship as v1.0 + post-launch work.

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

## Admin credential view UI (M7 deferred minor)

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

The QR is intentional design (server-side derive + render). In v1 the
URI appears as a copy/paste line; v1.1 enhancement is to render an SVG
QR server-side (no client JS, CSP-clean).

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

Tracking convention: when an item ships, move its bullet into the
build-log + delete the line here.
