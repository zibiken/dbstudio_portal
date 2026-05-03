# Portal UX pass — phases, sticky chrome, credential CRUD, confirm dialog

**Date:** 2026-05-03
**Status:** Approved (brainstorm complete)
**Repo:** `/opt/dbstudio_portal/`

---

## Problem

Four pain points reported by the project owner while using the staging portal:

1. The admin **project phase adder/editor** (`/admin/customers/:id/projects/:id`) is hard to use. Buttons collide on the row; every action is a form POST → redirect, so the page reloads and the viewport scrolls back to the top. With even a handful of phases, edits are punishing.
2. `<header class="page-header">` and `<nav class="subtabs">` scroll out of view on long pages. They should stay pinned to the top so content scrolls underneath.
3. Admins cannot create credentials directly — only by fulfilling a customer-side `credential_request`. They also cannot delete credentials. Customers can already add/edit/delete; admins need parity.
4. The `Delete <provider>…` button on `/customer/credentials` (a `<details>` summary) clips its own text inside the narrow right-aligned table cell, and visually does not match other portal buttons (which render through `_button.ejs`).

## Goals

- Phase editor: no full-page reload on any per-phase or per-checklist action; cleaner two-row layout with click-to-edit fields.
- Sticky `page-header` + `subtabs` on every admin and customer page, with a mobile-friendly stuck state.
- Admin can add and delete credentials (parity with customer CRUD), with every admin-side mutation visible in the customer's Activity feed + digest.
- One shared confirm-dialog component used for every destructive action in the portal.

## Non-goals (deferred)

- Drag-and-drop reorder for phases.
- Folding credential request fulfilment into the new admin "add credential" screen.
- Undo-toast infrastructure.
- Any DB schema changes.

---

## Architecture

Five shared additions, then four area-specific changes built on top of them.

### Shared

1. **`views/components/_confirm-dialog.ejs`** — native `<dialog>` element. Locals: `id`, `title`, `body`, `triggerLabel`, `triggerVariant` (default `'danger'`), `triggerSize` (default `'sm'`), `confirmLabel`, `formAction`, `formMethod` (default `'post'`), `csrfToken`. Renders an `_button.ejs` trigger that opens the dialog; confirm submits the embedded form. No-JS fallback: trigger acts as a `<details>` summary and the form submits inline.
2. **`public/js/dialog.js`** — ~30 lines. Opens/closes the `<dialog>`, focus trap, ESC closes, restores focus to trigger on close. Listens once at the document level via event delegation.
3. **CSS for sticky chrome** (appended to existing layout stylesheet) — `position: sticky` on `.page-header` and `.subtabs`, stacked `top` offsets so subtabs sit under the header. `data-stuck="true"` on `<body>` collapses eyebrow + subtitle on mobile and reduces vertical padding on desktop.
4. **`public/js/sticky-chrome.js`** — ~20 lines. IntersectionObserver on a 1px sentinel before the page-header; toggles `data-stuck` on `<body>`.
5. **`public/js/phase-editor.js`** — event-delegated `submit` handler on the phase section. Each phase/checklist form sets `data-fragment="row"`. Handler runs `fetch(form.action, { method, body })` with header `Accept: text/html-fragment`; server returns the updated row HTML; client swaps the node. After a successful swap the handler moves focus to the swapped row's first focusable element (typically the label) so screen-reader users keep context. No-JS fallback: forms POST normally and the server redirects to the same page with `#phase-<id>` so the browser scrolls back to the row.

### Area-specific

| Area | Built on | New files |
|------|----------|-----------|
| Phase editor | #1, #5 | `_phase-row.ejs`, `phase-editor.js`, `phases.css` |
| Sticky chrome | #3, #4 | `sticky-chrome.js`, layout CSS additions |
| Customer credentials delete | #1 | — (replaces inline `<details>`) |
| Admin credential CRUD | #1 + new routes | `admin/credentials/new.ejs`, route handlers, service functions |

---

## Section 1 — Phase editor (option B for reload, option A for layout)

### Layout

Each phase renders as `<li class="phase-row card" id="phase-<id>">` with two rows.

**Top row** (single flex line, wraps on narrow viewports):

- Drag-handle placeholder (visual only, dragless for v1 — keeps space for a later DnD pass).
- Index badge.
- **Label** — contenteditable `<span>` styled like an input on hover/focus. Autosaves on blur if the value changed (POST to existing `/phases/:id/rename`, fragment swap).
- **Status pill** — a `<button>` rendered in the pill's existing colour. Click opens a small popover menu of the four statuses; selecting one POSTs to `/phases/:id/status` and swaps the row.
- **Overflow `⋯` button** — opens a menu: "Move up", "Move down", "Delete phase…". Move up/down POST to `/phases/:id/reorder`. Delete uses `_confirm-dialog`.

