# M11 — Visual Redesign + TOTP QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the portal to visual parity with `https://dbstudio.one` (typography, palette, spacing, motion, component language) and add server-side SVG QR codes to every TOTP-enrolment surface, so the bootstrap admin can complete onboarding and v1.0.0 can ship.

**Architecture:** Vendor marketing's `tokens.css` verbatim into `public/styles/tokens.css`, vendor marketing's `global.css` resets into `app.src.css`, rewrite `tailwind.config.js` to read the marketing tokens, then restyle every EJS view through reusable `views/components/_*.ejs` partials. Public surfaces get a dark obsidian hero + light form card. Admin and customer surfaces get top-bar + obsidian-on-ivory left sidebar + a width-switching `<main>`. `lib/qr.js` (wrapping the `qrcode` npm package) renders inline SVG into the welcome and 2FA-regen views.

**Tech Stack:** Fastify 5, EJS 5, Tailwind 3.4, marketing's tokens.css (Satoshi + General Sans + JetBrains Mono variable woff2), `qrcode` npm (new dep), Vitest (unit), `scripts/run-tests.sh` (integration), `scripts/a11y-check.js` (static a11y), `scripts/smoke.sh`.

**Spec:** `docs/superpowers/specs/2026-04-30-m11-visual-redesign-design.md`.

---

## Pre-flight context for the implementer

If you are a fresh subagent reading this for the first time, read these in order before writing any code:

1. `/opt/dbstudio_portal/SAFETY.md` — operational invariants. Never commit secrets. Pre-commit hook is active.
2. `/opt/dbstudio_portal/docs/superpowers/specs/2026-04-30-m11-visual-redesign-design.md` — full spec for this milestone.
3. `/opt/dbstudio_portal/RUNBOOK.md` "Display formats — dates and times" + "M8.7 (landed)".
4. `/opt/dbstudio/src/styles/tokens.css` — the upstream tokens we are vendoring.
5. `/opt/dbstudio/src/styles/global.css` — the upstream resets we are vendoring.
6. `/opt/dbstudio_portal/views/layouts/{public,admin,customer}.ejs` and the existing views under `views/{public,admin,customer}/` — the surfaces being restyled.

### Hard rules (apply to every task)

- Repo perms: every new file you create needs `sudo chown root:portal-app <file> && sudo chmod 0640 <file>` (0750 for executable scripts; 0750 for new directories with their contents at 0640). The Edit/Write tools sometimes flip ownership back to root:root — re-apply after each file write.
- Commits unsigned (no GPG key on the box). No Co-Authored-By trailer. Conventional-commits format (`feat(m11-N): ...`, `fix(m11-N): ...`, `docs(m11-N): ...`).
- One commit per logical task in this plan.
- Never commit secrets. Pre-commit hook will block; do not bypass.
- Always run integration tests via `sudo bash /opt/dbstudio_portal/scripts/run-tests.sh`. Run unit tests via `sudo -u portal-app /opt/dbstudio_portal/node_modules/.bin/vitest run tests/unit/`.
- Always rebuild CSS + email templates after EJS / CSS changes:
  ```bash
  sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin \
    /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
  ```
- After EJS changes that affect served HTML, restart `portal.service`:
  ```bash
  sudo systemctl restart portal.service && sleep 2 && sudo bash /opt/dbstudio_portal/scripts/smoke.sh
  ```
- Never relax systemd hardening to make something start. Investigate.
- Never weaken any check in `lib/safety-check.js` or any cross-cutting contract listed in the spec § "Cross-cutting contracts that must NOT change in M11".
- Hardcoded display format DD/MM/YYYY and DD/MM/YYYY HH:mm 24h via `lib/dates.js` `euDate` / `euDateTime` (Atlantic/Canary timezone). Do not introduce other formats.
- Do not write Co-Authored-By lines, do not write authors that reference Anthropic, do not push without operator instruction.

### Mid-redesign warning

Between Task 2 (Tailwind config rewrite) and the surface restyle tasks (Task 9+), existing EJS views reference Tailwind class names that no longer exist in the new theme (`bg-bg`, `text-ink-900`, `bg-accent`, etc.). Tailwind silently drops unknown classes from the compiled CSS, so served pages will render with HTML defaults + the global resets only — not crashed, just unstyled. This is acceptable because the portal has no production traffic yet (operator has not consumed the welcome token). The plan executes tasks 1 → 21 top-to-bottom; do not pause partway through and direct the operator to use the portal until at least Tasks 1–12 are landed (foundation + components + public surfaces, which is what onboarding needs).

### File structure (M11-only — no logic-layer churn)

| Area | Touched in this milestone |
|---|---|
| `public/styles/tokens.css` | **Replaced** with vendored marketing tokens + 3 semantic-state additions |
| `public/styles/app.src.css` | **Restructured** — tokens import, marketing global resets, M11 component CSS, Tailwind base/components/utilities |
| `public/static/fonts/` | **New directory** with 3 woff2 files copied from marketing |
| `tailwind.config.js` | **Rewritten** `theme.extend` to read marketing tokens |
| `views/layouts/{public,admin,customer}.ejs` | **Replaced** with new chrome shells |
| `views/components/_*.ejs` | **New directory** — 14 partials |
| `views/public/*.ejs` | All restyled |
| `views/admin/**/*.ejs` | All restyled |
| `views/customer/**/*.ejs` | All restyled |
| `lib/qr.js` | **New** — server-side SVG QR module |
| `lib/customer-summary.js` | **New** — dashboard aggregator |
| `tests/unit/qr.test.js` | **New** |
| `tests/unit/customer-summary.test.js` | **New** |
| `scripts/a11y-check.js` | **Extended** with M11 pattern checks |
| `scripts/smoke.sh` | **Extended** with probe #10 (gated on `RUN_M11_SMOKE=1`) |
| `docs/superpowers/m11-acceptance-dryrun.md` | **New** — operator screenshot-pair sign-off doc |
| `package.json` | **+1 dep:** `qrcode` |

No domain/, routes/, migrations/ work. M11 is presentation-layer.

---

## Progress (live)

| Task | Status | Commit | Notes |
|---|---|---|---|
| T1 Vendor tokens.css + woff2 fonts | ✅ | `47cdc35` | Fonts at `/static/fonts/` (NOT `/static/static/fonts/` — see T1 verification) |
| T2 Rewrite tailwind.config.js + restructure app.src.css | ✅ | `c590c69` | |
| T3 Update layouts (chrome shells only) | ✅ | `8fc90e6` | |
| T4 Leaf component partials (eyebrow, alert, button, input) | ✅ | `0984cf5` | EJS-comment bug found and fixed in T5 — never embed `%>` inside `<%# %>` |
| T5 Container partials (card, page-header, table, breadcrumb, footer) | ✅ | `b67ff28` | |
| T6 Hero + chrome partials (hero-public, top-bar, sidebar-admin, sidebar-customer) | ✅ | `fcb0d67` | `lib/render.js` updated to flow ALL locals to layout (was only flowing title/body/nonce) |
| T7 lib/qr.js + unit tests | ✅ | `311fdfe` | 7 TDD unit tests; `qrcode` npm dep added |
| T8 _qr partial | ✅ | `d3d938d` | |
| T9 /login + /login/2fa restyled | ✅ | `15877fe` | |
| T10 /welcome/:token (admin) restyled with QR | ✅ | `dff8f17` | |
| T11 /customer/welcome/:token restyled with QR | ✅ | `0262e2a` | |
| T12 /reset/:token + /logout + 4xx + backup-codes restyled | ✅ | `4a76653` | `/reset` shares the welcome flow via registerWelcomeRoutes — inherited automatically |
| **VISUAL FIX 1** Align components to dbstudio.one rendered values | ✅ | `8dd5fd7` | h1-h4 scale shifted up one step; buttons drop fixed height; card bg ivory→white; QR 220→180px |
| **VISUAL FIX 2** Split logo into thin pre-hero brand strip | ✅ | `d3b296f` | Operator caught logo-eyebrow-headline redundancy; logo now in `.public-brand` strip above hero |
| T13 /admin/customers list + new + detail + sub-tabs | ✅ | `4356979` | `_admin-customer-tabs` partial; status-pill component |
| T14a admin NDAs subroute restyled | ✅ | `bb99a6b` | M8.5 multipart contract preserved byte-identical |
| T14b admin documents subroute restyled | ✅ | `4a76f73` | M6 multipart contract preserved byte-identical |
| T14c admin invoices subroute restyled | ✅ | `ba8c041` | |
| T14d admin projects subroute restyled | ✅ | `775880c` | |
| T14e admin credential-requests subroute restyled | ✅ | `26644b4` | M7 review M2 indexed-name field array preserved |
| **VISUAL FIX 3** Eye/eye-off SVG icons for password toggle | ✅ | `c952411` | Operator reported `·` middot — replaced with feather-style SVG icons + JS toggle |
| **AUTH FIX 1** /login/2fa redirects admins to /admin/customers, not / | ✅ | `bc67e04` | server.js GET '/' redirects to /login, so the previous '/' target bounced admins back to the login form post-2FA. Updated 2 integration test assertions in lockstep. |
| **AUTH FIX 2** Admin /welcome auto-logs-in (mirrors completeCustomerWelcome) | ✅ | `6a06f7c` | Mints session inside the invite-consume tx + stepUp + login_success audit (`via='onboarding'`). Backup-codes "continue" button now → /admin/customers. Auto-applies to /reset (shared handler). |
| **PLAN REWIRE** Insert T15 polish, demote T19 admin profile, broaden T22 | ✅ | `7f28264` | Re-ordered T15→T22 around customer-perception priority + locked-bar-first principle. Documented in `## Rewired execution sequence` above. |
| T15 Admin surface polish + English copy + extended search + responsive + missing list views | ✅ | `e96bc20` | Operator review surfaced 3 deltas during T15 walk: mobile non-responsive, two tab routes 404'd (Documents + Credentials), credential-request field types missing. First two baked in here (≤640px breakpoints + new `routes/admin/credentials.js` + `admin/documents/list.ejs` + `admin/credentials/list.ejs` metadata-only view). Tests +7 (579 total). New doc: `docs/superpowers/m11-list-surface-contract.md`. |
| T15.5 Credential-request dynamic field repeater + clearer type labels | ✅ | `e65ef2b` | Per-field type wiring (text/secret/url/note) was already correct end-to-end since M7; missing UX was the "+ Add another field" repeater + descriptive type-option labels. No schema, contract, or service change. Customer fulfillment view restyle deferred to T18b (chrome only — type-aware rendering is correct). |
| T16 lib/customer-summary.js + integration tests (TDD) | ✅ | `5badbd7` | One-query Postgres aggregator (per-section count + latestAt + unreadCount). 7 tests covering shape / empty / counts / unread semantics / isolation / latestAt / guard. |
| T17 /customer/dashboard restyled (bento + summary) | ✅ | `bc5183d` | 6-card bento grid wired to T16's getCustomerDashboardSummary. Cache-Control: private, max-age=15. |
| T18a Customer NDAs/Documents/Invoices/Projects restyled | ✅ | `d7bca9e` | Includes new GET /customer/documents list route + view (was missing). NDA drafts filtered out per M8.4 contract. |
| T18b Customer Credentials/Credential-requests/Activity/Profile restyled | ✅ | `cce3dd3` | Type-aware credential-request fulfilment preserved (note→textarea / secret→password / url / text). Profile sub-pages restyled in T22. |
| T19 /admin/profile (QR) + /admin/audit + export | ✅ | `7c3626c` | Operator-only. Same skeleton as customer/profile from T18b. Audit-export CSV streaming preserved. |
| T20 Extend scripts/a11y-check.js with M11 checks | ✅ | `3de8078` | 5 EJS-side + 1 CSS-partner check. Sidebar conditional-class false positives fixed via classIsDynamic() helper. |
| T21 Add probe #10 to scripts/smoke.sh | ✅ | `5fc6312` | Gated on RUN_M11_SMOKE=1 + M11_SMOKE_WELCOME_TOKEN. Default off — production smoke runs 1-9 unchanged. |
| T22 Final cross-surface polish sweep + acceptance dry-run | ✅ | `(this commit)` | Restyled the 10 deep profile sub-pages (admin + customer × totp-regen / backup-codes-regen / -show / email-verify / sessions). Drift scan returns zero legacy class names. Authored docs/superpowers/m11-acceptance-dryrun.md. v1.0.0 tag fires on operator sign-off in dryrun §9. |

## Open issues at handoff — RESOLVED 2026-04-30

Both blockers from the previous handoff are landed and pushed:

1. ~~**`/login/2fa` post-success redirect bounces back to `/login`.**~~ Fixed in `bc67e04`. `routes/public/login-2fa.js` now redirects admins to `/admin/customers` after successful TOTP / backup-code submission. The two integration assertions in `tests/integration/auth/login-flow.test.js` that pinned the broken `/` target were updated in the same commit. Customer flows do not pass through this route (customers are stepped-up inside `completeCustomerWelcome`), so the change is admin-only by construction.

2. ~~**`/welcome/:token` (admin) bounces operator back to `/login` after backup codes.**~~ Fixed in `6a06f7c`. `domain/admins/service.js#completeWelcome` now mints the admin's first session inside the same transaction as the invite consumption (mirrors `completeCustomerWelcome`), `routes/public/welcome.js` calls `setSessionCookie` on success, and `views/public/2fa-enrol.ejs`'s "continue" button now points at `/admin/customers`. The same handler is mounted at `/reset` via `registerResetRoutes` so password resets inherit auto-login automatically — symmetric with the customer flow which has no separate reset path. Tests: 572 green + 3 skipped (baseline unchanged), smoke 9/9.

## Rewired execution sequence (2026-04-30 — operator polish review)

After operator visual sign-off on T13 (`/admin/customers`), they confirmed it "looks fine but isn't on the sweet spot" — concrete deltas: empty-state hugs the search bar with no spacing, Spanish field labels (razón social / NIF / domicilio) need English display copy, search only matches razón social (need email + contact-person too). The bar is "promoting a Studio, not a fast mocked up page" — so polish quality must match the marketing site (`https://dbstudio.one`), not just clear an a11y scanner.

The remaining T15→T21 sequence has been rewired around two principles:

1. **Lock the bar before more list surfaces ship.** The empty-state-no-spacing smell on T13 is a list-surface pattern smell — it would repeat across every T14 list and every T18 list if not captured. Fix the patterns once (now T15) and document the contract; downstream tasks inherit instead of paying cleanup tax.

2. **Polish budget goes where the eyes are.** T17 customer dashboard + T18 customer per-section pages are what every paying customer sees on first login; they are promoted ahead of the operator-only admin profile/audit surfaces (was T15, now T19). Customers see polished surfaces first; the operator sees polished admin pages slightly later — but they're polished by the time v1.0 tags.

| New | Was | Task | Notes |
|---|---|---|---|
| T15 | *new* | Admin surface polish + English copy + extended search (+ responsive + 2 missing list views) | Polish-debt sweep on T13/T14. Codifies list-surface contract for T17/T18 to inherit. Scope grew during operator review to include ≤640px responsive pass and the two previously-404'd tab routes (Documents, Credentials metadata-only). |
| T15.5 | *new* | Credential-request dynamic field repeater | Inserted after T15 operator review. Schema/contract unchanged — UX-only. |
| T16 | T16 | lib/customer-summary.js (TDD) | Unchanged. Dep for T17. |
| T17 | T17 | Customer dashboard (bento + summary) | Polished from day 1 against T15's contract. |
| T18a/b | T18a/b | Customer per-section pages | Polished from day 1. |
| T19 | T15 | Admin profile + audit + audit-export | Demoted — operator-only. |
| T20 | T19 | a11y check extension | Renumbered. |
| T21 | T20 | Smoke probe #10 | Renumbered. |
| T22 | T21 | Final cross-surface polish sweep + acceptance dry-run + v1.0 tag | Renumbered + scope broadened to include explicit drift-fix budget, not just dryrun authoring. |

---

## How to execute this plan

Each task is a single commit. After the last step of every task, the working tree must be clean and `git log -1 --oneline` must show the new commit. The progress table above is updated after each commit lands (mark `⬜` → `✅` and paste the short sha).

Inside a task, every step is 2–5 minutes of work. Run the verification commands as written; if they fail, stop, diagnose, fix the underlying cause — do not skip the verification or weaken it.

---

## Task 1: Vendor tokens.css + woff2 fonts

**Files:**
- Create: `public/static/fonts/satoshi-variable.woff2` (copied from `/opt/dbstudio/public/fonts/satoshi-variable.woff2`)
- Create: `public/static/fonts/generalsans-variable.woff2` (copied from `/opt/dbstudio/public/fonts/generalsans-variable.woff2`)
- Create: `public/static/fonts/jetbrainsmono-latin-variable.woff2` (copied from `/opt/dbstudio/public/fonts/jetbrainsmono-latin-variable.woff2`)
- Replace: `public/styles/tokens.css` (current portal tokens replaced with marketing tokens verbatim + 3 semantic-state additions, with font URLs rewritten to `/static/fonts/...`)

- [ ] **Step 1: Create the fonts directory and copy the three woff2 files**

```bash
sudo install -d -o root -g portal-app -m 0750 /opt/dbstudio_portal/public/static
sudo install -d -o root -g portal-app -m 0750 /opt/dbstudio_portal/public/static/fonts
sudo install -m 0640 -o root -g portal-app /opt/dbstudio/public/fonts/satoshi-variable.woff2 /opt/dbstudio_portal/public/static/fonts/
sudo install -m 0640 -o root -g portal-app /opt/dbstudio/public/fonts/generalsans-variable.woff2 /opt/dbstudio_portal/public/static/fonts/
sudo install -m 0640 -o root -g portal-app /opt/dbstudio/public/fonts/jetbrainsmono-latin-variable.woff2 /opt/dbstudio_portal/public/static/fonts/
ls -la /opt/dbstudio_portal/public/static/fonts/
```

Expected: 3 files, each `-rw-r----- root portal-app`, sizes ~31–43 KB.

- [ ] **Step 2: Replace `public/styles/tokens.css`**

Write `/opt/dbstudio_portal/public/styles/tokens.css` with this exact content:

```css
/* Design tokens — vendored verbatim from /opt/dbstudio/src/styles/tokens.css
   on 2026-04-30 (M11). The portal copy adds three semantic-state tokens
   (--c-error, --c-warn, --c-success) since marketing has no error/warn/
   success palette; everything else is identical. Do not edit this file
   to drift from marketing — re-vendor instead. */

@font-face {
  font-family: 'Satoshi';
  src: url('/static/fonts/satoshi-variable.woff2') format('woff2-variations');
  font-weight: 300 900;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'General Sans';
  src: url('/static/fonts/generalsans-variable.woff2') format('woff2-variations');
  font-weight: 300 700;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'JetBrains Mono';
  src: url('/static/fonts/jetbrainsmono-latin-variable.woff2') format('woff2-variations');
  font-weight: 100 800;
  font-style: normal;
  font-display: swap;
}

:root {
  /* -------- Colour -------- */
  --c-obsidian: #0A0A0A;
  --c-carbon:   #111111;
  --c-ivory:    #F6F3EE;
  --c-pearl:    #E9E3DA;
  --c-slate:    #A8B0B8;
  --c-stone:    #CFC6B8;
  --c-moss:     #2F5D50;
  --c-gold:     #C4A97A;
  --c-ice:      #8FD3FF;
  --c-white:    #FFFFFF;

  /* Semantic */
  --bg-dark:           var(--c-obsidian);
  --bg-dark-alt:       var(--c-carbon);
  --bg-light:          var(--c-ivory);
  --bg-light-alt:      var(--c-pearl);
  --fg-on-dark:        var(--c-white);
  --fg-on-dark-muted:  var(--c-slate);
  --fg-on-light:       var(--c-obsidian);
  --fg-on-light-muted: #555555;
  --border-dark:       rgba(255, 255, 255, 0.08);
  --border-light:      var(--c-pearl);
  --cta-bg:            var(--c-moss);
  --cta-bg-hover:      var(--c-gold);
  --accent:            var(--c-ice);
  --focus-ring:        var(--c-ice);

  /* Portal-only semantic-state additions (marketing has no error/warn/success). */
  --c-error:   #a32020;
  --c-warn:    #b35a1f;
  --c-success: var(--c-moss);

  /* -------- Typography -------- */
  --f-display: 'Satoshi', system-ui, -apple-system, Segoe UI, sans-serif;
  --f-body:    'General Sans', system-ui, -apple-system, Segoe UI, sans-serif;
  --f-mono:    'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  --f-xs:  12px;
  --f-sm:  14px;
  --f-md:  16px;
  --f-lg:  18px;
  --f-xl:  20px;
  --f-2xl: clamp(1.5rem, 2vw, 1.75rem);
  --f-3xl: clamp(1.75rem, 3vw, 2.25rem);
  --f-4xl: clamp(2.25rem, 4vw, 3.25rem);
  --f-5xl: clamp(3rem, 7vw, 7rem);

  --lh-display: 1.1;
  --lh-head:    1.25;
  --lh-body:    1.55;
  --lh-lead:    1.4;

  --ls-display: -0.02em;
  --ls-head:    -0.01em;
  --ls-body:     0;
  --ls-upper:    0.1em;

  /* -------- Space -------- */
  --s-1:   4px;
  --s-2:   8px;
  --s-3:   12px;
  --s-4:   16px;
  --s-6:   24px;
  --s-8:   32px;
  --s-12:  48px;
  --s-16:  64px;
  --s-24:  96px;
  --s-32:  128px;
  --s-40:  160px;
  --s-48:  192px;

  --container:    1280px;
  --content:       1024px;
  --prose:          680px;

  /* -------- Effects -------- */
  --radius-btn:   8px;
  --radius-card: 12px;
  --shadow-card: 0 1px 2px rgba(10, 10, 10, 0.04);

  /* -------- Motion -------- */
  --dur-micro:   200ms;
  --dur-reveal:  450ms;
  --ease-expo:   cubic-bezier(0.16, 1, 0.3, 1);

  /* -------- Layers -------- */
  --z-navbar:     100;
  --z-drawer:     200;
  --z-cookie:     300;
  --z-backtotop:  150;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-micro:  0ms;
    --dur-reveal: 0ms;
  }
}
```

Note: marketing's `tokens.css` has `--content: 960px`. The spec calls for `--content: 1024px` as the form-container width. The portal copy bumps that one value (still inside marketing's intent — both are between `--prose` and `--container`).

- [ ] **Step 3: Re-apply repo perms**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/public/styles/tokens.css
sudo chmod 0640 /opt/dbstudio_portal/public/styles/tokens.css
ls -la /opt/dbstudio_portal/public/styles/tokens.css
```

Expected: `-rw-r----- root portal-app`.

- [ ] **Step 4: Verify the dev server can serve the fonts**

Tokens.css won't be exercised yet (Tailwind config still references the old token names — that's T2). Just confirm static-mount serves the new font files:

```bash
sudo systemctl restart portal.service
sleep 2
curl -sI http://127.0.0.1:3400/static/fonts/satoshi-variable.woff2 | head -3
curl -sI http://127.0.0.1:3400/static/fonts/generalsans-variable.woff2 | head -3
curl -sI http://127.0.0.1:3400/static/fonts/jetbrainsmono-latin-variable.woff2 | head -3
```

Expected: each returns `HTTP/1.1 200 OK` with `content-type: font/woff2`.

If any return 404, the static mount in `server.js` needs adjusting. Existing convention is that everything under `public/static/` is served at `/static/...`; if the new `fonts` subdir isn't picked up, check `@fastify/static`'s `prefix` and `root` in `server.js`.

- [ ] **Step 5: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add public/styles/tokens.css public/static/fonts/
sudo -u root git commit -m "feat(m11-1): vendor marketing tokens.css + woff2 fonts

Replace portal's bespoke tokens.css with /opt/dbstudio/src/styles/tokens.css
verbatim (font URLs rewritten to /static/fonts/, --content bumped to
1024px, three semantic-state tokens --c-error/--c-warn/--c-success
appended). Copy Satoshi + General Sans + JetBrains Mono variable woff2
into public/static/fonts/. No Tailwind config or view changes yet —
those land in m11-2 onwards."
```

Verify:

```bash
git log -1 --oneline
git status
```

Expected: new commit on top of `929558d`, working tree clean.

---

## Task 2: Rewrite tailwind.config.js + restructure app.src.css

**Files:**
- Modify: `tailwind.config.js` (full rewrite of `theme.extend`)
- Replace: `public/styles/app.src.css` (vendored marketing globals + Tailwind directives)

- [ ] **Step 1: Rewrite `tailwind.config.js`**

Write `/opt/dbstudio_portal/tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./views/**/*.ejs', './public/**/*.html'],
  theme: {
    extend: {
      colors: {
        obsidian: 'var(--c-obsidian)',
        carbon:   'var(--c-carbon)',
        ivory:    'var(--c-ivory)',
        pearl:    'var(--c-pearl)',
        slate:    'var(--c-slate)',
        stone:    'var(--c-stone)',
        moss:     'var(--c-moss)',
        gold:     'var(--c-gold)',
        ice:      'var(--c-ice)',
        white:    'var(--c-white)',
        error:    'var(--c-error)',
        warn:     'var(--c-warn)',
        success:  'var(--c-success)',
        'fg-on-dark':         'var(--fg-on-dark)',
        'fg-on-dark-muted':   'var(--fg-on-dark-muted)',
        'fg-on-light':        'var(--fg-on-light)',
        'fg-on-light-muted':  'var(--fg-on-light-muted)',
        'border-dark':        'var(--border-dark)',
        'border-light':       'var(--border-light)',
      },
      fontFamily: {
        display: ['Satoshi', 'system-ui', 'sans-serif'],
        body:    ['"General Sans"', 'system-ui', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        xs:   ['var(--f-xs)',  { lineHeight: 'var(--lh-body)' }],
        sm:   ['var(--f-sm)',  { lineHeight: 'var(--lh-body)' }],
        md:   ['var(--f-md)',  { lineHeight: 'var(--lh-body)' }],
        lg:   ['var(--f-lg)',  { lineHeight: 'var(--lh-lead)' }],
        xl:   ['var(--f-xl)',  { lineHeight: 'var(--lh-lead)' }],
        '2xl': ['var(--f-2xl)', { lineHeight: 'var(--lh-head)' }],
        '3xl': ['var(--f-3xl)', { lineHeight: 'var(--lh-head)' }],
        '4xl': ['var(--f-4xl)', { lineHeight: 'var(--lh-display)' }],
        '5xl': ['var(--f-5xl)', { lineHeight: 'var(--lh-display)' }],
      },
      letterSpacing: {
        display: 'var(--ls-display)',
        head:    'var(--ls-head)',
        body:    'var(--ls-body)',
        upper:   'var(--ls-upper)',
      },
      spacing: {
        1:  'var(--s-1)',
        2:  'var(--s-2)',
        3:  'var(--s-3)',
        4:  'var(--s-4)',
        6:  'var(--s-6)',
        8:  'var(--s-8)',
        12: 'var(--s-12)',
        16: 'var(--s-16)',
        24: 'var(--s-24)',
        32: 'var(--s-32)',
        40: 'var(--s-40)',
        48: 'var(--s-48)',
      },
      maxWidth: {
        container: 'var(--container)',
        content:   'var(--content)',
        prose:     'var(--prose)',
      },
      borderRadius: {
        btn:  'var(--radius-btn)',
        card: 'var(--radius-card)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
      },
      transitionDuration: {
        micro:  'var(--dur-micro)',
        reveal: 'var(--dur-reveal)',
      },
      transitionTimingFunction: {
        expo: 'var(--ease-expo)',
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 2: Replace `public/styles/app.src.css`**

Write `/opt/dbstudio_portal/public/styles/app.src.css`:

```css
@import './tokens.css';

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
h1 { font-size: var(--f-4xl); line-height: var(--lh-display); letter-spacing: var(--ls-display); font-weight: 900; }
h2 { font-size: var(--f-3xl); }
h3 { font-size: var(--f-2xl); }
h4 { font-size: var(--f-xl); }

