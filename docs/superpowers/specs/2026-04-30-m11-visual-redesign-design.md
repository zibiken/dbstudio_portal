# M11 — Visual Redesign + TOTP QR (design spec)

> **Status:** Surfaced 2026-04-30 at the close of M10-C operator onboarding.
> Must ship before v1.0.0 tag. No production traffic on portal yet.

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
   same imagery and motion vocabulary.

2. **Server-side SVG QR codes on every TOTP-enrolment surface.** No
   client-side JS rendering, no CDN, no inline `data:` image schemes
   that bloat the CSP allow-list. SVG produced by `qrcode` npm in
   Node and inlined into the EJS view at request time. Must be
   accessible (`<svg role="img" aria-label="...">` with the
   already-shown-in-text otpauth URI as a copy fallback).

3. **A11y re-audit post-redesign.** Skip-link + focus-visible + label
   coverage stay green; new components added (cards, hero blocks,
   form-with-aside layouts) must hit AA contrast against the new
   palette and pass `scripts/a11y-check.js` before the milestone closes.

## Non-goals

- Marketing-site features (blog, case-studies, pricing) — the portal is
  customer-only; the marketing surface stays at `dbstudio.one`.
- A redesign of `dbstudio.one` itself — this is one-way alignment.
- Component framework migration — Tailwind 4 stays.

## Surfaces in scope

### Public (highest visual priority — first impression)

- `GET /` → `/login` redirect (no UI of its own).
- `GET /login` (form, error states, rate-limited 429).
- `GET /login/2fa` (TOTP code, backup-code fallback).
- `GET /welcome/:token` (admin invite consume — password set, TOTP
  enrol with QR + backup codes display).
- `GET /customer/welcome/:token` (customer invite consume — same flow).
- `GET /reset/:token` (password reset).
- `GET /logout` confirmation.
- All public-facing 4xx error pages (404 / 410 / 429).

### Admin (second priority — daily-use surface)

- `/admin/customers` (list + search + paginate)
- `/admin/customers/new` and `/admin/customers/:id`
- `/admin/customers/:id/{ndas,documents,credentials,credential-requests,invoices,projects}`
- `/admin/profile` (name, email, password, 2FA, sessions)
- `/admin/audit` + the streamed CSV export confirmation page

### Customer (second priority — peer of admin)

- `/customer/dashboard` (cards-to-features grid)
- `/customer/{ndas,documents,credentials,credential-requests,invoices,projects,activity,profile}`

## Design system to match

The match target is `dbstudio.one` as it stands on 2026-04-30. The
implementer's first task in M11 is a survey pass:

1. Fetch the marketing site's HTML + CSS, inventory its design tokens
   (colors, typography scale, spacing scale, radius, shadow), components
   (buttons, inputs, cards, navigation, hero, footer), font files,
   imagery (hero illustrations, brand patterns).
2. Produce a one-page reference doc mapping marketing-site tokens →
   portal layer:
   - `tokens.css` (already exists) gets the verbatim variable names.
   - Component classes get matching utility patterns or extracted into
     `views/components/_<name>.ejs` partials.
   - Asset directory: copy the relevant brand assets into
     `public/static/brand/` so the portal serves them itself (no
     cross-origin requests, CSP stays clean).
3. Hand the survey doc to the operator for sign-off before coding starts.

Likely token shape (informed guess; final values come from the survey):

- **Type:** Cormorant Garamond (already loaded for NDAs) for display
  headings; Inter (already loaded) for UI body. H1/H2/H3 scale matched
  to marketing.
- **Palette:** `--color-ink-900 / --color-ink-600 / --color-ink-300 /
  --color-bg / --color-accent` mapped from marketing's brand palette.
- **Spacing:** marketing's modular scale; assume 4/8/12/16/24/32/48/64.
- **Radii / shadow:** matched to marketing's card style.

## Implementation order

The plan written via `superpowers:writing-plans` will break this into
implementer-sized tasks. Sketch:

1. Survey + reference doc (gate the rest of the work on operator
   sign-off).
2. Token + asset infrastructure: import tokens.css from marketing,
   copy brand assets, wire fonts, expand `views/layouts/{public,admin,customer}.ejs`
   with the new system.
3. Component partials: button, input-group, card, alert, page-hero,
   sidebar-nav, top-bar, footer.
4. Server-side SVG QR (`lib/qr.js` wrapper around the `qrcode` npm
   package, returns `<svg>` strings; use in welcome + regen views).
   Lands as its own commit so it is reviewable in isolation.
5. Public surface restyle (welcome, login, login-2fa, reset, errors).
   Highest priority because operator onboarding blocks here.
6. Admin surface restyle (customers list/detail/edit, profile, audit).
7. Customer surface restyle (dashboard, all section pages, activity).
8. A11y re-audit; expand `scripts/a11y-check.js` if new components have
   patterns the static scanner misses.
9. Smoke + visual regression: open one page per surface in a browser
   alongside the marketing site, screenshot side-by-side, attach to
   the M11 acceptance dry-run doc.

## Acceptance criteria

- Every surface in scope is visually consistent with `dbstudio.one` —
  fonts, palette, spacing, component language, imagery patterns.
- Bootstrap admin can complete welcome onboarding end-to-end on a
  phone-sized viewport in a clean browser:
  - Reads the welcome email
  - Sets password (HIBP)
  - **Scans the QR code** with their authenticator app
  - Enters TOTP code, sees backup codes, saves them
  - Lands on dashboard
- `scripts/a11y-check.js` reports 0 offenders post-redesign.
- `scripts/run-tests.sh` passes (visual changes don't break logic).
- The remaining §11 line "1 customer + 1 credential decrypted cleanly"
  in the restore drill becomes runnable because the operator can
  finally onboard, create a test customer, walk customer onboarding,
  and add a credential.

## Operator artefacts to preserve

- The bootstrap admin row created at the end of M10-C
  (`bram@roxiplus.es`, id `019ddf64-c9c0-7171-aa05-cb509c579092`).
- The welcome token is single-use, 7-day expiry. If M11 ships before
  the token expires, the operator uses it as-is. If M11 takes longer
  than 7 days, mint a new welcome token via the admin-reset RUNBOOK
  procedure and document the swap in the build log.
- The age public key on `/var/lib/portal/.age-recipients` and the
  matching offline private key on the operator workstation MUST NOT
  change during M11. Backups in flight are encrypted to that key.

## Open questions for brainstorming

- Animation: marketing has subtle motion; how much of it crosses into
  the portal without feeling out of place in an admin tool?
- Customer dashboard cards: marketing uses bento-style; portal might
  benefit from a tighter table-style for invoice/document/credential
  density.
- Hero on `/login` and `/welcome/...`: marketing has illustrative
  hero blocks. Use the same imagery, or a portal-specific quieter
  variant?

These get resolved in the M11 brainstorming session before plan
authorship.

**End of design spec.**
