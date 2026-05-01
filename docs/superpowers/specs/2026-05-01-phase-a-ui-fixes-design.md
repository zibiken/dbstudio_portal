# Phase A — UI/UX fixes (design)

> **Status:** approved 2026-05-01 (operator). To be planned alongside Phase B (digest emails) and Phase C (invoice OCR) in a single combined implementation plan.

## Why

Operator-reported quality issues across the portal that are visually jarring or functionally broken. Each item is small but the cumulative effect undermines the "feels finished" bar of the v1 UI. None of these touch the security model; this phase is pure UX/templating.

## In scope

Six tightly-scoped fixes, listed below with the canonical resolution. No new features, no schema changes, no domain-logic changes.

### A1. Page width policy: every detail/edit page widens to match list pages

**Symptom.** Detail and edit pages (e.g. credential-request fulfil, project create/edit, invoice create/edit, NDA create/edit, profile, onboarding) currently render at `mainWidth: 'content'` (~1024 px container). List pages (NDAs, Documents, Credentials, Customers, Invoices) render at `mainWidth: 'wide'`. The result is a visible "surface jump" when the user navigates list → detail or list → edit.

**Resolution.** In every route handler that renders a customer or admin view, replace `mainWidth: 'content'` with `mainWidth: 'wide'`. Keep `mainWidth: 'wide'` where it is already set. The `surface` layout in `views/layouts/{customer,admin}.ejs` already reads `data-width` from `mainWidth`; no layout change required.

Two narrowness exceptions — keep `mainWidth: 'content'` only for:
- `customer/onboarding/*` — full-screen single-task surfaces with no sidebar context.
- `not-found.ejs` views — the empty-state hero looks better at narrow width.

(All other current `'content'` callsites flip to `'wide'`.)

### A2. `GET /admin` → 302 redirect to `/admin/customers`

**Symptom.** `https://portal.dbstudio.one/admin` returns Fastify 404 because no route is registered at that path. The admin top-bar logo also links to `/admin`.

**Resolution.** Add a single `GET /admin` route in a new file `routes/admin/_index.js` (or fold into an existing admin route module — implementation choice for the plan). The handler verifies admin session via the existing `requireAdminSession` middleware and replies with `reply.redirect('/admin/customers', 302)`. Unauthenticated requests fall through to the same auth flow as every other `/admin/*` route.

### A3. Defensive `form` default in EJS templates

**Symptom.** `POST /customer/credential-requests/:id/fulfil` returns 500 when validation succeeds (or any path that re-renders the GET-style detail page without supplying `form`). The crash is in `views/customer/credential-requests/detail.ejs:49` reading `form?.label`. Optional chaining only protects against `null`/`undefined` *property access* — the variable itself is not declared, so EJS throws `form is not defined`.

**Resolution.** Two-pronged:

1. In `detail.ejs`, replace the three `form?.…` reads with a hoisted local at the top of the file:
   ```ejs
   <% var f = (typeof form !== 'undefined' && form) ? form : {}; %>
   ```
   then use `f.label`, `f.payload?.[name]`, `f.reason`. Optional chaining on `f.payload` is fine because `f` itself is now always defined.

2. Audit every other EJS template under `views/customer/**` and `views/admin/**` for the pattern `<%= someUndefinedLocal?.field %>` and apply the same hoisted-default fix. (Scope-bounded: grep + spot-check.) No route-side changes are required if the templates default safely.

Rationale for fixing in the template, not the route: routes can forget to pass `form` (and several already do). The template should not crash on the GET path that the renderer is *intended* to call without `form`.

### A4. Universal sign-out button at the bottom of the sidebar (both surfaces)

**Symptom.** Today's sign-out is `<a class="top-bar__signout" href="/logout">Sign out</a>` in `_top-bar.ejs` — operator described it as "isn't even a button". On the customer dashboard there is no other sign-out affordance.

**Resolution.**