p { margin: 0 0 var(--s-4); }
a { color: var(--c-moss); text-decoration: underline; text-underline-offset: 3px; }
a:hover { color: var(--c-gold); }

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

/* ---- M11 component styles (filled in by Tasks 4–6) ---- */
/* Placeholder layer; Tasks 4–6 append @layer components rules below. */

@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 3: Re-apply repo perms**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/tailwind.config.js /opt/dbstudio_portal/public/styles/app.src.css
sudo chmod 0640 /opt/dbstudio_portal/tailwind.config.js /opt/dbstudio_portal/public/styles/app.src.css
ls -la /opt/dbstudio_portal/tailwind.config.js /opt/dbstudio_portal/public/styles/app.src.css
```

- [ ] **Step 4: Rebuild CSS + email templates**

```bash
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin \
  /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
```

Expected: build completes, `public/styles/app.css` regenerated. Size should be in the same ballpark as before (Tailwind drops the unknown old class names and emits new utilities lazily as views start using them; until views are restyled, output will be near-empty but not error).

- [ ] **Step 5: Restart portal + smoke**

```bash
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

Expected: probes 1–9 still green. Probe #10 doesn't exist yet (T21).

- [ ] **Step 6: Run the test suite to confirm nothing logical broke**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: 565+ tests green, 2 skipped (live-email + RUN_PDF_E2E gates). No new failures.

- [ ] **Step 7: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add tailwind.config.js public/styles/app.src.css
sudo -u root git commit -m "feat(m11-2): rewrite tailwind config + app.src.css for marketing tokens

theme.extend now reads from --c-*/--f-*/--s-*/--radius-*/--shadow-*
and exposes obsidian/ivory/moss/gold/ice/slate/stone/pearl/carbon
colours, display/body/mono fonts, marketing's spacing scale,
container/content/prose maxWidths, btn/card radii, card shadow,
micro/reveal durations, expo timing function.

app.src.css now imports tokens, vendors marketing's global resets
(box-sizing, body baseline, h1–h4 scale, a/:focus-visible/skip-link/
container/section/section--*/eyebrow/visually-hidden, with body.public
flipped to dark canvas), then Tailwind base/components/utilities. The
component layer is empty; Tasks 4–6 fill it with M11 component styles.

EJS views still reference old class names (bg-bg, text-ink-900, etc.)
that no longer resolve; they render with HTML defaults until the
surface restyle tasks roll through (T9–T18b). Operator does not
consume the welcome token until Tasks 1–12 are landed."
```

Verify:

```bash
git log -1 --oneline
git status
```

---

## Task 3: Update layouts (chrome shells only — content slot unchanged)

This task swaps `views/layouts/{public,admin,customer}.ejs` to the new chrome shells. Content slot stays as `<%- body %>`; views inside it still render their old markup until later tasks restyle them.

**Files:**
- Replace: `views/layouts/public.ejs`
- Replace: `views/layouts/admin.ejs`
- Replace: `views/layouts/customer.ejs`

- [ ] **Step 1: Replace `views/layouts/public.ejs`**

Write `/opt/dbstudio_portal/views/layouts/public.ejs`:

```ejs
<!doctype html>
<html lang="<%= typeof lang !== 'undefined' ? lang : 'en' %>">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#0A0A0A">
  <title><%= typeof title !== 'undefined' ? title : 'DB Studio Portal' %></title>
  <link rel="icon" href="/static/brand/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/static/brand/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png">
  <link rel="manifest" href="/static/brand/site.webmanifest">
  <link rel="stylesheet" href="/static/styles/app.css" nonce="<%= nonce %>">
</head>
<body class="public">
  <a class="skip-link" href="#main-content">Skip to main content</a>

  <% if (typeof hero !== 'undefined' && hero) { %>
    <%- include('../components/_hero-public', { hero: hero }) %>
  <% } %>

  <main id="main-content" class="public-form section--light">
    <div class="public-form__inner">
      <%- body %>
    </div>
  </main>

  <%- include('../components/_footer', { variant: 'dark' }) %>
</body>
</html>
```

The `_hero-public` and `_footer` partials don't exist yet (Tasks 5–6). Until they land, EJS renders will throw `ENOENT`. To keep this task atomic, the partials are stubbed in this task.

Create stub `views/components/` directory:

```bash
sudo install -d -o root -g portal-app -m 0750 /opt/dbstudio_portal/views/components
```

Write `/opt/dbstudio_portal/views/components/_hero-public.ejs` (stub — full implementation in T6):

```ejs
<%# stub — full implementation in T6 %>
<section class="hero hero--public section--dark">
  <div class="container">
    <% if (hero.eyebrow) { %><p class="eyebrow"><%= hero.eyebrow %></p><% } %>
    <h1><%= hero.title %></h1>
    <% if (hero.lead) { %><p class="hero__lead"><%= hero.lead %></p><% } %>
  </div>
</section>
```

Write `/opt/dbstudio_portal/views/components/_footer.ejs` (stub — full implementation in T5):

```ejs
<%# stub — full implementation in T5 %>
<footer class="site-footer <%= (typeof variant !== 'undefined' && variant === 'dark') ? 'section--dark' : 'section--light' %>">
  <div class="container">
    <small>&copy; DB Studio · <a href="https://dbstudio.one/privacy">privacy</a> · <a href="https://dbstudio.one/terms">terms</a></small>
  </div>
</footer>
```

- [ ] **Step 2: Replace `views/layouts/admin.ejs`**

Write `/opt/dbstudio_portal/views/layouts/admin.ejs`:

```ejs
<!doctype html>
<html lang="<%= typeof lang !== 'undefined' ? lang : 'en' %>">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#0A0A0A">
  <title><%= typeof title !== 'undefined' ? title : 'Admin' %> · DB Studio Portal</title>
  <link rel="icon" href="/static/brand/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/static/brand/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png">
  <link rel="manifest" href="/static/brand/site.webmanifest">
  <link rel="stylesheet" href="/static/styles/app.css" nonce="<%= nonce %>">
</head>
<body class="admin">
  <a class="skip-link" href="#main-content">Skip to main content</a>

  <%- include('../components/_top-bar', { surface: 'admin', user: typeof user !== 'undefined' ? user : null, sectionLabel: typeof sectionLabel !== 'undefined' ? sectionLabel : 'ADMIN' }) %>

  <div class="surface-shell">
    <%- include('../components/_sidebar-admin', { active: typeof activeNav !== 'undefined' ? activeNav : '' }) %>

    <main id="main-content" class="surface" data-width="<%= typeof mainWidth !== 'undefined' ? mainWidth : 'wide' %>">
      <% if (typeof vaultLockedBanner !== 'undefined' && vaultLockedBanner) { %>
        <%- include('../components/_alert', { variant: 'warn', sticky: true, body: 'Credential vault is locked. Re-enter your password to unlock.' }) %>
      <% } %>
      <%- body %>
    </main>
  </div>

  <%- include('../components/_footer', { variant: 'light' }) %>
</body>
</html>
```

Stub the new partials referenced (top-bar, sidebar-admin, alert) so the layout doesn't ENOENT:

Write `/opt/dbstudio_portal/views/components/_top-bar.ejs` (stub — full impl in T6):

```ejs
<%# stub — full implementation in T6 %>
<header class="top-bar" role="banner">
  <a href="/" aria-label="DB Studio Portal" class="top-bar__logo">
    <img src="/static/brand/logo-black.png" alt="DB Studio">
  </a>
  <p class="top-bar__section eyebrow"><%= sectionLabel %></p>
  <div class="top-bar__menu">
    <% if (user) { %>
      <span><%= user.name %></span>
      <a href="/logout">Sign out</a>
    <% } %>
  </div>
</header>
```

Write `/opt/dbstudio_portal/views/components/_sidebar-admin.ejs` (stub — full impl in T6):

```ejs
<%# stub — full implementation in T6 %>
<nav class="sidebar" aria-label="Admin navigation">
  <ul>
    <li<%= active === 'customers' ? ' aria-current="page"' : '' %>><a href="/admin/customers">Customers</a></li>
    <li<%= active === 'audit' ? ' aria-current="page"' : '' %>><a href="/admin/audit">Audit</a></li>
    <li<%= active === 'profile' ? ' aria-current="page"' : '' %>><a href="/admin/profile">Profile</a></li>
  </ul>
</nav>
```

Write `/opt/dbstudio_portal/views/components/_alert.ejs` (stub — full impl in T4):

```ejs
<%# stub — full implementation in T4 %>
<div class="alert alert--<%= variant %><%= (typeof sticky !== 'undefined' && sticky) ? ' alert--sticky' : '' %>" role="<%= (variant === 'error' || variant === 'warn') ? 'alert' : 'status' %>">
  <%- body %>
</div>
```

- [ ] **Step 3: Replace `views/layouts/customer.ejs`**

Write `/opt/dbstudio_portal/views/layouts/customer.ejs`:

```ejs
<!doctype html>
<html lang="<%= typeof lang !== 'undefined' ? lang : 'en' %>">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#0A0A0A">
  <title><%= typeof title !== 'undefined' ? title : 'Portal' %> · DB Studio</title>
  <link rel="icon" href="/static/brand/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/static/brand/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png">
  <link rel="manifest" href="/static/brand/site.webmanifest">
  <link rel="stylesheet" href="/static/styles/app.css" nonce="<%= nonce %>">
</head>
<body class="customer">
  <a class="skip-link" href="#main-content">Skip to main content</a>

  <%- include('../components/_top-bar', { surface: 'customer', user: typeof user !== 'undefined' ? user : null, sectionLabel: typeof sectionLabel !== 'undefined' ? sectionLabel : (typeof customer !== 'undefined' && customer ? customer.razon_social : 'PORTAL') }) %>

  <div class="surface-shell">
    <%- include('../components/_sidebar-customer', { active: typeof activeNav !== 'undefined' ? activeNav : '' }) %>

    <main id="main-content" class="surface" data-width="<%= typeof mainWidth !== 'undefined' ? mainWidth : 'wide' %>">
      <% if (typeof vaultLockedBanner !== 'undefined' && vaultLockedBanner) { %>
        <%- include('../components/_alert', { variant: 'warn', sticky: true, body: 'Credential vault is locked. Re-enter your password to unlock.' }) %>
      <% } %>
      <%- body %>
    </main>
  </div>

  <%- include('../components/_footer', { variant: 'light' }) %>
</body>
</html>
```

Stub the customer sidebar:

Write `/opt/dbstudio_portal/views/components/_sidebar-customer.ejs` (stub — full impl in T6):

```ejs
<%# stub — full implementation in T6 %>
<nav class="sidebar" aria-label="Section navigation">
  <ul>
    <li<%= active === 'dashboard'           ? ' aria-current="page"' : '' %>><a href="/customer/dashboard">Dashboard</a></li>
    <li<%= active === 'ndas'                ? ' aria-current="page"' : '' %>><a href="/customer/ndas">NDAs</a></li>
    <li<%= active === 'documents'           ? ' aria-current="page"' : '' %>><a href="/customer/documents">Documents</a></li>
    <li<%= active === 'credentials'         ? ' aria-current="page"' : '' %>><a href="/customer/credentials">Credentials</a></li>
    <li<%= active === 'credential-requests' ? ' aria-current="page"' : '' %>><a href="/customer/credential-requests">Credential requests</a></li>
    <li<%= active === 'invoices'            ? ' aria-current="page"' : '' %>><a href="/customer/invoices">Invoices</a></li>
    <li<%= active === 'projects'            ? ' aria-current="page"' : '' %>><a href="/customer/projects">Projects</a></li>
    <li<%= active === 'activity'            ? ' aria-current="page"' : '' %>><a href="/customer/activity">Activity</a></li>
    <li<%= active === 'profile'             ? ' aria-current="page"' : '' %>><a href="/customer/profile">Profile</a></li>
  </ul>
</nav>
```

- [ ] **Step 4: Re-apply repo perms on every new/modified file**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/layouts/{public,admin,customer}.ejs
sudo chmod 0640 /opt/dbstudio_portal/views/layouts/{public,admin,customer}.ejs
sudo chown -R root:portal-app /opt/dbstudio_portal/views/components
sudo find /opt/dbstudio_portal/views/components -type d -exec chmod 0750 {} +
sudo find /opt/dbstudio_portal/views/components -type f -exec chmod 0640 {} +
ls -la /opt/dbstudio_portal/views/layouts/ /opt/dbstudio_portal/views/components/
```

- [ ] **Step 5: Rebuild CSS + restart + smoke**

```bash
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin \
  /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
curl -sI http://127.0.0.1:3400/login | head -3
curl -s http://127.0.0.1:3400/login | head -40
```

Expected: smoke green; `/login` returns 200; the served HTML body begins with the new public-layout chrome (skip-link → hero stub → form section). The body content (the login form) renders inside the form section but with old class names that don't match the new theme — that's expected mid-redesign.

- [ ] **Step 6: Run the test suite**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Any integration test that asserts on rendered HTML body (e.g. checking for a specific class name or DOM structure that the layout swap changed) will need to be updated. Inspect failures and adjust assertions to target the new chrome (skip-link, top-bar/sidebar containers, public hero) — not the body content (that lands per-surface in T9+).

If a test asserts content that has structurally moved (e.g. `<header class="brand">` → `<header class="top-bar">`), update the assertion. If a test asserts on functional behaviour (e.g. POST returns 302), it should still pass.

Once green:

- [ ] **Step 7: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add views/layouts/ views/components/
sudo -u root git commit -m "feat(m11-3): swap layouts to new chrome shells

views/layouts/public.ejs becomes hero + form-section + footer.
views/layouts/admin.ejs and customer.ejs become top-bar + sidebar +
surface (data-width=content|wide) + footer, with optional vault-locked
banner pinned under the top-bar when locals.vaultLockedBanner is set.

views/components/ created with stubs for _hero-public, _top-bar,
_sidebar-admin, _sidebar-customer, _alert, _footer — full styled
implementations land in T4–T6. Stubs preserve enough markup that
existing routes still render through the new layouts without ENOENT.

Routes will need to start passing the new locals (hero / sectionLabel /
activeNav / mainWidth / vaultLockedBanner / user) progressively as
each surface is restyled in T9–T18b. Defaults are sensible
(mainWidth=wide, no hero on public unless passed)."
```

---

## Task 4: Leaf component partials (eyebrow, alert, button, input)

**Files:**
- Replace: `views/components/_alert.ejs` (full impl, replacing T3 stub)
- Create: `views/components/_eyebrow.ejs`
- Create: `views/components/_button.ejs`
- Create: `views/components/_input.ejs`
- Modify: `public/styles/app.src.css` — append component styles for `.alert`, `.btn`, `.input-field`

- [ ] **Step 1: Write `views/components/_eyebrow.ejs`**

```ejs
<%# Usage: <%- include('../components/_eyebrow', { text: 'ADMIN · CUSTOMERS' }) %>
    Renders a JetBrains Mono uppercase tracked label. %>
<p class="eyebrow"><%= text %></p>
```

- [ ] **Step 2: Replace `views/components/_alert.ejs` with full impl**

```ejs
<%# Usage:
    <%- include('../components/_alert', { variant: 'info'|'success'|'warn'|'error',
                                          body: '...HTML or text...',
                                          sticky: false }) %>
    body may contain HTML; callers must HTML-escape user input themselves. %>
<%
  var v = (typeof variant !== 'undefined') ? variant : 'info';
  var role = (v === 'error' || v === 'warn') ? 'alert' : 'status';
  var sticky = (typeof sticky !== 'undefined') && sticky;
%>
<div class="alert alert--<%= v %><%= sticky ? ' alert--sticky' : '' %>" role="<%= role %>">
  <div class="alert__body"><%- body %></div>
</div>
```

- [ ] **Step 3: Write `views/components/_button.ejs`**

```ejs
<%# Usage:
    <%- include('../components/_button', { variant: 'primary'|'secondary'|'ghost'|'danger',
                                           size: 'md'|'sm',
                                           type: 'submit'|'button',
                                           label: 'Sign in',
                                           href: null,            // if set, renders <a> instead of <button>
                                           name: null, value: null,
                                           disabled: false,
                                           busy: false }) %>
%>
<%
  var v = (typeof variant !== 'undefined') ? variant : 'primary';
  var s = (typeof size !== 'undefined') ? size : 'md';
  var t = (typeof type !== 'undefined') ? type : 'button';
  var classes = 'btn btn--' + v + ' btn--' + s;
  var disabled = (typeof disabled !== 'undefined') && disabled;
  var busy = (typeof busy !== 'undefined') && busy;
%>
<% if (typeof href !== 'undefined' && href) { %>
  <a href="<%= href %>" class="<%= classes %>"><%= label %></a>
<% } else { %>
  <button type="<%= t %>" class="<%= classes %>"
    <% if (typeof name !== 'undefined' && name) { %>name="<%= name %>"<% } %>
    <% if (typeof value !== 'undefined' && value) { %>value="<%= value %>"<% } %>
    <% if (disabled) { %>disabled<% } %>
    <% if (busy) { %>aria-busy="true"<% } %>
  ><%= label %></button>
<% } %>
```

- [ ] **Step 4: Write `views/components/_input.ejs`**

```ejs
<%# Usage:
    <%- include('../components/_input', { name: 'email',
                                          type: 'email',          // text|email|password|number|tel|url
                                          label: 'Email',
                                          value: '',
                                          required: true,
                                          autocomplete: 'username',
                                          inputmode: null,
                                          pattern: null,
                                          minlength: null,
                                          maxlength: null,
                                          autofocus: false,
                                          placeholder: null,
                                          helper: null,           // helper text below
                                          error: null,            // error text below (turns the input red)
                                          showHideToggle: false   // password show/hide button (only meaningful for type=password)
                                        }) %>
%>
<%
  var t = (typeof type !== 'undefined') ? type : 'text';
  var v = (typeof value !== 'undefined' && value !== null) ? value : '';
  var req = (typeof required !== 'undefined') && required;
  var hasErr = (typeof error !== 'undefined') && error;
  var inputId = 'inp_' + name + '_' + Math.random().toString(36).slice(2, 8);
%>
<div class="input-field<%= hasErr ? ' input-field--error' : '' %>">
  <label class="input-field__label" for="<%= inputId %>"><%= label %></label>
  <div class="input-field__control">
    <input id="<%= inputId %>" name="<%= name %>" type="<%= t %>" value="<%= v %>"
      <% if (req) { %>required<% } %>
      <% if (typeof autocomplete !== 'undefined' && autocomplete) { %>autocomplete="<%= autocomplete %>"<% } %>
      <% if (typeof inputmode !== 'undefined' && inputmode) { %>inputmode="<%= inputmode %>"<% } %>
      <% if (typeof pattern !== 'undefined' && pattern) { %>pattern="<%= pattern %>"<% } %>
      <% if (typeof minlength !== 'undefined' && minlength !== null) { %>minlength="<%= minlength %>"<% } %>
      <% if (typeof maxlength !== 'undefined' && maxlength !== null) { %>maxlength="<%= maxlength %>"<% } %>
      <% if (typeof autofocus !== 'undefined' && autofocus) { %>autofocus<% } %>
      <% if (typeof placeholder !== 'undefined' && placeholder) { %>placeholder="<%= placeholder %>"<% } %>
      <% if (hasErr) { %>aria-invalid="true" aria-describedby="<%= inputId %>_err"<% } else if (typeof helper !== 'undefined' && helper) { %>aria-describedby="<%= inputId %>_help"<% } %>
    >
    <% if (t === 'password' && (typeof showHideToggle !== 'undefined') && showHideToggle) { %>
      <button type="button" class="input-field__toggle" data-input="<%= inputId %>" aria-label="Show password" aria-pressed="false">·</button>
    <% } %>
  </div>
  <% if (typeof helper !== 'undefined' && helper && !hasErr) { %>
    <p class="input-field__helper" id="<%= inputId %>_help"><%= helper %></p>
  <% } %>
  <% if (hasErr) { %>
    <p class="input-field__error" id="<%= inputId %>_err" role="alert"><%= error %></p>
  <% } %>
