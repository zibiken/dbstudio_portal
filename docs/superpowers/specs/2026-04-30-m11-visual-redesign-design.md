# M11 — Visual Redesign + TOTP QR (design spec)

> **Status:** Brainstorm closed 2026-04-30. Implementation plan to be authored
> next via `superpowers:writing-plans`. Must ship before v1.0.0 tag. No
> production traffic on portal yet.

## Why this exists

M0–M10 tracked function (auth, NDA, vault, audit, backups, go-live infra)
but never carved out a proper visual-design pass. The brand-tokens line
in §3 of the original portal-design spec ("dbstudio.one's tokens.css is
the source of truth") was honoured at the level of CSS variables, but
the actual *application* of those tokens to typography, layout, imagery,
motion, and component density never happened — what landed is a thin
Tailwind utility layer over the public layouts, which presents as plain
unstyled HTML next to the marketing site at `https://dbstudio.one`.

Separately, the TOTP enrolment view (admin welcome flow + admin/customer
TOTP regen flows) renders the `otpauth://...` URI as a copy/paste line
with no QR code. M9-review's M7-minor classified this as v1.1 polish;
M10-C's operator onboarding attempt re-classified it as a v1 blocker —
no operator should be expected to type a 200-character secret into a
mobile authenticator app.

Both issues prevent the operator (the only user who currently has a
welcome token) from getting through onboarding. v1 cannot ship until
both are fixed.

## Goals

1. **Visual unification with `dbstudio.one`.** A user landing on
   `https://portal.dbstudio.one/login` after browsing the marketing site
   should not feel they have moved between two unrelated products. Same
   typography, same palette, same component language, same density,
   same motion vocabulary — by sharing marketing's `tokens.css`
   verbatim, not by approximation.

2. **Server-side SVG QR codes on every TOTP-enrolment surface.** No
   client-side JS rendering, no CDN, no inline `data:` image schemes
   that bloat the CSP allow-list. SVG produced by the `qrcode` npm
   package in Node and inlined into the EJS view at request time. Must
   be accessible (`<svg role="img" aria-label="...">`); the manual
   secret stays visible as a paste fallback for desktop authenticators.

3. **A11y re-audit post-redesign.** Skip-link + focus-visible + label
   coverage stay green; new components added (cards, hero blocks,
   sidebar nav, dense tables, modal cards, QR partial) must hit AA
   contrast against the new palette and pass `scripts/a11y-check.js`
   before the milestone closes.

## Non-goals

- Marketing-site features (blog, case-studies, pricing) — the portal is
  customer-only; the marketing surface stays at `dbstudio.one`.
- A redesign of `dbstudio.one` itself — this is one-way alignment.
- Component framework migration — Tailwind 4 stays.
- Email-template re-skin — emails currently use a `renderBaseEmail()`
  helper with Inter + Cormorant for client-rendering reach. M11 leaves
  email templates untouched; v1.1 follow-up tracks a possible re-skin.
- Automated visual-regression infra — manual screenshot pairs at
  acceptance time only. Not a v1 blocker if drift appears later.

## Decisions taken in the brainstorm (2026-04-30)

| # | Topic | Resolution |
|---|---|---|
| Q1 | Theme posture | Public surfaces dark like marketing's hero; admin and customer surfaces light (ivory canvas) with dark used as accent moments (top-bar, sidebar, hero strips, page-1 NDA brand bar). |
| Q2 | Tokens | Vendor `/opt/dbstudio/src/styles/tokens.css` verbatim into `/opt/dbstudio_portal/public/styles/tokens.css`. No portal token-layer file. The portal copy adds three semantic-state tokens (`--c-error`, `--c-warn`, `--c-success`) since marketing has no error/warn/success palette; everything else is identical. Marketing's tokens.css on the marketing side stays untouched. |
| Q3 | Type system | Satoshi (display) + General Sans (body) + JetBrains Mono (eyebrow/code) on portal screens, self-hosted at `/opt/dbstudio_portal/public/static/fonts/`. Cormorant Garamond stays loaded only inside `templates/nda.html` for the PDF service. Inter is dropped from screens. |
| Q4 | Animation | Marketing-parity reveals on public surfaces (`--ease-expo`, 200/450 ms tokens — scroll-reveal fade on the hero). Admin and customer surfaces: micro only (200 ms button hover, 200 ms input focus, 150 ms link colour). `prefers-reduced-motion: reduce` zeroes both. No scroll reveals on admin or customer pages. |
| Q5 | Customer dashboard | Bento 6-card grid (NDAs · Documents · Credentials · Credential requests · Invoices · Projects). Each card carries: icon eyebrow, count, most-recent timestamp (`euDateTime`), unread badge when relevant, footer link. Profile + Activity move into the sidebar instead of dashboard tiles. |
| Q6 | Public hero | Type-only on obsidian (eyebrow · Satoshi display · lead). No imagery — marketing's Nano Banana illustrations are sales-narrative pieces and don't belong on a login surface. |
| Q7 | Admin/customer chrome | Top-bar + persistent left sidebar nav. Sidebar is obsidian-on-ivory (dark accent on light canvas). Width 240 px on `lg+`, collapsible behind a hamburger on `<lg`. Admin sidebar: Customers · Audit · Profile. Customer sidebar: Dashboard · NDAs · Documents · Credentials · Credential requests · Invoices · Projects · Activity · Profile. |
| Q8 | TOTP enrol layout | QR primary + small monospace fallback secret labelled "Or enter this code manually" + 6-digit confirmation field. Full `otpauth://` URI dropped from the visible UI (encoded inside the QR; never logged). |
| Q9 | Container width / density | Forms/profile pages use `--content` (1024 px). List pages use `--container` (1280 px). Audit / credentials / credential-requests / invoices tables use a dense 36 px row variant with 8/12 px cell padding and ivory/pearl striping. NDAs / documents / projects use medium-density 44 px rows. Mobile: tables collapse to stacked cards below 768 px. |
| Q10 | Visual regression | Manual screenshot pairs at acceptance time at 1280×800 + 390×844, dropped into `docs/superpowers/m11-acceptance-dryrun.md`, operator signs off. No automated visual-regression harness in v1. |

## Surfaces in scope

### Public (highest visual priority — operator onboarding blocks here)

- `GET /` → `/login` redirect (no UI of its own; already landed in M10-C).
- `GET /login` (form, error states, rate-limited 429).
- `GET /login/2fa` (TOTP code, backup-code fallback in `<details>`).
- `GET /welcome/:token` (admin invite consume — password set + TOTP enrol with QR + backup codes display).
- `GET /customer/welcome/:token` (customer invite consume — same flow, customer copy).
- `GET /reset/:token` (password reset).
- `GET /logout` confirmation.
- All public-facing 4xx error pages (404 / 410 / 429).

### Admin (second priority — daily-use surface)

- `/admin/customers` list + search + paginate.
- `/admin/customers/new`, `/admin/customers/:id`.
- `/admin/customers/:id/{ndas,documents,credentials,credential-requests,invoices,projects,users}` — sub-tab strip pinned across all six routes; "users" folds in the existing customer-user management view.
- `/admin/profile` — Identity · Password · 2FA · Sessions tabs.
- `/admin/audit` + `/admin/audit/export` confirmation page.

### Customer (peer of admin)

- `/customer/dashboard` (bento grid).
- `/customer/{ndas,documents,credentials,credential-requests,invoices,projects,activity,profile}`.
- `/customer/credential-requests/new` (form to file a new request).

## Design system source

`/opt/dbstudio/src/styles/tokens.css` is the upstream. M11 copies it
into `/opt/dbstudio_portal/public/styles/tokens.css` verbatim except
for two adjustments local to the portal copy:

1. The `@font-face` `src` URLs are rewritten from `/fonts/...` to
   `/static/fonts/...` to match the portal's static-mount convention.
2. Three semantic-state tokens are appended (marketing has no
   error/warn/success palette):
   ```css
   --c-error:   #a32020;
   --c-warn:    #b35a1f;
   --c-success: var(--c-moss);
   ```

The three woff2 files (Satoshi, General Sans, JetBrains Mono) are
copied from `/opt/dbstudio/public/fonts/` into
`/opt/dbstudio_portal/public/static/fonts/` with the standard portal
repo perms (`root:portal-app`, mode 0640).

`tailwind.config.js` `theme.extend` is rewritten to read from the
marketing tokens (colors → `obsidian/ivory/moss/gold/ice/slate/stone/
pearl/carbon` mapped to `var(--c-*)`; fontFamily → `display/body/mono`
mapped to `var(--f-*)`; spacing → `var(--s-*)`; radii → `var(--radius-*)`;
shadows → `var(--shadow-*)`; maxWidth `container/content/prose` matching
marketing's three scales).

## Implementation order

The plan written via `superpowers:writing-plans` will break this into
implementer-sized commits. Sketch:

1. **Survey + reference doc.** Ratified during this brainstorm; resolved
   decisions land in this spec rather than as a separate doc. No
   operator gate before coding starts — gate becomes "operator reviews
   this spec" (the brainstorming skill's spec-review checkpoint).
2. **Token + asset infrastructure.** Vendor `tokens.css`, copy fonts,
   rewrite `tailwind.config.js`, restructure `app.src.css` (tokens →
   marketing global resets → Tailwind base/components/utilities), copy
   marketing's `global.css` resets verbatim into the portal layer.
   Build + smoke verifies woff2 files served and `app.css` size sane.
3. **Component partials.** Land under `views/components/_*.ejs`:
   `_button`, `_input`, `_card`, `_alert`, `_eyebrow`, `_page-header`,
   `_table`, `_qr`, `_breadcrumb`, `_top-bar`, `_sidebar-admin`,
   `_sidebar-customer`, `_hero-public`, `_footer`. Each commit includes
   the partial + its scoped CSS in `app.src.css`.
4. **Server-side SVG QR module.** Land `lib/qr.js` (single export
   `renderTotpQrSvg(uri, { label })`) + unit tests at
   `tests/unit/qr.test.js`. Reviewable in isolation; touches no view
   yet. Adds the `qrcode` npm dep.
5. **Layouts.** Restructure `views/layouts/{public,admin,customer}.ejs`
   to use the new chrome (public: hero + form card; admin/customer:
   top-bar + sidebar + `<main data-width="content|wide">`).
6. **Public surface restyle.** `/login`, `/login/2fa`, `/welcome/:token`
   (with QR), `/customer/welcome/:token` (with QR), `/reset/:token`,
   `/logout`, 4xx pages. Highest priority because operator onboarding
   blocks here.
7. **Admin surface restyle.** `/admin/customers` list/new/detail, the
   six sub-tab routes, `/admin/profile` (with QR on 2FA-regen),
   `/admin/audit` + export confirmation.
8. **Customer surface restyle.** `/customer/dashboard` (bento grid +
   `lib/customer-summary.js` aggregator) plus the 8 sidebar section
   pages (`/customer/{ndas,documents,credentials,credential-requests,
   invoices,projects,activity,profile}`) plus
   `/customer/credential-requests/new`. Profile carries the 2FA-regen
   QR; activity renders the SAFE_METADATA_KEYS-allow-listed timeline.
9. **A11y re-audit.** Extend `scripts/a11y-check.js` with the new
   pattern checks (sidebar `aria-current`, hamburger
   `aria-expanded`/`aria-controls`, QR `role="img"` + non-URI
   `aria-label`, modal `aria-modal`/`aria-labelledby`, contrast
   assertions on the new combinations, reduced-motion zero-out coverage).
10. **Smoke + acceptance dry-run.** Add probe #10 to `scripts/smoke.sh`
    (TOTP-enrol QR renders, gated on `RUN_M11_SMOKE=1`). Author
    `docs/superpowers/m11-acceptance-dryrun.md` with screenshot-pair
    placeholders for the operator to fill in at sign-off.

## Component partials (canonical list)

| Partial | Used by | Notes |
|---|---|---|
| `_button` | All forms, action rows, modals | Variants `primary` (moss), `secondary` (ivory + stone border), `ghost`, `danger`. Sizes `md` 40 px, `sm` 32 px. `:hover` moss → gold. |
| `_input` | All forms | Label above input, helper line, error line. 1 px stone border, ice focus ring. Password type carries a show/hide toggle. |
| `_card` | Dashboard bento, profile sub-sections, audit-detail modal, empty-state slots | Ivory ground, 1 px pearl, `--radius-card` 12 px, `--shadow-card`. |
| `_alert` | Flash messages, vault-locked banner | Variants `info`/`success`/`warn`/`error`. 4 px coloured left border. `role="alert"` on error/warn; `role="status"` on info/success. |
| `_eyebrow` | Hero blocks, page-headers, dashboard cards, top-bar centre | JetBrains Mono uppercase, `--ls-upper`, `--f-xs`. Slate on dark, muted-ink on light. |
| `_page-header` | Every list and detail page | Eyebrow + h1 + optional subtitle + optional right-aligned action slot. |
| `_table` | All list pages | Dense (36 px) for audit/credentials/credential-requests/invoices; medium (44 px) for NDAs/documents/projects. Stone bottom-border on header row, JetBrains Mono uppercase column labels. Mobile collapses to stacked cards. |
| `_qr` | Welcome (admin + customer), 2FA regen (admin + customer) | Wraps `lib/qr.js`. 220×220 on `md+`, 180×180 on mobile. `role="img"`, `aria-label` is descriptive (not the otpauth URI). |
| `_breadcrumb` | Admin per-customer subroutes | Pearl chevron separators, slate text, current crumb in obsidian. Skipped on top-level pages. |
| `_top-bar` | Admin + customer layouts | Logo (white-on-obsidian) left, current-section eyebrow centre, profile menu right. 64 px tall. Vault-locked banner sits as sticky `_alert` directly below when active. |
| `_sidebar-admin`, `_sidebar-customer` | Admin + customer layouts | Obsidian on ivory canvas, 240 px wide on `lg+`, collapsible on mobile via hamburger. Active item carries `aria-current="page"` + moss left-border. |
| `_hero-public` | All public-surface pages | Obsidian ground, eyebrow + Satoshi display + General Sans lead. No imagery. |
| `_footer` | All three layouts | Minimal: `© DB Studio · privacy · terms` linking to marketing's legal pages, plus portal version string from `package.json`. |

## Server-side SVG QR module (`lib/qr.js`)

Single export:
```js
export function renderTotpQrSvg(otpauthUri, { label }) → string
```

Implementation:
- Uses `qrcode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0F0F0E', light: '#F6F3EE' } })`. Obsidian-on-ivory rather than pure black/white, so the QR sits inside the ivory card without a contrast break.
- Post-processes the returned `<svg>`: injects `role="img"`, `aria-label` (HTML-escaped), `focusable="false"`, ensures a `viewBox` is present, strips any inline `<style>` (CSP cleanliness — the portal does not allow `style-src 'unsafe-inline'`).
- Never logs or echoes `otpauthUri`. The argument order is `(uri, opts)` so an accidental swap doesn't write the URI as the label.
- Throws on empty URI.

Unit tests (`tests/unit/qr.test.js`):
- "Returns valid SVG with the label."
- "Renders the same bytes for the same URI" (determinism — `qrcode` is deterministic given fixed mask/EC; pinned via `errorCorrectionLevel: 'M', margin: 1`).
- "Throws on empty URI."
- "Label is HTML-escaped" (the label flows into an attribute; must be escaped to prevent attribute injection).
- "Label may not contain `otpauth://`" (defensive — fails loudly if a caller accidentally passes the URI as the label).

Wired into:
- `GET /welcome/:token` (admin invite consume).
- `GET /customer/welcome/:token`.
- `GET /admin/profile/2fa/regen`.
- `GET /customer/profile/2fa/regen`.

## Customer dashboard summary (`lib/customer-summary.js`)

Single export:
```js
export async function getCustomerDashboardSummary(db, { customerId }) →
  { ndas, documents, credentials, credentialRequests, invoices, projects }
```

Each entry returns `{ count, latestAt, unreadCount }`. Implementation is
one Postgres query (CTEs aggregating per-table counts + max(updated_at)
+ per-customer-user "unread" using existing seen-at columns where they
exist, falling back to `0` when they don't). Cached behind
`Cache-Control: private, max-age=15` on the dashboard route — short
enough to feel live, cheap enough not to hammer the DB.

## A11y re-audit checks (additions to `scripts/a11y-check.js`)

- Every `<nav>` carries an `aria-label`.
- The hamburger button has `aria-expanded` + `aria-controls`, and the
  controlled element exists.
- Every `_qr` SVG has `role="img"` and a non-empty `aria-label` that
  does **not** contain `otpauth://`.
- Every modal `_card` has `aria-modal="true"` + `aria-labelledby`
  pointing at a heading inside the modal.
- The sidebar's active item has `aria-current="page"`.
- AA contrast assertions for the new combinations: ivory text on
  obsidian (~17:1 ✓), obsidian on ivory (~17:1 ✓), moss on ivory
  (~7.4:1 ✓), slate on obsidian (~7:1 ✓), gold on obsidian (~7.5:1 ✓).
- `--c-slate` may be used as text only on dark grounds; on light
  surfaces it is restricted to borders and decorative dividers. The
  script enforces this by checking that no element with `color:
  var(--c-slate)` lives inside `body.public > .section--light` or any
  `.surface` (light) container.
- Every `transition` / `animation` rule in `app.css` post-build has a
  `@media (prefers-reduced-motion: reduce)` zero-out partner.

All existing checks (skip-link present, focus-visible coverage, label
coverage, alt-text on `<img>`) remain.

## Smoke (additions to `scripts/smoke.sh`)

Probe #10 — "TOTP enrol page renders QR." Curl `/welcome/<seeded-test-token>`
(only when `RUN_M11_SMOKE=1` and a one-shot seeded token exists),
assert the HTML body contains `<svg role="img" aria-label="TOTP`. Default
off in production smoke runs to avoid generating throwaway tokens
against the real DB; runs once during M11 acceptance. Existing 9 probes
unchanged.

## Acceptance criteria

- Every surface in scope is visually consistent with `dbstudio.one` —
  fonts, palette, spacing, component language, motion vocabulary.
- `scripts/a11y-check.js` reports 0 offenders post-redesign with the
  new pattern checks active.
- `sudo bash scripts/run-tests.sh` passes (visual changes don't break
  logic).
- `sudo bash scripts/smoke.sh` (probes 1–9) passes; probe #10 passes
  once with `RUN_M11_SMOKE=1` against a seeded enrol token during the
  acceptance dry run.
- `docs/superpowers/m11-acceptance-dryrun.md` carries side-by-side
  screenshot pairs at 1280×800 + 390×844 for: marketing homepage hero
  ↔ portal `/login` hero, marketing Capabilities grid ↔ customer
  dashboard bento, marketing Footer ↔ portal footer, marketing Services
  card ↔ portal `_card`, plus full-page mobile screenshots of `/login`
  and `/customer/dashboard`. Operator signs off in the doc.
- Bootstrap admin can complete welcome onboarding end-to-end on a
  phone-sized viewport in a clean browser:
  - Reads the welcome email.
  - Sets password (HIBP feedback inline).
  - **Scans the QR code** with their authenticator app (or pastes the
    fallback secret).
  - Enters TOTP code, sees backup codes, saves them.
  - Lands on the dashboard.
- The §11 line "1 customer + 1 credential decrypted cleanly" in the
  restore drill becomes runnable because the operator can finally
  onboard, create a test customer, walk customer onboarding, and add
  a credential. M11 itself does NOT re-run the drill — the drill log
  in RUNBOOK gets a second row when the operator re-runs the drill
  after M11 ships.

## Operator artefacts to preserve

- The bootstrap admin row created at the end of M10-C
  (`bram@roxiplus.es`, id `019ddf64-c9c0-7171-aa05-cb509c579092`).
  M11 must not invalidate the existing welcome flow's token-consumption
  contract — the redesigned `/welcome/:token` still consumes the
  existing token row.
- The welcome token is single-use, 7-day expiry, issued 2026-04-30. If
  M11 ships before 2026-05-07 the operator uses it as-is. If M11 takes
  longer, mint a new welcome token via the admin-reset RUNBOOK
  procedure and document the swap in `docs/build-log.md`.
- The age public key on `/var/lib/portal/.age-recipients` and the
  matching offline private key on the operator workstation MUST NOT
  change during M11. Backups in flight are encrypted to that key.

## Cross-cutting contracts that must NOT change in M11

M11 is presentation-layer only. The following contracts (carried
forward from M3–M10 and verified at every milestone close) stay
canonical and must not be relaxed by the redesign:

- Customer DEK envelope contract (spec §2.4).
- Customer-side route gate (`requireCustomerSession` from
  `lib/auth/middleware.js`).
- Multipart route guards (form-order + `x-csrf-token` header).
- Signed-URL issuance budget (60/min, M6 review I1).
- Vault-lock 5-minute sliding window (M7 Task 7.3); locked-vault throw
  paths must NOT refresh the timer.
- Decrypt-failure pattern (M7 review I1).
- Activity-feed allow-list (`SAFE_METADATA_KEYS` in
  `lib/activity-feed.js`, M7 review M1).
- Drafts-are-admin-only contract (M8.4).
- M8 review I2 audit-visibility override.
- M8.7 multi-page NDA contract (`NdaOverflowError` is gone; Puppeteer's
  `page.pdf()` `Uint8Array` must be wrapped as
  `Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)` before
  encode/hash; templates archive prior `nda.html` under its sha before
  re-running `bootstrap-templates.sh`).
- M9 review I1 hijack-site `applySecureHeadersRaw(raw)` rule.
- M9 review I2 sensitive-POST rate-limit wiring.
- audit_log append-only at the row level via trigger.
- Hardcoded display format DD/MM/YYYY and DD/MM/YYYY HH:mm 24h,
  Atlantic/Canary timezone, via `lib/dates.js` `euDate` / `euDateTime`.
- Pre-commit secret scanner active; SAFETY.md canonical.
- Repo perms: every new file `root:portal-app` mode 0640 (0750 for
  executables; 0750 for new directories).
- Commits unsigned (no GPG key on the box); no Co-Authored-By trailer.
- One commit per logical task in conventional-commits format
  (`feat(m11-N) ...`).

**End of design spec.**
