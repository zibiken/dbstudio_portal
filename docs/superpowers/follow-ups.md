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

Tracking convention: when an item ships, move its bullet into the
build-log + delete the line here.