</div>
```

The show/hide toggle wires up via a single inline `<script nonce>` shipped in the public layout — DEFER that wiring to T9 (it only matters on the login + welcome surfaces). For now the toggle button is rendered but inert; the partial passes a a11y check because the button has an accessible name.

- [ ] **Step 5: Append component CSS to `public/styles/app.src.css`**

Append the following block to `/opt/dbstudio_portal/public/styles/app.src.css` immediately before the `@tailwind base;` line. Locate the comment `/* ---- M11 component styles (filled in by Tasks 4–6) ---- */` and replace the placeholder line below it with this block:

```css
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
.btn--md { height: 40px; padding: 0 var(--s-4); font-size: var(--f-md); }
.btn--sm { height: 32px; padding: 0 var(--s-3); font-size: var(--f-sm); }
.btn--primary   { background: var(--c-moss); color: var(--c-ivory); border-color: var(--c-moss); }
.btn--primary:hover { background: var(--c-gold); border-color: var(--c-gold); color: var(--c-obsidian); }
.btn--secondary { background: var(--c-ivory); color: var(--c-obsidian); border-color: var(--c-stone); }
.btn--secondary:hover { background: var(--c-pearl); }
.btn--ghost     { background: transparent; color: var(--c-obsidian); border-color: transparent; }
.btn--ghost:hover { text-decoration: underline; text-underline-offset: 3px; }
.btn--danger    { background: var(--c-error); color: var(--c-white); border-color: var(--c-error); }
.btn--danger:hover { background: #c12626; border-color: #c12626; }
.btn:disabled, .btn[aria-busy="true"] { opacity: 0.5; pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .btn { transition: none; }
}

/* _input */
.input-field { display: flex; flex-direction: column; gap: var(--s-2); margin-block: var(--s-3); }
.input-field__label  { font-size: var(--f-sm); font-weight: 600; color: var(--fg-on-light); }
.input-field__control { position: relative; display: flex; align-items: stretch; }
.input-field__control input {
  flex: 1;
  height: 40px;
  padding: 0 var(--s-3);
  border: 1px solid var(--c-stone);
  border-radius: var(--radius-btn);
  background: var(--c-white);
  color: var(--fg-on-light);
  font-family: var(--f-body);
  font-size: var(--f-md);
  transition: border var(--dur-micro) var(--ease-expo);
}
.input-field__control input:focus { outline: none; border-color: var(--c-moss); }
.input-field__control input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.input-field--error .input-field__control input { border-color: var(--c-error); }
.input-field__toggle {
  position: absolute; right: var(--s-2); top: 50%; transform: translateY(-50%);
  width: 28px; height: 28px;
  border-radius: var(--radius-btn);
  border: 1px solid var(--c-stone);
  background: var(--c-ivory);
  color: var(--fg-on-light);
}
.input-field__helper { font-size: var(--f-xs); color: var(--fg-on-light-muted); margin: 0; }
.input-field__error  { font-size: var(--f-xs); color: var(--c-error); margin: 0; }
@media (prefers-reduced-motion: reduce) {
  .input-field__control input { transition: none; }
}
```

- [ ] **Step 6: Re-apply repo perms**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/components/_*.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo chmod 0640 /opt/dbstudio_portal/views/components/_*.ejs /opt/dbstudio_portal/public/styles/app.src.css
```

- [ ] **Step 7: Build + restart + smoke**

```bash
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin \
  /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

- [ ] **Step 8: Run tests**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: still green. The new partials aren't included by any view yet (only the stubs from T3 are referenced), so no test should regress on this commit.

- [ ] **Step 9: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add views/components/_eyebrow.ejs views/components/_alert.ejs views/components/_button.ejs views/components/_input.ejs public/styles/app.src.css
sudo -u root git commit -m "feat(m11-4): leaf component partials — eyebrow, alert, button, input

- _eyebrow: thin wrapper around the global .eyebrow rule.
- _alert: variants info/success/warn/error, sticky option, role
  derived from variant (alert for error/warn, status otherwise).
- _button: variants primary/secondary/ghost/danger, sizes md/sm,
  href falls back to <a>, disabled + busy supported, hover swap
  moss → gold.
- _input: label-above + helper + error pattern, password
  show/hide toggle button rendered (wiring shim lands in T9),
  ice focus ring, error state turns border red.

Component styles appended to app.src.css before @tailwind base;
honour prefers-reduced-motion. _alert is now full impl
(replacing the T3 stub)."
```

---

## Task 5: Container partials (card, page-header, table, breadcrumb, footer)

**Files:**
- Create: `views/components/_card.ejs`
- Create: `views/components/_page-header.ejs`
- Create: `views/components/_table.ejs`
- Create: `views/components/_breadcrumb.ejs`
- Replace: `views/components/_footer.ejs` (full impl, replacing T3 stub)
- Modify: `public/styles/app.src.css` — append component styles

- [ ] **Step 1: `_card.ejs`**

```ejs
<%# Usage:
    <%- include('../components/_card', { eyebrow: 'NDAs', title: '3 active', body: '...HTML...', footerHref: '/customer/ndas', footerLabel: 'Open →', count: 3, latestAt: '28/04/2026 14:12', unread: 1, modal: false, modalLabelledBy: null }) %>
    body may contain HTML. %>
<%
  var modal = (typeof modal !== 'undefined') && modal;
  var lab = (typeof modalLabelledBy !== 'undefined') ? modalLabelledBy : null;
%>
<article class="card<%= modal ? ' card--modal' : '' %>"
  <% if (modal) { %>role="dialog" aria-modal="true"<% } %>
  <% if (lab) { %>aria-labelledby="<%= lab %>"<% } %>>
  <% if (typeof eyebrow !== 'undefined' && eyebrow) { %>
    <p class="eyebrow card__eyebrow"><%= eyebrow %></p>
  <% } %>
  <% if (typeof title !== 'undefined' && title) { %>
    <h2 class="card__title" <% if (lab) { %>id="<%= lab %>"<% } %>><%= title %></h2>
  <% } %>
  <% if (typeof count !== 'undefined' && count !== null) { %>
    <p class="card__count">
      <span class="card__count-value"><%= count %></span>
      <% if (typeof latestAt !== 'undefined' && latestAt) { %>
        <span class="card__count-meta">updated <%= latestAt %></span>
      <% } %>
      <% if (typeof unread !== 'undefined' && unread > 0) { %>
        <span class="card__unread" aria-label="<%= unread %> unread"><%= unread %></span>
      <% } %>
    </p>
  <% } %>
  <% if (typeof body !== 'undefined' && body) { %>
    <div class="card__body"><%- body %></div>
  <% } %>
  <% if (typeof footerHref !== 'undefined' && footerHref) { %>
    <a class="card__footer" href="<%= footerHref %>"><%= footerLabel %></a>
  <% } %>
</article>
```

- [ ] **Step 2: `_page-header.ejs`**

```ejs
<%# Usage:
    <%- include('../components/_page-header', { eyebrow: 'CUSTOMERS', title: 'Acme S.L.', subtitle: 'CIF B12345678', actions: '<a class="btn btn--primary btn--md" href="...">+ New customer</a>' }) %>
    actions is raw HTML. %>
<header class="page-header">
  <% if (typeof eyebrow !== 'undefined' && eyebrow) { %>
    <p class="eyebrow"><%= eyebrow %></p>
  <% } %>
  <h1 class="page-header__title"><%= title %></h1>
  <% if (typeof subtitle !== 'undefined' && subtitle) { %>
    <p class="page-header__subtitle"><%= subtitle %></p>
  <% } %>
  <% if (typeof actions !== 'undefined' && actions) { %>
    <div class="page-header__actions"><%- actions %></div>
  <% } %>
</header>
```

- [ ] **Step 3: `_table.ejs`**

```ejs
<%# Usage:
    <%- include('../components/_table', {
      density: 'dense'|'medium',          // default 'medium'
      columns: [
        { label: 'When',   align: 'left'  },
        { label: 'Actor',  align: 'left'  },
        { label: '',       align: 'right' }
      ],
      rows: [
        { cells: ['28/04/2026 14:12', 'Bram', '<a href="...">Open</a>'] },
        ...
      ],
      emptyState: 'No audit events yet.'   // shown when rows is empty
    }) %>
    Cells with raw HTML render as raw HTML; cells with plain strings are
    HTML-escaped by EJS at the call site (use <%- %> in cell strings if
    you intentionally want HTML). %>
<%
  var density = (typeof density !== 'undefined' && density) ? density : 'medium';
%>
<% if (typeof rows !== 'undefined' && rows && rows.length) { %>
  <div class="table-wrap">
    <table class="data-table data-table--<%= density %>">
      <thead>
        <tr>
          <% columns.forEach(function(c) { %>
            <th scope="col" class="data-table__th data-table__th--<%= c.align || 'left' %>"><%= c.label %></th>
          <% }) %>
        </tr>
      </thead>
      <tbody>
        <% rows.forEach(function(r) { %>
          <tr>
            <% r.cells.forEach(function(cell, i) {
                 var align = columns[i] && columns[i].align ? columns[i].align : 'left'; %>
              <td class="data-table__td data-table__td--<%= align %>"><%- cell %></td>
            <% }) %>
          </tr>
        <% }) %>
      </tbody>
    </table>
  </div>
<% } else { %>
  <div class="data-table__empty">
    <p><%= (typeof emptyState !== 'undefined' && emptyState) ? emptyState : 'Nothing here yet.' %></p>
  </div>
<% } %>
```

- [ ] **Step 4: `_breadcrumb.ejs`**

```ejs
<%# Usage:
    <%- include('../components/_breadcrumb', { trail: [
      { label: 'Customers', href: '/admin/customers' },
      { label: 'Acme S.L.', href: '/admin/customers/abc' },
      { label: 'NDAs', href: null }                       // null href = current crumb
    ] }) %>
%>
<% if (trail && trail.length > 1) { %>
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <ol>
      <% trail.forEach(function(c, i) { %>
        <li>
          <% if (c.href && i < trail.length - 1) { %>
            <a href="<%= c.href %>"><%= c.label %></a>
            <span class="breadcrumb__sep" aria-hidden="true">›</span>
          <% } else { %>
            <span aria-current="page"><%= c.label %></span>
          <% } %>
        </li>
      <% }) %>
    </ol>
  </nav>
<% } %>
```

- [ ] **Step 5: Replace `_footer.ejs` with full impl**

```ejs
<%# Usage:
    <%- include('../components/_footer', { variant: 'dark'|'light' }) %>
    Reads portal version from a global `portalVersion` local set in server.js. %>
<%
  var v = (typeof variant !== 'undefined') ? variant : 'light';
  var ver = (typeof portalVersion !== 'undefined' && portalVersion) ? portalVersion : '';
%>
<footer class="site-footer site-footer--<%= v %>">
  <div class="container site-footer__inner">
    <p class="site-footer__brand">&copy; DB Studio</p>
    <ul class="site-footer__links">
      <li><a href="https://dbstudio.one/privacy">Privacy</a></li>
      <li><a href="https://dbstudio.one/terms">Terms</a></li>
      <li><a href="https://dbstudio.one">dbstudio.one</a></li>
    </ul>
    <% if (ver) { %><p class="site-footer__version eyebrow">portal <%= ver %></p><% } %>
  </div>
</footer>
```

The `portalVersion` local is plumbed in T6 (the chrome task). For now, the partial gracefully omits it when the local is unset.

- [ ] **Step 6: Append component CSS to `app.src.css`**

Append this block to the M11 component-styles section in `/opt/dbstudio_portal/public/styles/app.src.css` immediately after the `_input` block (and before `@tailwind base;`):

```css
/* _card */
.card {
  background: var(--c-ivory);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  padding: var(--s-6);
  display: flex; flex-direction: column; gap: var(--s-3);
  color: var(--fg-on-light);
}
.card__eyebrow { margin: 0; }
.card__title   { margin: 0; font-size: var(--f-xl); }
.card__count   { display: flex; align-items: baseline; gap: var(--s-3); margin: 0; }
.card__count-value { font-family: var(--f-display); font-size: var(--f-3xl); font-weight: 900; line-height: var(--lh-display); }
.card__count-meta  { font-size: var(--f-xs); color: var(--fg-on-light-muted); }
.card__unread {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 24px; height: 24px;
  border-radius: 999px;
  background: var(--c-moss); color: var(--c-ivory);
  font-size: var(--f-xs); font-weight: 700;
  padding: 0 var(--s-2);
}
.card__body   { color: var(--fg-on-light-muted); }
.card__footer { font-size: var(--f-sm); color: var(--c-moss); margin-top: auto; }
.card--modal {
  max-width: var(--prose);
  margin-inline: auto;
}

/* _page-header */
.page-header {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--s-2) var(--s-6);
  align-items: end;
  margin-bottom: var(--s-8);
  border-bottom: 1px solid var(--border-light);
  padding-bottom: var(--s-4);
}
.page-header .eyebrow      { grid-column: 1 / -1; margin: 0; }
.page-header__title        { grid-column: 1; margin: 0; font-size: var(--f-3xl); }
.page-header__subtitle     { grid-column: 1; margin: 0; color: var(--fg-on-light-muted); }
.page-header__actions      { grid-column: 2; grid-row: 2 / span 2; align-self: end; }
@media (max-width: 640px) {
  .page-header { grid-template-columns: 1fr; }
  .page-header__actions { grid-column: 1; grid-row: auto; }
}

/* _table */
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; }
.data-table__th {
  font-family: var(--f-mono);
  text-transform: uppercase;
  font-size: var(--f-xs);
  letter-spacing: var(--ls-upper);
  color: var(--fg-on-light-muted);
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--c-stone);
  text-align: left;
}
.data-table__th--right { text-align: right; }
.data-table__td { padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--border-light); }
.data-table__td--right { text-align: right; }
.data-table--dense  tr { height: 36px; }
.data-table--medium tr { height: 44px; }
.data-table tbody tr:nth-child(even) td { background: var(--c-pearl); }
.data-table__empty {
  padding: var(--s-8);
  text-align: center;
  color: var(--fg-on-light-muted);
  background: var(--bg-light-alt);
  border-radius: var(--radius-card);
}
@media (max-width: 768px) {
  .data-table thead { display: none; }
  .data-table tbody, .data-table tr, .data-table td { display: block; width: 100%; }
  .data-table tr { border: 1px solid var(--border-light); border-radius: var(--radius-card); padding: var(--s-3); margin-bottom: var(--s-3); height: auto !important; background: var(--c-ivory) !important; }
  .data-table td { border: 0; padding: var(--s-1) 0; }
}

/* _breadcrumb */
.breadcrumb { font-size: var(--f-sm); margin-bottom: var(--s-4); }
.breadcrumb ol { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--s-2); }
.breadcrumb a  { color: var(--fg-on-light-muted); }
.breadcrumb__sep { color: var(--c-stone); margin-inline: var(--s-2); }
.breadcrumb [aria-current="page"] { color: var(--c-obsidian); font-weight: 600; }

/* _footer */
.site-footer { padding: var(--s-8) 0; border-top: 1px solid var(--border-light); }
.site-footer--dark  { background: var(--bg-dark);  color: var(--fg-on-dark); border-color: var(--border-dark); }
.site-footer--light { background: var(--bg-light-alt); color: var(--fg-on-light); }
.site-footer__inner { display: flex; flex-wrap: wrap; gap: var(--s-4); align-items: center; }
.site-footer__brand { margin: 0; font-weight: 700; }
.site-footer__links { list-style: none; padding: 0; margin: 0; display: flex; gap: var(--s-4); }
.site-footer__links a { color: inherit; }
.site-footer__version { margin-left: auto; }
@media (max-width: 640px) {
  .site-footer__inner { flex-direction: column; align-items: flex-start; }
  .site-footer__version { margin-left: 0; }
}
```

- [ ] **Step 7: Re-apply perms, build, smoke, test**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/components/_*.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo chmod 0640 /opt/dbstudio_portal/views/components/_*.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

- [ ] **Step 8: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add views/components/_card.ejs views/components/_page-header.ejs views/components/_table.ejs views/components/_breadcrumb.ejs views/components/_footer.ejs public/styles/app.src.css
sudo -u root git commit -m "feat(m11-5): container partials — card, page-header, table, breadcrumb, footer

- _card: ivory + pearl border + card shadow, supports eyebrow/title/
  count+latestAt+unread badge/body/footer link/modal mode
  (aria-modal + aria-labelledby).
- _page-header: eyebrow + h1 + subtitle + right-aligned actions slot,
  collapses to single column under 640px.
- _table: dense (36px) and medium (44px) row variants, JetBrains Mono
  uppercase column heads, ivory/pearl striping, mobile collapses to
  per-row stacked card layout.
- _breadcrumb: chevron separators, current crumb in obsidian.
- _footer: full impl replacing the T3 stub; light + dark variants,
  reads portalVersion local (plumbed in T6)."
```

---

## Task 6: Hero + chrome partials (hero-public, top-bar, sidebar-admin, sidebar-customer)

**Files:**
- Replace: `views/components/_hero-public.ejs` (full impl, replacing T3 stub)
- Replace: `views/components/_top-bar.ejs` (full impl, replacing T3 stub)
- Replace: `views/components/_sidebar-admin.ejs` (full impl, replacing T3 stub)
- Replace: `views/components/_sidebar-customer.ejs` (full impl, replacing T3 stub)
- Modify: `server.js` — wire `portalVersion` into the global view locals; wire `nonce` for the inline scripts.
- Modify: `public/styles/app.src.css` — append chrome styles (hero, top-bar, sidebar, surface-shell, surface).

- [ ] **Step 1: Replace `_hero-public.ejs` with full impl**

```ejs
<%# Usage:
    <%- include('../components/_hero-public', { hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Sign in', lead: '...' } }) %>
%>
<section class="hero hero--public section--dark" data-reveal>
  <div class="container hero__inner">
    <a href="/" aria-label="DB Studio Portal" class="hero__logo">
      <img src="/static/brand/logo-white.png" alt="DB Studio">
    </a>
    <% if (hero.eyebrow) { %><p class="eyebrow"><%= hero.eyebrow %></p><% } %>
    <h1 class="hero__title"><%= hero.title %></h1>
    <% if (hero.lead) { %><p class="hero__lead"><%= hero.lead %></p><% } %>
  </div>
</section>
```

- [ ] **Step 2: Replace `_top-bar.ejs` with full impl**

```ejs
<%# Usage:
    <%- include('../components/_top-bar', { surface: 'admin'|'customer', user: {...}, sectionLabel: 'CUSTOMERS · ACME' }) %>
%>
<header class="top-bar" role="banner">
  <button class="top-bar__hamburger" type="button" aria-expanded="false" aria-controls="m11-sidebar" aria-label="Open navigation">
    <span></span><span></span><span></span>
  </button>
  <a href="<%= surface === 'admin' ? '/admin' : '/customer/dashboard' %>" aria-label="DB Studio Portal" class="top-bar__logo">
    <img src="/static/brand/logo-white.png" alt="DB Studio">
  </a>
  <p class="top-bar__section eyebrow"><%= sectionLabel %></p>
  <div class="top-bar__menu">
    <% if (user) { %>
      <span class="top-bar__user"><%= user.name %></span>
      <a class="top-bar__signout" href="/logout">Sign out</a>
    <% } %>
  </div>
</header>
```

- [ ] **Step 3: Replace `_sidebar-admin.ejs` with full impl**

```ejs
<%# Usage: <%- include('../components/_sidebar-admin', { active: 'customers'|'audit'|'profile' }) %> %>
<nav id="m11-sidebar" class="sidebar sidebar--admin" aria-label="Admin navigation" data-collapsed="true">
  <ul class="sidebar__list">
    <li class="sidebar__item<%= active === 'customers' ? ' sidebar__item--active' : '' %>">
      <a href="/admin/customers"<% if (active === 'customers') { %> aria-current="page"<% } %>>Customers</a>
    </li>
    <li class="sidebar__item<%= active === 'audit' ? ' sidebar__item--active' : '' %>">
      <a href="/admin/audit"<% if (active === 'audit') { %> aria-current="page"<% } %>>Audit</a>
    </li>
    <li class="sidebar__item<%= active === 'profile' ? ' sidebar__item--active' : '' %>">
      <a href="/admin/profile"<% if (active === 'profile') { %> aria-current="page"<% } %>>Profile</a>
    </li>
  </ul>
</nav>
```

- [ ] **Step 4: Replace `_sidebar-customer.ejs` with full impl**

```ejs
<%# Usage: <%- include('../components/_sidebar-customer', { active: 'dashboard'|'ndas'|... }) %> %>
<%
  var items = [
    { key: 'dashboard',           label: 'Dashboard',           href: '/customer/dashboard' },
    { key: 'ndas',                label: 'NDAs',                href: '/customer/ndas' },
    { key: 'documents',           label: 'Documents',           href: '/customer/documents' },
    { key: 'credentials',         label: 'Credentials',         href: '/customer/credentials' },
    { key: 'credential-requests', label: 'Credential requests', href: '/customer/credential-requests' },
    { key: 'invoices',            label: 'Invoices',            href: '/customer/invoices' },
    { key: 'projects',            label: 'Projects',            href: '/customer/projects' },
    { key: 'activity',            label: 'Activity',            href: '/customer/activity' },
    { key: 'profile',             label: 'Profile',             href: '/customer/profile' }
  ];
%>
<nav id="m11-sidebar" class="sidebar sidebar--customer" aria-label="Section navigation" data-collapsed="true">
  <ul class="sidebar__list">
    <% items.forEach(function(it) { %>
      <li class="sidebar__item<%= active === it.key ? ' sidebar__item--active' : '' %>">
        <a href="<%= it.href %>"<% if (active === it.key) { %> aria-current="page"<% } %>><%= it.label %></a>
      </li>
    <% }) %>
  </ul>
</nav>
```

- [ ] **Step 5: Wire `portalVersion` into global view locals (server.js)**

Locate the view-engine setup in `/opt/dbstudio_portal/server.js`. Read it first:

```bash
grep -n "view\|render\|locals\|engine" /opt/dbstudio_portal/server.js | head -30
```

Find where `@fastify/view` is registered. Add (or extend) a `defaultContext` so every render gets `portalVersion` from `package.json`. Pattern:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const portalVersion = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;

await app.register(fastifyView, {
  // ...existing options...
  defaultContext: {
    portalVersion,
    // ...any existing keys...
  }
});
```

If a `defaultContext` already exists, just add `portalVersion` to it. Make sure the `nonce` per-request hook still runs and exposes `nonce` to views (it should already — that's how the existing layouts get a nonce).

- [ ] **Step 6: Add the hamburger + show/hide-toggle inline script to the public/admin/customer layouts**

Edit `/opt/dbstudio_portal/views/layouts/public.ejs`, `admin.ejs`, and `customer.ejs`. Immediately before `</body>` add:

```ejs
  <script nonce="<%= nonce %>">
    // Hamburger toggle for sidebar.
    (function () {
      var ham = document.querySelector('.top-bar__hamburger');
      var bar = document.getElementById('m11-sidebar');
      if (!ham || !bar) return;
      ham.addEventListener('click', function () {
        var open = bar.getAttribute('data-collapsed') === 'false';
        bar.setAttribute('data-collapsed', open ? 'true' : 'false');
        ham.setAttribute('aria-expanded', open ? 'false' : 'true');
        ham.setAttribute('aria-label', open ? 'Open navigation' : 'Close navigation');
      });
    })();

    // Password show/hide toggle.
    (function () {
      document.querySelectorAll('.input-field__toggle').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-input');
          var input = document.getElementById(id);
          if (!input) return;
          var show = input.getAttribute('type') === 'password';
          input.setAttribute('type', show ? 'text' : 'password');
          btn.setAttribute('aria-pressed', show ? 'true' : 'false');
          btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        });
      });
    })();
  </script>
```

The public layout doesn't need a sidebar so the hamburger block is a no-op there (it returns early); keep the script identical across layouts for code reuse.

- [ ] **Step 7: Append chrome CSS to `app.src.css`**

Append before `@tailwind base;`:

```css
/* _hero-public */
.hero--public { padding-block: var(--s-12) var(--s-16); }
@media (min-width: 768px) { .hero--public { padding-block: var(--s-16) var(--s-24); } }
.hero__inner { max-width: var(--content); }
.hero__logo  { display: inline-block; margin-bottom: var(--s-6); }
.hero__logo img { height: 32px; width: auto; }
.hero__title { font-size: var(--f-5xl); margin: 0 0 var(--s-4); }
.hero__lead  { font-size: var(--f-lg); color: var(--fg-on-dark-muted); max-width: var(--prose); }
[data-reveal] {
  opacity: 0; transform: translateY(8px);
  transition: opacity var(--dur-reveal) var(--ease-expo), transform var(--dur-reveal) var(--ease-expo);
}
[data-reveal].is-revealed { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) {
  [data-reveal] { opacity: 1; transform: none; transition: none; }
}

/* Public form section sits beneath the hero */
.public-form { padding-block: var(--s-12); }
.public-form__inner { max-width: var(--content); margin-inline: auto; padding-inline: var(--s-6); }

/* _top-bar */
.top-bar {
  height: 64px;
  background: var(--bg-dark);
  color: var(--fg-on-dark);
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: center;
  gap: var(--s-4);
  padding: 0 var(--s-4);
  border-bottom: 1px solid var(--border-dark);
  position: sticky; top: 0; z-index: var(--z-navbar);
}
.top-bar__hamburger {
  display: inline-flex; flex-direction: column; gap: 4px;
  background: transparent; border: 0; padding: 8px; border-radius: var(--radius-btn);
  width: 36px; height: 36px;
}
.top-bar__hamburger span { display: block; height: 2px; width: 20px; background: var(--c-ivory); }
@media (min-width: 1024px) { .top-bar__hamburger { display: none; } }
.top-bar__logo img { height: 24px; width: auto; }
.top-bar__section { color: var(--fg-on-dark-muted); margin: 0; }
.top-bar__menu { display: flex; gap: var(--s-3); align-items: center; }
.top-bar__user { font-size: var(--f-sm); color: var(--fg-on-dark-muted); }
.top-bar__signout { color: var(--c-ivory); text-decoration: underline; }

/* surface-shell + sidebar + surface */
.surface-shell { display: grid; grid-template-columns: 1fr; min-height: calc(100vh - 64px - 1px); }
@media (min-width: 1024px) { .surface-shell { grid-template-columns: 240px 1fr; } }

.sidebar {
  background: var(--bg-dark);
  color: var(--fg-on-dark);
  border-right: 1px solid var(--border-dark);
  padding: var(--s-6) var(--s-3);
  font-family: var(--f-body);
}
.sidebar[data-collapsed="true"] { display: none; }
@media (min-width: 1024px) {
  .sidebar, .sidebar[data-collapsed="true"] { display: block; }
}
.sidebar__list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--s-1); }
.sidebar__item a {
  display: block; padding: var(--s-2) var(--s-3);
  color: var(--fg-on-dark-muted);
  text-decoration: none;
  border-left: 2px solid transparent;
  border-radius: 0 var(--radius-btn) var(--radius-btn) 0;
}
.sidebar__item a:hover { color: var(--c-ivory); background: var(--bg-dark-alt); }
.sidebar__item--active a {
  color: var(--c-ivory);
  border-left-color: var(--c-moss);
  background: var(--bg-dark-alt);
}

.surface { padding: var(--s-8) var(--s-4); }
.surface[data-width="content"] > * { max-width: var(--content); margin-inline: auto; }
.surface[data-width="wide"]    > * { max-width: var(--container); margin-inline: auto; }
@media (min-width: 768px) { .surface { padding: var(--s-12) var(--s-8); } }
```

- [ ] **Step 8: Re-apply perms, build, smoke, test**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/components/_*.ejs /opt/dbstudio_portal/views/layouts/*.ejs /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/server.js
sudo chmod 0640 /opt/dbstudio_portal/views/components/_*.ejs /opt/dbstudio_portal/views/layouts/*.ejs /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/server.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
curl -s http://127.0.0.1:3400/login | grep -E 'class="(top-bar|sidebar|hero|public-form|site-footer)' | head -5
curl -sI http://127.0.0.1:3400/login | head -3
```

The `/login` page only uses the public layout, so it should NOT show top-bar/sidebar — only hero + public-form + footer. That confirms the layout switching correctly.

Test admin/customer chrome by hitting `/admin/customers` (will 302 to /login if not authenticated; that's still confirmation the route resolves). To confirm the chrome renders in a session, you can hand-craft a session locally or skip the live render check until T13 lands.

- [ ] **Step 9: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add views/components/_hero-public.ejs views/components/_top-bar.ejs views/components/_sidebar-admin.ejs views/components/_sidebar-customer.ejs views/layouts/ public/styles/app.src.css server.js
sudo -u root git commit -m "feat(m11-6): hero + chrome partials, plumbed portalVersion + scripts

- _hero-public: type-only obsidian hero (logo white, eyebrow,
  Satoshi 5xl headline, lead) with [data-reveal] fade-in.
- _top-bar: 64px sticky obsidian header with hamburger (lg-hidden),
  logo, section eyebrow, user name + sign-out.
- _sidebar-admin / _sidebar-customer: 240px obsidian-on-ivory
  sidebar (data-collapsed hides on <lg), active item carries
  aria-current=page + moss left-border.
- Layouts get an inline <script nonce> wiring (a) hamburger
  expand/collapse with aria-expanded/aria-label sync, (b) password
  show/hide toggle on .input-field__toggle.
- server.js: defaultContext now exposes portalVersion (read
  from package.json at boot) so _footer can render it.

Component CSS: hero, public-form, top-bar, surface-shell,
sidebar, surface (with data-width content|wide max-width
swap). Reduced-motion zeroes [data-reveal] and transitions."
```

---

## Task 7: lib/qr.js + unit tests (TDD)

**Files:**
- Create: `lib/qr.js`
- Create: `tests/unit/qr.test.js`
- Modify: `package.json` — add `qrcode` dependency

- [ ] **Step 1: Add the `qrcode` dep**

```bash
cd /opt/dbstudio_portal
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm install qrcode@^1.5.4 --save --no-fund --no-audit
git diff -- package.json package-lock.json | head -40
```

Expected: `qrcode` added to `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Write the failing tests first**

Write `/opt/dbstudio_portal/tests/unit/qr.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { renderTotpQrSvg } from '../../lib/qr.js';

const SAMPLE_URI = 'otpauth://totp/DB%20Studio:bram@roxiplus.es?secret=JBSWY3DPEHPK3PXP&issuer=DB%20Studio&algorithm=SHA1&digits=6&period=30';

describe('renderTotpQrSvg', () => {
  it('returns an SVG string with role="img" and the provided aria-label', () => {
    const svg = renderTotpQrSvg(SAMPLE_URI, { label: 'TOTP enrolment for bram@roxiplus.es' });
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="TOTP enrolment for bram@roxiplus.es"');
    expect(svg).toContain('focusable="false"');
    expect(svg).toContain('viewBox');
  });

  it('is deterministic — same URI produces identical bytes', () => {
    const a = renderTotpQrSvg(SAMPLE_URI, { label: 'a' });
    const b = renderTotpQrSvg(SAMPLE_URI, { label: 'a' });
    expect(a).toEqual(b);
  });

  it('throws on empty URI', async () => {
    await expect(async () => renderTotpQrSvg('', { label: 'x' })).rejects.toThrow(/empty|required/i);
    await expect(async () => renderTotpQrSvg(null, { label: 'x' })).rejects.toThrow();
    await expect(async () => renderTotpQrSvg(undefined, { label: 'x' })).rejects.toThrow();
  });

  it('HTML-escapes the label so attribute injection is impossible', () => {
    const svg = renderTotpQrSvg(SAMPLE_URI, { label: 'evil" onload="x' });
    expect(svg).not.toContain('onload="x"');
    expect(svg).toContain('aria-label="evil&quot; onload=&quot;x"');
  });

  it('refuses to use the otpauth URI as a label (defensive)', async () => {
    await expect(async () => renderTotpQrSvg(SAMPLE_URI, { label: SAMPLE_URI })).rejects.toThrow(/otpauth/i);
  });

  it('does not include any inline <style>', () => {
    const svg = renderTotpQrSvg(SAMPLE_URI, { label: 'x' });
    expect(svg).not.toMatch(/<style/i);
  });

  it('uses obsidian #0F0F0E on ivory #F6F3EE (matches portal palette)', () => {
    const svg = renderTotpQrSvg(SAMPLE_URI, { label: 'x' });
    expect(svg.toLowerCase()).toContain('#0f0f0e');
    expect(svg.toLowerCase()).toContain('#f6f3ee');
  });
});
```

- [ ] **Step 3: Run the tests; confirm they fail**

```bash
sudo -u portal-app /opt/dbstudio_portal/node_modules/.bin/vitest run tests/unit/qr.test.js
```

Expected: failures with "Cannot find module '../../lib/qr.js'" or similar.

- [ ] **Step 4: Implement `lib/qr.js`**

Write `/opt/dbstudio_portal/lib/qr.js`:

```js
// Server-side SVG QR rendering for TOTP enrolment surfaces.
//
// Single export. Returns a string of SVG markup with role="img" +
// aria-label injected and any inline <style> stripped (CSP cleanliness).
// The function never logs or echoes the otpauth URI.
//
// Used by views/components/_qr.ejs from:
//   GET /welcome/:token            (admin invite consume)
//   GET /customer/welcome/:token
//   GET /admin/profile/2fa/regen
//   GET /customer/profile/2fa/regen

import qrcode from 'qrcode';

const PALETTE = {
  // Obsidian on ivory: matches portal's --c-obsidian / --c-ivory tokens.
  // Slightly off-pure so the QR sits inside an ivory card without a
  // contrast break, while still scanning reliably (~17:1 luminance).
  dark:  '#0F0F0E',
  light: '#F6F3EE'
};

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {string} otpauthUri  The otpauth:// URI to encode. Never logged.
 * @param {{ label: string }} opts
 * @returns {Promise<string>} SVG markup ready to inline.
 */
export async function renderTotpQrSvg(otpauthUri, opts) {
  if (!otpauthUri || typeof otpauthUri !== 'string') {
    throw new Error('renderTotpQrSvg: otpauthUri is required and must be a non-empty string');
  }
  const label = opts && typeof opts.label === 'string' ? opts.label : '';
  if (!label) {
    throw new Error('renderTotpQrSvg: opts.label is required');
  }
  if (label.includes('otpauth://')) {
    // Defensive: callers must not pass the URI itself as the label.
    throw new Error('renderTotpQrSvg: aria-label must not contain the otpauth URI');
  }

  // qrcode.toString returns a deterministic SVG given fixed mask + EC.
  // errorCorrectionLevel 'M' is the standard for TOTP enrolment (~15%
  // damage tolerance). margin 1 keeps the QR tight inside the ivory card.
  const raw = await qrcode.toString(otpauthUri, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    color: { dark: PALETTE.dark, light: PALETTE.light }
  });

  // Strip any inline <style> the library might emit (CSP cleanliness:
  // portal does not allow style-src 'unsafe-inline').
  let svg = raw.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Inject role="img", aria-label, focusable="false". Ensure viewBox is
  // present (qrcode emits it, but be defensive).
  svg = svg.replace(/<svg([^>]*)>/i, (_, attrs) => {
    let a = attrs;
    if (!/viewBox=/.test(a)) a += ' viewBox="0 0 100 100"';
    if (!/role=/.test(a))     a += ' role="img"';
    if (!/focusable=/.test(a)) a += ' focusable="false"';
    a += ` aria-label="${escapeAttr(label)}"`;
    return `<svg${a}>`;
  });

  return svg;
}
```

- [ ] **Step 5: Run the tests; confirm they pass**

```bash
sudo -u portal-app /opt/dbstudio_portal/node_modules/.bin/vitest run tests/unit/qr.test.js
```

Expected: 7 passes, 0 fails.

The "is deterministic" test depends on `qrcode` being deterministic given fixed mask/EC; that's true for the library. If it ever flips to non-deterministic, the test catches it. If it does fail, do NOT pin a mask in the implementation — document the new behaviour and update the test to assert structural equality (e.g. same path data, regardless of attribute order) rather than byte equality.

- [ ] **Step 6: Re-apply perms**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/lib/qr.js /opt/dbstudio_portal/tests/unit/qr.test.js /opt/dbstudio_portal/package.json /opt/dbstudio_portal/package-lock.json
sudo chmod 0640 /opt/dbstudio_portal/lib/qr.js /opt/dbstudio_portal/tests/unit/qr.test.js /opt/dbstudio_portal/package.json /opt/dbstudio_portal/package-lock.json
```

- [ ] **Step 7: Smoke + full test run**

```bash
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: smoke green; full test count goes from 565 → 572 (+7 new qr tests).

- [ ] **Step 8: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add lib/qr.js tests/unit/qr.test.js package.json package-lock.json
sudo -u root git commit -m "feat(m11-7): lib/qr.js — server-side SVG QR rendering

renderTotpQrSvg(uri, { label }) wraps qrcode npm
(toString type=svg, errorCorrectionLevel=M, margin=1, obsidian-
on-ivory palette). Post-processes the returned SVG to inject
role=img, aria-label (HTML-escaped), focusable=false, viewBox;
strips any inline <style> for CSP cleanliness.

Defensive: throws on empty URI; throws if the aria-label contains
otpauth:// (catches the argument-order slip that would write the
secret into the DOM as plaintext).

7 unit tests cover SVG shape, determinism, empty URI, label
escaping, label-vs-URI guard, no-inline-style, palette match.
qrcode added as dep (~50 KB unpacked, MIT, no native modules)."
```

---

## Task 8: _qr partial (consumes lib/qr.js)

**Files:**
- Create: `views/components/_qr.ejs`
- Modify: `public/styles/app.src.css` — append `.qr-block` styles

The partial wraps a precomputed SVG string. Routes call `renderTotpQrSvg(...)` server-side and pass the result into the partial as `svgString` so the EJS render stays sync and CSP-clean.

- [ ] **Step 1: Write `views/components/_qr.ejs`**

```ejs
<%# Usage:
    var qrSvg = await renderTotpQrSvg(otpauthUri, { label: '...' });
    <%- include('../components/_qr', { svg: qrSvg, secret: '<base32 secret>' }) %>

    Renders the QR as a block, with the manual secret visible
    underneath as a paste fallback labelled "Or enter this code
    manually". The full otpauth URI is NOT rendered in the visible UI. %>
<div class="qr-block">
  <div class="qr-block__svg"><%- svg %></div>
  <p class="qr-block__fallback">
    <span class="qr-block__fallback-label">Or enter this code manually</span>
    <code class="qr-block__secret"><%= secret %></code>
  </p>
</div>
```

- [ ] **Step 2: Append `.qr-block` styles to `app.src.css`**

```css
/* _qr */
.qr-block {
  display: flex; flex-direction: column; gap: var(--s-3);
  align-items: flex-start;
  margin-block: var(--s-4);
}
.qr-block__svg {
  width: 220px; height: 220px;
  background: var(--c-ivory);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  padding: var(--s-3);
  box-shadow: var(--shadow-card);
}
.qr-block__svg svg { width: 100%; height: 100%; display: block; }
@media (max-width: 480px) {
  .qr-block__svg { width: 180px; height: 180px; }
}
.qr-block__fallback { margin: 0; font-size: var(--f-sm); color: var(--fg-on-light-muted); }
.qr-block__fallback-label { display: block; margin-bottom: var(--s-1); }
.qr-block__secret {
  font-family: var(--f-mono); font-size: var(--f-sm);
  background: var(--bg-light-alt);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-btn);
  padding: var(--s-1) var(--s-2);
  word-break: break-all; overflow-wrap: anywhere;
}
```

- [ ] **Step 3: Re-apply perms, build, smoke, test**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/components/_qr.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo chmod 0640 /opt/dbstudio_portal/views/components/_qr.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

The partial is not yet referenced by any route (T10 + T11 + T19 + T18b wire it in), so no integration tests should change. If a test happens to render a view that includes `_qr` without `svg`/`secret` locals being set, you'll see an EJS error — but no current view does that.

- [ ] **Step 4: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add views/components/_qr.ejs public/styles/app.src.css
sudo -u root git commit -m "feat(m11-8): _qr partial + scoped block styles

EJS-side partial that takes a precomputed SVG string + the manual
secret and renders the QR block with the secret visible underneath
as a paste fallback. No client JS, no data: image scheme, CSP-clean.

Routes will compute the SVG via lib/qr.js renderTotpQrSvg() in
their handler and pass it as locals.svg before rendering. Wired
into the welcome/regen surfaces in T10/T11/T19/T18b."
```

---

## Task 9: /login + /login/2fa restyled

**Files:**
- Replace: `views/public/login.ejs`
- Replace: `views/public/2fa-challenge.ejs`
- Modify: route handler(s) for `/login` and `/login/2fa` — pass `hero` local through to the layout.

- [ ] **Step 1: Find the login routes**

```bash
grep -RIn "GET.*['\"]/login\|reply.view.*login" /opt/dbstudio_portal/routes /opt/dbstudio_portal/server.js | head -20
```

Locate the file that renders `views/public/login.ejs` and the file that renders `views/public/2fa-challenge.ejs`. They are typically under `routes/public/`.

- [ ] **Step 2: Update both routes to pass a `hero` local**

In each `reply.view('public/login', { ... })` call, add (or extend) the locals to include:

```js
return reply.view('public/login', {
  // ...existing locals (csrfToken, error, etc.)...
  hero: {
    eyebrow: 'DB STUDIO PORTAL',
    title:   'Sign in',
    lead:    'Use your work email and password.'
  }
});
```

For `/login/2fa`:

```js
return reply.view('public/2fa-challenge', {
  // ...existing locals...
  hero: {
    eyebrow: 'DB STUDIO PORTAL',
    title:   'Verify it\'s you',
    lead:    'Enter the 6-digit code from your authenticator.'
  }
});
```

Pass the same `hero` object on every response branch (success render, validation-error render, rate-limited render). If a route 302-redirects, no hero is needed.

- [ ] **Step 3: Replace `views/public/login.ejs`**

```ejs
<%
  var hasErr = (typeof error !== 'undefined') && error;
%>
<% if (hasErr) { %>
  <%- include('../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="/login" autocomplete="on" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <%- include('../components/_input', {
    name: 'email', type: 'email', label: 'Email',
    autocomplete: 'username', required: true, autofocus: true
  }) %>

  <%- include('../components/_input', {
    name: 'password', type: 'password', label: 'Password',
    autocomplete: 'current-password', required: true,
    showHideToggle: true
  }) %>

  <div class="form-actions">
    <%- include('../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Sign in' }) %>
  </div>

  <p class="form-footer-link"><a href="/reset">Forgot your password?</a></p>
</form>
```

- [ ] **Step 4: Replace `views/public/2fa-challenge.ejs`**

```ejs
<%
  var hasErr = (typeof error !== 'undefined') && error;
%>
<% if (hasErr) { %>
  <%- include('../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="/login/2fa" autocomplete="off" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <input type="hidden" name="method" value="totp">

  <%- include('../components/_input', {
    name: 'totp_code', type: 'text', label: 'Six-digit code from your authenticator',
    inputmode: 'numeric', pattern: '[0-9]{6}', autocomplete: 'one-time-code',
    required: true, autofocus: true, maxlength: 6
  }) %>

  <div class="form-actions">
    <%- include('../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Verify' }) %>
  </div>
</form>

<details class="backup-fallback">
  <summary>I lost my authenticator — use a backup code</summary>
  <form method="post" action="/login/2fa" autocomplete="off" class="form-stack">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <input type="hidden" name="method" value="backup">

    <%- include('../components/_input', {
      name: 'backup_code', type: 'text', label: 'Backup code',
      autocomplete: 'off', required: true, placeholder: 'ABCDE-FGHJK'
    }) %>

    <div class="form-actions">
      <%- include('../components/_button', { variant: 'secondary', size: 'md', type: 'submit', label: 'Use backup code' }) %>
    </div>
  </form>
</details>
```

- [ ] **Step 5: Append `.form-stack`, `.form-actions`, `.form-footer-link`, `.backup-fallback` styles to `app.src.css`**

```css
/* form layout helpers used by public + admin + customer surfaces */
.form-stack { display: flex; flex-direction: column; gap: var(--s-3); }
.form-actions { display: flex; gap: var(--s-3); margin-top: var(--s-4); }
.form-footer-link { font-size: var(--f-sm); margin-top: var(--s-3); }
.backup-fallback { margin-top: var(--s-6); font-size: var(--f-sm); }
.backup-fallback summary { cursor: pointer; color: var(--c-moss); }
.backup-fallback[open] summary { margin-bottom: var(--s-3); }
```

- [ ] **Step 6: Re-apply perms, build, restart, smoke, test, manual check**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/public/login.ejs /opt/dbstudio_portal/views/public/2fa-challenge.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo chmod 0640 /opt/dbstudio_portal/views/public/login.ejs /opt/dbstudio_portal/views/public/2fa-challenge.ejs /opt/dbstudio_portal/public/styles/app.src.css
# also re-apply perms on whichever route file you edited:
sudo chown root:portal-app /opt/dbstudio_portal/routes/public/<file>.js
sudo chmod 0640 /opt/dbstudio_portal/routes/public/<file>.js

sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

# Manual: confirm the rendered /login page contains both new chrome and form
curl -s http://127.0.0.1:3400/login | grep -E 'class="(hero|public-form|input-field|btn--primary|site-footer)' | head -8
```

Expected: smoke green, tests green (any test asserting on the previous `<section class="auth">` markup needs updating to the new partial structure — search for `class="auth"` in the test suite and replace assertions to match the new components).

- [ ] **Step 7: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add views/public/login.ejs views/public/2fa-challenge.ejs public/styles/app.src.css routes/public/
sudo -u root git commit -m "feat(m11-9): /login and /login/2fa restyled

login: hero + form-card with email + password (show/hide toggle)
+ primary submit + forgot-password link. 2fa: hero + TOTP form
+ backup-code fallback in <details>. Both pass the appropriate
hero locals through routes/public/<handler>.js.

Form layout helpers (form-stack, form-actions, form-footer-link,
backup-fallback) appended to app.src.css. Tests updated to assert
on _input/_button/_alert markup instead of the old <section class=auth>."
```

---

## Task 10: /welcome/:token (admin invite) restyled with QR

**Files:**
- Replace: `views/public/welcome.ejs` and any sibling pieces (e.g. `2fa-enrol.ejs` if separate).
- Modify: the route handler for `GET /welcome/:token` to compute the QR SVG server-side and pass it through.

- [ ] **Step 1: Find the route handler**

```bash
grep -RIn "GET.*['\"]/welcome\|reply.view.*welcome" /opt/dbstudio_portal/routes/public /opt/dbstudio_portal/server.js | head -10
```

Locate the route that renders the admin welcome view. The token is consumed via `domain/admins/service.js`. The view receives locals like `enrolSecret`, `otpauthUri`, `name`, `email`, `csrfToken`, `action`, `submitLabel`.

- [ ] **Step 2: Compute the QR SVG in the handler**

Update the handler to:

```js
import { renderTotpQrSvg } from '../../lib/qr.js';

// ...inside the handler, after the welcome data is loaded:
const qrSvg = await renderTotpQrSvg(otpauthUri, {
  label: `TOTP enrolment for ${admin.email}`
});

return reply.view('public/welcome', {
  csrfToken,
  action,
  submitLabel,
  name: admin.name,
  email: admin.email,
  enrolSecret,
  qrSvg,
  hero: {
    eyebrow: 'DB STUDIO PORTAL',
    title:   `Welcome to the portal, ${admin.name}`,
    lead:    'Set a password and register an authenticator app to finish setup.'
  }
});
```

The handler must NOT pass `otpauthUri` to the view any longer — the URI is fully encoded inside the QR; rendering it visibly is exactly the bug M11 is fixing.

If `welcome.ejs` is split into a two-step flow (e.g. step-1 password then step-2 TOTP enrol), apply the change on the step that shows the TOTP enrolment.

- [ ] **Step 3: Replace `views/public/welcome.ejs`**

```ejs
<%
  var hasErr = (typeof error !== 'undefined') && error;
%>
<% if (hasErr) { %>
  <%- include('../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="<%= action %>" autocomplete="off" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <fieldset class="fieldset-stack">
    <legend class="eyebrow">Step 1 — Set a password</legend>
    <%- include('../components/_input', {
      name: 'password', type: 'password', label: 'New password',
      autocomplete: 'new-password', required: true, minlength: 12,
      helper: 'At least 12 characters. Will be checked against known-breached passwords.',
      showHideToggle: true
    }) %>
  </fieldset>

  <fieldset class="fieldset-stack">
    <legend class="eyebrow">Step 2 — Register your authenticator</legend>
    <p>Scan this QR with your authenticator app (Authy, 1Password, Google Authenticator, Bitwarden), then enter the 6-digit code below.</p>
    <%- include('../components/_qr', { svg: qrSvg, secret: enrolSecret }) %>
    <%- include('../components/_input', {
      name: 'totp_code', type: 'text', label: 'Six-digit code from your authenticator',
      inputmode: 'numeric', pattern: '[0-9]{6}', autocomplete: 'one-time-code',
      required: true, maxlength: 6
    }) %>
  </fieldset>

  <div class="form-actions">
    <%- include('../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: submitLabel }) %>
  </div>
</form>
```

- [ ] **Step 4: Append `.fieldset-stack` styles**

```css
/* fieldset-stack used by multi-step welcome / reset / profile forms */
.fieldset-stack { border: 0; padding: 0; margin: 0 0 var(--s-6); display: flex; flex-direction: column; gap: var(--s-3); }
.fieldset-stack legend { padding: 0; }
.fieldset-stack p { color: var(--fg-on-light-muted); margin: 0 0 var(--s-3); }
```

- [ ] **Step 5: Verify the handler is async + the fastify-view engine awaits the locals**

If `reply.view` doesn't already accept a Promise as a local, the handler must `await` the QR before calling `reply.view`. The pattern in the example above (`const qrSvg = await renderTotpQrSvg(...)` before the `reply.view`) is correct and matches Fastify-async style.

- [ ] **Step 6: Re-apply perms, build, restart, smoke, test**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/public/welcome.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo chmod 0640 /opt/dbstudio_portal/views/public/welcome.ejs /opt/dbstudio_portal/public/styles/app.src.css
# also the route handler file
sudo chown root:portal-app /opt/dbstudio_portal/routes/public/<welcome-handler>.js
sudo chmod 0640 /opt/dbstudio_portal/routes/public/<welcome-handler>.js

sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Tests likely affected: any integration test that asserts on welcome.ejs body content (`enrolSecret as <code>`, `otpauthUri as <code>`). Update those to assert `<svg role="img"` and `<code class="qr-block__secret">` instead. The route logic test for `welcome.consume` is unchanged (POST behaviour identical).

- [ ] **Step 7: Commit**

```bash
cd /opt/dbstudio_portal
sudo -u root git add views/public/welcome.ejs public/styles/app.src.css routes/public/
sudo -u root git commit -m "feat(m11-10): /welcome/:token restyled with server-side QR

Admin welcome flow now renders the QR via lib/qr.js + _qr partial.
Manual secret stays visible underneath as a paste fallback for
desktop authenticators. The full otpauth:// URI is no longer
rendered in the visible UI — it is encoded inside the QR and never
echoed to the response body.

Route handler computes the QR SVG with renderTotpQrSvg before
rendering the view (label = 'TOTP enrolment for <admin.email>').
View structure: 2 fieldsets (password + authenticator) + submit.

Tests updated to assert on <svg role=img and the qr-block__secret
fallback line. Route POST behaviour is unchanged."
```

---

## Task 11: /customer/welcome/:token restyled with QR

**Files:**
- Replace: `views/customer/onboarding/welcome.ejs` (or wherever the customer welcome view lives — locate via `find /opt/dbstudio_portal/views/customer -name '*.ejs'`).
- Modify: the route handler for `GET /customer/welcome/:token` (likely under `routes/customer/onboarding.js`).

- [ ] **Step 1: Locate the customer welcome view + route**

```bash
find /opt/dbstudio_portal/views/customer -name '*.ejs' | xargs grep -l welcome 2>/dev/null
grep -RIn "/customer/welcome\|customer.*welcome\|reply.view.*customer/onboarding" /opt/dbstudio_portal/routes/customer 2>/dev/null | head -10
```

- [ ] **Step 2: Update the handler — same shape as T10**

```js
import { renderTotpQrSvg } from '../../lib/qr.js';

// inside the customer welcome handler:
const qrSvg = await renderTotpQrSvg(otpauthUri, {
  label: `TOTP enrolment for ${customerUser.email}`
});

return reply.view('customer/onboarding/welcome', {
  csrfToken,
  action,
  submitLabel,
  name: customerUser.name,
  email: customerUser.email,
  customerName: customer.razon_social,
  enrolSecret,
  qrSvg,
  hero: {
    eyebrow: 'DB STUDIO PORTAL',
    title:   `Welcome to the DB Studio portal, ${customerUser.name}`,
    lead:    `${customer.razon_social}. Set a password and register an authenticator app to finish setup.`
  }
});
```

- [ ] **Step 3: Replace the customer welcome view body**

```ejs
<%
  var hasErr = (typeof error !== 'undefined') && error;
%>
<% if (hasErr) { %>
  <%- include('../../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="<%= action %>" autocomplete="off" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <fieldset class="fieldset-stack">
    <legend class="eyebrow">Step 1 — Set a password</legend>
    <%- include('../../components/_input', {
      name: 'password', type: 'password', label: 'New password',
      autocomplete: 'new-password', required: true, minlength: 12,
      helper: 'At least 12 characters. Will be checked against known-breached passwords.',
      showHideToggle: true
    }) %>
  </fieldset>

  <fieldset class="fieldset-stack">
    <legend class="eyebrow">Step 2 — Register your authenticator</legend>
    <p>Scan this QR with your authenticator app, then enter the 6-digit code below.</p>
    <%- include('../../components/_qr', { svg: qrSvg, secret: enrolSecret }) %>
    <%- include('../../components/_input', {
      name: 'totp_code', type: 'text', label: 'Six-digit code from your authenticator',
      inputmode: 'numeric', pattern: '[0-9]{6}', autocomplete: 'one-time-code',
      required: true, maxlength: 6
    }) %>
  </fieldset>

  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: submitLabel }) %>
  </div>
</form>
```

The relative path is `../../components/...` here because customer welcome views typically live at `views/customer/onboarding/welcome.ejs` (one level deeper than admin's `views/public/welcome.ejs`). Verify the path matches your tree.

- [ ] **Step 4: Build, restart, smoke, test, commit**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/customer/onboarding/welcome.ejs /opt/dbstudio_portal/routes/customer/onboarding.js
sudo chmod 0640 /opt/dbstudio_portal/views/customer/onboarding/welcome.ejs /opt/dbstudio_portal/routes/customer/onboarding.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add views/customer/onboarding/welcome.ejs routes/customer/onboarding.js
sudo -u root git commit -m "feat(m11-11): /customer/welcome/:token restyled with server-side QR

Customer onboarding flow mirrors the admin welcome (m11-10) — same
2-fieldset layout, same _qr partial wired through the lib/qr.js
helper. Hero copy customised: eyebrow + 'Welcome to the DB Studio
portal, <name>' + lead carrying the customer's razón social.

The full otpauth:// URI is no longer in the response body."
```

---

## Task 12: /reset/:token + /logout + 4xx + backup-codes restyled

**Files:**
- Replace: `views/public/reset.ejs` (currently a 26-byte stub — flesh it out).
- Replace: `views/public/2fa-enrol.ejs` (the existing backup-codes display) and any sibling backup-codes view used post-enrolment.
- Replace: `views/public/welcome-invalid.ejs` (the 410-style page).
- Create or replace: `views/public/logout.ejs` (logout confirmation), `views/public/error-404.ejs`, `views/public/error-410.ejs`, `views/public/error-429.ejs` (only those that don't already exist; check first).
- Modify: route handlers to pass `hero` locals where missing.

- [ ] **Step 1: Inventory existing pages**

```bash
ls -la /opt/dbstudio_portal/views/public/
grep -RIn "error-404\|error-410\|error-429\|reply.view.*error\|setNotFound\|reply.callNotFound" /opt/dbstudio_portal/routes /opt/dbstudio_portal/server.js | head -20
```

Decide which pages already render a view vs which inherit Fastify's default error pages. For T12, restyle existing public pages and create restyled views only for the public-facing 4xx pages that already render a view.

- [ ] **Step 2: Replace `views/public/reset.ejs`**

```ejs
<% if (typeof error !== 'undefined' && error) { %>
  <%- include('../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="<%= action %>" autocomplete="off" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <%- include('../components/_input', {
    name: 'password', type: 'password', label: 'New password',
    autocomplete: 'new-password', required: true, minlength: 12,
    helper: 'At least 12 characters. Will be checked against known-breached passwords.',
    showHideToggle: true
  }) %>

  <%- include('../components/_input', {
    name: 'password_confirm', type: 'password', label: 'Confirm new password',
    autocomplete: 'new-password', required: true, minlength: 12,
    showHideToggle: true
  }) %>

  <div class="form-actions">
    <%- include('../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Update password' }) %>
  </div>
</form>
```

In the route handler for `GET /reset/:token`, add `hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Reset your password', lead: 'Pick a new password to sign in.' }` to the view locals.

- [ ] **Step 3: Replace `views/public/2fa-enrol.ejs` (the backup-codes display)**

```ejs
<%- include('../components/_alert', { variant: 'warn', body: 'You will not see these codes again. Store them in your password manager. Each code works once if you lose access to your authenticator.' }) %>

<ul class="backup-codes">
  <% codes.forEach(function(code) { %>
    <li><code><%= code %></code></li>
  <% }) %>
</ul>

<div class="form-actions">
  <%- include('../components/_button', { variant: 'primary', size: 'md', href: '/login', label: 'I have saved my codes — continue to sign in' }) %>
</div>
```

In the route handler that renders this view, set:

```js
hero: {
  eyebrow: 'DB STUDIO PORTAL',
  title:   'Save your backup codes',
  lead:    'Each code works once. Store them in your password manager.'
}
```

Append `.backup-codes` styles to `app.src.css`:

```css
.backup-codes {
  list-style: none; padding: 0; margin: var(--s-4) 0;
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-2) var(--s-4);
}
.backup-codes li code {
  font-family: var(--f-mono);
  font-size: var(--f-md);
  background: var(--bg-light-alt);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-btn);
  padding: var(--s-2) var(--s-3);
  display: block; text-align: center;
}
@media (max-width: 480px) {
  .backup-codes { grid-template-columns: 1fr; }
}
```

- [ ] **Step 4: Replace `views/public/welcome-invalid.ejs`**

```ejs
<%- include('../components/_alert', { variant: 'warn', body: 'This invitation link is no longer valid. It may have been used already or expired.' }) %>

<p>If you believe this is wrong, contact your account manager and request a new invite.</p>

<div class="form-actions">
  <%- include('../components/_button', { variant: 'secondary', size: 'md', href: '/login', label: 'Back to sign in' }) %>
</div>
```

The route that renders this view should pass `hero: { eyebrow: 'DB STUDIO PORTAL', title: 'This link has expired', lead: null }`.

- [ ] **Step 5: Logout confirmation**

If `views/public/logout.ejs` doesn't exist, create it:

```ejs
<%- include('../components/_alert', { variant: 'success', body: 'You are signed out of the portal.' }) %>

<p>Sign in again or close this tab.</p>

<div class="form-actions">
  <%- include('../components/_button', { variant: 'primary', size: 'md', href: '/login', label: 'Sign in again' }) %>
</div>
```

If a logout route already 302-redirects to `/login` and you don't want to add a confirmation page, skip this — but the spec calls for one (post-redirect cooldown surface). Pick whichever pattern the existing logout route uses; do not change route logic in T12.

If you do add the view, also add the route handler render call with `hero: { eyebrow: 'DB STUDIO PORTAL', title: 'Signed out', lead: 'You are signed out of the portal.' }`.

- [ ] **Step 6: 4xx public pages**

If `routes/public/*` already renders custom 404/410/429 views, restyle them to the same pattern (alert + brief explanation + back-to-sign-in button). If they currently fall through to Fastify defaults, leave them — adding 4xx views is out of M11 scope.

A reasonable shared template if needed:

```ejs
<%- include('../components/_alert', { variant: variant, body: alertBody }) %>
<p><%- bodyText %></p>
<div class="form-actions">
  <%- include('../components/_button', { variant: 'secondary', size: 'md', href: '/login', label: 'Back to sign in' }) %>
</div>
```

- [ ] **Step 7: Build, restart, smoke, test, commit**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/public/*.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo chmod 0640 /opt/dbstudio_portal/views/public/*.ejs /opt/dbstudio_portal/public/styles/app.src.css
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add views/public/ public/styles/app.src.css routes/public/
sudo -u root git commit -m "feat(m11-12): /reset, /logout, welcome-invalid, backup-codes restyled

- /reset/:token: full password + confirm-password form via _input.
- backup-codes view: warn alert + 2x5 monospace grid + 'continue
  to sign in' primary button.
- welcome-invalid: 410-style page with warn alert + back-to-sign-in.
- /logout confirmation page (if route added).

Hero locals filled in for every restyled page. .backup-codes
grid styles appended to app.src.css. No 4xx page beyond what
already renders a custom view — adding new ones is out of M11 scope."
```

**At this point Tasks 1–12 are landed. The portal's public surface is fully restyled, the operator can complete welcome onboarding (QR + password + TOTP + backup codes), and the bootstrap admin can land on a styled — but not yet restyled — admin dashboard. Subsequent tasks restyle the post-login surfaces.**

---

## Task 13: /admin/customers list + new + detail/edit + sub-tabs

**Files:**
- Replace: `views/admin/customers/list.ejs`
- Replace: `views/admin/customers/new.ejs`
- Replace: `views/admin/customers/detail.ejs` (or `edit.ejs` — whatever the existing tree has)
- Replace: `views/admin/customers/created.ejs` (the post-create confirmation page if it exists)
- Replace: `views/admin/customers/not-found.ejs` (404 within admin)
- Create: `views/components/_admin-customer-tabs.ejs` (sub-tab strip used on the customer detail + each sub-route page)
- Modify: `routes/admin/customers.js` — pass `activeNav: 'customers'`, `mainWidth`, and `sectionLabel` locals.

- [ ] **Step 1: Inventory existing admin customer views**

```bash
ls -la /opt/dbstudio_portal/views/admin/customers/
grep -RIn "reply.view.*admin/customers" /opt/dbstudio_portal/routes/admin | head -30
```

- [ ] **Step 2: Create the sub-tab partial**

Write `/opt/dbstudio_portal/views/components/_admin-customer-tabs.ejs`:

```ejs
<%# Usage:
    <%- include('../components/_admin-customer-tabs', {
      customerId: '...uuid...',
      active: 'edit'|'ndas'|'documents'|'credentials'|'credential-requests'|'invoices'|'projects'|'users'
    }) %>
%>
<%
  var tabs = [
    { key: 'edit',                label: 'Edit',                href: '/admin/customers/' + customerId },
    { key: 'ndas',                label: 'NDAs',                href: '/admin/customers/' + customerId + '/ndas' },
    { key: 'documents',           label: 'Documents',           href: '/admin/customers/' + customerId + '/documents' },
    { key: 'credentials',         label: 'Credentials',         href: '/admin/customers/' + customerId + '/credentials' },
    { key: 'credential-requests', label: 'Credential requests', href: '/admin/customers/' + customerId + '/credential-requests' },
    { key: 'invoices',            label: 'Invoices',            href: '/admin/customers/' + customerId + '/invoices' },
    { key: 'projects',            label: 'Projects',            href: '/admin/customers/' + customerId + '/projects' },
    { key: 'users',               label: 'Customer users',      href: '/admin/customers/' + customerId + '/users' }
  ];
%>
<nav class="subtabs" aria-label="Customer sections">
  <ul>
    <% tabs.forEach(function(t) { %>
      <li class="subtabs__item<%= active === t.key ? ' subtabs__item--active' : '' %>">
        <a href="<%= t.href %>"<% if (active === t.key) { %> aria-current="page"<% } %>><%= t.label %></a>
      </li>
    <% }) %>
  </ul>
</nav>
```

Append `.subtabs` styles to `app.src.css`:

```css
.subtabs { margin-bottom: var(--s-6); border-bottom: 1px solid var(--border-light); }
.subtabs ul { display: flex; flex-wrap: wrap; gap: var(--s-3); list-style: none; padding: 0; margin: 0; }
.subtabs__item a {
  display: inline-block;
  font-family: var(--f-mono);
  text-transform: uppercase;
  font-size: var(--f-xs);
  letter-spacing: var(--ls-upper);
  color: var(--fg-on-light-muted);
  padding: var(--s-3) var(--s-1);
  border-bottom: 2px solid transparent;
  text-decoration: none;
}
.subtabs__item a:hover { color: var(--c-obsidian); }
.subtabs__item--active a { color: var(--c-obsidian); border-bottom-color: var(--c-moss); font-weight: 600; }
```

- [ ] **Step 3: Replace `views/admin/customers/list.ejs`**

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN',
  title: 'Customers',
  actions: '<a class="btn btn--primary btn--md" href="/admin/customers/new">+ New customer</a>'
}) %>

<form method="get" action="/admin/customers" class="form-inline" role="search">
  <%- include('../../components/_input', {
    name: 'q', type: 'text', label: 'Search by razón social or CIF',
    value: typeof q !== 'undefined' ? q : '', autocomplete: 'off'
  }) %>
  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'secondary', size: 'md', type: 'submit', label: 'Search' }) %>
  </div>
</form>

<%
  var rows = (customers || []).map(function(c) {
    return { cells: [
      c.razon_social || '',
      c.nif || '',
      typeof euDate === 'function' ? euDate(c.created_at) : c.created_at,
      typeof euDateTime === 'function' && c.last_activity_at ? euDateTime(c.last_activity_at) : '',
      '<a class="btn btn--ghost btn--sm" href="/admin/customers/' + c.id + '">Open →</a>'
    ]};
  });
%>
<%- include('../../components/_table', {
  density: 'medium',
  columns: [
    { label: 'Razón social',  align: 'left'  },
    { label: 'CIF',           align: 'left'  },
    { label: 'Created',       align: 'left'  },
    { label: 'Last activity', align: 'left'  },
    { label: '',              align: 'right' }
  ],
  rows: rows,
  emptyState: 'No customers yet.'
}) %>

<% if (typeof pagination !== 'undefined' && pagination) { %>
  <nav class="pagination" aria-label="Pagination">
    <% if (pagination.prevHref) { %><a class="btn btn--ghost btn--sm" href="<%= pagination.prevHref %>">← Previous</a><% } %>
    <span class="eyebrow"><%= pagination.label %></span>
    <% if (pagination.nextHref) { %><a class="btn btn--ghost btn--sm" href="<%= pagination.nextHref %>">Next →</a><% } %>
  </nav>
<% } %>
```

`euDate` / `euDateTime` are exposed via the existing locals plumbing (they live in `lib/dates.js` and are already a default context helper — verify with `grep euDateTime /opt/dbstudio_portal/server.js`; if not exposed, add them to `defaultContext` in T6's view-engine setup before this task lands).

Append `.form-inline` and `.pagination` styles to `app.src.css`:

```css
.form-inline { display: flex; gap: var(--s-3); align-items: end; flex-wrap: wrap; margin-bottom: var(--s-6); }
.form-inline .input-field { flex: 1 1 240px; margin: 0; }
.pagination { display: flex; gap: var(--s-3); align-items: center; justify-content: center; padding-block: var(--s-6); }
.pagination .eyebrow { margin: 0; }
```

- [ ] **Step 4: Replace `views/admin/customers/new.ejs`**

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: 'New customer'
}) %>

<% if (typeof error !== 'undefined' && error) { %>
  <%- include('../../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="/admin/customers" autocomplete="off" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <%- include('../../components/_input', { name: 'razon_social', type: 'text', label: 'Razón social', required: true, value: typeof draft !== 'undefined' ? (draft.razon_social || '') : '' }) %>
  <%- include('../../components/_input', { name: 'nif',          type: 'text', label: 'CIF / NIF',     required: true, value: typeof draft !== 'undefined' ? (draft.nif || '') : '' }) %>
  <%- include('../../components/_input', { name: 'country',      type: 'text', label: 'Country',       required: true, value: typeof draft !== 'undefined' ? (draft.country || 'ES') : 'ES' }) %>
  <%- include('../../components/_input', { name: 'contact_name', type: 'text', label: 'Primary contact name',  required: true, value: typeof draft !== 'undefined' ? (draft.contact_name || '') : '' }) %>
  <%- include('../../components/_input', { name: 'contact_email', type: 'email', label: 'Primary contact email', required: true, autocomplete: 'email', value: typeof draft !== 'undefined' ? (draft.contact_email || '') : '' }) %>

  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Create customer' }) %>
    <%- include('../../components/_button', { variant: 'ghost',   size: 'md', href: '/admin/customers', label: 'Cancel' }) %>
  </div>
</form>
```

The exact form fields should match the existing `routes/admin/customers.js` POST handler's expected body shape. If the existing form had additional fields (representante_*, address, etc.), preserve them — only swap to `_input` partials.

- [ ] **Step 5: Replace `views/admin/customers/detail.ejs` (or whatever the existing edit view is named)**

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: customer.razon_social,
  subtitle: 'CIF ' + (customer.nif || '—')
}) %>

<%- include('../../components/_admin-customer-tabs', { customerId: customer.id, active: 'edit' }) %>

<% if (typeof flash !== 'undefined' && flash) { %>
  <%- include('../../components/_alert', { variant: flash.variant, body: flash.body }) %>
<% } %>

<form method="post" action="/admin/customers/<%= customer.id %>" autocomplete="off" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <%- include('../../components/_input', { name: 'razon_social',   type: 'text',  label: 'Razón social',  required: true, value: customer.razon_social || '' }) %>
  <%- include('../../components/_input', { name: 'nif',            type: 'text',  label: 'CIF / NIF',     required: true, value: customer.nif || '' }) %>
  <%- include('../../components/_input', { name: 'country',        type: 'text',  label: 'Country',       required: true, value: customer.country || '' }) %>
  <%- include('../../components/_input', { name: 'representante_nombre', type: 'text', label: 'Representante — nombre', value: customer.representante_nombre || '' }) %>
  <%- include('../../components/_input', { name: 'representante_dni',    type: 'text', label: 'Representante — DNI',    value: customer.representante_dni || '' }) %>
  <%- include('../../components/_input', { name: 'representante_cargo',  type: 'text', label: 'Representante — cargo',  value: customer.representante_cargo || '' }) %>

  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Save changes' }) %>
  </div>
</form>

<section class="status-actions">
  <h2>Customer status</h2>
  <p>Current: <strong><%= customer.status %></strong></p>
  <div class="form-actions">
    <% if (customer.status === 'active') { %>
      <form method="post" action="/admin/customers/<%= customer.id %>/suspend" class="form-inline-action">
        <input type="hidden" name="_csrf" value="<%= csrfToken %>">
        <%- include('../../components/_button', { variant: 'secondary', size: 'sm', type: 'submit', label: 'Suspend' }) %>
      </form>
    <% } else if (customer.status === 'suspended') { %>
      <form method="post" action="/admin/customers/<%= customer.id %>/reactivate" class="form-inline-action">
        <input type="hidden" name="_csrf" value="<%= csrfToken %>">
        <%- include('../../components/_button', { variant: 'secondary', size: 'sm', type: 'submit', label: 'Reactivate' }) %>
      </form>
    <% } %>
    <% if (customer.status !== 'archived') { %>
      <form method="post" action="/admin/customers/<%= customer.id %>/archive" class="form-inline-action">
        <input type="hidden" name="_csrf" value="<%= csrfToken %>">
        <%- include('../../components/_button', { variant: 'danger', size: 'sm', type: 'submit', label: 'Archive' }) %>
      </form>
    <% } %>
  </div>
</section>
```

Append a small style:

```css
.status-actions { margin-top: var(--s-12); padding-top: var(--s-6); border-top: 1px solid var(--border-light); }
.form-inline-action { display: inline-flex; }
```

- [ ] **Step 6: Replace `views/admin/customers/created.ejs` (post-create confirmation)**

If this file exists (M5 plumbed it), restyle:

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: 'Customer created'
}) %>

<%- include('../../components/_alert', { variant: 'success', body: 'The customer has been created and an invitation email has been queued for the primary contact.' }) %>

<div class="card">
  <p class="eyebrow">Belt-and-braces invite URL</p>
  <p>If the email never lands, share this URL with the contact directly. It is single-use and expires in 7 days.</p>
  <p><code><%= inviteUrl %></code></p>
</div>

<div class="form-actions">
  <%- include('../../components/_button', { variant: 'primary', size: 'md', href: '/admin/customers/' + customer.id, label: 'Open customer' }) %>
  <%- include('../../components/_button', { variant: 'ghost',   size: 'md', href: '/admin/customers', label: 'Back to customers' }) %>
</div>
```

- [ ] **Step 7: Replace `views/admin/customers/not-found.ejs` if it exists**

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: 'Customer not found'
}) %>

<%- include('../../components/_alert', { variant: 'warn', body: 'No customer matches that identifier.' }) %>

<div class="form-actions">
  <%- include('../../components/_button', { variant: 'secondary', size: 'md', href: '/admin/customers', label: 'Back to customers' }) %>
</div>
```

- [ ] **Step 8: Update routes to pass `activeNav` + `mainWidth` + `sectionLabel`**

In `routes/admin/customers.js`, every `reply.view('admin/customers/<page>', { ... })` call gets new locals:

```js
return reply.view('admin/customers/list', {
  // ...existing locals...
  activeNav: 'customers',
  mainWidth: 'wide',                                  // list pages
  sectionLabel: 'ADMIN · CUSTOMERS',
  user: request.session && request.session.admin ? { name: request.session.admin.name } : null
});
```

For form pages (new, detail, created, not-found):

```js
return reply.view('admin/customers/new', {
  // ...
  activeNav: 'customers',
  mainWidth: 'content',                               // form pages
  sectionLabel: 'ADMIN · CUSTOMERS',
  user: { name: request.session.admin.name }
});
```

- [ ] **Step 9: Build, restart, smoke, test, commit**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/admin/customers/*.ejs /opt/dbstudio_portal/views/components/_admin-customer-tabs.ejs /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/admin/customers.js
sudo chmod 0640 /opt/dbstudio_portal/views/admin/customers/*.ejs /opt/dbstudio_portal/views/components/_admin-customer-tabs.ejs /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/admin/customers.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add views/admin/customers/ views/components/_admin-customer-tabs.ejs public/styles/app.src.css routes/admin/customers.js
sudo -u root git commit -m "feat(m11-13): admin customers — list/new/detail/created restyled, sub-tab strip

- list.ejs: page-header + search form + medium-density table +
  pagination row.
- new.ejs: form-stack of _input partials + create/cancel actions.
- detail.ejs: page-header + _admin-customer-tabs (active=edit) +
  edit form + status transition action group.
- created.ejs / not-found.ejs: alert + back-to-list actions.
- _admin-customer-tabs.ejs: shared sub-tab strip (Edit · NDAs ·
  Documents · Credentials · Credential requests · Invoices ·
  Projects · Customer users) used across the customer detail
  and per-customer subroutes.
- routes/admin/customers.js: pass activeNav, mainWidth, sectionLabel,
  user to every reply.view call. mainWidth=wide for list, content
  for form pages."
```

---

## Task 14: Admin per-customer subroutes restyled (NDAs, Documents, Credentials, Credential-requests, Invoices, Projects, Users)

This task restyles all 7 per-customer admin subroute pages in one commit (small EJS edits per file, all share the same shape: page-header + sub-tab strip + section-specific table or form).

**Files (replace all):**
- `views/admin/ndas/*.ejs` (list + new + detail)
- `views/admin/documents/*.ejs` (list + new — upload form)
- `views/admin/credentials/*.ejs` (list + new + edit + view-modal)
- `views/admin/credential-requests/*.ejs` (list + new + detail)
- `views/admin/invoices/*.ejs` (list + new — upload form)
- `views/admin/projects/*.ejs` (list + new + detail + edit)
- `views/admin/customers/users/*.ejs` (list + new — invite-user form)

**Routes to modify:** every `reply.view(...)` call in `routes/admin/{ndas,documents,credentials,credential-requests,invoices,projects,customers}.js` to pass `activeNav: 'customers'`, `mainWidth`, `sectionLabel`, `user`.

The shape is repetitive. Below is the canonical template for a list page; each list page in this task follows the same shape with the data-source columns swapped:

- [ ] **Step 1: Inventory existing views**

```bash
find /opt/dbstudio_portal/views/admin -name '*.ejs' -not -path '*customers/*' | sort
ls -la /opt/dbstudio_portal/views/admin/customers/users/ 2>/dev/null
```

If `views/admin/customers/users/` doesn't exist yet, the existing user-management view lives elsewhere (search with `grep -RIn "customer.*users\|customer_users" /opt/dbstudio_portal/views/admin`). Adapt paths to match.

- [ ] **Step 2: Apply the canonical list-page template per surface**

The template (replace cells/columns/empty-state per surface):

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
  title: '<NDAs|Documents|Credentials|Credential requests|Invoices|Projects|Customer users>',
  actions: '<a class="btn btn--primary btn--md" href="/admin/customers/' + customer.id + '/<surface>/new">+ New <surface-singular></a>'
}) %>

<%- include('../../components/_admin-customer-tabs', { customerId: customer.id, active: '<surface-key>' }) %>

<% if (typeof flash !== 'undefined' && flash) { %>
  <%- include('../../components/_alert', { variant: flash.variant, body: flash.body }) %>
<% } %>

<%
  var rows = (items || []).map(function(it) {
    return { cells: [
      // surface-specific cells
    ]};
  });
%>
<%- include('../../components/_table', {
  density: '<dense for credentials/credential-requests/invoices, medium for ndas/documents/projects/users>',
  columns: [
    // surface-specific columns
  ],
  rows: rows,
  emptyState: '<surface-specific empty message>'
}) %>
```

Concrete column layouts:

**NDAs list** (medium density):
- Generated · Razón social · Status · Project · Actions
- Cells: `euDateTime(it.generated_at)`, `customer.razon_social`, `it.status`, `it.project_name || '—'`, `<a class="btn btn--ghost btn--sm" href="/admin/ndas/${it.id}">Open →</a>`

**Documents list** (medium density):
- Uploaded · Filename · Category · Size · By · Actions
- Cells: `euDateTime(it.uploaded_at)`, `it.filename`, `it.category`, `formatBytes(it.size_bytes)`, `it.uploaded_by_name`, `<a class="btn btn--ghost btn--sm" href="/admin/documents/${it.id}">Open →</a>`

**Credentials list** (dense density):
- Service · Username · Updated · Actions
- Cells: `it.service_label`, `it.username || '—'`, `euDateTime(it.updated_at)`, `<a class="btn btn--ghost btn--sm" href="/admin/customers/${customer.id}/credentials/${it.id}">Open →</a>`

**Credential requests list** (dense density):
- Created · Service · Status · Actions
- Cells: `euDateTime(it.created_at)`, `it.service_label`, `it.status`, action button matrix per status.

**Invoices list** (dense density):
- Issued · Number · Amount · Due · Status · Actions
- Cells: `euDate(it.issued_at)`, `it.number`, `it.amount_eur` formatted, `euDate(it.due_at)`, `<span class="status-pill status-pill--${it.status}">${it.status}</span>`, `<a class="btn btn--ghost btn--sm" href="/admin/invoices/${it.id}">Open →</a>`

**Projects list** (medium density):
- Name · Status · Started · Last update · Actions
- Cells: `it.name`, `it.status`, `it.started_at ? euDate(it.started_at) : '—'`, `euDateTime(it.updated_at)`, `<a class="btn btn--ghost btn--sm" href="/admin/projects/${it.id}">Open →</a>`

**Customer users list** (medium density):
- Name · Email · Status · Last sign-in · Actions
- Cells: `it.name`, `it.email`, `it.status`, `it.last_login_at ? euDateTime(it.last_login_at) : '—'`, action matrix (resend invite / suspend / reactivate).

Append a `.status-pill` style:

```css
.status-pill {
  display: inline-block;
  padding: 2px var(--s-2);
  border-radius: 999px;
  font-size: var(--f-xs);
  font-family: var(--f-mono);
  text-transform: uppercase;
  letter-spacing: var(--ls-upper);
  background: var(--bg-light-alt);
  color: var(--fg-on-light-muted);
}
.status-pill--paid     { background: rgba(47, 93, 80, 0.12); color: var(--c-moss); }
.status-pill--open     { background: rgba(196, 169, 122, 0.18); color: #826928; }
.status-pill--overdue  { background: rgba(163, 32, 32, 0.12); color: var(--c-error); }
.status-pill--void     { background: var(--c-pearl); color: var(--fg-on-light-muted); }
.status-pill--active   { background: rgba(47, 93, 80, 0.12); color: var(--c-moss); }
.status-pill--suspended{ background: rgba(196, 169, 122, 0.18); color: #826928; }
.status-pill--archived { background: var(--c-pearl); color: var(--fg-on-light-muted); }
.status-pill--pending  { background: rgba(196, 169, 122, 0.18); color: #826928; }
.status-pill--approved { background: rgba(47, 93, 80, 0.12); color: var(--c-moss); }
.status-pill--fulfilled{ background: rgba(47, 93, 80, 0.20); color: var(--c-moss); }
.status-pill--rejected { background: rgba(163, 32, 32, 0.12); color: var(--c-error); }
```

- [ ] **Step 3: Apply the canonical form-page template per surface**

For each `*/new.ejs`, `*/edit.ejs`, `*/detail.ejs`:

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
  title: '<surface verb> <surface-singular>'
}) %>

<%- include('../../components/_admin-customer-tabs', { customerId: customer.id, active: '<surface-key>' }) %>

<% if (typeof error !== 'undefined' && error) { %>
  <%- include('../../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="<form-action>" autocomplete="off" class="form-stack" <% if (typeof multipart !== 'undefined' && multipart) { %>enctype="multipart/form-data"<% } %>>
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <!-- _input partials per field -->

  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: '<verb action>' }) %>
    <%- include('../../components/_button', { variant: 'ghost',   size: 'md', href: '<back href>', label: 'Cancel' }) %>
  </div>
</form>
```

For multipart forms (documents/upload, NDAs/upload-signed, NDAs/upload-audit, invoices/new with PDF), preserve the existing `enctype="multipart/form-data"` + the inline-script CSRF-header shim from M6:

```ejs
<script nonce="<%= nonce %>">
  document.querySelector('form[enctype]').addEventListener('submit', function (e) {
    var fd = new FormData(this);
    var token = this.querySelector('input[name="_csrf"]').value;
    e.preventDefault();
    var xhr = new XMLHttpRequest();
    xhr.open(this.method, this.action, true);
    xhr.setRequestHeader('x-csrf-token', token);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 400) {
        document.body.innerHTML = xhr.responseText;
      } else {
        document.body.innerHTML = xhr.responseText;
      }
    };
    xhr.send(fd);
  });
</script>
```

If the existing M6 multipart form already had a different shim, preserve it byte-identical — just swap the form fields to `_input` partials. Do NOT change the M6 multipart contract (form-order + x-csrf-token header).

- [ ] **Step 4: Routes pass new locals**

For each `routes/admin/<surface>.js` file, every `reply.view(...)` call gets:

```js
{
  activeNav:    'customers',
  mainWidth:    'wide',                  // 'content' for new/edit/detail forms
  sectionLabel: 'ADMIN · CUSTOMERS',
  user:         { name: request.session.admin.name }
}
```

For credential-requests detail and the credential-view modal route, also pass `vaultLockedBanner: !isVaultUnlocked(request.session)` so the layout shows the warn alert when the vault is locked. The vault-lock contract from M7 stays unchanged — the visual change is decorative.

- [ ] **Step 5: Build, restart, smoke, test, commit**

```bash
sudo chown -R root:portal-app /opt/dbstudio_portal/views/admin
sudo find /opt/dbstudio_portal/views/admin -type d -exec chmod 0750 {} +
sudo find /opt/dbstudio_portal/views/admin -type f -exec chmod 0640 {} +
sudo chown root:portal-app /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/admin/*.js
sudo chmod 0640 /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/admin/*.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add views/admin/ public/styles/app.src.css routes/admin/
sudo -u root git commit -m "feat(m11-14): admin per-customer subroutes restyled

NDAs / Documents / Credentials / Credential-requests / Invoices /
Projects / Customer-users — list pages all carry page-header +
_admin-customer-tabs (active per surface) + _table; form pages
carry page-header + tabs + form-stack of _input partials.

Densities: dense (36px) for credentials/credential-requests/invoices;
medium (44px) for NDAs/documents/projects/users. Status pill
component added (.status-pill--paid/open/overdue/void/active/
suspended/archived/pending/approved/fulfilled/rejected).

Multipart contracts (M6 form-order + x-csrf-token) preserved
byte-identical. Vault-lock banner pinned under top-bar via
locals.vaultLockedBanner on credential view paths. mainWidth=wide
for lists, content for forms."
```

---

> **Navigation note (2026-04-30 rewire):** From this point forward, task numbers do NOT follow file position. Execute in numerical order: **T15 → T16 → T17 → T18a → T18b → T19 → T20 → T21 → T22**. T15 (admin surface polish, the new task body below) was inserted on 2026-04-30 between T14 and what is now T19. Tasks 16–18b appear later in this file but execute BEFORE T19. The "Rewired execution sequence" table near the top of this document is the canonical order.

---

## Task 15: Admin surface polish + English copy + extended search

> **NEW (2026-04-30 rewire):** Inserted after operator visual sign-off on T13. Goal is to lock the list-surface bar BEFORE T17/T18 customer-facing surfaces ship, so they inherit the polished pattern instead of paying cleanup tax later. This task does NOT change schema, routes, or any cross-cutting contract — it is presentation-layer + one search-query extension.

**Goal:** Bring T13 (`/admin/customers`) and T14a–e (per-customer subroutes) up to the marketing-site bar, codify the patterns as a one-page "list-surface contract" doc that T17/T18 inherit, replace Spanish display copy with English, and extend the customers search to match email + contact-person in addition to razón social.

**Why this matters:** Operator review of T13 found three concrete deltas: (1) empty-state row hugs the search bar with no spacing, (2) Spanish field labels (razón social / NIF / domicilio) read as developer artefacts to non-Spanish-speaking customers, (3) search only matches razón social, but operators look up customers by contact email or contact name far more often. The first delta is a list-surface pattern smell that would repeat across every list in T14 and T18 if not captured now. Fixing the pattern once + writing it down + applying it to all already-restyled list surfaces is cheaper than discovering the same smell in 9 more lists later.

**Files:**
- Create: `views/components/_empty-state.ejs` (canonical empty state — single illustration + headline + lead + optional primary CTA)
- Create: `views/components/_list-toolbar.ejs` (canonical search/filter strip + result-count + optional "New" CTA, used above every list)
- Create: `views/components/_pagination.ejs` (extract the inline pagination `<nav>` from `views/admin/customers/list.ejs` into a partial; T14 lists currently inline their own copies, T17/T18 will need it too)
- Create: `views/components/_user-mention.ejs` (small leaf — `name` on top + muted `email` below; reused by every "primary contact" cell. Note: this is NOT the existing `<UserMention>` JSX component from DB Football's CLAUDE.md — that's a separate codebase. The portal is server-rendered EJS and has no JS components.)
- Note: `status-pill` stays as an inline CSS class (`.status-pill .status-pill--active` etc.) — it's already used inline in T13/T14 markup; a partial would add more lines of `<%- include … %>` than it saves. Leave as-is.
- Modify: `views/admin/customers/list.ejs` — adopt `_list-toolbar` + `_empty-state` + `_pagination` + `_user-mention`, English column headers, fix spacing
- Modify: `views/admin/customers/{new,detail,edit,created}.ejs` — English form labels + field copy
- Modify: `views/admin/customers/not-found.ejs` — adopt `_empty-state`
- Modify: `views/admin/customers/{ndas,documents,credentials,credential-requests,invoices,projects}/*.ejs` — adopt `_list-toolbar` + `_empty-state` on every list view; English column headers + form labels
- Modify: `domain/customers/repo.js` `listCustomers()` — extend `q` to OR-match razón social + customer_users.email + customer_users.name (LEFT JOIN customer_users + DISTINCT)
- Modify: `tests/integration/customers/listCustomers.test.js` (or wherever it lives — find via grep) — add three tests: search hits email-only match, contact-name-only match, and the existing razón-social match (regression)
- Modify: `public/styles/app.src.css` — add list-surface spacing tokens / classes if existing utilities don't already cover them (likely 1–2 small additions; do not re-vendor anything)
- Create: `docs/superpowers/m11-list-surface-contract.md` (canonical doc — spacing rhythm, empty-state shape, search-toolbar shape, table chrome, hover/focus states, copy register; T17/T18 link to this)

### Step 1: Walk the marketing-site reference + capture the rhythm

Before touching any code, open `https://dbstudio.one` (Capabilities section + any list/grid surface) at 1280×800 in the browser dev-tools and read the rendered values for:
- Section vertical rhythm (heading → first row spacing, row → row spacing)
- Card / row internal padding
- Hover state (background tint, transform if any)
- Focus ring (color, width, offset)
- Empty-state pattern (does marketing have one? if not, look at the "404 / nothing here" archetype across the site)
- Type rhythm in row content (label vs. value sizing, secondary text colour)

Note these as numbers (px values from the inspector) in scratch — they go into the contract doc in Step 8.

For the portal-side baseline, open `https://portal.dbstudio.one/admin/customers` in a logged-in session (now possible after `bc67e04` + `6a06f7c`) and inspect the same elements. Capture the deltas as a list — these are what Step 2 onward fixes.

### Step 2: Create `views/components/_empty-state.ejs`

A single canonical empty state is used by every list when `rows.length === 0`. Locals: `{ icon?, headline, lead, ctaHref?, ctaLabel? }`. The component renders:
- A 56×56 outline icon block (default: a plus-in-square or empty-table glyph; pass a different SVG via `icon` for context)
- An h2 headline (medium weight, ink-900)
- A lead paragraph (ink-700, max 60ch, centered)
- An optional primary button (only if both `ctaHref` and `ctaLabel` are set)

Spacing: `--space-12` above (separating from the toolbar) + `--space-8` between icon → headline → lead → CTA. Centered horizontally, 480px max-width content column. NOT inside a card — the empty state replaces the table on lists, it does not nest.

Reference the contract doc (Step 8) for the exact token values; this partial reads them via `var(--space-N)` so retoning the scale propagates automatically.

### Step 3: Create `views/components/_list-toolbar.ejs`

The list-toolbar partial replaces the inline `<form action="/admin/customers" method="get">` blocks currently scattered across list views. Locals: `{ action, q, qLabel, placeholder, totalLabel, ctaHref?, ctaLabel? }`. Renders:

- A flex row, justify-between, with the search form on the left and (if `ctaHref` + `ctaLabel`) a primary "New …" button on the right.
- Below the row, a small `--c-ink-600` line: `<%= total %> result<%= total === 1 ? '' : 's' %><% if (q) { %> for "<%= q %>"<% } %>`. This is the result-count strip — the operator's silent confirmation that the search did something.
- The form's `<input>` carries `name="q"`, `value="<%- q %>"` (escape!), `placeholder` from locals, an inline left-side magnifier SVG, and the same eye-style icon system from VISUAL FIX 3 for visual consistency.

Spacing: `--space-6` below the toolbar before the table or empty state — this is the fix for the operator-reported "no spacing between search and the empty-state row" smell. Document this gap in the contract.

### Step 4: Modify `views/admin/customers/list.ejs` — adopt the new partials, fix spacing, English headers

Replace the existing search form + table-or-empty-row block with:

```ejs
<%- include('../../components/_list-toolbar', {
  action: '/admin/customers',
  q,
  placeholder: 'Search by company name, contact email, or contact name…',
  total,
  ctaHref: '/admin/customers/new',
  ctaLabel: 'New customer',
}) %>

<% if (rows.length === 0) { %>
  <%- include('../../components/_empty-state', {
    headline: q ? 'No customers match this search' : 'No customers yet',
    lead: q
      ? 'Try a different search, or clear it to see every customer.'
      : 'Customers added here can be invited via secure email — they get a one-time link to register their account and 2FA.',
    ctaHref: q ? null : '/admin/customers/new',
    ctaLabel: q ? null : 'Add the first customer',
  }) %>
<% } else { %>
  <table class="table">
    <thead>
      <tr>
        <th>Company name</th>
        <th>Tax ID</th>
        <th>Primary contact</th>
        <th>Status</th>
        <th>Created</th>
      </tr>
    </thead>
    <tbody>
      <% rows.forEach(function(row) { %>
        <tr>
          <td><a href="/admin/customers/<%= row.id %>"><%= row.razon_social %></a></td>
          <td><%= row.nif || '—' %></td>
          <td><%- include('../../components/_user-mention', { name: row.primary_contact_name, email: row.primary_contact_email }) %></td>
          <td><%- include('../../components/_status-pill', { status: row.status }) %></td>
          <td><time datetime="<%= row.created_at_iso %>"><%= euDate(row.created_at) %></time></td>
        </tr>
      <% }) %>
    </tbody>
  </table>
  <%- include('../../components/_pagination', { page, totalPages, qs }) %>
<% } %>
```

Notes:
- `_user-mention.ejs` and `_pagination.ejs` are both new partials created in this task. `status-pill` is the existing inline CSS-class pattern from T13 — keep using `<span class="status-pill status-pill--<%= row.status %>">` directly, no partial.
- Spacing `--space-8` between toolbar and table OR empty state is owned by `_list-toolbar`'s margin-bottom.
- English headers: Company name / Tax ID / Primary contact / Status / Created.

### Step 5: Apply English copy to T13 + T14 forms and detail views

Canonical mapping (Spanish DB column → English display label):

| DB column | English display |
|---|---|
| `razon_social` | Company name |
| `nif` (or `cif` if so labelled) | Tax ID |
| `domicilio` | Registered address |
| `contacto` / `nombre_contacto` | Contact name |
| `email_contacto` | Contact email |
| `telefono` | Phone |

Apply this to:
- `views/admin/customers/new.ejs` form labels
- `views/admin/customers/edit.ejs` form labels
- `views/admin/customers/detail.ejs` summary card field labels (left column)
- `views/admin/customers/created.ejs` confirmation copy
- Any `views/admin/customers/{ndas,documents,credentials,credential-requests,invoices,projects}/*.ejs` that surfaces customer fields (most won't, but check)

**Storage column names DO NOT change** — only display labels. The schema column is still `razon_social`; we just don't render that string to the operator.

If any `placeholder=`, `aria-label=`, or `<title>` attribute references the Spanish term, update those too.

### Step 6: Apply `_list-toolbar` + `_empty-state` to T14 lists

Walk every T14a–e list view (NDAs / Documents / Credentials / Credential-requests / Invoices / Projects) and apply the same pattern as Step 4. Each gets a contextual empty state — e.g. NDAs: "No NDAs yet", lead "Generate a customer NDA from the customer's overview tab.", CTA "Go to <customer> overview". Documents: "No documents yet" with "Upload a document" CTA. Etc.

This is mechanical but per-surface. Each commits as a sub-step (e.g., `feat(m11-15a): customers list polish`, `feat(m11-15b): NDAs list polish`, …) OR collapses into one big commit if the diff is contained — operator preference noted in `feedback_dbf_workflow.md` is "one PR per logical task" so a single `feat(m11-15)` commit is fine here as long as the message enumerates the surfaces touched.

### Step 7: Extend `domain/customers/repo.js` `listCustomers()` to OR-match email + contact name

Current `listCustomers(db, { q, limit, offset })` likely runs:
```sql
SELECT … FROM customers WHERE razon_social ILIKE ${q}% LIMIT … OFFSET …
```

Extend to:
```sql
SELECT DISTINCT c.*
  FROM customers c
  LEFT JOIN customer_users cu ON cu.customer_id = c.id
 WHERE c.razon_social ILIKE ${'%' + q + '%'}
    OR cu.email ILIKE ${'%' + q + '%'}
    OR cu.name ILIKE ${'%' + q + '%'}
 ORDER BY c.created_at DESC
 LIMIT … OFFSET …
```

Use `LEFT JOIN` so customers with zero customer_users still appear. `DISTINCT` so a customer with multiple matching users doesn't duplicate. Use leading-and-trailing `%` (`ILIKE '%X%'`) so the operator can search for substrings anywhere in the field — the current "starts with" pattern is too restrictive for the email use case.

**Note on customer-user lifecycle:** `customer_users` has no `archived_at` / `deleted_at` column at v1.0 — rows are deleted via the customers `ON DELETE CASCADE`. If a future migration adds soft-delete on customer_users, add `AND cu.<col> IS NULL` to the JOIN condition; do NOT add it speculatively here.

The `total` count needs the same JOIN/DISTINCT treatment — or use a subquery:
```sql
SELECT COUNT(DISTINCT c.id) FROM customers c LEFT JOIN customer_users cu …
```

Verify performance with EXPLAIN on the staging DB if any customer has > 50 users (unlikely at v1.0, but check). Add a `GIN` trigram index on `customers.razon_social`, `customer_users.email`, `customer_users.name` only if EXPLAIN shows seq scans on a meaningful row count — defer to a follow-up if not.

Update the route handler `routes/admin/customers.js` `app.get('/admin/customers', …)` only if it constructs the query — most likely it just passes `q` through to `listCustomers` and no change is needed.

### Step 8: New tests for the extended search

Find the existing `listCustomers` tests:
```bash
grep -rln "listCustomers" /opt/dbstudio_portal/tests/
```

Add tests for:
1. Search by razón social substring (regression — was the only previous match key).
2. Search by customer-user email substring matches the parent customer.
3. Search by customer-user name substring matches the parent customer.
4. Search across multiple matching users does not duplicate the customer row in results.
5. Empty `q` returns all customers (regression).

Use the integration-test pattern (real DB, RUN_DB_TESTS gate). Each test seeds 2–3 customers + 2–3 customer_users, runs `listCustomers({ q })`, asserts the row set.

### Step 9: Author `docs/superpowers/m11-list-surface-contract.md`

A one-page doc that T17/T18 will reference. Sections:

1. **Spacing rhythm** — the exact token values for: page-header → toolbar gap, toolbar → table/empty-state gap, table row → row gap (probably 0 inside a striped table; document the stripe contrast token), table → pagination gap, sidebar gutter.
2. **Toolbar shape** — search input + result-count line + optional CTA. Reference `_list-toolbar` partial.
3. **Empty-state shape** — icon + headline + lead + optional CTA. Reference `_empty-state` partial. Copy register: "No X yet" / "X added here can be …" / "Add the first X".
4. **Table chrome** — headers (small caps? or just medium-weight ink-900), zebra stripes (yes/no — match marketing), hover row treatment, link colours inside cells.
5. **Hover + focus states** — focus ring colour + width + offset; row hover background tint.
6. **Copy register** — concise, slightly formal, English. Mapping table for Spanish-stored columns.

This doc is the contract. T17 dashboard's bento cards reference it for empty-card shape; T18 list surfaces reference it for everything. T22 final sweep validates against it.

### Step 10: Build, restart, smoke, tests

```bash
cd /opt/dbstudio_portal
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node scripts/build.js
sudo systemctl restart portal.service && sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: smoke 9/9, tests at or above the current baseline (572 + 3 skipped + the 3–5 new search tests added in Step 8).

### Step 11: Operator visual sign-off

Before committing, walk the operator through the polished surfaces at 1280×800 + 390×844:
- `/admin/customers` (with and without a `?q=…` populated)
- `/admin/customers/<id>` overview tab
- `/admin/customers/<id>/ndas` (and the empty-state variant — easy to trigger by creating a fresh customer)
- Same for `/documents`, `/credentials`, `/credential-requests`, `/invoices`, `/projects`

The operator either signs off ("yes, this is the bar") or points at remaining deltas. If deltas remain, fix inline; do NOT defer to T22. T15's whole purpose is to lock the bar.

### Step 12: Re-apply perms, commit

```bash
sudo chown root:portal-app views/components/_empty-state.ejs views/components/_list-toolbar.ejs views/components/_pagination.ejs views/components/_user-mention.ejs docs/superpowers/m11-list-surface-contract.md
sudo chmod 0640 views/components/_empty-state.ejs views/components/_list-toolbar.ejs views/components/_pagination.ejs views/components/_user-mention.ejs docs/superpowers/m11-list-surface-contract.md
# (other modified files retain their existing root:portal-app 0640 perms)

cd /opt/dbstudio_portal
sudo -u root git add views/components/_empty-state.ejs views/components/_list-toolbar.ejs \
  views/components/_pagination.ejs views/components/_user-mention.ejs \
  views/admin/customers/ \
  domain/customers/repo.js \
  tests/integration/customers/ \
  public/styles/app.src.css \
  docs/superpowers/m11-list-surface-contract.md

sudo -u root git commit -m "feat(m11-15): admin surface polish, English copy, extended search

Sweeps T13/T14 admin list surfaces against the marketing-site bar
and codifies the list-surface contract for T17/T18 to inherit.

Adds:
- views/components/_empty-state.ejs (canonical empty state)
- views/components/_list-toolbar.ejs (search + result-count + CTA)
- docs/superpowers/m11-list-surface-contract.md (the contract)

Polishes:
- /admin/customers list, new, detail, edit, created, not-found
- /admin/customers/<id>/{ndas,documents,credentials,
  credential-requests,invoices,projects} list views
- English display copy throughout (Company name / Tax ID /
  Registered address / Contact / Phone) — schema columns
  unchanged

Extends:
- domain/customers/repo.js#listCustomers — q now OR-matches
  razon_social + customer_users.email + customer_users.name
  (LEFT JOIN + DISTINCT). Substring match (ILIKE %X%) instead
  of the previous starts-with.
- tests/integration/customers/ — 5 new tests covering email,
  contact-name, razón-social, dedup, and empty-q regression.

No schema, route-contract, audit, or cross-cutting-contract
changes. Tests: NNN passed + 3 skipped, smoke 9/9. Operator
signed off the polished surfaces in person before commit."
```

If the operator-sign-off step finds deltas during Step 11, fix them and re-run Step 10 before committing. Do NOT commit a partially-polished pass.

### Acceptance criteria

T15 is done when ALL of these are true:
- Every T13/T14 list surface uses `_list-toolbar` and `_empty-state` partials (no inline search forms or bare empty `<tr>` rows remain).
- All Spanish display copy is replaced with the English mapping in Step 5 (verify with `grep -RIn "razón\|razon_social\|NIF[:\b]\|domicilio" views/admin/`; storage refs in domain/repo are fine, only display copy must change).
- `listCustomers` matches email + contact-name + razón-social with substring semantics, dedups via DISTINCT, returns the same total count under both populated `q` and empty `q`.
- New unit/integration tests pass; existing 572-green baseline holds (or grows).
- `docs/superpowers/m11-list-surface-contract.md` exists and captures spacing / toolbar / empty-state / table / hover-focus / copy register with concrete token values, not vague references.
- Operator visual sign-off recorded in the commit message ("Operator signed off the polished surfaces in person before commit").

Once acceptance lands, T16 (customer-summary lib) starts immediately — no review pause needed; T16 is TDD pure-function work that can run in parallel with the operator's lived-experience review of T15-polished admin surfaces.

---

## Task 19: /admin/profile (with QR on 2FA-regen) + /admin/audit + audit export

> **NOTE (2026-04-30 rewire):** Was Task 15 in the original numbering. Demoted to T19 — operator-only surface, no customer perception, can ship after the customer-facing T17/T18 pass.

**Files:**
- Replace: `views/admin/profile/*.ejs` (Identity / Password / 2FA / Sessions tabs)
- Create: `views/components/_profile-tabs.ejs` (shared between admin and customer profile in T18b)
- Replace: `views/admin/audit/*.ejs` (list + export confirmation)
- Modify: `routes/admin/profile.js` and `routes/admin/audit.js` — pass `activeNav`, `mainWidth`, `sectionLabel`, plus the QR svg on the 2FA regen branch.

- [ ] **Step 1: Profile-tabs partial (shared admin/customer)**

Write `/opt/dbstudio_portal/views/components/_profile-tabs.ejs`:

```ejs
<%# Usage:
    <%- include('../components/_profile-tabs', {
      surface: 'admin'|'customer',
      active:  'identity'|'password'|'2fa'|'sessions'
    }) %>
%>
<%
  var base = surface === 'admin' ? '/admin/profile' : '/customer/profile';
  var tabs = [
    { key: 'identity',  label: 'Identity',  href: base                     },
    { key: 'password',  label: 'Password',  href: base + '/password'       },
    { key: '2fa',       label: 'Two-factor', href: base + '/2fa'           },
    { key: 'sessions',  label: 'Sessions',  href: base + '/sessions'       }
  ];
%>
<nav class="subtabs" aria-label="Profile sections">
  <ul>
    <% tabs.forEach(function(t) { %>
      <li class="subtabs__item<%= active === t.key ? ' subtabs__item--active' : '' %>">
        <a href="<%= t.href %>"<% if (active === t.key) { %> aria-current="page"<% } %>><%= t.label %></a>
      </li>
    <% }) %>
  </ul>
</nav>
```

- [ ] **Step 2: Restyle admin profile sub-tab views**

Each `views/admin/profile/<tab>.ejs` follows the shape:

```ejs
<%- include('../../components/_page-header', { eyebrow: 'ADMIN', title: 'Profile · <Tab name>' }) %>
<%- include('../../components/_profile-tabs', { surface: 'admin', active: '<tab-key>' }) %>

<% if (typeof flash !== 'undefined' && flash) { %>
  <%- include('../../components/_alert', { variant: flash.variant, body: flash.body }) %>
<% } %>

<form method="post" action="<%= action %>" autocomplete="off" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <!-- _input partials per field -->
  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: '<action>' }) %>
  </div>
</form>
```

Specific tabs:

**Identity (`identity.ejs`):** name + email (with verify-required helper if email-change is pending). Submit "Save changes."

**Password (`password.ejs`):** current password + new password + confirm new password, all `_input` with `showHideToggle: true`. Helper line on new password notes HIBP check. Submit "Update password."

**2FA (`2fa.ejs`):** show current 2FA status. If `regenInProgress` is set (route returns the regen view), wire the QR + secret + 6-digit confirmation field:

```ejs
<% if (typeof regenInProgress !== 'undefined' && regenInProgress) { %>
  <p>Scan this QR with your authenticator app, then enter the 6-digit code below to confirm. Your existing authenticator stops working as soon as you confirm.</p>
  <form method="post" action="/admin/profile/2fa/regen/confirm" autocomplete="off" class="form-stack">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <%- include('../../components/_qr', { svg: qrSvg, secret: enrolSecret }) %>
    <%- include('../../components/_input', {
      name: 'totp_code', type: 'text', label: 'Six-digit code',
      inputmode: 'numeric', pattern: '[0-9]{6}', autocomplete: 'one-time-code',
      required: true, maxlength: 6
    }) %>
    <div class="form-actions">
      <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Confirm new authenticator' }) %>
      <%- include('../../components/_button', { variant: 'ghost',   size: 'md', href: '/admin/profile/2fa', label: 'Cancel' }) %>
    </div>
  </form>
<% } else { %>
  <p>Two-factor is enabled.</p>
  <form method="post" action="/admin/profile/2fa/regen" autocomplete="off">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <div class="form-actions">
      <%- include('../../components/_button', { variant: 'secondary', size: 'md', type: 'submit', label: 'Regenerate authenticator' }) %>
    </div>
  </form>
  <details class="backup-fallback">
    <summary>Regenerate backup codes</summary>
    <p>Generates a new set of 10 single-use codes; old codes stop working.</p>
    <form method="post" action="/admin/profile/2fa/backup-regen" autocomplete="off">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <div class="form-actions">
        <%- include('../../components/_button', { variant: 'secondary', size: 'sm', type: 'submit', label: 'Regenerate backup codes' }) %>
      </div>
    </form>
  </details>
<% } %>
```

In `routes/admin/profile.js`, on the 2FA regen GET (the one that returns the new authenticator's secret + URI), compute `qrSvg`:

```js
import { renderTotpQrSvg } from '../../lib/qr.js';

// inside the regen handler:
const qrSvg = await renderTotpQrSvg(otpauthUri, {
  label: `New TOTP enrolment for ${admin.email}`
});
return reply.view('admin/profile/2fa', {
  // existing locals minus otpauthUri
  regenInProgress: true,
  enrolSecret,
  qrSvg,
  csrfToken,
  activeNav: 'profile',
  mainWidth: 'content',
  sectionLabel: 'ADMIN · PROFILE',
  user: { name: admin.name }
});
```

Drop `otpauthUri` from the locals passed to the view — it's encoded inside the QR.

**Sessions (`sessions.ejs`):** dense `_table` with columns Started · Last seen · IP · UA family · Actions (revoke). Below the table, a "Sign out everywhere" form button.

- [ ] **Step 3: Restyle admin audit views**

`views/admin/audit/list.ejs`:

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN',
  title: 'Audit log',
  actions: '<a class="btn btn--secondary btn--md" href="/admin/audit/export">Export CSV</a>'
}) %>

<form method="get" action="/admin/audit" class="form-inline" role="search">
  <%- include('../../components/_input', { name: 'from',   type: 'date', label: 'From', value: typeof from !== 'undefined' ? from : '' }) %>
  <%- include('../../components/_input', { name: 'to',     type: 'date', label: 'To',   value: typeof to !== 'undefined' ? to : '' }) %>
  <%- include('../../components/_input', { name: 'actor',  type: 'text', label: 'Actor', value: typeof actor !== 'undefined' ? actor : '' }) %>
  <%- include('../../components/_input', { name: 'action', type: 'text', label: 'Action', value: typeof action !== 'undefined' ? action : '' }) %>
  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'secondary', size: 'md', type: 'submit', label: 'Filter' }) %>
  </div>
</form>

<%
  var rows = (events || []).map(function(e) {
    return { cells: [
      euDateTime(e.ts),
      e.actor_display_name || '<system>',
      e.action,
      e.target || '',
      '<button class="btn btn--ghost btn--sm" type="button" data-audit-meta="' + encodeURIComponent(JSON.stringify(e.metadata)) + '">Details</button>'
    ]};
  });
%>
<%- include('../../components/_table', {
  density: 'dense',
  columns: [
    { label: 'When',     align: 'left'  },
    { label: 'Actor',    align: 'left'  },
    { label: 'Action',   align: 'left'  },
    { label: 'Target',   align: 'left'  },
    { label: '',         align: 'right' }
  ],
  rows: rows,
  emptyState: 'No audit events match these filters.'
}) %>

<% if (typeof pagination !== 'undefined' && pagination) { %>
  <nav class="pagination" aria-label="Pagination">
    <% if (pagination.prevHref) { %><a class="btn btn--ghost btn--sm" href="<%= pagination.prevHref %>">← Previous</a><% } %>
    <span class="eyebrow"><%= pagination.label %></span>
    <% if (pagination.nextHref) { %><a class="btn btn--ghost btn--sm" href="<%= pagination.nextHref %>">Next →</a><% } %>
  </nav>
<% } %>

<dialog id="audit-meta" aria-labelledby="audit-meta-title">
  <article class="card card--modal" aria-modal="true" aria-labelledby="audit-meta-title">
    <h2 id="audit-meta-title" class="card__title">Event details</h2>
    <pre class="card__body" id="audit-meta-body"></pre>
    <div class="form-actions">
      <button class="btn btn--ghost btn--sm" type="button" data-close>Close</button>
    </div>
  </article>
</dialog>

<script nonce="<%= nonce %>">
  (function () {
    var dlg = document.getElementById('audit-meta');
    var body = document.getElementById('audit-meta-body');
    document.querySelectorAll('[data-audit-meta]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        try {
          var meta = JSON.parse(decodeURIComponent(btn.getAttribute('data-audit-meta')));
          body.textContent = JSON.stringify(meta, null, 2);
        } catch (_) {
          body.textContent = '(unable to parse metadata)';
        }
        if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      });
    });
    dlg.querySelector('[data-close]').addEventListener('click', function () {
      if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
    });
  })();
</script>
```

The `<dialog>` element gives us native modal semantics for free; `aria-modal` + `aria-labelledby` are on the inner `card--modal` per spec. Append a small style:

```css
dialog#audit-meta { padding: 0; border: 0; background: transparent; max-width: var(--prose); }
dialog#audit-meta::backdrop { background: rgba(10, 10, 10, 0.5); }
```

`views/admin/audit/export.ejs`:

```ejs
<%- include('../../components/_page-header', { eyebrow: 'ADMIN · AUDIT', title: 'Export audit log' }) %>

<div class="card">
  <p>Date range: <strong><%= rangeFrom %> → <%= rangeTo %></strong></p>
  <p>Estimated rows: <strong><%= estimatedRows %></strong></p>
</div>

<form method="get" action="/admin/audit/export.csv" class="form-stack">
  <input type="hidden" name="from" value="<%= rangeFrom %>">
  <input type="hidden" name="to"   value="<%= rangeTo %>">
  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Download CSV' }) %>
    <%- include('../../components/_button', { variant: 'ghost',   size: 'md', href: '/admin/audit', label: 'Cancel' }) %>
  </div>
</form>
```

The audit-export route's M9 review-I1 contract (`applySecureHeadersRaw(reply.raw)` before first chunk) stays unchanged — that's purely route logic. The view above is rendered by the GET confirmation page, not the streaming download itself.

- [ ] **Step 4: Build, restart, smoke, test, commit**

```bash
sudo chown -R root:portal-app /opt/dbstudio_portal/views/admin/profile /opt/dbstudio_portal/views/admin/audit
sudo find /opt/dbstudio_portal/views/admin/profile /opt/dbstudio_portal/views/admin/audit -type d -exec chmod 0750 {} +
sudo find /opt/dbstudio_portal/views/admin/profile /opt/dbstudio_portal/views/admin/audit -type f -exec chmod 0640 {} +
sudo chown root:portal-app /opt/dbstudio_portal/views/components/_profile-tabs.ejs /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/admin/profile.js /opt/dbstudio_portal/routes/admin/audit.js
sudo chmod 0640 /opt/dbstudio_portal/views/components/_profile-tabs.ejs /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/admin/profile.js /opt/dbstudio_portal/routes/admin/audit.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add views/admin/profile/ views/admin/audit/ views/components/_profile-tabs.ejs public/styles/app.src.css routes/admin/profile.js routes/admin/audit.js
sudo -u root git commit -m "feat(m11-15): admin profile (with QR) + audit + audit export

- _profile-tabs partial (shared admin + customer): Identity ·
  Password · Two-factor · Sessions strip.
- admin/profile/{identity,password,2fa,sessions}.ejs all restyled.
  2fa.ejs renders QR + secret + 6-digit confirmation when
  regenInProgress (route plumbs qrSvg via renderTotpQrSvg);
  otherwise shows status + regen button + backup-code regen.
- admin/audit/list.ejs: filter form + dense table + native
  <dialog> for event-detail modal (aria-modal + aria-labelledby
  on the inner card--modal). audit/export.ejs: confirmation card
  + download button.

routes/admin/{profile,audit}.js pass activeNav=profile|audit,
mainWidth=content, sectionLabel, user. M9 review I1 audit-export
secure-headers contract unchanged."
```

---

## Task 16: lib/customer-summary.js + unit tests (TDD)

**Files:**
- Create: `lib/customer-summary.js`
- Create: `tests/integration/customer-summary/summary.test.js` (integration — needs DB)

The dashboard summary is fundamentally a SQL aggregation. The test harness for it lives under `tests/integration/` because the queries are real SQL against a per-test schema. The test follows the existing integration-test pattern (see `tests/integration/customers/` for shape).

- [ ] **Step 1: Inspect an existing integration test for shape**

```bash
ls /opt/dbstudio_portal/tests/integration/customers/
cat /opt/dbstudio_portal/tests/integration/customers/*.test.js | head -80
cat /opt/dbstudio_portal/tests/global-setup.js
```

Note the per-test isolated schema convention. Match it.

- [ ] **Step 2: Write the failing test**

Write `/opt/dbstudio_portal/tests/integration/customer-summary/summary.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb } from '../../../config/db.js';
import { runMigrations } from '../../../migrations/runner.js';
import { getCustomerDashboardSummary } from '../../../lib/customer-summary.js';
import { v7 as uuidv7 } from 'uuid';

const DATABASE_URL = process.env.DATABASE_URL;

let db;

beforeEach(async () => {
  // Per-test isolated schema, matching the global-setup pattern.
  db = createDb({ connectionString: DATABASE_URL });
  await runMigrations({ db, dir: '/opt/dbstudio_portal/migrations' });
});

describe('getCustomerDashboardSummary', () => {
  it('returns six section keys with count/latestAt/unreadCount fields', async () => {
    const customerId = uuidv7();
    // Seed minimal customer row + admin (FK requirements). Use the
    // existing helper if there is one; otherwise raw INSERTs are fine
    // for an integration test like this.
    await db.insertInto('customers').values({
      id: customerId,
      razon_social: 'Acme S.L.',
      nif: 'B12345678',
      country: 'ES',
      status: 'active',
      created_at: new Date(),
      updated_at: new Date()
    }).execute();

    const result = await getCustomerDashboardSummary(db, { customerId });

    expect(Object.keys(result).sort()).toEqual([
      'credentialRequests', 'credentials', 'documents', 'invoices', 'ndas', 'projects'
    ]);
    for (const key of Object.keys(result)) {
      expect(result[key]).toHaveProperty('count');
      expect(result[key]).toHaveProperty('latestAt');
      expect(result[key]).toHaveProperty('unreadCount');
      expect(typeof result[key].count).toBe('number');
      expect(typeof result[key].unreadCount).toBe('number');
    }
  });

  it('reports zero counts for an empty customer', async () => {
    const customerId = uuidv7();
    await db.insertInto('customers').values({
      id: customerId, razon_social: 'Empty S.L.', nif: 'B11111111',
      country: 'ES', status: 'active',
      created_at: new Date(), updated_at: new Date()
    }).execute();

    const r = await getCustomerDashboardSummary(db, { customerId });
    for (const key of Object.keys(r)) {
      expect(r[key].count).toBe(0);
      expect(r[key].latestAt).toBeNull();
      expect(r[key].unreadCount).toBe(0);
    }
  });

  it('counts ndas, documents, invoices etc. for the customer', async () => {
    const customerId = uuidv7();
    await db.insertInto('customers').values({
      id: customerId, razon_social: 'Busy S.L.', nif: 'B22222222',
      country: 'ES', status: 'active',
      created_at: new Date(), updated_at: new Date()
    }).execute();

    // Seed one row in each table the summary aggregates from.
    // (The exact insert syntax depends on the schema — keep this loose
    // and match what the test fixtures helper exposes; if no helper,
    // raw kysely .insertInto(...).values(...).execute() works.)
    await db.insertInto('documents').values({
      id: uuidv7(), customer_id: customerId, category: 'invoice-pdf',
      filename: 'inv.pdf', size_bytes: 100, sha256: 'a'.repeat(64),
      uploaded_by_admin_id: null, uploaded_at: new Date(), updated_at: new Date()
    }).execute();

    const r = await getCustomerDashboardSummary(db, { customerId });
    expect(r.documents.count).toBeGreaterThanOrEqual(1);
    expect(r.documents.latestAt).not.toBeNull();
  });

  it('isolates customers — one customer does not see another customer\'s rows', async () => {
    const aId = uuidv7(), bId = uuidv7();
    await db.insertInto('customers').values([
      { id: aId, razon_social: 'A', nif: 'B33333333', country: 'ES', status: 'active', created_at: new Date(), updated_at: new Date() },
      { id: bId, razon_social: 'B', nif: 'B44444444', country: 'ES', status: 'active', created_at: new Date(), updated_at: new Date() }
    ]).execute();

    await db.insertInto('documents').values({
      id: uuidv7(), customer_id: aId, category: 'doc',
      filename: 'a.pdf', size_bytes: 1, sha256: 'b'.repeat(64),
      uploaded_by_admin_id: null, uploaded_at: new Date(), updated_at: new Date()
    }).execute();

    const ra = await getCustomerDashboardSummary(db, { customerId: aId });
    const rb = await getCustomerDashboardSummary(db, { customerId: bId });
    expect(ra.documents.count).toBeGreaterThanOrEqual(1);
    expect(rb.documents.count).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test, confirm it fails**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-summary/
```

Expected: failure (`Cannot find module '../../../lib/customer-summary.js'`).

- [ ] **Step 4: Implement `lib/customer-summary.js`**

Write `/opt/dbstudio_portal/lib/customer-summary.js`:

```js
// Customer dashboard summary aggregator.
//
// One Postgres call returning per-section counts + most-recent timestamp
// + unread-count for the customer dashboard's bento grid. Cached behind
// `Cache-Control: private, max-age=15` on the dashboard route — short
// enough to feel live, cheap enough not to hammer the DB.
//
// Tables aggregated:
//   ndas                 (count + max(generated_at) + unread = ndas not yet seen)
//   documents            (count + max(updated_at)   + unread = documents not yet seen)
//   credentials          (count + max(updated_at))
//   credential_requests  (count + max(updated_at)   + unread = requests with status='approved' awaiting fulfilment)
//   invoices             (count + max(updated_at)   + unread = invoices with status='open')
//   projects             (count + max(updated_at))
//
// Where the schema lacks a per-customer-user "seen" column, unreadCount
// falls back to 0 — adding seen tracking is a v1.1 follow-up.

import { sql } from 'kysely';

/**
 * @param {import('kysely').Kysely<any>} db
 * @param {{ customerId: string }} args
 * @returns {Promise<{
 *   ndas:               { count: number, latestAt: Date|null, unreadCount: number },
 *   documents:          { count: number, latestAt: Date|null, unreadCount: number },
 *   credentials:        { count: number, latestAt: Date|null, unreadCount: number },
 *   credentialRequests: { count: number, latestAt: Date|null, unreadCount: number },
 *   invoices:           { count: number, latestAt: Date|null, unreadCount: number },
 *   projects:           { count: number, latestAt: Date|null, unreadCount: number }
 * }>}
 */
export async function getCustomerDashboardSummary(db, { customerId }) {
  if (!customerId) throw new Error('getCustomerDashboardSummary: customerId required');

  // One round-trip with six CTEs. The `unread` column is cheap because
  // it counts under the same lock the count(*) is already taking.
  const row = await sql<{
    ndas_count: number, ndas_latest: Date|null, ndas_unread: number,
    docs_count: number, docs_latest: Date|null, docs_unread: number,
    cred_count: number, cred_latest: Date|null,
    creq_count: number, creq_latest: Date|null, creq_unread: number,
    inv_count:  number, inv_latest:  Date|null, inv_unread:  number,
    prj_count:  number, prj_latest:  Date|null
  }>`
    WITH
      ndas_agg AS (
        SELECT COUNT(*)::int AS c, MAX(generated_at) AS l,
               COUNT(*) FILTER (WHERE signed_document_id IS NOT NULL)::int AS u
        FROM ndas WHERE customer_id = ${customerId}
      ),
      docs_agg AS (
        SELECT COUNT(*)::int AS c, MAX(uploaded_at) AS l,
               0::int AS u
        FROM documents WHERE customer_id = ${customerId} AND category != 'nda-draft'
      ),
      cred_agg AS (
        SELECT COUNT(*)::int AS c, MAX(updated_at) AS l
        FROM credentials WHERE customer_id = ${customerId}
      ),
      creq_agg AS (
        SELECT COUNT(*)::int AS c, MAX(updated_at) AS l,
               COUNT(*) FILTER (WHERE status = 'approved')::int AS u
        FROM credential_requests WHERE customer_id = ${customerId}
      ),
      inv_agg AS (
        SELECT COUNT(*)::int AS c, MAX(updated_at) AS l,
               COUNT(*) FILTER (WHERE status = 'open')::int AS u
        FROM invoices WHERE customer_id = ${customerId}
      ),
      prj_agg AS (
        SELECT COUNT(*)::int AS c, MAX(updated_at) AS l
        FROM projects WHERE customer_id = ${customerId}
      )
    SELECT
      ndas_agg.c AS ndas_count, ndas_agg.l AS ndas_latest, ndas_agg.u AS ndas_unread,
      docs_agg.c AS docs_count, docs_agg.l AS docs_latest, docs_agg.u AS docs_unread,
      cred_agg.c AS cred_count, cred_agg.l AS cred_latest,
      creq_agg.c AS creq_count, creq_agg.l AS creq_latest, creq_agg.u AS creq_unread,
      inv_agg.c  AS inv_count,  inv_agg.l  AS inv_latest,  inv_agg.u AS inv_unread,
      prj_agg.c  AS prj_count,  prj_agg.l  AS prj_latest
    FROM ndas_agg, docs_agg, cred_agg, creq_agg, inv_agg, prj_agg
  `.execute(db);

  const r = row.rows[0] || {
    ndas_count: 0, ndas_latest: null, ndas_unread: 0,
    docs_count: 0, docs_latest: null, docs_unread: 0,
    cred_count: 0, cred_latest: null,
    creq_count: 0, creq_latest: null, creq_unread: 0,
    inv_count: 0,  inv_latest: null,  inv_unread: 0,
    prj_count: 0,  prj_latest: null
  };

  return {
    ndas:               { count: r.ndas_count, latestAt: r.ndas_latest, unreadCount: r.ndas_unread },
    documents:          { count: r.docs_count, latestAt: r.docs_latest, unreadCount: r.docs_unread },
    credentials:        { count: r.cred_count, latestAt: r.cred_latest, unreadCount: 0 },
    credentialRequests: { count: r.creq_count, latestAt: r.creq_latest, unreadCount: r.creq_unread },
    invoices:           { count: r.inv_count,  latestAt: r.inv_latest,  unreadCount: r.inv_unread  },
    projects:           { count: r.prj_count,  latestAt: r.prj_latest,  unreadCount: 0 }
  };
}
```

The "documents" unreadCount uses `0` for v1 — the schema doesn't track per-customer-user "seen" state. The unreadCount fields for credentials and projects are likewise 0 (not pertinent: credentials are revealed on demand, projects don't carry status that signals "needs attention"). Future v1.1 work can add seen-at columns and surface real numbers.

If your schema columns differ (e.g. `documents.uploaded_at` vs `documents.created_at`), adapt the SQL to match — the test will tell you. Do NOT add migrations in M11; this is presentation-layer.

- [ ] **Step 5: Run the tests, confirm they pass**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-summary/
```

Expected: 4 tests pass. If a test fails because the schema's column names differ, fix the SQL inline (do NOT change the test). Tests that fail because tables don't have rows-on-empty-customer are real bugs in the SQL (NULL handling) — fix.

- [ ] **Step 6: Re-apply perms, full test suite, commit**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/lib/customer-summary.js /opt/dbstudio_portal/tests/integration/customer-summary/summary.test.js
sudo chmod 0640 /opt/dbstudio_portal/lib/customer-summary.js /opt/dbstudio_portal/tests/integration/customer-summary/summary.test.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add lib/customer-summary.js tests/integration/customer-summary/summary.test.js
sudo -u root git commit -m "feat(m11-16): lib/customer-summary.js — dashboard aggregator + tests

getCustomerDashboardSummary(db, { customerId }) returns one
{ count, latestAt, unreadCount } per section (ndas, documents,
credentials, credentialRequests, invoices, projects) via a single
6-CTE Postgres query.

Unread-count semantics:
  - ndas:               signed (signed_document_id IS NOT NULL)
  - documents:          0 (no per-user seen state in v1)
  - credentials:        0 (revealed on demand)
  - credentialRequests: status = 'approved' (awaiting fulfilment)
  - invoices:           status = 'open'
  - projects:           0

Documents query excludes nda-draft category (drafts are admin-only
per M8.4 contract).

4 integration tests cover: shape (six keys, three numeric fields),
empty customer (zero counts, null latestAt), seeded customer
(non-zero counts), customer isolation."
```

---

## Task 17: /customer/dashboard restyled (bento grid + summary)

**Files:**
- Replace: `views/customer/dashboard.ejs`
- Modify: `routes/customer/dashboard.js` (or wherever the dashboard handler lives) — call `getCustomerDashboardSummary`, set `Cache-Control: private, max-age=15`, pass locals.

- [ ] **Step 1: Locate the dashboard handler**

```bash
grep -RIn "customer/dashboard\|reply.view.*customer/dashboard" /opt/dbstudio_portal/routes/customer 2>/dev/null
```

- [ ] **Step 2: Update the handler**

```js
import { getCustomerDashboardSummary } from '../../lib/customer-summary.js';

// inside the GET /customer/dashboard handler:
const summary = await getCustomerDashboardSummary(request.server.db, {
  customerId: request.session.customer.id
});

reply.header('Cache-Control', 'private, max-age=15');
return reply.view('customer/dashboard', {
  user:         { name: request.session.customerUser.name },
  customer:     request.session.customer,
  summary,
  activeNav:    'dashboard',
  mainWidth:    'wide',
  sectionLabel: request.session.customer.razon_social
});
```

- [ ] **Step 3: Replace `views/customer/dashboard.ejs`**

```ejs
<%- include('../components/_page-header', {
  eyebrow: customer.razon_social,
  title: 'Hello, ' + user.name,
  subtitle: 'Your projects, NDAs, credentials and invoices in one place.'
}) %>

<%
  function fmtLatest(latestAt) {
    if (!latestAt) return null;
    return 'updated ' + euDateTime(latestAt);
  }
%>

<div class="bento">
  <%- include('../components/_card', {
    eyebrow: 'NDAs',
    title:   summary.ndas.count + (summary.ndas.count === 1 ? ' agreement' : ' agreements'),
    count:   summary.ndas.count,
    latestAt: fmtLatest(summary.ndas.latestAt),
    unread:   summary.ndas.unreadCount,
    footerHref:  '/customer/ndas',
    footerLabel: 'Open NDAs →'
  }) %>

  <%- include('../components/_card', {
    eyebrow: 'Documents',
    title:   summary.documents.count + (summary.documents.count === 1 ? ' file' : ' files'),
    count:   summary.documents.count,
    latestAt: fmtLatest(summary.documents.latestAt),
    unread:   summary.documents.unreadCount,
    footerHref:  '/customer/documents',
    footerLabel: 'Open documents →'
  }) %>

  <%- include('../components/_card', {
    eyebrow: 'Credentials',
    title:   summary.credentials.count + (summary.credentials.count === 1 ? ' secret' : ' secrets'),
    count:   summary.credentials.count,
    latestAt: fmtLatest(summary.credentials.latestAt),
    unread:   summary.credentials.unreadCount,
    footerHref:  '/customer/credentials',
    footerLabel: 'Open credential vault →'
  }) %>

  <%- include('../components/_card', {
    eyebrow: 'Credential requests',
    title:   summary.credentialRequests.count + (summary.credentialRequests.count === 1 ? ' request' : ' requests'),
    count:   summary.credentialRequests.count,
    latestAt: fmtLatest(summary.credentialRequests.latestAt),
    unread:   summary.credentialRequests.unreadCount,
    footerHref:  '/customer/credential-requests',
    footerLabel: 'Open requests →'
  }) %>

  <%- include('../components/_card', {
    eyebrow: 'Invoices',
    title:   summary.invoices.count + (summary.invoices.count === 1 ? ' invoice' : ' invoices'),
    count:   summary.invoices.count,
    latestAt: fmtLatest(summary.invoices.latestAt),
    unread:   summary.invoices.unreadCount,
    footerHref:  '/customer/invoices',
    footerLabel: 'Open invoices →'
  }) %>

  <%- include('../components/_card', {
    eyebrow: 'Projects',
    title:   summary.projects.count + (summary.projects.count === 1 ? ' engagement' : ' engagements'),
    count:   summary.projects.count,
    latestAt: fmtLatest(summary.projects.latestAt),
    unread:   summary.projects.unreadCount,
    footerHref:  '/customer/projects',
    footerLabel: 'Open projects →'
  }) %>
</div>
```

Append `.bento` styles to `app.src.css`:

```css
.bento {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s-4);
  margin-block: var(--s-6);
}
@media (max-width: 1024px) { .bento { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px)  { .bento { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: Build, restart, smoke, test, commit**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/views/customer/dashboard.ejs /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/customer/dashboard.js
sudo chmod 0640 /opt/dbstudio_portal/views/customer/dashboard.ejs /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/customer/dashboard.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add views/customer/dashboard.ejs public/styles/app.src.css routes/customer/dashboard.js
sudo -u root git commit -m "feat(m11-17): /customer/dashboard restyled — bento + summary

page-header (eyebrow=razón social, title=greeting) + 6-card
bento grid (NDAs · Documents · Credentials · Credential requests
· Invoices · Projects), each card carrying count + 'updated <ts>'
+ unread badge driven by lib/customer-summary.

Profile and Activity moved out of the dashboard; both reachable
from the sidebar instead.

Route handler calls getCustomerDashboardSummary, sets
Cache-Control: private, max-age=15, passes activeNav=dashboard +
mainWidth=wide + sectionLabel=customer.razon_social."
```

---

## Task 18a: Customer NDAs / Documents / Invoices / Projects restyled

**Files:**
- Replace: `views/customer/ndas/list.ejs`
- Replace: `views/customer/documents/list.ejs`
- Replace: `views/customer/invoices/list.ejs`
- Replace: `views/customer/projects/list.ejs` (and `detail.ejs` if present)
- Modify: each `routes/customer/<surface>.js` to pass `activeNav`, `mainWidth`, `sectionLabel`, `user`, `customer`.

These are read-mostly customer surfaces — list pages with download/open links into existing M6/M8 plumbing. No new logic.

- [ ] **Step 1: Apply the canonical customer-list shape**

For each list page:

```ejs
<%- include('../../components/_page-header', {
  eyebrow: customer.razon_social,
  title:   '<surface name>'
}) %>

<%
  var rows = (items || []).map(function(it) {
    return { cells: [ /* surface-specific cells */ ]};
  });
%>
<%- include('../../components/_table', {
  density: '<dense for invoices, medium for ndas/documents/projects>',
  columns: [ /* surface-specific columns */ ],
  rows: rows,
  emptyState: '<surface-specific empty message>'
}) %>
```

Concrete columns + cells:

**NDAs** (medium):
- Generated · Status · Provider · Customer · Actions
- Cells: `euDateTime(it.generated_at)`, `<span class="status-pill status-pill--${it.status}">${it.status}</span>`, `'DB Studio'`, customer.razon_social, `<a class="btn btn--ghost btn--sm" href="/customer/documents/${it.signed_document_id}/download">Download signed PDF</a>` (gated on `it.signed_document_id` — drafts never reach customer surface per M8.4 + M8.6).
- Empty state: "No NDAs yet — your account manager will generate one when needed."

**Documents** (medium):
- Uploaded · Filename · Category · Size · Actions
- Cells: `euDateTime(it.uploaded_at)`, `it.filename`, `it.category`, `formatBytes(it.size_bytes)`, `<a class="btn btn--ghost btn--sm" href="/customer/documents/${it.id}/download">Download</a>`.
- Empty state: "No documents yet."

**Invoices** (dense):
- Issued · Number · Amount · Due · Status · Actions
- Cells: `euDate(it.issued_at)`, `it.number`, `formatEur(it.amount_eur_cents)`, `euDate(it.due_at)`, `<span class="status-pill status-pill--${it.status}">${it.status}</span>`, download button.
- Empty state: "No invoices yet."

**Projects** (medium):
- Name · Status · Started · Last update · Actions
- Cells: `it.name`, `<span class="status-pill status-pill--${it.status}">${it.status}</span>`, `it.started_at ? euDate(it.started_at) : '—'`, `euDateTime(it.updated_at)`, `<a class="btn btn--ghost btn--sm" href="/customer/projects/${it.id}">Open →</a>`.
- Empty state: "No active projects."

If `formatBytes` and `formatEur` aren't already in `lib/dates.js` or another helper — they probably are; check `grep formatBytes /opt/dbstudio_portal/lib/`. If not, add a one-liner inside the EJS template (`(b/1024).toFixed(1) + ' KB'`).

- [ ] **Step 2: Project detail page (if present)**

`views/customer/projects/detail.ejs`:

```ejs
<%- include('../../components/_page-header', {
  eyebrow: customer.razon_social + ' · PROJECTS',
  title:   project.name,
  subtitle: project.status
}) %>

<%- include('../../components/_breadcrumb', { trail: [
  { label: 'Projects', href: '/customer/projects' },
  { label: project.name, href: null }
]}) %>

<div class="card">
  <p><%= project.description || '(No description)' %></p>
  <dl class="kv">
    <dt>Status</dt>           <dd><%= project.status %></dd>
    <dt>Started</dt>          <dd><%= project.started_at ? euDate(project.started_at) : '—' %></dd>
    <dt>Last update</dt>      <dd><%= euDateTime(project.updated_at) %></dd>
  </dl>
</div>

<% if (typeof activity !== 'undefined' && activity && activity.length) { %>
  <h2>Recent activity</h2>
  <ul class="activity">
    <% activity.forEach(function(e) { %>
      <li class="activity__item">
        <p class="eyebrow"><%= euDateTime(e.ts) %></p>
        <p><%= e.message %></p>
      </li>
    <% }) %>
  </ul>
<% } %>
```

Append `.kv` and `.activity` styles:

```css
.kv { display: grid; grid-template-columns: max-content 1fr; gap: var(--s-2) var(--s-6); margin: var(--s-4) 0; }
.kv dt { color: var(--fg-on-light-muted); font-size: var(--f-sm); }
.kv dd { margin: 0; }
.activity { list-style: none; padding: 0; margin: var(--s-6) 0; display: flex; flex-direction: column; gap: var(--s-3); }
.activity__item { padding: var(--s-3) var(--s-4); border: 1px solid var(--border-light); border-radius: var(--radius-card); background: var(--bg-light-alt); }
.activity__item .eyebrow { margin-bottom: var(--s-1); }
.activity__item p:last-child { margin: 0; }
```

- [ ] **Step 3: Update the four customer route files**

Each list handler passes `activeNav: '<surface-key>'`, `mainWidth: 'wide'`, `sectionLabel: customer.razon_social`, `user: ...`, `customer: ...`. The detail page handler passes `mainWidth: 'content'`.

- [ ] **Step 4: Build, restart, smoke, test, commit**

```bash
sudo chown -R root:portal-app /opt/dbstudio_portal/views/customer/{ndas,documents,invoices,projects}
sudo find /opt/dbstudio_portal/views/customer -type d -exec chmod 0750 {} +
sudo find /opt/dbstudio_portal/views/customer -type f -exec chmod 0640 {} +
sudo chown root:portal-app /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/customer/{ndas,documents,invoices,projects}.js
sudo chmod 0640 /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/customer/{ndas,documents,invoices,projects}.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add views/customer/ndas/ views/customer/documents/ views/customer/invoices/ views/customer/projects/ public/styles/app.src.css routes/customer/ndas.js routes/customer/documents.js routes/customer/invoices.js routes/customer/projects.js
sudo -u root git commit -m "feat(m11-18a): customer NDAs / documents / invoices / projects restyled

list pages use page-header (eyebrow=razón social, title=section)
+ _table (medium for ndas/documents/projects, dense for invoices)
+ status-pill where status is meaningful. Empty-state copy
matches the spec.

Project detail page adds breadcrumb + key/value description card
+ recent-activity timeline (entries from existing activity feed
filtered to project_id).

Routes pass activeNav=<surface>, mainWidth=wide (content for
project detail), sectionLabel=razón social, user, customer."
```

---

## Task 18b: Customer Credentials / Credential-requests / Activity / Profile restyled

**Files:**
- Replace: `views/customer/credentials/*.ejs`
- Replace: `views/customer/credential-requests/*.ejs`
- Replace: `views/customer/activity.ejs`
- Replace: `views/customer/profile/*.ejs`
- Modify: each `routes/customer/<surface>.js` to pass `activeNav`, `mainWidth`, `sectionLabel`, `user`, `customer`. The credential routes additionally pass `vaultLockedBanner: !isVaultUnlocked(request.session)`. The 2FA-regen branch of profile passes the QR svg.

This is the densest task in the plan because credentials carry the vault-locked banner + reveal modal contract from M7. **Do NOT change route logic** — only swap markup.

- [ ] **Step 1: Customer credentials list**

`views/customer/credentials/list.ejs`:

```ejs
<%- include('../../components/_page-header', {
  eyebrow: customer.razon_social,
  title:   'Credentials',
  actions: '<a class="btn btn--primary btn--md" href="/customer/credentials/new">+ Add credential</a>'
}) %>

<%
  var rows = (credentials || []).map(function(c) {
    var actions = '<a class="btn btn--ghost btn--sm" href="/customer/credentials/' + c.id + '/view">Reveal</a>';
    return { cells: [ c.service_label, c.username || '—', euDateTime(c.updated_at), actions ] };
  });
%>
<%- include('../../components/_table', {
  density: 'dense',
  columns: [
    { label: 'Service',  align: 'left'  },
    { label: 'Username', align: 'left'  },
    { label: 'Updated',  align: 'left'  },
    { label: '',         align: 'right' }
  ],
  rows: rows,
  emptyState: 'No credentials yet — add one or wait for your account manager to fulfil a credential request.'
}) %>
```

`views/customer/credentials/new.ejs`:

```ejs
<%- include('../../components/_page-header', { eyebrow: customer.razon_social + ' · CREDENTIALS', title: 'Add credential' }) %>

<% if (typeof error !== 'undefined' && error) { %>
  <%- include('../../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="/customer/credentials" autocomplete="off" class="form-stack">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <%- include('../../components/_input', { name: 'service_label', type: 'text',     label: 'Service', required: true }) %>
  <%- include('../../components/_input', { name: 'username',      type: 'text',     label: 'Username (optional)' }) %>
  <%- include('../../components/_input', { name: 'secret',        type: 'password', label: 'Secret', required: true, showHideToggle: true,
    helper: 'Stored encrypted under your customer key. Never displayed back to admins or logged.' }) %>
  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Add credential' }) %>
    <%- include('../../components/_button', { variant: 'ghost',   size: 'md', href: '/customer/credentials', label: 'Cancel' }) %>
  </div>
</form>
```

`views/customer/credentials/view.ejs` (the reveal modal page — current behaviour shows a 30s countdown then auto-clears):

```ejs
<%- include('../../components/_page-header', {
  eyebrow: customer.razon_social + ' · CREDENTIALS',
  title:   credential.service_label
}) %>

<%- include('../../components/_breadcrumb', { trail: [
  { label: 'Credentials', href: '/customer/credentials' },
  { label: credential.service_label, href: null }
]}) %>

<article class="card card--modal" role="dialog" aria-modal="true" aria-labelledby="cred-reveal-title">
  <h2 id="cred-reveal-title" class="card__title">Decrypted credential</h2>
  <dl class="kv">
    <dt>Service</dt>  <dd><%= credential.service_label %></dd>
    <% if (credential.username) { %><dt>Username</dt> <dd><%= credential.username %></dd><% } %>
    <dt>Secret</dt>   <dd><code class="reveal-secret"><%= secretPlain %></code></dd>
  </dl>
  <p class="reveal-countdown" data-deadline="<%= deadlineMs %>">This window auto-closes in <span data-countdown>30</span> seconds.</p>
  <div class="form-actions">
    <button class="btn btn--secondary btn--sm" type="button" data-copy="<%= secretPlain %>">Copy secret</button>
    <%- include('../../components/_button', { variant: 'ghost', size: 'sm', href: '/customer/credentials', label: 'Close' }) %>
  </div>
</article>

<script nonce="<%= nonce %>">
  (function () {
    var el = document.querySelector('[data-countdown]');
    var card = document.querySelector('.reveal-countdown');
    var deadline = parseInt(card.getAttribute('data-deadline'), 10);
    var copyBtn = document.querySelector('[data-copy]');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var v = copyBtn.getAttribute('data-copy');
        if (navigator.clipboard) navigator.clipboard.writeText(v);
      });
    }
    function tick() {
      var s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (el) el.textContent = s;
      if (s <= 0) {
        var sec = document.querySelector('.reveal-secret');
        if (sec) sec.textContent = '••••••••••';
        if (copyBtn) copyBtn.disabled = true;
        return;
      }
      setTimeout(tick, 200);
    }
    tick();
  })();
</script>
```

The route already calls `service.view(...)` which returns the plaintext + sets `vault_unlocked_at`. The route passes `secretPlain`, `deadlineMs = Date.now() + 30000`, `credential` to the view. **Route logic unchanged.**

Append `.reveal-countdown` style:

```css
.reveal-secret { font-family: var(--f-mono); font-size: var(--f-md); }
.reveal-countdown { font-size: var(--f-xs); color: var(--fg-on-light-muted); }
```

- [ ] **Step 2: Customer credential-requests**

`views/customer/credential-requests/list.ejs` follows the dense-table pattern. Columns: Created · Service · Status · Actions. Action column shows a "Cancel" button for `pending`, a "Fulfil" link for `approved`, "Mark not applicable" link for `approved`. The handler passes `vaultLockedBanner: !isVaultUnlocked(request.session)` so the banner pins under the top-bar; reveal/fulfil paths gate on the vault-locked contract via the existing route logic.

`views/customer/credential-requests/new.ejs`: form-stack of `_input` partials for service + reason, primary submit "File request."

`views/customer/credential-requests/detail.ejs`: page-header + breadcrumb + per-field input (the existing dynamic form per M7.4 — preserve the field-shape iteration, just swap each field render to `_input`).

- [ ] **Step 3: Customer activity**

`views/customer/activity.ejs`:

```ejs
<%- include('../components/_page-header', {
  eyebrow: customer.razon_social,
  title:   'Account activity'
}) %>

<% if (events && events.length) { %>
  <ul class="activity">
    <% events.forEach(function(e) { %>
      <li class="activity__item">
        <p class="eyebrow"><%= euDateTime(e.ts) %><% if (e.actor_display_name) { %> · <%= e.actor_display_name %><% } %></p>
        <p><%= e.message %></p>
      </li>
    <% }) %>
  </ul>
  <% if (typeof pagination !== 'undefined' && pagination && pagination.olderHref) { %>
    <nav class="pagination" aria-label="Pagination">
      <a class="btn btn--ghost btn--sm" href="<%= pagination.olderHref %>">Older →</a>
    </nav>
  <% } %>
<% } else { %>
  <p>No recent activity.</p>
<% } %>
```

The activity-feed allow-list (`SAFE_METADATA_KEYS` from `lib/activity-feed.js`) is canonical — the route already produces sanitised `e.message`. M11 doesn't touch the allow-list.

- [ ] **Step 4: Customer profile**

`views/customer/profile/identity.ejs`, `password.ejs`, `2fa.ejs`, `sessions.ejs` — shape is identical to the admin profile from T19, with three differences:

1. `_profile-tabs` is invoked with `surface: 'customer'`.
2. Form actions POST to `/customer/profile/...` not `/admin/profile/...`.
3. `2fa.ejs` regen flow uses `lib/qr.js` server-side just like the admin path:

```js
// inside the customer 2fa-regen handler:
const qrSvg = await renderTotpQrSvg(otpauthUri, {
  label: `New TOTP enrolment for ${customerUser.email}`
});
return reply.view('customer/profile/2fa', {
  regenInProgress: true,
  enrolSecret,
  qrSvg,
  csrfToken,
  activeNav: 'profile',
  mainWidth: 'content',
  sectionLabel: customer.razon_social + ' · PROFILE',
  user: { name: customerUser.name },
  customer
});
```

- [ ] **Step 5: Build, restart, smoke, test, commit**

```bash
sudo chown -R root:portal-app /opt/dbstudio_portal/views/customer
sudo find /opt/dbstudio_portal/views/customer -type d -exec chmod 0750 {} +
sudo find /opt/dbstudio_portal/views/customer -type f -exec chmod 0640 {} +
sudo chown root:portal-app /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/customer/*.js
sudo chmod 0640 /opt/dbstudio_portal/public/styles/app.src.css /opt/dbstudio_portal/routes/customer/*.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo systemctl restart portal.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add views/customer/credentials/ views/customer/credential-requests/ views/customer/activity.ejs views/customer/profile/ public/styles/app.src.css routes/customer/credentials.js routes/customer/credential-requests.js routes/customer/activity.js routes/customer/profile.js
sudo -u root git commit -m "feat(m11-18b): customer credentials / credential-requests / activity / profile restyled

- credentials/list (dense), credentials/new (form-stack with
  show/hide toggle), credentials/view (reveal modal — kv table
  + 30s countdown + clipboard copy + auto-mask). Route logic
  unchanged: vault-lock 5-min sliding window contract from M7
  preserved; locked-vault banner pinned via locals.vaultLockedBanner.
- credential-requests/list (dense, action matrix per status),
  credential-requests/new (form-stack), credential-requests/detail
  (per-field dynamic form preserved byte-identical except
  swapped to _input partials).
- activity.ejs: timeline list of events, pagination footer.
  SAFE_METADATA_KEYS allow-list contract preserved.
- customer profile sub-tabs (identity/password/2fa/sessions)
  mirror admin profile from m11-15. 2fa regen renders QR via
  lib/qr.js + _qr partial."
```

---

## Task 20: Extend scripts/a11y-check.js with M11 pattern checks

> **NOTE (2026-04-30 rewire):** Was Task 19. Renumbered after the new T15 polish task was inserted.

**Files:**
- Modify: `scripts/a11y-check.js`

The existing script (M9 Task 9.6) checks `<img>` alt, heading order, and form-input labels. Append M11-specific checks. The script remains informational (exit 0); a non-zero exit was never used and the reporting flow lets the implementer scan and fix offenders.

- [ ] **Step 1: Read the existing script**

```bash
cat /opt/dbstudio_portal/scripts/a11y-check.js
```

Note the `flag(file, line, msg)` helper, the `offenders` array, and the iteration over `views/**/*.ejs`. The script reads each file as a string and runs regex checks.

- [ ] **Step 2: Append the M11 checks**

Add the following checks at the bottom of the file, immediately before the summary block. Each takes the file path + content and pushes onto `offenders` via `flag(...)`.

```js
// ---- M11 a11y checks ---------------------------------------------------

// Every <nav> must carry an aria-label.
const NAV_RE = /<nav\b([^>]*)>/gi;
function checkNavLabel(file, content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/<nav\b([^>]*)>/i);
    if (!m) continue;
    if (!/aria-label\s*=/.test(m[1])) {
      flag(file, i + 1, '<nav> missing aria-label');
    }
  }
}

// Hamburger button must carry aria-expanded + aria-controls referring
// to an element ID that exists in the same template tree.
function checkHamburgerWiring(file, content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/class="[^"]*top-bar__hamburger/.test(lines[i])) continue;
    if (!/aria-expanded=/.test(lines[i])) flag(file, i + 1, 'hamburger button missing aria-expanded');
    if (!/aria-controls=/.test(lines[i])) flag(file, i + 1, 'hamburger button missing aria-controls');
  }
}

// Every QR partial (_qr.ejs) emits an <svg role="img" aria-label="...">
// where the aria-label does NOT contain otpauth://. Since lib/qr.js
// enforces this server-side already, this check is a static sanity
// pass: warn if any view directly hand-writes an <svg> with
// aria-label containing the URI.
function checkQrLabel(file, content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/aria-label="([^"]*otpauth:\/\/[^"]*)"/i);
    if (m) flag(file, i + 1, 'aria-label contains otpauth:// (label MUST NOT carry the secret URI)');
  }
}

// Modal cards (card--modal) must carry aria-modal="true" and
// aria-labelledby pointing at an id present in the same template.
function checkModalCardLabelling(file, content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/class="[^"]*card--modal/.test(lines[i])) continue;
    // The aria-* attrs may be on the same line or the next one or two.
    const window2 = lines.slice(Math.max(0, i - 1), i + 3).join(' ');
    if (!/aria-modal="true"/.test(window2)) {
      flag(file, i + 1, '.card--modal missing aria-modal="true"');
    }
    if (!/aria-labelledby=/.test(window2)) {
      flag(file, i + 1, '.card--modal missing aria-labelledby');
    }
  }
}

