# DB Studio Portal — follow-ups (live)

This file captures work that is deferred but not yet shipped. Shipped
items move to `docs/build-log.md` per the tracking convention at the
bottom of this file.

For history of what has shipped, see `docs/build-log.md`.

---

## ROADMAP STATUS (2026-05-04)

Test count: 740 passing / 3 skipped / 0 failing.
Migration ledger: `0014_audit_metadata_customer_index`.
Advisory linters: `check-detail-pattern.js` has 2 pre-existing out-of-scope
warnings (`customers/detail.ejs`, `projects/detail.ejs`); `a11y-check.js`
reports 12 input-label offenders across 4 files (see Accessibility pass
below); `i18n-audit.js` reports 810 candidate offenders across 118 files.

---

## Open follow-ups from Phase G — phases + checklists

- **N+1 in admin project detail GET** —
  `Promise.all(phases.map(listItemsByPhase))` is O(phases). Acceptable
  for the current admin tool; replace with a single JOIN if a project
  ever crosses ~30 phases.
- **303 vs 302 redirect inconsistency** — phase routes use 303 (POST →
  GET pattern), older admin POSTs use 302. Operator decision 2026-05-03:
  303 project-wide; migrate older 302s opportunistically as files are
  touched, no sweep PR. (**In flight 2026-05-04** — bundled sweep
  underway as Phase C of the current ship.)

---

## i18n localisation (spec §2.11 / plan Task 9.5)

`scripts/i18n-audit.js` reports **810 candidate offenders across 118 files**
as of 2026-05-03 (up from 620/79 at M9 → M10 — the new files come from
phases editor partials, the `_confirm-dialog` rollout, and credential-
request views landed in Bundles 1–4). Every user-visible string in the
EJS views + route layer flows through raw template literals instead of
`t()`. The localisation grind remains v1.1 work per spec §2.11. The
audit is wired into `scripts/run-tests.sh` as advisory; promote to
blocking when the v1.1 i18n branch lands and gets the count to zero.

**Status:** the audit script lands; the localisation grind does not.

**Why deferred:**
- v1 ships EN-only per spec §2.11 + §4 ("§19 i18n — scaffolded, EN-only ships").
- No `t()` exists in the codebase yet — there is no i18next set-up,
  no `locales/en/<namespace>.json`, no integration in `lib/render.js`.
- A full i18n pass requires (a) i18next + i18next-fs-backend wired
  through render.js with per-request language resolution from
  `customer_users.language` / `admins.language` (already in schema),
  (b) one JSON namespace per route group, (c) ~810 hand-edits to
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

**Status (2026-05-04):** scaffolding has landed (see build-log Bundle 5),
but the pass is incomplete. The static `scripts/a11y-check.js` is wired
into `scripts/run-tests.sh` as advisory and reports 12 input-label
offenders across 4 files. The axe-core JSDOM harness runs only on public
routes (`/login`, `/reset`) — authenticated views still need a fixture
login helper.

**Currently blocking promotion to required:**
- 12 input-label offenders (dynamic-id label association) across:
  3× `views/admin/credential-requests/new.ejs`,
  1× `views/components/_input.ejs`,
  4× `views/components/_phase-row.ejs`,
  4× `views/customer/credential-requests/detail.ejs`.
- No fixture login helper in `scripts/a11y-check.js` — authenticated
  views (admin customers list, customer dashboard, credentials, profile,
  activity, admin/audit) are not covered by the axe-core run.
- No skip-link from the brand header to `<main>`.
- Heading-order audit pending — some pages currently jump h1 → h3.
- Focus traps for any modal-style flows (currently none — confirmation
  pages are linear, but consider when re-templating).

**Already in place:** semantic HTML (form labels with `for=`, table
headers, role="alert" on errors, ARIA-labelled brand link); design
tokens hit AA contrast on `--color-ink-900` against `--color-bg`;
`cancel-link` underline + focus styles inherited from the global
`a:focus` rule; `<details>`/`<summary>` disclosure forms in place of
`onsubmit="return confirm(...)"`.

**In flight 2026-05-04** — the bundled ship's Phase B closes the four
items above and promotes `RUN_A11Y_AXE` to blocking.

---

## Password-reset enumeration UX — options (c) and (d)

Options (a) and (b) (the inline typo hint on `views/public/reset-sent.ejs`)
already shipped; see build-log.

- **(c) out-of-band typo notification** — when a Levenshtein-1 typo of a
  registered address attempts a reset, optionally email the real
  registered user. Defer per 2026-05-04 operator decision: introduces a
  new outbound vector with non-trivial design questions (per-recipient
  rate-limit for anti-harass, copy that is informative without being
  anxiety-inducing, slight existence-leak to anyone watching the
  recipient's mailbox). Worth doing eventually but needs its own
  brainstorm. Not v1.
- **(d) Levenshtein-1 rate-limit on reset attempts** — share a rate-limit
  bucket across address-cluster typos so a fat-finger typo loop is
  caught after a few tries instead of repeating indefinitely against
  non-existent addresses. Privacy-safe (no existence leak; existence is
  already revealed by login bucket counts to attackers, but reset is
  separately bucketed and that boundary is preserved). **In flight
  2026-05-04** as Phase D of the current ship.

---

## TOTP regen view shows the otpauth URI as text (M11-classified)

**Status: re-classified as v1 / M11 work, no longer a v1.1 follow-up.**
The bootstrap-admin onboarding attempt at the close of M10-C surfaced
that the manual-only otpauth URI is unusable in practice — the operator
refused to onboard against it. Server-side SVG QR rendering moves into
M11 alongside the visual redesign. See
`docs/superpowers/specs/2026-04-30-m11-visual-redesign-design.md`.

---

Tracking convention: when an item ships, move its bullet into
`docs/build-log.md` and delete the line here. Strikethrough markers
should not accumulate in this file — that is what the build-log is for.