- Add a sign-out block at the bottom of both `_sidebar-customer.ejs` and `_sidebar-admin.ejs`, rendered as a ghost-variant button via the existing `_button` partial (`variant: 'ghost'`, `size: 'md'`, `href: '/logout'`, `label: 'Sign out'`). The block uses a new `.sidebar__footer` wrapper (CSS: `margin-top: auto;` so it pins to the bottom of the sidebar regardless of nav-item count).
- Render the sign-out button in **all** layout states, including vault-locked and mid-onboarding. The customer onboarding views currently use the `customer.ejs` layout but mark `mainWidth: 'content'`; the sidebar is already in that layout, so the sign-out comes "for free".
- Remove `<a class="top-bar__signout" …>` (and its container `.top-bar__menu` if it becomes empty after removal — keep the `top-bar__user` name display) from `_top-bar.ejs`.
- Mobile behaviour: the sidebar collapses behind the existing hamburger; opening the hamburger now also exposes the sign-out. No top-bar fallback.
- CSS for `.sidebar__footer`: padding to match `.sidebar__list` rhythm, top divider rule (`border-top: 1px solid var(--border-light);`) so the button reads as a footer affordance rather than another nav item.

### A5. Customer dashboard `.bento` → equal cells

**Symptom.** Operator reports the NDA card on the customer dashboard is larger than the other five cards. Likely caused by a "first child spans extra columns" rule in the `.bento` CSS, or by an asymmetric grid template.

**Resolution.** Replace the bento grid with an equal-cell responsive grid:

```css
.bento {
  display: grid;
  gap: var(--s-6);
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}
```

Remove any `:first-child { grid-column: span 2 }` (or similar) rules. All six dashboard cards become uniform. Grid auto-fits 1/2/3 columns at small/medium/large breakpoints. No HTML change in `dashboard.ejs`.

### A6. `.btn` rendered as `<a>` inside data tables loses its colour

**Symptom.** Operator reports the "Fulfil →" pill on `/customer/credential-requests` does not look like the "New customer" pill on `/admin/customers`, even though both are rendered with `class="btn btn--primary"`. Root cause: line 926 of `public/styles/app.src.css`:
```css
.data-table a { color: var(--c-obsidian); text-decoration: none; }
```
This rule wins specificity against `.btn--primary { color: var(--fg-on-dark) }` (higher specificity due to the `.data-table` ancestor + tag selector beats single class selector). Result: black text on a moss-green background, looking unstyled.

**Resolution.** Scope the table-link rule so it does not target buttons:
```css
.data-table a:not(.btn) { color: var(--c-obsidian); text-decoration: none; }
.data-table a:not(.btn):hover { color: var(--c-moss); text-decoration: underline; text-underline-offset: 3px; }
.data-table a:not(.btn):focus-visible { /* …existing focus rule… */ }
```
Apply the same `:not(.btn)` guard to the corresponding `:hover` and `:focus-visible` rules below it (lines 927–929 in `app.src.css`).

## Out of scope

- Any change to status-pill markup or to the `_button` partial itself.
- Any change to authentication, audit, or the logout handler at `routes/public/logout.js`.
- Any change to email templates, schema, or business logic. Phases B and C cover those.
- Adding new sidebar nav items.
- Reworking the page-header / breadcrumb components.

## Acceptance

For Phase A to be considered "done":

- Navigating list → detail → edit → list on all six customer features and all six admin features shows no surface-width jump.
- `GET /admin` while signed in as admin redirects to `/admin/customers`; while signed out, behaves like any other `/admin/*` URL (auth challenge).
- `GET /customer/credential-requests/:id` returns 200 even when no `form` is set; `POST …/fulfil` re-render on validation error returns 422 with prefilled values; both render without EJS errors.
- A single ghost-variant "Sign out" button appears at the bottom of the sidebar on both surfaces (customer and admin), in all layout states. The top bar contains no sign-out link.
- The customer dashboard renders six visually equal cards.
- The "Fulfil →" anchor inside `data-table` on `/customer/credential-requests` renders with white text on moss-green background, identical to the "New customer" button on `/admin/customers`.

## Test plan

- Unit/integration: extend the existing Vitest HTTP suite to assert the redirect status of `GET /admin` (302 → `/admin/customers`) for an authenticated admin.
- Snapshot: a Vitest render test for `customer/credential-requests/detail.ejs` with `form` undefined (proves the EJS no longer throws).
- Manual: a smoke pass per the acceptance list above, run on staging-equivalent localhost (no separate staging exists for the portal — verification is on the operator's dev session before commit-and-deploy).

## Risk

Low. No schema, no auth, no domain logic. Reverting any single fix is a one-commit revert. The only cross-cutting change is the CSS `:not(.btn)` guard on `.data-table a`; it only narrows a rule, it cannot widen unintended targets.