// Sidebar's active item must carry aria-current="page".
function checkSidebarActiveAriaCurrent(file, content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/class="[^"]*sidebar__item--active/.test(lines[i])) continue;
    // Look at the next 1-2 lines for the <a> tag.
    const window2 = lines.slice(i, i + 3).join(' ');
    if (!/aria-current="page"/.test(window2)) {
      flag(file, i + 1, '.sidebar__item--active without aria-current="page"');
    }
  }
}

// --c-slate may be used as text colour ONLY on dark grounds.
// Approximation: if a view inside views/admin/** or views/customer/**
// or any template that doesn't include `body.public` uses
// color: var(--c-slate) inline, flag it.
function checkSlateOnLight(file, content) {
  if (!/views\/(admin|customer)\//.test(file)) return;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/color:\s*var\(--c-slate\)/.test(lines[i])) {
      flag(file, i + 1, '--c-slate used as text colour on a light surface (allowed only as border/divider)');
    }
  }
}

for (const file of viewFiles) {
  const content = readFileSync(file, 'utf8');
  checkNavLabel(file, content);
  checkHamburgerWiring(file, content);
  checkQrLabel(file, content);
  checkModalCardLabelling(file, content);
  checkSidebarActiveAriaCurrent(file, content);
  checkSlateOnLight(file, content);
}
```

If `viewFiles` is not the variable name in the existing script, rename to match. The original script iterates the `views/` tree and stores files in some collection — reuse that.

- [ ] **Step 3: One additional CSS-side check — reduced-motion zero-out coverage**

After the file-iteration block, also scan `public/styles/app.src.css` for `transition:` / `animation:` rules whose properties don't have a `prefers-reduced-motion` partner. This is a softer check (a transition on `:hover` color is fine without a partner; only motion-bearing transitions matter). Add as a post-iteration block:

```js
// ---- Reduced-motion partner-check (advisory) --------------------------