**Bottom row** — the existing `<details>` checklist, structurally unchanged. Item rename/toggle/visibility/delete forms also go through the fragment-swap handler. The add-item form swaps the whole checklist `<ul>`.

The "New phase" form at the top of the section is also fragment-aware: on success the server returns the new `<li>` to append to the list and clears the input.

### Server changes

One helper in the route file: when `Accept: text/html-fragment` (or `?fragment=row`) is present, render `views/components/_phase-row.ejs` and return only that fragment. Without the header/param, behaviour is unchanged → redirect to `/admin/customers/:id/projects/:id#phase-<id>`. Same DB state in both modes.

### Files touched

- `views/admin/projects/detail.ejs` — replace inline phase markup with `include('../../components/_phase-row', { phase: p, customer, project, csrfToken })`.
- `views/components/_phase-row.ejs` — **new**, extracted + restyled per option A.
- `public/css/phases.css` (or appended to existing styles) — card-row layout, status-menu, overflow-menu, popover positioning.
- `public/js/phase-editor.js` — **new**, fragment-swap handler, autosave-on-blur for label, click-outside menu close, error-alert insertion on non-2xx.
- `routes/admin/projects.js` (or wherever phase routes live) — accept `?fragment=row` / `Accept: text/html-fragment`, render `_phase-row.ejs` partial; redirect-with-anchor otherwise.
- `views/components/_confirm-dialog.ejs` + `public/js/dialog.js` — **new shared**.

---

## Section 2 — Sticky chrome (option B — admin + customer)

### Behaviour

- `<header class="page-header">` and `<nav class="subtabs">` both `position: sticky`. Header at `top: 0`; subtabs at `top: var(--page-header-height)`. Pages without subtabs: header alone sticks.
- A 1px sentinel `<div>` immediately before `.page-header`. IntersectionObserver toggles `body[data-stuck="true"]` when the sentinel leaves the viewport.
- `data-stuck="true"`:
  - Mobile (`max-width: 640px`): hide `.eyebrow` and `.page-header__subtitle`, shrink title size, reduce vertical padding — target stuck-bar height ~48px.
  - Desktop: keep title; reduce vertical padding ~20%; subtle bottom shadow so chrome reads as floating.
- `.page-header__title` in the stuck state gets `max-width: 100%` + `overflow: hidden` + `text-overflow: ellipsis` so long customer names truncate instead of triggering a layout shift when the eyebrow/subtitle collapse.
- `.page-header` and `.subtabs` get a solid background (existing surface token) so content scrolls *under*, not through.
- `z-index` above page content but below `<dialog>` (which uses the browser top layer anyway).
- `scroll-margin-top: calc(var(--page-header-height) + var(--subtabs-height) + 1rem)` on `.phase-row` (and any other anchor target) so no-JS fallback redirects to `#phase-<id>` don't land hidden under the chrome.

### Files touched

- `views/layouts/*.ejs` — add the 1px sentinel `<div class="chrome-sentinel"></div>` immediately before each `_page-header` include (admin + customer layouts).
- `public/css/layout.css` (or equivalent) — sticky rules, stuck-state collapse rules, scroll-margin.
- `public/js/sticky-chrome.js` — **new**, IntersectionObserver + `data-stuck` toggle.
- `views/components/_page-header.ejs` — no markup change; CSS only.

---

## Section 3 — Admin credential CRUD (option A + C)

### New service functions in `domain/credentials/service.js`

**`createByAdmin(db, { adminId, customerId, provider, label, payload, projectId }, ctx)`**

- Mirrors `createByAdminFromRequest` but takes `customerId` directly — no `lockOpenRequest`, no `credential_requests` row touched.
- Same KEK/DEK path: `requireKek(ctx)` + `loadCustomerDekRow(tx, customerId)` + `unwrapDek` + `encrypt(plaintext, dek)`.
- Asserts `customer.status === 'active'` and `assertProjectBelongsToCustomer(tx, projectId, customerId)` (reuses existing helpers).
- `createdBy: 'admin'`.
- Audit row: `actor_type: 'admin'`, `action: 'credential.created'`, **`visibleToCustomer: true`** (per option C).
- Phase B digest event for the customer: `credential.created`, `bucket: 'fyi'` (lands in customer Activity feed and email digest).

**`deleteByAdmin(db, { adminId, credentialId }, ctx)`**

- Mirrors the existing customer-side delete exactly (matches its hard-vs-soft semantic — to be confirmed at implementation time by reading `deleteByCustomer`; spec is "match it").
- Audit row: `actor_type: 'admin'`, `action: 'credential.deleted'`, `visibleToCustomer: true`.
- Phase B digest event: `credential.deleted`, `bucket: 'fyi'`.

### New routes in `routes/admin/credentials.js`

