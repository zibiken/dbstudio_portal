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

## Phase D operator feedback batch (2026-05-01)

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

### 4. Login lockout is global to the NPM proxy IP (functional / security-adjacent)

Real incident 2026-05-01 ~12:58 WEST: the operator typed a wrong
password for `info@brainzr.eu` 2-3 times, reset, then got "Too many
attempts. Try again later." instantly on the next attempt despite a
valid password. Diagnosis from `rate_limit_buckets`:

```
key                       | count | locked_until
login:ip:212.231.193.53   |   5   | 2026-05-01 14:19:02+02   ← LOCKED
login:email:info@brainzr.eu|   3   | (unlocked)
```

`212.231.193.53` is **Nginx Proxy Manager**, the single ingress for all
portal traffic. `routes/public/login.js` builds `ipBucket(req)` from
`req.ip`, which under the current Fastify config is the connection IP
(NPM), not the originating client IP. Result: **every failed login
across every user, customer, and admin on the entire portal shares the
same IP bucket.** Five fails total = global lockout for 30 minutes.
Same bug applies to `login-2fa.js`, `reset.js`, customer-side login
routes, and any other route using `ipBucket`-style keys.

**Fix scope** (Phase E or a small security-fix bundle, depending on
how often this is biting):
- Configure Fastify with `trustProxy: '212.231.193.53'` (or the
  appropriate CIDR / proxy-list).
  Then `req.ip` returns the leftmost-trusted X-Forwarded-For value,
  i.e. the real client IP.
- Verify `X-Forwarded-For` is being sent correctly by the NPM template.
- Add an integration test that asserts `req.ip` reflects an
  X-Forwarded-For header when Fastify is configured to trust a proxy.
- Audit every `req.ip` callsite (login + login-2fa + reset + profile
  email/password mutations + signed-URL routes) to make sure none of
  them are still bucketed against the proxy.
- Reset existing `login:ip:212.231.193.53` and similar global-IP
  buckets after the fix lands so the legacy lockouts clear.

**Risk if left unfixed:** denial-of-service against the entire portal
by a single bad actor (or a noisy bot) hitting `/login` with bogus
credentials. Higher priority than (1) and (2) above.

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