const cssPath = join(ROOT, 'public', 'styles', 'app.src.css');
const css = readFileSync(cssPath, 'utf8');
const cssLines = css.split('\n');
const motionProps = /transform|opacity|translate/;
let hasMotionRule = false;
let hasReducedMotionPartner = false;
for (const line of cssLines) {
  if (/transition\s*:[^;]*\b(?:transform|opacity|translate)\b/.test(line)) hasMotionRule = true;
  if (/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(line))           hasReducedMotionPartner = true;
}
if (hasMotionRule && !hasReducedMotionPartner) {
  flag(cssPath, 0, 'motion-bearing transition declared without any prefers-reduced-motion: reduce partner block');
}
```

- [ ] **Step 4: Run the script and fix every offender it reports**

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/a11y-check.js
```

Expected: 0 offenders. If the script reports offenders, fix them inline:
- A `<nav>` without `aria-label` → add it.
- A modal card without `aria-modal` → add it.
- A `--c-slate` text on a light surface → swap to `--fg-on-light-muted`.

If the existing M9 checks report offenders, those are pre-M11 issues — fix them in the same task (they're in the M11 redesign anyway).

- [ ] **Step 5: Re-apply perms, smoke, test, commit**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/scripts/a11y-check.js
sudo chmod 0750 /opt/dbstudio_portal/scripts/a11y-check.js
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh

cd /opt/dbstudio_portal
sudo -u root git add scripts/a11y-check.js
# also any view files you fixed in step 4:
sudo -u root git add views/
sudo -u root git commit -m "feat(m11-19): extend a11y-check.js with M11 pattern checks

Adds six new checks to the static a11y scanner:
- <nav> must carry aria-label.
- Hamburger button must carry aria-expanded + aria-controls.
- aria-label on QR SVG must NOT contain otpauth:// (defensive
  static check; lib/qr.js enforces server-side).