- `GET /admin/customers/:id/credentials/new` — renders `views/admin/credentials/new.ejs`. Fields: provider, label, scope (project dropdown including company-wide), payload (provider-specific fields). Step-up gated using the same vault-unlock check the reveal route uses.
- `POST /admin/customers/:id/credentials` — calls `createByAdmin`, redirects to credential detail.
- `POST /admin/customers/:id/credentials/:credId/delete` — calls `deleteByAdmin`, redirects to the credentials list with a flash.

### View tweaks

- `views/admin/credentials/list.ejs`:
  - `_list-toolbar` gets a CTA `Add a credential` linking to `/new`.
  - Empty-state CTA also points to `/new` (currently points to credential-requests/new — keep credential-requests path as the secondary CTA).
  - Each row gets a Delete trigger using `_confirm-dialog` (`triggerVariant: 'danger'`, `triggerSize: 'sm'`).
- `views/admin/credentials/show.ejs`:
  - Add a Delete button next to the existing Edit, also via `_confirm-dialog`.

---

## Section 4 — Customer credentials delete button (option A)

`views/customer/credentials/list.ejs` lines 77–85 today render `<details>` with a `Delete <label>…` summary that clips. Replace with `_confirm-dialog`:

```ejs
<%- include('../../components/_confirm-dialog', {
  id: 'delete-cred-' + c.id,
  triggerLabel: 'Delete',
  triggerVariant: 'danger',
  triggerSize: 'sm',
  title: 'Delete ' + (c.label || c.provider) + '?',
  body: 'Permanently removes this credential from your vault. Cannot be undone.',
  confirmLabel: 'Delete',
  formAction: '/customer/credentials/' + c.id + '/delete',
  csrfToken: csrfToken
}) %>
```

The trigger uses the same `_button.ejs` shape, size, and typography as `Add a credential` — only the colour swaps to danger red. No item label in the trigger, so no clipping.

### Files touched

- `domain/credentials/service.js` — new `createByAdmin`, new `deleteByAdmin`.
- `routes/admin/credentials.js` — new `GET /new`, `POST /`, `POST /:credId/delete`.
- `views/admin/credentials/new.ejs` — **new**.
- `views/admin/credentials/list.ejs` — toolbar CTA + per-row delete dialog.
- `views/admin/credentials/show.ejs` — delete dialog next to Edit.
- `views/customer/credentials/list.ejs` — replace `<details>` with `_confirm-dialog`.
- `routes/customer/credentials.js` — no changes (existing `POST /customer/credentials/:id/delete` handles the form).

---

## Testing

- **Unit:** `createByAdmin`, `deleteByAdmin` — happy path, vault locked (KEK absent), cross-customer project rejection, inactive customer rejection, audit row written with `visibleToCustomer: true`, digest event fanned out for `bucket: 'fyi'`.
- **Route-level (admin credentials):** auth gating (non-admin → 401/403), CSRF rejection, step-up redirect when vault locked, success path 302 → detail / list.
- **Route-level (phase + checklist):** every existing form route returns the row fragment when `?fragment=row` is present, redirect-with-anchor otherwise. Same DB state in both modes — assert via shared "submit twice, compare" helper.
- **View-level snapshot:** `_phase-row.ejs`, `_confirm-dialog.ejs`.
- **Manual:** keyboard nav through the new dialog (focus trap, ESC closes, focus restores to trigger), screen-reader pass on autosave-on-blur label, mobile sticky-chrome collapse below 640px, no-JS fallback path for one phase action and one credential delete.

## Error handling

- `phase-editor.js` fetch handler: on success, moves focus to the swapped row's first focusable element (preserves screen-reader context). On non-2xx, parses error HTML and inserts an inline `_alert` above the affected row. On network failure, removes its own `submit` listener and lets the form do a normal browser submit.
- Confirm dialog: with JS, dialog opens; submit is a normal `<form>` POST inside the dialog (full reload is fine for one-shot destructive actions — no fetch needed). Without JS, trigger acts as a `<details>` summary and the form submits inline.
- Sticky chrome: pure CSS works without JS; `data-stuck` collapse on mobile is the only JS-dependent niceness.

## Rollout

- Single staging deploy via `/usr/local/bin/staging-build.sh "<message>"`.
- No DB migrations.
- SW bump *not* needed for staging; will be needed when this ships to prod.
- Smoke checks after deploy:
  1. Load `/admin/customers/:id/projects/:id`. Edit a phase label (blur). Change a phase status. Delete a phase via dialog. Toggle a checklist item. Confirm: no flash, no scroll jump, no full reload.
  2. Scroll a long admin page. Confirm chrome stays stuck at the top with mobile collapse below 640px.
  3. Add a credential as admin. Delete it as admin. Confirm both audit rows are visible in the customer's Activity feed.
  4. Delete a credential as customer via the new dialog. Confirm matching shape/size with the `Add a credential` button.

## Out of scope (deferred)

- Drag-and-drop reorder for phases.
- Folding credential request fulfilment into the new admin add screen.
- Undo-toast infrastructure.