- .card--modal must carry aria-modal=true + aria-labelledby.
- .sidebar__item--active must contain an <a> with aria-current=page.
- --c-slate is forbidden as text colour on light surfaces
  (allowed for borders/dividers only).

Adds an advisory CSS-side check: motion-bearing transitions
require a prefers-reduced-motion: reduce partner block in
public/styles/app.src.css. Existing M9 checks unchanged.

Reports 0 offenders post-redesign."
```

---

## Task 21: Add probe #10 to scripts/smoke.sh

> **NOTE (2026-04-30 rewire):** Was Task 20. Renumbered.

**Files:**
- Modify: `scripts/smoke.sh`

The smoke script currently runs 9 probes. Probe #10 is "TOTP enrol page renders QR" — gated on `RUN_M11_SMOKE=1` so it doesn't run in production smoke runs.

- [ ] **Step 1: Read the existing smoke script**

```bash
cat /opt/dbstudio_portal/scripts/smoke.sh
```

- [ ] **Step 2: Append probe #10**

Append the following block at the end of the script's probe sequence, immediately before the final summary line. Adapt the `pass`/`fail` helper names to whatever the existing script uses:

```bash
# Probe 10 — TOTP enrol page renders QR (gated)
if [[ "${RUN_M11_SMOKE:-}" == "1" ]]; then
  TOKEN="${M11_SMOKE_WELCOME_TOKEN:-}"
  if [[ -z "$TOKEN" ]]; then
    fail "10/10 RUN_M11_SMOKE=1 but M11_SMOKE_WELCOME_TOKEN is empty — set it to a seeded admin or customer welcome token"
  else
    BODY=$(curl -sS -L "http://127.0.0.1:3400/welcome/$TOKEN" || true)
    if echo "$BODY" | grep -q '<svg[^>]*role="img"[^>]*aria-label="[^"]*TOTP'; then
      pass "10/10 TOTP enrol page renders inline SVG QR"
    else
      fail "10/10 TOTP enrol page did not render inline SVG QR"
    fi
  fi
else
  echo "10/10 (skipped: set RUN_M11_SMOKE=1 + M11_SMOKE_WELCOME_TOKEN to exercise)"
fi
```

If the existing script counts pass/fail in a variable (e.g. `PASS_COUNT`, `TOTAL`), update those counters appropriately. Match the existing style.

- [ ] **Step 3: Run smoke without the gate, then with the gate (against a test token)**

```bash
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

Expected: probes 1–9 pass; probe 10 reports skipped.

To exercise probe 10 manually (during M11 acceptance — operator action; not part of this task's verification):
```bash
# Mint a one-shot welcome token, then:
sudo RUN_M11_SMOKE=1 M11_SMOKE_WELCOME_TOKEN=<token> bash /opt/dbstudio_portal/scripts/smoke.sh
```

For this task's verification, the skipped state is sufficient.

- [ ] **Step 4: Re-apply perms, commit**

```bash
sudo chown root:root /opt/dbstudio_portal/scripts/smoke.sh
sudo chmod 0755 /opt/dbstudio_portal/scripts/smoke.sh

cd /opt/dbstudio_portal
sudo -u root git add scripts/smoke.sh
sudo -u root git commit -m "feat(m11-20): smoke.sh probe #10 — TOTP enrol QR renders (gated)

Adds a tenth probe gated on RUN_M11_SMOKE=1 + an
M11_SMOKE_WELCOME_TOKEN env. Curls /welcome/<token> and asserts
the response body contains an inline <svg role=\"img\"
aria-label=\"TOTP*\">. Default off (skipped) so production
smoke runs (1-9) don't generate throwaway tokens against the
live DB. Exercised once during M11 acceptance dry-run."
```

The smoke script's existing perms convention is `0755 root:root` (it's a system script under `scripts/`, not a portal-owned one — verify the existing chmod with `ls -la /opt/dbstudio_portal/scripts/smoke.sh` and match exactly).

---

## Task 22: Final cross-surface polish sweep + acceptance dry-run + v1.0 tag

> **NOTE (2026-04-30 rewire):** Was Task 21 ("Author docs/superpowers/m11-acceptance-dryrun.md"). Scope broadened: this task now carries explicit budget for fixing any cross-surface drift caught during the dry-run walk (T17/T18 may have introduced inconsistencies vs. T15's contract; this is where they get reconciled), in addition to authoring the dryrun doc and capturing the screenshot pairs. The dryrun doc step below stays as written; what's added is a leading "polish sweep" pass that walks the full surface set at 1280×800 + 390×844, catalogues drift, fixes inline (or files a tightly-scoped follow-up commit per surface), and only THEN authors the dryrun template for the operator to fill in. v1.0.0 tag fires only after the dryrun is signed off — unchanged from before.

**Files:**
- Create: `docs/superpowers/m11-acceptance-dryrun.md`

This document carries the operator's screenshot-pair sign-off at the close of M11. The implementer ships a template; the operator fills it in.

- [ ] **Step 1: Write the dry-run doc**

Write `/opt/dbstudio_portal/docs/superpowers/m11-acceptance-dryrun.md`:

```markdown
# M11 — Acceptance Dry Run

> **Purpose:** Walk the M11 acceptance criteria from the design spec
> (`docs/superpowers/specs/2026-04-30-m11-visual-redesign-design.md`)
> line-by-line, prove each one, and capture the side-by-side
> screenshot pairs for the operator's sign-off.
>
> **Filled in by:** the operator after M11 implementation lands.
> **Sign-off action:** commit this file with the screenshots and the
> sign-off line at the bottom completed.

---

## 1. Visual consistency with `dbstudio.one`

Capture each pair at **1280×800** (desktop) and **390×844** (mobile),
both surfaces in light mode (or whatever the marketing site's default
is on the day). Save under `docs/superpowers/m11-screenshots/`.

| Pair | Marketing source | Portal target | 1280×800 | 390×844 |
|---|---|---|---|---|
| Hero rhythm | `https://dbstudio.one/` (above-the-fold) | `https://portal.dbstudio.one/login` | _attach_ | _attach_ |
| Section grid | `https://dbstudio.one/` (Capabilities section) | `/customer/dashboard` (bento grid) | _attach_ | _attach_ |
| Footer | `https://dbstudio.one/` (footer) | any portal page footer | _attach_ | _attach_ |
| Card | `https://dbstudio.one/` (Services tile) | `/customer/dashboard` (single card) | _attach_ | — |
| Login mobile | — | `/login` full page on 390×844 | — | _attach_ |
| Dashboard mobile | — | `/customer/dashboard` full page on 390×844 | — | _attach_ |

Operator note any deltas worth fixing in v1.1: ___________________________

## 2. A11y re-audit

Run the static scanner:

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/a11y-check.js
```

Paste the output:

```
(paste here)
```

Expected: 0 offenders.

## 3. Tests

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: all tests green (target ≥ 580; we added qr unit tests + customer-summary integration tests).

Paste the trailing summary line: ___________________________

## 4. Smoke

```bash
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

Expected: probes 1–9 pass, probe 10 skipped. Paste the trailing summary line: ___________________________

## 5. Probe 10 (one-shot exercise)

Reset the welcome token (or use the bootstrap admin's existing token if still valid):

```bash
# from RUNBOOK § "Reset an admin's welcome flow"
# → produces a fresh token URL
```

Then:

```bash
sudo RUN_M11_SMOKE=1 M11_SMOKE_WELCOME_TOKEN=<token-from-the-URL> bash /opt/dbstudio_portal/scripts/smoke.sh
```

Expected: probe 10 passes ("TOTP enrol page renders inline SVG QR"). Paste the line:
___________________________

## 6. Bootstrap admin onboarding (live)

Walk this end-to-end on a phone-sized viewport in a clean browser
profile (no portal cookies):

- [ ] Open the welcome email; click the link.
- [ ] Set a password (>= 12 chars, not in HIBP).
- [ ] Scan the QR with an authenticator app (Authy / 1Password / Google Authenticator / Bitwarden).
- [ ] Enter the 6-digit code; press Finish setup.
- [ ] See the 10 backup codes; save them in your password manager.
- [ ] Click the "I've saved my codes" button.
- [ ] Land on `/admin/customers` (the post-login default for an admin).

Did onboarding complete cleanly? Yes / No (and notes): ___________________________

## 7. §11 acceptance line: "1 customer + 1 credential decrypted cleanly"

Once the bootstrap admin is in:

- [ ] Create one test customer at `/admin/customers/new` (e.g. razón social "M11 Test S.L.", CIF "B99999999"). Capture the invite URL on the post-create confirmation page.
- [ ] Open the customer welcome URL in a different browser profile; walk customer onboarding (password + QR + TOTP + backup codes).
- [ ] Generate one NDA at `/admin/customers/<id>/ndas/new`. Project optional.
- [ ] Add one credential at `/admin/customers/<id>/credentials/new` (or via a credential request — operator's preference).
- [ ] Verify the customer can see the credential at `/customer/credentials` and reveal it (vault-unlock with their password).
- [ ] Run `sudo bash /opt/dbstudio_portal/scripts/restore-drill.sh`. Confirm the round-trip green branch fires the "1 customer + 1 credential decrypted cleanly" message.
- [ ] Append a new row to RUNBOOK § "Backup restore drill" log table with the date + outcome.

## 8. Sign-off

Operator: _____________________________________________

Date (DD/MM/YYYY): __________________________________________

Version tagged: v1.0.0 (after this doc is filled in and committed,
operator runs `git tag v1.0.0 && git push origin v1.0.0`).

---
```

- [ ] **Step 2: Re-apply perms, commit**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/docs/superpowers/m11-acceptance-dryrun.md
sudo chmod 0640 /opt/dbstudio_portal/docs/superpowers/m11-acceptance-dryrun.md

cd /opt/dbstudio_portal
sudo -u root git add docs/superpowers/m11-acceptance-dryrun.md
sudo -u root git commit -m "docs(m11-21): m11-acceptance-dryrun.md — operator sign-off template

Templates the §11 acceptance walk: screenshot pairs (1280x800 +
390x844) for hero/grid/footer/card; a11y scanner output; tests
+ smoke + probe-10 paste-in slots; bootstrap-admin onboarding
checklist; the '1 customer + 1 credential decrypted cleanly'
restore-drill follow-through; final operator sign-off line +
v1.0.0 tag instruction.

Operator fills this in after M11 implementation lands and
commits the screenshots + outputs alongside it."
```

---

## Self-review

After all 21 commits land, run this pass before declaring M11 done:

1. **Spec coverage:** every Q1–Q10 resolution and every § in the spec ("Decisions taken in the brainstorm", "Surfaces in scope", "Design system source", "Implementation order", "Component partials canonical list", "Server-side SVG QR module", "Customer dashboard summary", "A11y re-audit checks", "Smoke (additions)", "Acceptance criteria", "Operator artefacts to preserve", "Cross-cutting contracts that must NOT change") maps to one or more T1–T22 tasks. Cross-check against the spec verbatim. The new T15 (admin surface polish, inserted in the 2026-04-30 rewire) does not have a corresponding spec § — it's a polish-debt sweep against the marketing-site bar; its acceptance criteria are documented inline in the task body below.

2. **Placeholder scan:** `grep -RIn 'TODO\|TBD\|FIXME\|placeholder' /opt/dbstudio_portal/views/components/ /opt/dbstudio_portal/views/layouts/ /opt/dbstudio_portal/lib/qr.js /opt/dbstudio_portal/lib/customer-summary.js`. Expected: 0 hits.

3. **Type/locals consistency:** the `hero` local shape used in T9 (`{ eyebrow, title, lead }`) is the same in T10–T12. The `sectionLabel` local is uppercase eyebrow text in every place it's set. The `mainWidth` local is `'content'` for forms and `'wide'` for lists across every restyled route. The `activeNav` local matches the sidebar item key (`'customers'`, `'audit'`, `'profile'`, `'dashboard'`, `'ndas'`, etc.) with no drift.

4. **Cross-cutting contracts unchanged:** verify `git diff main..HEAD` shows zero changes to `lib/auth/middleware.js`, `lib/auth/vault-lock.js`, `lib/files.js`, `lib/secure-headers.js`, `lib/activity-feed.js`, any migration file, `lib/audit-query.js`, `pdf-service.js`, `templates/nda.html`, the M6 multipart contract code, the M7 step-up plumbing.

5. **Operator artefacts:** `cat /var/lib/portal/.age-recipients` still shows the same public key. The bootstrap admin row still exists (`SELECT id, email FROM admins WHERE id='019ddf64-c9c0-7171-aa05-cb509c579092'`). The welcome token row hasn't been consumed (its `consumed_at` column is still NULL). If the welcome token has expired, follow the spec's instruction to mint a new one and document the swap in `docs/build-log.md`.

If any of the above fails, fix inline before declaring M11 ready for v1.0.0 tag.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-m11-visual-redesign-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Each task in this plan is sized for one subagent commit (~5-15 min of focused work). Three-stage review at the natural seams (after T6 chrome lands; after T12 onboarding-blocker tasks land; after T15 polish contract is locked; after T22 closes).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?







