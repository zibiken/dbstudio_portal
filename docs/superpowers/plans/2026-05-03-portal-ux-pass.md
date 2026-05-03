# Portal UX Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline `<details>` confirms with a shared `<dialog>`-based component, make `.page-header` + `.subtabs` sticky on every admin and customer page, give admins direct create/delete on credentials with customer-visible audit + digest, and rebuild the phase editor with a two-row card layout that updates in place via fetch+fragment swap (no full page reload).

**Architecture:** Five shared additions (`_confirm-dialog.ejs` + `dialog.js`, sticky-chrome CSS + JS, `phase-editor.js`) plus four area-specific changes built on top. Implemented in dependency order so every task ships green on its own. New services mirror existing ones (`createByAdmin` ↔ `createByAdminFromRequest`, `deleteByAdmin` ↔ `deleteByCustomer`). Phase routes content-negotiate on `Accept: text/html-fragment` (or `?fragment=row`) — fragment requests render `_phase-row.ejs`; everything else continues redirecting with `#phase-<id>`.

**Tech Stack:** Fastify + EJS + Kysely/Postgres backend, vanilla JS (no framework), existing `_button.ejs` / `_alert.ejs` / `_input.ejs` components, vitest + `app.inject()` integration tests, AES-GCM envelope crypto from `lib/crypto/envelope.js`.

**Spec:** `docs/superpowers/specs/2026-05-03-portal-ux-pass-design.md` (commit `c587c5f`).

---

## File Map

**New files:**
- `views/components/_confirm-dialog.ejs` — reusable confirm-dialog component
- `views/components/_phase-row.ejs` — single-phase card partial (extracted)
- `views/admin/credentials/new.ejs` — admin add-credential form
- `public/js/dialog.js` — `<dialog>` open/close/focus-trap
- `public/js/sticky-chrome.js` — IntersectionObserver `data-stuck` toggle
- `public/js/phase-editor.js` — fetch + fragment-swap + autosave
- `tests/integration/credentials/admin-create.test.js`
- `tests/integration/credentials/admin-delete.test.js`
- `tests/integration/projects/phase-fragment.test.js`

**Modified files:**
- `domain/credentials/service.js` — add `createByAdmin`, `deleteByAdmin`
- `routes/admin/credentials.js` — add `GET /new`, `POST /`, `POST /:credId/delete`
- `routes/admin/project-phases.js` — content-negotiate on `?fragment=row`
- `routes/admin/phase-checklist-items.js` — same content-negotiation
- `views/layouts/admin.ejs` — add `<div class="chrome-sentinel"></div>` before `<%- body %>`; load new JS files
- `views/layouts/customer.ejs` — same sentinel + JS loads
- `views/admin/projects/detail.ejs` — replace inline phase markup with `_phase-row` includes
- `views/admin/credentials/list.ejs` — add `Add a credential` toolbar CTA + per-row Delete dialog
- `views/admin/credentials/show.ejs` — add Delete button via `_confirm-dialog`
- `views/customer/credentials/list.ejs` — replace `<details>` block with `_confirm-dialog`
- `public/styles/app.css` (or appended file `public/styles/sticky-chrome.css` + `public/styles/phases.css` if the build pipeline supports separate sheets — check before committing) — sticky chrome rules, phase-row card layout, confirm-dialog styles, status-menu / overflow-menu

**Layout note:** `views/layouts/admin.ejs` and `views/layouts/customer.ejs` already pull `/static/styles/app.css`. If `public/styles/app.css` is built from sources, append the new rules there or wire them into the build. If it's a single hand-edited file, append the rules at the bottom with a clear `/* === Portal UX pass 2026-05-03 === */` banner.

---

## Conventions

- **Test-runner:** vitest. Integration tests need `RUN_DB_TESTS=1 vitest run <path>`. Tests use `describe.skipIf(skip)` so unguarded local runs pass empty.
- **Commit style:** existing repo uses Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`). Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` on every commit.
- **Build target:** staging only. Use `/usr/local/bin/staging-build.sh "<message>"` for the deploy commit at the end. Do **not** run `npm run build` directly. Do **not** push to production.
- **No SW bump** during this plan — staging only. Production deploy bumps `SW_VERSION` later.

---

## Task 1: Shared `_confirm-dialog` component + `dialog.js`

**Files:**
- Create: `views/components/_confirm-dialog.ejs`
- Create: `public/js/dialog.js`
- Modify: `views/layouts/admin.ejs` (load `dialog.js`)
- Modify: `views/layouts/customer.ejs` (load `dialog.js`)
- Append: `public/styles/app.css` (or local stylesheet) — confirm-dialog styles
- Test: manual smoke check (component is exercised by Task 2's integration test)

- [ ] **Step 1: Write the component**

`views/components/_confirm-dialog.ejs`:

```ejs
<%# Confirm dialog. Locals:
   id, title, body, triggerLabel, confirmLabel,
   formAction, formMethod (default 'post'), csrfToken,
   triggerVariant (default 'danger'), triggerSize (default 'sm'). %>
<%
  var _v   = (typeof triggerVariant !== 'undefined') ? triggerVariant : 'danger';
  var _s   = (typeof triggerSize !== 'undefined') ? triggerSize : 'sm';
  var _m   = (typeof formMethod !== 'undefined') ? formMethod : 'post';
  var _cl  = (typeof confirmLabel !== 'undefined') ? confirmLabel : 'Confirm';
%>
<details class="confirm-dialog" data-confirm-dialog id="cd-<%= id %>">
  <summary class="btn btn--<%= _v %> btn--<%= _s %>" aria-haspopup="dialog" aria-controls="cd-<%= id %>-dialog">
    <%= triggerLabel %>
  </summary>
  <dialog class="confirm-dialog__dialog" id="cd-<%= id %>-dialog" aria-labelledby="cd-<%= id %>-title">
    <form method="<%= _m %>" action="<%= formAction %>" class="confirm-dialog__form">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <h2 class="confirm-dialog__title" id="cd-<%= id %>-title"><%= title %></h2>
      <p class="confirm-dialog__body"><%= body %></p>
      <div class="confirm-dialog__actions">
        <button type="button" class="btn btn--ghost btn--sm" data-confirm-dialog-cancel>Cancel</button>
        <%- include('./_button', { variant: _v, size: _s, type: 'submit', label: _cl }) %>
      </div>
    </form>
  </dialog>
</details>
```

The `<details>` wrapper is the no-JS fallback: clicking the summary discloses the form inline. With JS, `dialog.js` intercepts the summary click, prevents the disclosure toggle, opens the `<dialog>` instead.

- [ ] **Step 2: Write `public/js/dialog.js`**

```js
(function () {
  'use strict';

  function isDialogSupported() {
    return typeof HTMLDialogElement === 'function';
  }

  function findDialog(details) {
    return details.querySelector('.confirm-dialog__dialog');
  }

  function openFromSummary(details, summary, ev) {
    var dlg = findDialog(details);
    if (!dlg || !isDialogSupported()) return; // let <details> handle it
    ev.preventDefault();
    details.open = false; // ensure the disclosure stays closed
    dlg.__cdTrigger = summary;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    var first = dlg.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (first) first.focus();
  }

  function close(dlg) {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
    var trigger = dlg.__cdTrigger;
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  document.addEventListener('click', function (ev) {
    var summary = ev.target.closest('details[data-confirm-dialog] > summary');
    if (summary) {
      var details = summary.parentElement;
      openFromSummary(details, summary, ev);
      return;
    }
    var cancel = ev.target.closest('[data-confirm-dialog-cancel]');
    if (cancel) {
      ev.preventDefault();
      var dlg = cancel.closest('dialog');
      if (dlg) close(dlg);
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var dlg = document.querySelector('dialog.confirm-dialog__dialog[open]');
    if (dlg) {
      ev.preventDefault();
      close(dlg);
    }
  });
})();
```

- [ ] **Step 3: Wire `dialog.js` into both layouts**

In `views/layouts/admin.ejs`, immediately before `</body>` (after the existing inline `<script nonce>...` block):

```ejs
  <script src="/static/js/dialog.js" nonce="<%= nonce %>"></script>
```

Same line in `views/layouts/customer.ejs`. Verify the CSP nonce is already in use for the existing inline script — keep the pattern identical.

- [ ] **Step 4: Confirm `/static/js/*` is served**

```bash
grep -n "fastify-static\|/static" /opt/dbstudio_portal/server.js | head
ls /opt/dbstudio_portal/public/js 2>&1
```

Expected: `server.js` registers `@fastify/static` with `prefix: '/static'`, mounting `public/`. If `public/js/` does not exist, create it: `mkdir -p public/js`.

- [ ] **Step 5: Append confirm-dialog CSS**

Append to the canonical stylesheet (verify path with `ls public/styles/`):

```css
/* === Portal UX pass 2026-05-03: confirm-dialog === */
.confirm-dialog { display: inline-block; }
.confirm-dialog > summary { list-style: none; cursor: pointer; }
.confirm-dialog > summary::-webkit-details-marker { display: none; }
.confirm-dialog__dialog {
  border: 1px solid var(--surface-border, #2a2a2a);
  border-radius: 12px;
  background: var(--surface-1, #111);
  color: inherit;
  padding: 1.25rem 1.5rem;
  max-width: min(28rem, 92vw);
}
.confirm-dialog__dialog::backdrop { background: rgba(0,0,0,0.5); }
.confirm-dialog__title { margin: 0 0 0.5rem; font-size: 1.05rem; }
.confirm-dialog__body { margin: 0 0 1rem; color: var(--text-muted, #aaa); }
.confirm-dialog__actions {
  display: flex; justify-content: flex-end; gap: 0.5rem;
}
/* No-JS fallback: when <dialog> is unsupported, the inline form is just visible. */
.confirm-dialog[open] > .confirm-dialog__dialog:not([open]) {
  display: block; position: static; box-shadow: var(--shadow-lg);
}
```

Adjust CSS variable names to match the actual tokens used elsewhere — grep for `--surface` in `public/styles/app.css` to confirm.

- [ ] **Step 6: Manual smoke check**

```bash
cd /opt/dbstudio_portal && /usr/local/bin/staging-build.sh "wip(ui): confirm-dialog component"
```

Open `https://staging.db.football/admin/...` in a browser, navigate to a page that already includes `<details>` (any phase row Delete) — those still work as before since they don't use the new component yet. Confirm that no regression occurs on existing pages (the new JS only acts on `details[data-confirm-dialog]`).

- [ ] **Step 7: Commit**

```bash
cd /opt/dbstudio_portal
git add views/components/_confirm-dialog.ejs public/js/dialog.js views/layouts/admin.ejs views/layouts/customer.ejs public/styles/app.css
git commit -m "$(cat <<'EOF'
feat(ui): add reusable _confirm-dialog component + dialog.js

Native <dialog> with focus management, ESC close, focus restore on
trigger. <details> wrapper is the no-JS fallback. Component takes
id/title/body/triggerLabel/confirmLabel/formAction; trigger renders via
the existing _button.ejs so it shape-matches sibling buttons (only the
colour swaps for variant=danger).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Use `_confirm-dialog` on `/customer/credentials` (fixes the "Delete Hosting…" clip)

**Files:**
- Modify: `views/customer/credentials/list.ejs:77-85`
- Test: integration test asserting the rendered HTML uses the new component

- [ ] **Step 1: Write a failing integration test**

Create `tests/integration/credentials/customer-list-delete-dialog.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import { createSession } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_cust_dlg_${Date.now()}`;

describe.skipIf(skip)('GET /customer/credentials renders confirm-dialog for delete', () => {
  let app, db, kek;
  const ctx = () => ({ actorType: 'system', audit: { tag }, ip: '198.51.100.1', userAgentHash: 'h', kek });

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  it('renders the new _confirm-dialog (no clipped Delete <label>… summary)', async () => {
    const c = await customersService.create(db, {
      razonSocial: `${tag} Co S.L.`,
      primaryUser: { name: 'U', email: `${tag}+u@example.com` },
    }, ctx());
    await credentialsService.createByCustomer(db, {
      customerId: c.customerId,
      customerUserId: c.primaryUserId,
      provider: 'hosting',
      label: 'Hosting Credentials',
      payload: { user: 'x', password: 'y' },
    }, ctx());

    const sid = await createSession(db, { userType: 'customer', userId: c.primaryUserId, ip: '198.51.100.1' });
    const signed = app.signCookie(sid);

    const res = await app.inject({
      method: 'GET',
      url: '/customer/credentials',
      headers: { cookie: 'sid=' + signed },
    });
    expect(res.statusCode).toBe(200);
    // New component is in use:
    expect(res.body).toMatch(/data-confirm-dialog/);
    // Trigger label is generic "Delete" (no item label clipping):
    expect(res.body).toMatch(/<summary class="btn btn--danger btn--sm"[^>]*>\s*Delete\s*<\/summary>/);
    // Old clipped pattern is gone:
    expect(res.body).not.toMatch(/Delete Hosting Credentials…/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /opt/dbstudio_portal && RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/customer-list-delete-dialog.test.js
```

Expected: FAIL — body still contains `Delete Hosting Credentials…`, no `data-confirm-dialog` attribute.

- [ ] **Step 3: Replace the inline `<details>` with `_confirm-dialog`**

In `views/customer/credentials/list.ejs`, replace lines 77–85 (`<td>` containing the inline `<details>`) with:

```ejs
              <td class="data-table__td data-table__td--right">
                <%- include('../../components/_confirm-dialog', {
                  id: 'delete-cred-' + c.id,
                  triggerLabel: 'Delete',
                  triggerVariant: 'danger',
                  triggerSize: 'sm',
                  confirmLabel: 'Delete',
                  title: 'Delete ' + (c.label || c.provider) + '?',
                  body: 'Permanently removes this credential from your vault. Cannot be undone.',
                  formAction: '/customer/credentials/' + encodeURIComponent(c.id) + '/delete',
                  csrfToken: csrfToken
                }) %>
              </td>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/customer-list-delete-dialog.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the full credentials test suite to confirm no regressions**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add views/customer/credentials/list.ejs tests/integration/credentials/customer-list-delete-dialog.test.js
git commit -m "$(cat <<'EOF'
fix(ui): customer credentials Delete uses shared confirm-dialog

Replaces inline <details>+<summary>Delete X…</summary> in narrow table
cell — text no longer clips. Trigger renders through _button.ejs so
shape/size/typography match Add a credential; only the colour differs.
Same component will be reused on admin credentials + phase row Delete
in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Sticky chrome — CSS + sentinel + JS

**Files:**
- Modify: `views/layouts/admin.ejs` (sentinel before `<%- body %>`, load `sticky-chrome.js`)
- Modify: `views/layouts/customer.ejs` (same)
- Create: `public/js/sticky-chrome.js`
- Append: `public/styles/app.css`
- Test: manual cross-viewport smoke check

- [ ] **Step 1: Append sticky-chrome CSS**

Append to the same banner block opened in Task 1:

```css
/* === Portal UX pass 2026-05-03: sticky chrome === */
:root {
  --page-header-height: 96px;
  --subtabs-height: 48px;
}
.chrome-sentinel { height: 1px; }
.page-header {
  position: sticky; top: 0; z-index: 30;
  background: var(--surface, #0a0a0a);
  transition: padding 120ms ease;
}
.subtabs {
  position: sticky; top: var(--page-header-height); z-index: 29;
  background: var(--surface, #0a0a0a);
  border-bottom: 1px solid var(--surface-border, #2a2a2a);
}
body[data-stuck="true"] .page-header { padding-top: 0.5rem; padding-bottom: 0.5rem; box-shadow: 0 1px 0 rgba(255,255,255,0.06); }
body[data-stuck="true"] .page-header__title { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 640px) {
  body[data-stuck="true"] .eyebrow,
  body[data-stuck="true"] .page-header__subtitle { display: none; }
  body[data-stuck="true"] .page-header__title { font-size: 1rem; }
}
.phase-row { scroll-margin-top: calc(var(--page-header-height) + var(--subtabs-height) + 1rem); }
```

Replace the placeholder values for `--page-header-height` / `--subtabs-height` with the actual measured values from the running portal. Quick way to measure:

```bash
# In Chrome devtools console on /admin/customers/:id:
JSON.stringify({ h: document.querySelector('.page-header').offsetHeight, s: document.querySelector('.subtabs')?.offsetHeight })
```

If a layout shift becomes visible after deploy, swap in the real values.

- [ ] **Step 2: Write `public/js/sticky-chrome.js`**

```js
(function () {
  'use strict';
  var sentinel = document.querySelector('.chrome-sentinel');
  if (!sentinel || typeof IntersectionObserver !== 'function') return;
  var io = new IntersectionObserver(function (entries) {
    var entry = entries[0];
    if (!entry) return;
    document.body.setAttribute('data-stuck', entry.isIntersecting ? 'false' : 'true');
  }, { threshold: 0 });
  io.observe(sentinel);
})();
```

- [ ] **Step 3: Add the sentinel + script tag to both layouts**

In `views/layouts/admin.ejs`, inside `<main id="main-content">`, immediately before `<%- body %>`:

```ejs
      <div class="chrome-sentinel" aria-hidden="true"></div>
```

After the `<script src="/static/js/dialog.js"...>` line added in Task 1, append:

```ejs
  <script src="/static/js/sticky-chrome.js" nonce="<%= nonce %>"></script>
```

Same two edits in `views/layouts/customer.ejs`.

- [ ] **Step 4: Restart staging and smoke-check**

```bash
cd /opt/dbstudio_portal && /usr/local/bin/staging-build.sh "feat(ui): sticky page-header + subtabs"
```

In a browser, on `https://staging.db.football/admin/customers/<any-id>/projects/<any-id>` (long phase list):
1. Scroll down — header and subtabs stay pinned, content scrolls under.
2. On a viewport ≤ 640px wide (Chrome devtools mobile preset), confirm the eyebrow + subtitle collapse when stuck and re-expand at the top.
3. Click a `#phase-<id>` anchor (or trigger a no-JS phase form submit) and confirm the row lands below the chrome (not hidden under it).

- [ ] **Step 5: Commit**

```bash
git add views/layouts/admin.ejs views/layouts/customer.ejs public/js/sticky-chrome.js public/styles/app.css
git commit -m "$(cat <<'EOF'
feat(ui): sticky page-header + subtabs across admin and customer surfaces

position: sticky on .page-header and .subtabs, IntersectionObserver
on a 1px sentinel toggles body[data-stuck=true] to collapse eyebrow +
subtitle on mobile and reduce padding on desktop. Long titles get
ellipsis to prevent layout shift when collapse triggers. .phase-row
gets scroll-margin-top so anchor jumps land below the chrome.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `createByAdmin` service function

**Files:**
- Modify: `domain/credentials/service.js` (append after `createByAdminFromRequest`)
- Test: `tests/integration/credentials/admin-create.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/credentials/admin-create.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import * as credentialsRepo from '../../../domain/credentials/repo.js';
import { unwrapDek, decrypt } from '../../../lib/crypto/envelope.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_admin_create_${Date.now()}`;

describe.skipIf(skip)('credentials/service createByAdmin', () => {
  let db, kek;
  const ctx = () => ({ actorType: 'admin', actorId: null, ip: '198.51.100.10', userAgentHash: 'h', portalBaseUrl: 'https://portal.example.test/', audit: { tag }, kek });

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function makeCustomer(suffix) {
    return await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `U ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, ctx());
  }

  it('encrypts payload under the customer DEK and writes a customer-visible audit row', async () => {
    const c = await makeCustomer('happy');
    const r = await credentialsService.createByAdmin(db, {
      adminId: '00000000-0000-0000-0000-000000000001',
      customerId: c.customerId,
      provider: 'github',
      label: 'GitHub deploy key',
      payload: { token: 'gh-secret-' + Date.now() },
      projectId: null,
    }, ctx());
    expect(r.credentialId).toMatch(/^[0-9a-f-]{36}$/);

    const cred = await credentialsRepo.findCredentialById(db, r.credentialId);
    expect(cred.created_by).toBe('admin');
    expect(cred.project_id).toBeNull();
    expect(cred.provider).toBe('github');

    // Decrypt with the customer DEK to confirm round-trip.
    const cust = await sql`SELECT dek_ciphertext, dek_iv, dek_tag FROM customers WHERE id = ${c.customerId}::uuid`.execute(db);
    const dek = unwrapDek({ ciphertext: cust.rows[0].dek_ciphertext, iv: cust.rows[0].dek_iv, tag: cust.rows[0].dek_tag }, kek);
    const plaintext = decrypt({ ciphertext: cred.payload_ciphertext, iv: cred.payload_iv, tag: cred.payload_tag }, dek).toString('utf8');
    expect(JSON.parse(plaintext)).toEqual({ token: expect.stringContaining('gh-secret-') });

    const audit = await sql`SELECT action, visible_to_customer, metadata FROM audit_log WHERE target_id = ${r.credentialId}::uuid ORDER BY created_at`.execute(db);
    expect(audit.rows[0].action).toBe('credential.created');
    expect(audit.rows[0].visible_to_customer).toBe(true);
    expect(audit.rows[0].metadata.createdBy).toBe('admin');
  });

  it('rejects when project does not belong to the customer', async () => {
    const a = await makeCustomer('xa');
    const b = await makeCustomer('xb');
    // Make a project on customer B
    const projectsService = await import('../../../domain/projects/service.js');
    const pj = await projectsService.create(db, { customerId: b.customerId, name: 'B-pj', objetoProyecto: 'x' }, ctx());
    await expect(credentialsService.createByAdmin(db, {
      adminId: '00000000-0000-0000-0000-000000000001',
      customerId: a.customerId,
      provider: 'aws',
      label: 'whatever',
      payload: { x: '1' },
      projectId: pj.projectId,
    }, ctx())).rejects.toThrow();
  });

  it('throws when KEK is absent (vault locked)', async () => {
    const c = await makeCustomer('lock');
    await expect(credentialsService.createByAdmin(db, {
      adminId: '00000000-0000-0000-0000-000000000001',
      customerId: c.customerId,
      provider: 'aws',
      label: 'no-kek',
      payload: { x: '1' },
    }, { ...ctx(), kek: undefined })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /opt/dbstudio_portal && RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/admin-create.test.js
```

Expected: FAIL with `credentialsService.createByAdmin is not a function`.

- [ ] **Step 3: Implement `createByAdmin`**

In `domain/credentials/service.js`, after the existing `createByAdminFromRequest` function (around line 340 — find it with `grep -n "^export async function createByAdminFromRequest" domain/credentials/service.js`), add:

```js
export async function createByAdmin(db, {
  adminId,
  customerId,
  provider,
  label,
  payload,
  projectId = null,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentials.createByAdmin');
  const { provider: p, label: l } = requireProviderLabel(provider, label);
  const plaintext = encodePayload(payload);

  return await db.transaction().execute(async (tx) => {
    const customer = await loadCustomerDekRow(tx, customerId);
    if (customer.status !== 'active') {
      throw new Error(
        `cannot create credential for customer in status '${customer.status}' — must be 'active'`,
      );
    }
    await assertProjectBelongsToCustomer(tx, projectId, customerId);

    const dek = unwrapDek({
      ciphertext: customer.dek_ciphertext,
      iv: customer.dek_iv,
      tag: customer.dek_tag,
    }, kek);
    const env = encrypt(plaintext, dek);

    const id = uuidv7();
    await repo.insertCredential(tx, {
      id,
      customerId,
      provider: p,
      label: l,
      payloadCiphertext: env.ciphertext,
      payloadIv: env.iv,
      payloadTag: env.tag,
      createdBy: 'admin',
      projectId,
    });

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential.created',
      targetType: 'credential',
      targetId: id,
      metadata: { ...a.metadata, customerId, projectId, provider: p, label: l, createdBy: 'admin' },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Phase B digest: customer sees the admin-created credential land in
    // their Activity feed + email digest.
    const cnameRow = await sql`SELECT razon_social FROM customers WHERE id = ${customerId}::uuid`.execute(tx);
    const customerName = cnameRow.rows[0]?.razon_social ?? '';
    const customerUsersR = await sql`SELECT id, locale FROM customer_users WHERE customer_id = ${customerId}::uuid AND deleted_at IS NULL`.execute(tx);
    for (const u of customerUsersR.rows) {
      const vars = { customerName, count: 1 };
      await recordForDigest(tx, {
        recipientType: 'customer',
        recipientId:   u.id,
        customerId,
        bucket:        'fyi',
        eventType:     'credential.created',
        title:         titleFor('credential.created', u.locale, vars),
        linkPath:      `/customer/credentials/${id}`,
        metadata:      { credentialId: id, customerId, createdBy: 'admin' },
        vars,
        locale:        u.locale,
      });
    }

    return { credentialId: id };
  });
}
```

Cross-check the imports already in scope at the top of the file — `requireKek`, `requireProviderLabel`, `encodePayload`, `loadCustomerDekRow`, `assertProjectBelongsToCustomer`, `unwrapDek`, `encrypt`, `repo`, `uuidv7`, `baseAudit`, `writeAudit`, `recordForDigest`, `titleFor`, `sql` — all are used by the existing `createByCustomer` / `createByAdminFromRequest`. No new imports needed.

- [ ] **Step 4: Run test to verify it passes**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/admin-create.test.js
```

Expected: PASS, three test cases.

- [ ] **Step 5: Run the full credentials suite**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/ tests/unit/lib/crypto
```

Expected: all green; coverage thresholds (`lib/crypto/**`: 100%, `lib/auth/**`: 80%) hold.

- [ ] **Step 6: Commit**

```bash
git add domain/credentials/service.js tests/integration/credentials/admin-create.test.js
git commit -m "$(cat <<'EOF'
feat(credentials): admin createByAdmin service function

Mirror createByAdminFromRequest minus the request lock — admin can
create a credential directly under any active customer without the
customer first opening a credential_request. Encrypts under the
customer DEK via the admin's KEK (same path as fulfilment), writes a
customer-visible audit row, fans out a Phase B digest event to each
active customer_user.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Admin add-credential routes + view

**Files:**
- Modify: `routes/admin/credentials.js` (add `GET /new` and `POST /`)
- Create: `views/admin/credentials/new.ejs`
- Test: `tests/integration/credentials/admin-create.test.js` (extend with route-level case)

- [ ] **Step 1: Extend the integration test with a route case**

Append to `tests/integration/credentials/admin-create.test.js` inside the same `describe`:

```js
  describe('admin add-credential routes', () => {
    let app;
    beforeAll(async () => {
      const { build } = await import('../../../server.js');
      app = await build({ skipSafetyCheck: true, kek });
    });
    afterAll(async () => { await app?.close(); });

    async function makeAdminWithCookie() {
      const adminsService = await import('../../../domain/admins/service.js');
      const { createSession, stepUp } = await import('../../../lib/auth/session.js');
      const { unlockVault } = await import('../../../lib/auth/vault-lock.js');
      const created = await adminsService.create(db, { email: `${tag}+rt@example.com`, name: 'Rt' }, { actorType: 'system', audit: { tag } });
      await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'rt-pw-shouldnt-matter-91283' }, { audit: { tag }, hibpHasBeenPwned: async () => false });
      const sid = await createSession(db, { userType: 'admin', userId: created.id, ip: '198.51.100.40' });
      await stepUp(db, sid);
      await unlockVault(sid);
      return { adminId: created.id, signed: app.signCookie(sid) };
    }

    it('POST /admin/customers/:id/credentials creates a cred and 302s to detail', async () => {
      const c = await makeCustomer('rt');
      const { signed } = await makeAdminWithCookie();
      const csrf = await app.inject({ method: 'GET', url: `/admin/customers/${c.customerId}/credentials/new`, headers: { cookie: 'sid=' + signed } });
      const csrfToken = (csrf.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      expect(csrfToken).toBeTruthy();
      const res = await app.inject({
        method: 'POST',
        url: `/admin/customers/${c.customerId}/credentials`,
        headers: { cookie: 'sid=' + signed, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          provider: 'aws',
          label: 'AWS prod root',
          project_id: '',
          field_count: '1',
          field_name_0: 'access_key_id',
          field_value_0: 'AKIA-' + Date.now(),
        }).toString(),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/\/admin\/customers\/[^/]+\/credentials\/[^/]+$/);
    });

    it('GET /admin/customers/:id/credentials/new redirects to step-up when vault locked', async () => {
      const c = await makeCustomer('locked');
      const adminsService = await import('../../../domain/admins/service.js');
      const { createSession, stepUp } = await import('../../../lib/auth/session.js');
      const created = await adminsService.create(db, { email: `${tag}+locked@example.com`, name: 'L' }, { actorType: 'system', audit: { tag } });
      await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'l-pw-shouldnt-matter-91283' }, { audit: { tag }, hibpHasBeenPwned: async () => false });
      const sid = await createSession(db, { userType: 'admin', userId: created.id, ip: '198.51.100.40' });
      await stepUp(db, sid);
      // Note: vault NOT unlocked.
      const res = await app.inject({ method: 'GET', url: `/admin/customers/${c.customerId}/credentials/new`, headers: { cookie: 'sid=' + app.signCookie(sid) } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/admin\/step-up\?return=/);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/admin-create.test.js
```

Expected: FAIL — `GET /admin/customers/:id/credentials/new` returns 404.

- [ ] **Step 3: Add the routes**

In `routes/admin/credentials.js`, immediately after the existing `app.get('/admin/customers/:id/credentials', ...)` handler (ends ~line 67), add:

```js
  // Admin direct add (no credential_request needed). Step-up + vault-unlock
  // gated; the GET surfaces the form, POST encrypts + writes audit + digest.
  app.get('/admin/customers/:id/credentials/new', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    if (!isVaultUnlocked(session)) {
      const ret = encodeURIComponent(`/admin/customers/${req.params.id}/credentials/new`);
      return reply.redirect(`/admin/step-up?return=${ret}`, 302);
    }
    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);
    const projects = await listProjectsByCustomer(app.db, id);
    return renderAdmin(req, reply, 'admin/credentials/new', {
      title: 'Add credential · ' + customer.razon_social,
      customer,
      projects,
      form: null,
      csrfToken: await reply.generateCsrf(),
      mainWidth: 'wide',
      ...customerChrome(customer, 'credentials'),
    });
  });

  app.post('/admin/customers/:id/credentials', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    if (!isVaultUnlocked(session)) {
      const ret = encodeURIComponent(`/admin/customers/${req.params.id}/credentials/new`);
      return reply.redirect(`/admin/step-up?return=${ret}`, 302);
    }
    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, id);
    if (!customer) return notFound(req, reply);

    const body = req.body ?? {};
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    let projectId;
    try { projectId = parseProjectId(body.project_id); }
    catch { projectId = null; }
    const fieldCount = Number.parseInt(String(body.field_count ?? '0'), 10) || 0;
    const payload = {};
    for (let i = 0; i < fieldCount; i++) {
      const k = typeof body[`field_name_${i}`] === 'string' ? body[`field_name_${i}`].trim() : '';
      const v = typeof body[`field_value_${i}`] === 'string' ? body[`field_value_${i}`] : '';
      if (k && v !== '') payload[k] = v;
    }

    const renderForm = async (errorMsg) => {
      reply.code(422);
      const projects = await listProjectsByCustomer(app.db, id);
      return renderAdmin(req, reply, 'admin/credentials/new', {
        title: 'Add credential · ' + customer.razon_social,
        customer,
        projects,
        form: { provider, label, projectId },
        error: errorMsg,
        csrfToken: await reply.generateCsrf(),
        mainWidth: 'wide',
        ...customerChrome(customer, 'credentials'),
      });
    };

    if (!provider) return renderForm('Provider is required.');
    if (!label) return renderForm('Label is required.');
    if (Object.keys(payload).length === 0) return renderForm('At least one field/value pair is required.');

    let credentialId;
    try {
      const r = await credentialsService.createByAdmin(app.db, {
        adminId: session.user_id,
        customerId: id,
        provider,
        label,
        payload,
        projectId,
      }, { ip: req.ip ?? null, userAgentHash: null, audit: { source: 'admin-create' }, kek: app.kek });
      credentialId = r.credentialId;
    } catch (err) {
      return renderForm(err.message || 'Could not save the credential.');
    }
    return reply.redirect(`/admin/customers/${id}/credentials/${credentialId}`, 303);
  });
```

- [ ] **Step 4: Create the view**

Mirror `views/customer/credentials/new.ejs`. Create `views/admin/credentials/new.ejs`:

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: 'Add a credential',
  subtitle: customer.razon_social
}) %>

<%- include('../../components/_admin-customer-tabs', { customerId: customer.id, active: 'credentials' }) %>

<% if (typeof error !== 'undefined' && error) { %>
  <%- include('../../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="/admin/customers/<%= customer.id %>/credentials" class="form-stack" autocomplete="off">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <div class="card">
    <h2 class="card__title">Credential</h2>
    <fieldset class="fieldset-stack">
      <%- include('../../components/_input', {
        name: 'provider', type: 'text', label: 'Provider', required: true, maxlength: 128,
        value: form && form.provider ? form.provider : '',
        placeholder: 'e.g. AWS, GitHub, Stripe'
      }) %>
      <%- include('../../components/_input', {
        name: 'label', type: 'text', label: 'Label', required: true, maxlength: 128,
        value: form && form.label ? form.label : '',
        placeholder: 'What this credential is for'
      }) %>
    </fieldset>
  </div>

  <div class="card">
    <h2 class="card__title">Scope</h2>
    <%
      const selectedProjectId = (form && form.projectId) || '';
      const projectList = (typeof projects !== 'undefined' && Array.isArray(projects)) ? projects : [];
    %>
    <div class="input-field">
      <label class="input-field__label" for="adm_cred_new_project_id">Project</label>
      <div class="input-field__control">
        <select id="adm_cred_new_project_id" name="project_id">
          <option value="" <%= selectedProjectId === '' ? 'selected' : '' %>>Company-wide (all projects)</option>
          <% projectList.forEach(function(p) { %>
            <option value="<%= p.id %>" <%= selectedProjectId === p.id ? 'selected' : '' %>><%= p.name %></option>
          <% }) %>
        </select>
      </div>
    </div>
  </div>

  <div class="card">
    <h2 class="card__title">Fields</h2>
    <p class="card__subtitle">At least one is required. Values are encrypted under the customer's vault key. Values are <strong>not echoed back</strong> on a validation error — re-type them if the form re-renders.</p>
    <% var rows = 3; %>
    <input type="hidden" name="field_count" value="<%= rows %>">
    <div class="form-stack">
      <% for (var i = 0; i < rows; i++) { %>
        <div class="customer-cred-row">
          <input class="cr-fields__input" type="text" name="field_name_<%= i %>" placeholder="field name" aria-label="field name <%= i + 1 %>" maxlength="64">
          <input id="adm_cred_new_field_value_<%= i %>" class="cr-fields__input" type="password" name="field_value_<%= i %>" placeholder="value" aria-label="value for field <%= i + 1 %>" maxlength="2048" autocomplete="off">
        </div>
      <% } %>
    </div>
  </div>

  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Save credential' }) %>
    <%- include('../../components/_button', { variant: 'ghost',   size: 'md', href: '/admin/customers/' + customer.id + '/credentials', label: 'Cancel' }) %>
  </div>
</form>
```

- [ ] **Step 5: Run test to verify it passes**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/admin-create.test.js
```

Expected: PASS, all five cases (three from Task 4 + two new route cases).

- [ ] **Step 6: Commit**

```bash
git add routes/admin/credentials.js views/admin/credentials/new.ejs tests/integration/credentials/admin-create.test.js
git commit -m "$(cat <<'EOF'
feat(credentials): admin direct-add routes + view

GET /admin/customers/:id/credentials/new renders the new form (mirrors
customer-side new.ejs). POST persists via createByAdmin. Both gated by
isVaultUnlocked → /admin/step-up?return=… on lock. Validates provider,
label, and at least one field/value pair; on 422 re-renders with sticky
errors and an empty payload (values never echoed).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `deleteByAdmin` service + admin delete route

**Files:**
- Modify: `domain/credentials/service.js` (append `deleteByAdmin` near `deleteByCustomer`)
- Modify: `routes/admin/credentials.js` (add `POST /:credId/delete`)
- Test: `tests/integration/credentials/admin-delete.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/credentials/admin-delete.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as credentialsService from '../../../domain/credentials/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { unlockVault } from '../../../lib/auth/vault-lock.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cred_admin_del_${Date.now()}`;

describe.skipIf(skip)('credentials admin delete', () => {
  let app, db, kek;
  const ctx = () => ({ actorType: 'admin', actorId: null, ip: '198.51.100.50', userAgentHash: 'h', portalBaseUrl: 'https://portal.example.test/', audit: { tag }, kek });

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function makeFixture() {
    const c = await customersService.create(db, { razonSocial: `${tag} Co S.L.`, primaryUser: { name: 'U', email: `${tag}+u@example.com` } }, ctx());
    const created = await adminsService.create(db, { email: `${tag}+a@example.com`, name: 'A' }, { actorType: 'system', audit: { tag } });
    await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'a-pw-shouldnt-matter-12345' }, { audit: { tag }, hibpHasBeenPwned: async () => false });
    const sid = await createSession(db, { userType: 'admin', userId: created.id, ip: '198.51.100.50' });
    await stepUp(db, sid);
    await unlockVault(sid);
    const cred = await credentialsService.createByAdmin(db, {
      adminId: created.id, customerId: c.customerId, provider: 'wp', label: 'wp', payload: { x: '1' },
    }, ctx());
    return { customerId: c.customerId, credentialId: cred.credentialId, adminId: created.id, signed: app.signCookie(sid) };
  }

  it('removes the credential and writes a customer-visible audit row', async () => {
    const f = await makeFixture();
    const csrf = await app.inject({ method: 'GET', url: `/admin/customers/${f.customerId}/credentials`, headers: { cookie: 'sid=' + f.signed } });
    const csrfToken = (csrf.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    expect(csrfToken).toBeTruthy();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${f.customerId}/credentials/${f.credentialId}/delete`,
      headers: { cookie: 'sid=' + f.signed, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/admin/customers/${f.customerId}/credentials`);

    const after = await sql`SELECT id FROM credentials WHERE id = ${f.credentialId}::uuid`.execute(db);
    expect(after.rows).toHaveLength(0);

    const audit = await sql`SELECT action, visible_to_customer, actor_type FROM audit_log WHERE target_id = ${f.credentialId}::uuid AND action = 'credential.deleted'`.execute(db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_type).toBe('admin');
    expect(audit.rows[0].visible_to_customer).toBe(true);
  });

  it('404s when credId does not belong to URL customer', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${a.customerId}/credentials/${b.credentialId}/delete`,
      headers: { cookie: 'sid=' + a.signed, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'irrelevant',
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/admin-delete.test.js
```

Expected: FAIL — `deleteByAdmin` not defined / `POST /...delete` 404.

- [ ] **Step 3: Implement `deleteByAdmin`**

In `domain/credentials/service.js`, immediately after `deleteByCustomer` (~line 927), append:

```js
export async function deleteByAdmin(db, {
  adminId,
  credentialId,
}, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await repo.findCredentialById(tx, credentialId);
    if (!row) throw new CredentialNotFoundError(credentialId);

    await repo.deleteCredentialById(tx, credentialId);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential.deleted',
      targetType: 'credential',
      targetId: credentialId,
      metadata: {
        ...a.metadata,
        customerId: row.customer_id,
        provider: row.provider,
        label: row.label,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Phase B digest: the customer sees admin-side deletes in their feed.
    const cnameRow = await sql`SELECT razon_social FROM customers WHERE id = ${row.customer_id}::uuid`.execute(tx);
    const customerName = cnameRow.rows[0]?.razon_social ?? '';
    const customerUsersR = await sql`SELECT id, locale FROM customer_users WHERE customer_id = ${row.customer_id}::uuid AND deleted_at IS NULL`.execute(tx);
    for (const u of customerUsersR.rows) {
      const vars = { customerName, count: 1 };
      await recordForDigest(tx, {
        recipientType: 'customer',
        recipientId:   u.id,
        customerId:    row.customer_id,
        bucket:        'fyi',
        eventType:     'credential.deleted',
        title:         titleFor('credential.deleted', u.locale, vars),
        linkPath:      `/customer/credentials`,
        metadata:      { credentialId, customerId: row.customer_id, deletedBy: 'admin' },
        vars,
        locale:        u.locale,
      });
    }

    return { credentialId };
  });
}
```

- [ ] **Step 4: Confirm `titleFor` already supports `credential.deleted`**

```bash
grep -n "credential.deleted\|credential.created" /opt/dbstudio_portal/domain/digest /opt/dbstudio_portal/lib -r 2>&1 | head
```

Expected: at least one entry mapping `credential.deleted` to a translatable title. If missing, add a stub that mirrors the `credential.created` title — extend `titleFor` (or whichever locale module owns it) to accept the new event-type. Do this minimally; do not refactor the locale wiring.

- [ ] **Step 5: Add the admin delete route**

In `routes/admin/credentials.js`, after the `POST .../scope` handler, append:

```js
  app.post('/admin/customers/:id/credentials/:credId/delete', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    const cid = req.params?.id;
    const credId = req.params?.credId;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    if (typeof credId !== 'string' || !UUID_RE.test(credId)) return notFound(req, reply);

    const credential = await findCredentialById(app.db, credId);
    if (!credential || credential.customer_id !== cid) return notFound(req, reply);

    try {
      await credentialsService.deleteByAdmin(app.db, {
        adminId: session.user_id,
        credentialId: credId,
      }, { ip: req.ip ?? null, userAgentHash: null, audit: { source: 'admin-delete' } });
    } catch (err) {
      const safeError =
        err?.code === 'CREDENTIAL_NOT_FOUND' ? 'That credential no longer exists.' :
        'Could not delete the credential — please retry.';
      return reply.redirect(`/admin/customers/${cid}/credentials?error=${encodeURIComponent(safeError)}`, 302);
    }
    return reply.redirect(`/admin/customers/${cid}/credentials`, 302);
  });
```

- [ ] **Step 6: Run test to verify it passes**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/credentials/admin-delete.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add domain/credentials/service.js routes/admin/credentials.js tests/integration/credentials/admin-delete.test.js
git commit -m "$(cat <<'EOF'
feat(credentials): admin deleteByAdmin + delete route

Mirror deleteByCustomer minus the customer-user assertion. Customer-
visible audit + Phase B digest fan-out keeps the customer's Activity
feed honest about admin-side mutations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire the new admin Add + Delete buttons into the credentials list and show pages

**Files:**
- Modify: `views/admin/credentials/list.ejs` (toolbar CTA + per-row delete dialog)
- Modify: `views/admin/credentials/show.ejs` (delete button next to Edit)

- [ ] **Step 1: Edit `list.ejs` — toolbar CTA**

Currently `views/admin/credentials/list.ejs` does not use `_list-toolbar`. Add it at the top, immediately after the `_admin-customer-tabs` include and before the existing rendering:

```ejs
<%- include('../../components/_list-toolbar', {
  action: '/admin/customers/' + customer.id + '/credentials',
  q: '',
  total: rows.length,
  totalLabel: 'credential',
  placeholder: 'Search credentials…',
  ctaHref: '/admin/customers/' + customer.id + '/credentials/new',
  ctaLabel: 'Add a credential'
}) %>
```

(Confirm `_list-toolbar.ejs` props by reading the customer-side usage in `views/customer/credentials/list.ejs:16-24`.)

- [ ] **Step 2: Edit `list.ejs` — per-row delete dialog**

The current admin list uses the shared `_table` component with pre-rendered HTML strings, which does not give us a per-row dialog include. Convert the credential rows back to an inline `<table>` (same shape used on the customer side). After the toolbar:

```ejs
<% orderedGroups.forEach(function(group) { %>
  <h2 class="cred-group__heading"><%= group.name %> <span class="cred-group__count">· <%= group.rows.length %></span></h2>
  <div class="table-wrap">
    <table class="data-table data-table--medium">
      <thead>
        <tr>
          <th class="data-table__th data-table__th--left">Label</th>
          <th class="data-table__th data-table__th--left">Provider</th>
          <th class="data-table__th data-table__th--left">Origin</th>
          <th class="data-table__th data-table__th--left">Freshness</th>
          <th class="data-table__th data-table__th--left">Created</th>
          <th class="data-table__th data-table__th--left">Updated</th>
          <th class="data-table__th data-table__th--right"></th>
        </tr>
      </thead>
      <tbody>
        <% group.rows.forEach(function(c) { %>
          <tr>
            <td class="data-table__td data-table__td--left"><a href="/admin/customers/<%= customer.id %>/credentials/<%= c.id %>"><%= c.label %></a></td>
            <td class="data-table__td data-table__td--left"><%= c.provider %></td>
            <td class="data-table__td data-table__td--left"><%- originPill(c.created_by) %></td>
            <td class="data-table__td data-table__td--left"><%- freshnessPill(c.needs_update) %></td>
            <td class="data-table__td data-table__td--left"><%= euDateTime(c.created_at) %></td>
            <td class="data-table__td data-table__td--left"><%= euDateTime(c.updated_at) %></td>
            <td class="data-table__td data-table__td--right">
              <%- include('../../components/_confirm-dialog', {
                id: 'delete-adm-cred-' + c.id,
                triggerLabel: 'Delete',
                triggerVariant: 'danger',
                triggerSize: 'sm',
                confirmLabel: 'Delete',
                title: 'Delete ' + (c.label || c.provider) + '?',
                body: 'Permanently removes this credential from this customer\'s vault. The customer will see this in their Activity feed.',
                formAction: '/admin/customers/' + customer.id + '/credentials/' + c.id + '/delete',
                csrfToken: csrfToken
              }) %>
            </td>
          </tr>
        <% }) %>
      </tbody>
    </table>
  </div>
<% }) %>
```

Remove the existing call to `_table` and the `rowsFor` / `columns` helpers that are no longer needed.

- [ ] **Step 3: Edit `show.ejs` — delete button next to Edit**

Replace the `<div class="form-actions">` block at the bottom (lines 105–108) with:

```ejs
<div class="form-actions">
  <%- include('../../components/_button', { variant: 'secondary', size: 'sm', href: '/admin/customers/' + customer.id + '/credentials/' + credential.id + '/edit', label: 'Edit' }) %>
  <%- include('../../components/_confirm-dialog', {
    id: 'delete-adm-cred-show-' + credential.id,
    triggerLabel: 'Delete',
    triggerVariant: 'danger',
    triggerSize: 'sm',
    confirmLabel: 'Delete',
    title: 'Delete ' + (credential.label || credential.provider) + '?',
    body: 'Permanently removes this credential from ' + customer.razon_social + '\'s vault. The customer will see this in their Activity feed.',
    formAction: '/admin/customers/' + customer.id + '/credentials/' + credential.id + '/delete',
    csrfToken: csrfToken
  }) %>
  <%- include('../../components/_button', { variant: 'ghost',     size: 'sm', href: '/admin/customers/' + customer.id + '/credentials', label: '← Back to credentials' }) %>
</div>
```

- [ ] **Step 4: Update `csrfToken` in the list route render**

Confirm `routes/admin/credentials.js` `GET /admin/customers/:id/credentials` passes `csrfToken: await reply.generateCsrf()` to `renderAdmin`. If it doesn't, add it.

- [ ] **Step 5: Smoke check**

```bash
cd /opt/dbstudio_portal && /usr/local/bin/staging-build.sh "feat(credentials): admin add + delete UI"
```

In a browser:
1. `/admin/customers/<id>/credentials` shows `Add a credential` in the toolbar and a `Delete` button per row.
2. Click the toolbar CTA → form loads (vault-unlocked path) or → step-up (locked).
3. Submit the form → 303 to detail page with the new credential.
4. From the list, click `Delete` → dialog opens → confirm → 302 back to list, credential gone.
5. Check `/customer/credentials` while logged in as the customer — admin-side delete shows up in Activity feed with action `credential.deleted` and `actor_type: admin`.

- [ ] **Step 6: Commit**

```bash
git add views/admin/credentials/list.ejs views/admin/credentials/show.ejs
git commit -m "$(cat <<'EOF'
feat(credentials): admin list + show wire up Add CTA and Delete dialog

Toolbar CTA links to /new. Per-row Delete uses _confirm-dialog. Show
page Delete sits next to Edit. Same component, same shape, only colour
differs from sibling buttons.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Extract `_phase-row.ejs` partial (no behaviour change)

**Files:**
- Create: `views/components/_phase-row.ejs`
- Modify: `views/admin/projects/detail.ejs` (replace inline phase markup with `include('_phase-row')`)
- Test: existing `tests/integration/projects/*.test.js` continue to pass

- [ ] **Step 1: Read the inline phase markup**

The existing inline rendering is at `views/admin/projects/detail.ejs:113-213` (`<% phaseList.forEach(function(p, idx) { %>` ... `<% }); %>`). Copy that block verbatim into a new file as the **starting point** — Task 9 redesigns the layout; this task is purely an extract-and-substitute refactor so the diff stays reviewable.

- [ ] **Step 2: Create `views/components/_phase-row.ejs`**

Locals: `phase`, `idx`, `customer`, `project`, `csrfToken`, `phaseListLength`. Body (lifted from detail.ejs but with `p` → `phase`, `idx` and `phaseList.length` come from locals):

```ejs
<%# Single phase row. Locals: phase, idx, customer, project, csrfToken, phaseListLength %>
<%
  function phaseStatusPill(s) {
    var key = s === 'done' ? 'phase-done'
            : s === 'blocked' ? 'phase-blocked'
            : s === 'in_progress' ? 'phase-in-progress'
            : 'phase-not-started';
    var label = s === 'not_started' ? 'not started'
              : s === 'in_progress' ? 'in progress'
              : s;
    return '<span class="status-pill status-pill--' + key + '">' + label + '</span>';
  }
  var p = phase;
  var items = (p.items || []);
  var doneCount = items.filter(function(i){ return i.done_at; }).length;
%>
<li class="phase-row" id="phase-<%= p.id %>" data-status="<%= p.status %>">
  <span class="phase-row__index" aria-hidden="true"><%= idx + 1 %></span>
  <div class="phase-row__order">
    <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/reorder" data-fragment="row">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <input type="hidden" name="direction" value="up">
      <button class="btn btn--icon" type="submit" aria-label="Move <%= p.label %> up" <%= idx === 0 ? 'disabled' : '' %>>↑</button>
    </form>
    <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/reorder" data-fragment="row">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <input type="hidden" name="direction" value="down">
      <button class="btn btn--icon" type="submit" aria-label="Move <%= p.label %> down" <%= idx === phaseListLength - 1 ? 'disabled' : '' %>>↓</button>
    </form>
  </div>

  <form class="phase-row__rename" method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/rename" data-fragment="row">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <label class="visually-hidden" for="phase-label-<%= p.id %>">Phase label</label>
    <input id="phase-label-<%= p.id %>" class="phase-row__label-input" name="label" type="text" maxlength="200" value="<%= p.label %>" required>
    <button class="btn btn--ghost" type="submit">Save</button>
  </form>

  <div class="phase-row__status">
    <%- phaseStatusPill(p.status) %>
    <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/status" data-fragment="row">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <label class="visually-hidden" for="phase-status-<%= p.id %>">Change status for phase <%= p.label %></label>
      <select id="phase-status-<%= p.id %>" name="status" class="phase-row__status-select">
        <option value="not_started" <%= p.status === 'not_started' ? 'selected' : '' %>>not started</option>
        <option value="in_progress" <%= p.status === 'in_progress' ? 'selected' : '' %>>in progress</option>
        <option value="blocked"     <%= p.status === 'blocked'     ? 'selected' : '' %>>blocked</option>
        <option value="done"        <%= p.status === 'done'        ? 'selected' : '' %>>done</option>
      </select>
      <button class="btn btn--ghost" type="submit">Set</button>
    </form>
  </div>

  <%- include('./_confirm-dialog', {
    id: 'delete-phase-' + p.id,
    triggerLabel: 'Delete',
    triggerVariant: 'danger',
    triggerSize: 'sm',
    confirmLabel: 'Delete phase',
    title: 'Delete phase ' + p.label + '?',
    body: 'This removes the phase and any checklist items inside it. Cannot be undone.',
    formAction: '/admin/customers/' + customer.id + '/projects/' + project.id + '/phases/' + p.id + '/delete',
    csrfToken: csrfToken
  }) %>

  <details class="phase-row__checklist" <%= p.status !== 'not_started' ? 'open' : '' %>>
    <summary>Checklist (<%= items.length %><%= items.length === 0 ? '' : ', ' + doneCount + ' done' %>)</summary>
    <% if (items.length === 0) { %>
      <p class="checklist-empty">No items yet. Add your first checklist item below.</p>
    <% } else { %>
      <ul class="checklist-list">
        <% items.forEach(function(it) { %>
          <li class="checklist-item" data-done="<%= it.done_at ? 'true' : 'false' %>">
            <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/toggle" data-fragment="row">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <input type="hidden" name="done" value="<%= it.done_at ? 'false' : 'true' %>">
              <button class="btn btn--icon" type="submit" aria-label="<%= it.done_at ? 'Mark ' + it.label + ' as not done' : 'Mark ' + it.label + ' as done' %>"><%= it.done_at ? '☑' : '☐' %></button>
            </form>
            <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/rename" class="checklist-item__rename" data-fragment="row">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <label class="visually-hidden" for="item-label-<%= it.id %>">Item label</label>
              <input id="item-label-<%= it.id %>" class="phase-row__label-input" name="label" type="text" maxlength="500" value="<%= it.label %>" required>
              <button class="btn btn--ghost" type="submit">Save</button>
            </form>
            <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/visibility" data-fragment="row">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <input type="hidden" name="visibleToCustomer" value="<%= it.visible_to_customer ? 'false' : 'true' %>">
              <button class="btn btn--ghost checklist-item__visibility" type="submit" aria-label="<%= it.visible_to_customer ? 'Hide ' + it.label + ' from customer' : 'Show ' + it.label + ' to customer' %>"><%= it.visible_to_customer ? 'Customer visible' : 'Admin only' %></button>
            </form>
            <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/delete" data-fragment="row">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <button class="btn btn--ghost btn--danger" type="submit" aria-label="Delete <%= it.label %>">×</button>
            </form>
          </li>
        <% }); %>
      </ul>
    <% } %>
    <form class="checklist-create-form" method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items" data-fragment="row">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <label class="visually-hidden" for="new-item-<%= p.id %>">New checklist item label</label>
      <input id="new-item-<%= p.id %>" class="phase-row__label-input" name="label" type="text" maxlength="500" placeholder="New checklist item" required>
      <label class="checklist-create-form__check">
        <input type="checkbox" name="visibleToCustomer" value="true" checked>
        Visible to customer
      </label>
      <button class="btn btn--primary" type="submit">Add item</button>
    </form>
  </details>
</li>
```

Notes baked in already:
- `id="phase-<%= p.id %>"` for `#phase-<id>` no-JS scroll target.
- Every form gets `data-fragment="row"` (no-op until Task 10).
- Phase Delete uses `_confirm-dialog` (no longer the cramped inline `<details>`).

- [ ] **Step 3: Replace inline markup in `detail.ejs`**

In `views/admin/projects/detail.ejs`, replace the `<ol class="phase-list"> ... </ol>` block with:

```ejs
    <ol class="phase-list">
      <% phaseList.forEach(function(p, idx) { %>
        <%- include('../../components/_phase-row', {
          phase: p,
          idx: idx,
          customer: customer,
          project: project,
          csrfToken: csrfToken,
          phaseListLength: phaseList.length
        }) %>
      <% }); %>
    </ol>
```

- [ ] **Step 4: Run the existing phase-route integration tests**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/projects tests/integration/admin
```

Expected: all green — extract was meant to be behaviour-preserving.

- [ ] **Step 5: Commit**

```bash
git add views/components/_phase-row.ejs views/admin/projects/detail.ejs
git commit -m "$(cat <<'EOF'
refactor(projects): extract _phase-row.ejs partial

Pure extract — phase row markup moves verbatim into a reusable partial,
detail.ejs becomes a one-line include. Adds id="phase-<id>" anchor +
data-fragment="row" hooks for the upcoming fragment-swap handler. Phase
Delete now goes through _confirm-dialog (matches credentials side).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Phase row layout — two-row card, click-to-edit label, status menu, overflow menu

**Files:**
- Modify: `views/components/_phase-row.ejs` (markup restructure)
- Append: `public/styles/app.css` (phase-row card styles, status-menu, overflow-menu)

This task only touches markup + CSS. JS hookup (autosave-on-blur, popovers) lands in Task 10 — until then the form structure still works as plain submits.

- [ ] **Step 1: Restructure `_phase-row.ejs` to a two-row card**

Replace the body of `_phase-row.ejs` with the following. The ↑/↓ + Delete now live inside an overflow menu instead of being inline; the rename Save button is hidden by default and only shown when the input value differs from the original; the status select wraps a clickable pill:

```ejs
<%# Two-row phase card. Locals: phase, idx, customer, project, csrfToken, phaseListLength %>
<%
  var p = phase;
  var items = (p.items || []);
  var doneCount = items.filter(function(i){ return i.done_at; }).length;
%>
<li class="phase-row card" id="phase-<%= p.id %>" data-status="<%= p.status %>" data-phase-id="<%= p.id %>">
  <div class="phase-row__top">
    <span class="phase-row__handle" aria-hidden="true">⋮⋮</span>
    <span class="phase-row__index" aria-hidden="true"><%= idx + 1 %></span>

    <form class="phase-row__rename" method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/rename" data-fragment="row">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <label class="visually-hidden" for="phase-label-<%= p.id %>">Phase label</label>
      <input id="phase-label-<%= p.id %>" class="phase-row__label-input" name="label" type="text" maxlength="200" value="<%= p.label %>" data-original-value="<%= p.label %>" required>
      <button class="btn btn--ghost btn--sm phase-row__rename-save" type="submit" hidden>Save</button>
    </form>

    <div class="phase-row__status-wrap" data-status-menu>
      <button class="status-pill status-pill--phase-<%= p.status === 'in_progress' ? 'in-progress' : (p.status === 'not_started' ? 'not-started' : p.status) %> status-pill--button" type="button" aria-haspopup="menu" aria-expanded="false">
        <%= p.status === 'not_started' ? 'not started' : (p.status === 'in_progress' ? 'in progress' : p.status) %>
      </button>
      <form class="phase-row__status-form" method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/status" data-fragment="row" hidden>
        <input type="hidden" name="_csrf" value="<%= csrfToken %>">
        <input type="hidden" name="status" data-status-input>
      </form>
      <div class="status-menu" role="menu" hidden>
        <% ['not_started','in_progress','blocked','done'].forEach(function(s) { %>
          <button type="button" role="menuitem" class="status-menu__item" data-set-status="<%= s %>" <%= p.status === s ? 'aria-current="true"' : '' %>><%= s === 'not_started' ? 'not started' : (s === 'in_progress' ? 'in progress' : s) %></button>
        <% }); %>
      </div>
    </div>

    <div class="phase-row__overflow" data-overflow-menu>
      <button class="btn btn--icon btn--ghost" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for <%= p.label %>">⋯</button>
      <div class="overflow-menu" role="menu" hidden>
        <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/reorder" data-fragment="row">
          <input type="hidden" name="_csrf" value="<%= csrfToken %>">
          <input type="hidden" name="direction" value="up">
          <button type="submit" role="menuitem" class="overflow-menu__item" <%= idx === 0 ? 'disabled' : '' %>>↑ Move up</button>
        </form>
        <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/reorder" data-fragment="row">
          <input type="hidden" name="_csrf" value="<%= csrfToken %>">
          <input type="hidden" name="direction" value="down">
          <button type="submit" role="menuitem" class="overflow-menu__item" <%= idx === phaseListLength - 1 ? 'disabled' : '' %>>↓ Move down</button>
        </form>
        <hr class="overflow-menu__sep">
        <%- include('./_confirm-dialog', {
          id: 'delete-phase-' + p.id,
          triggerLabel: '🗑 Delete phase',
          triggerVariant: 'danger',
          triggerSize: 'sm',
          confirmLabel: 'Delete phase',
          title: 'Delete phase ' + p.label + '?',
          body: 'This removes the phase and any checklist items inside it. Cannot be undone.',
          formAction: '/admin/customers/' + customer.id + '/projects/' + project.id + '/phases/' + p.id + '/delete',
          csrfToken: csrfToken
        }) %>
      </div>
    </div>
  </div>

  <details class="phase-row__checklist" <%= p.status !== 'not_started' ? 'open' : '' %>>
    <summary>Checklist (<%= items.length %><%= items.length === 0 ? '' : ', ' + doneCount + ' done' %>)</summary>
    <% if (items.length === 0) { %>
      <p class="checklist-empty">No items yet. Add your first checklist item below.</p>
    <% } else { %>
      <ul class="checklist-list">
        <% items.forEach(function(it) { %>
          <li class="checklist-item" data-done="<%= it.done_at ? 'true' : 'false' %>">
            <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/toggle" data-fragment="row">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <input type="hidden" name="done" value="<%= it.done_at ? 'false' : 'true' %>">
              <button class="btn btn--icon" type="submit" aria-label="<%= it.done_at ? 'Mark ' + it.label + ' as not done' : 'Mark ' + it.label + ' as done' %>"><%= it.done_at ? '☑' : '☐' %></button>
            </form>
            <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/rename" class="checklist-item__rename" data-fragment="row">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <label class="visually-hidden" for="item-label-<%= it.id %>">Item label</label>
              <input id="item-label-<%= it.id %>" class="phase-row__label-input" name="label" type="text" maxlength="500" value="<%= it.label %>" data-original-value="<%= it.label %>" required>
              <button class="btn btn--ghost btn--sm" type="submit" hidden>Save</button>
            </form>
            <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/visibility" data-fragment="row">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <input type="hidden" name="visibleToCustomer" value="<%= it.visible_to_customer ? 'false' : 'true' %>">
              <button class="btn btn--ghost checklist-item__visibility" type="submit" aria-label="<%= it.visible_to_customer ? 'Hide ' + it.label + ' from customer' : 'Show ' + it.label + ' to customer' %>"><%= it.visible_to_customer ? 'Customer visible' : 'Admin only' %></button>
            </form>
            <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/delete" data-fragment="row">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <button class="btn btn--ghost btn--danger" type="submit" aria-label="Delete <%= it.label %>">×</button>
            </form>
          </li>
        <% }); %>
      </ul>
    <% } %>
    <form class="checklist-create-form" method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items" data-fragment="row">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <label class="visually-hidden" for="new-item-<%= p.id %>">New checklist item label</label>
      <input id="new-item-<%= p.id %>" class="phase-row__label-input" name="label" type="text" maxlength="500" placeholder="New checklist item" required>
      <label class="checklist-create-form__check">
        <input type="checkbox" name="visibleToCustomer" value="true" checked>
        Visible to customer
      </label>
      <button class="btn btn--primary btn--sm" type="submit">Add item</button>
    </form>
  </details>
</li>
```

Without JS the status pill is a button that doesn't open the menu (the `[hidden]` menu stays hidden); to keep no-JS users functional, also expose a `<noscript>` fallback that renders the original `<select>+Set` form. Add immediately after the `</div>` closing `phase-row__status-wrap`:

```ejs
    <noscript>
      <form method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/status">
        <input type="hidden" name="_csrf" value="<%= csrfToken %>">
        <select name="status">
          <option value="not_started" <%= p.status === 'not_started' ? 'selected' : '' %>>not started</option>
          <option value="in_progress" <%= p.status === 'in_progress' ? 'selected' : '' %>>in progress</option>
          <option value="blocked"     <%= p.status === 'blocked'     ? 'selected' : '' %>>blocked</option>
          <option value="done"        <%= p.status === 'done'        ? 'selected' : '' %>>done</option>
        </select>
        <button type="submit">Set</button>
      </form>
    </noscript>
```

(Equivalent `<noscript>` block for the rename Save button — it's hidden by default; without JS the `Save` is needed. Mark the rename Save with `data-rename-save` and unhide it in `<noscript>` via CSS.)

```ejs
    <noscript>
      <style>.phase-row__rename-save[hidden] { display: inline-flex !important; }</style>
    </noscript>
```

- [ ] **Step 2: Append phase-row CSS**

```css
/* === Portal UX pass 2026-05-03: phase row === */
.phase-row.card { padding: 0.75rem 1rem; margin: 0.5rem 0; }
.phase-row__top { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
.phase-row__handle { color: var(--text-muted, #888); cursor: grab; user-select: none; }
.phase-row__index {
  font-variant-numeric: tabular-nums; font-weight: 600;
  background: var(--surface-2, #181818); padding: 0 0.5rem;
  border-radius: 999px; min-width: 1.75rem; text-align: center;
}
.phase-row__rename { flex: 1 1 14rem; display: flex; gap: 0.5rem; align-items: center; }
.phase-row__label-input {
  flex: 1; background: transparent; border: 1px solid transparent;
  padding: 0.35rem 0.5rem; border-radius: 6px;
}
.phase-row__label-input:hover { border-color: var(--surface-border, #2a2a2a); }
.phase-row__label-input:focus { border-color: var(--accent, #4af); outline: none; background: var(--surface-2, #181818); }

.phase-row__status-wrap { position: relative; }
.status-pill--button { cursor: pointer; border: 0; }
.status-menu, .overflow-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 20;
  background: var(--surface-1, #111); border: 1px solid var(--surface-border, #2a2a2a);
  border-radius: 8px; box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.3));
  min-width: 12rem; padding: 0.25rem;
}
.status-menu__item, .overflow-menu__item {
  display: block; width: 100%; text-align: left; padding: 0.5rem 0.75rem;
  background: transparent; border: 0; color: inherit; cursor: pointer; border-radius: 6px;
}
.status-menu__item:hover, .overflow-menu__item:hover { background: var(--surface-2, #181818); }
.status-menu__item[aria-current="true"] { font-weight: 600; }
.overflow-menu__sep { border: 0; border-top: 1px solid var(--surface-border, #2a2a2a); margin: 0.25rem 0; }
.overflow-menu form { margin: 0; }

.phase-row__checklist { margin-top: 0.75rem; padding-top: 0.5rem; border-top: 1px dashed var(--surface-border, #2a2a2a); }
.phase-row__checklist > summary { cursor: pointer; padding: 0.25rem 0; user-select: none; }
```

- [ ] **Step 3: Smoke check**

```bash
cd /opt/dbstudio_portal && /usr/local/bin/staging-build.sh "feat(phases): two-row card layout"
```

Open `/admin/customers/<id>/projects/<id>`. Phase rows should now appear as cards with: handle, index, label input, clickable status pill (no menu yet — Task 10 wires it up), `⋯` overflow button (no menu yet), checklist below. Save button on rename is hidden — typing in the input still allows hitting Enter to submit.

- [ ] **Step 4: Commit**

```bash
git add views/components/_phase-row.ejs public/styles/app.css
git commit -m "$(cat <<'EOF'
feat(phases): two-row card layout with overflow + status menu shells

Markup + CSS only. Buttons no longer collide on a single line. JS to
open the status / overflow menus and autosave-on-blur for the label
lands in the next commit; until then forms still POST normally and the
<noscript> fallback exposes the original select+Set + Save controls.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `phase-editor.js` — fragment swap, autosave, popovers

**Files:**
- Create: `public/js/phase-editor.js`
- Modify: `views/admin/projects/detail.ejs` (load `phase-editor.js`)
- Modify: `routes/admin/project-phases.js` and `routes/admin/phase-checklist-items.js` (return fragment when `Accept: text/html-fragment` or `?fragment=row`)
- Test: `tests/integration/projects/phase-fragment.test.js`

- [ ] **Step 1: Write failing fragment-mode integration test**

Create `tests/integration/projects/phase-fragment.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as projectsService from '../../../domain/projects/service.js';
import * as phasesService from '../../../domain/phases/service.js';
import { createSession, stepUp } from '../../../lib/auth/session.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `phase_frag_${Date.now()}`;

describe.skipIf(skip)('phase routes content-negotiate fragment vs redirect', () => {
  let app, db;
  const ctx = () => ({ actorType: 'admin', audit: { tag }, ip: '198.51.100.60', userAgentHash: 'h' });

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    app = await build({ skipSafetyCheck: true });
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM phase_checklist_items WHERE phase_id IN (SELECT id FROM phases WHERE project_id IN (SELECT id FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})))`.execute(db);
    await sql`DELETE FROM phases WHERE project_id IN (SELECT id FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}))`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function makeFixture() {
    const c = await customersService.create(db, { razonSocial: `${tag} Co S.L.`, primaryUser: { name: 'U', email: `${tag}+u@example.com` } }, ctx());
    const pj = await projectsService.create(db, { customerId: c.customerId, name: 'P', objetoProyecto: 'x' }, ctx());
    const ph = await phasesService.create(db, { projectId: pj.projectId, customerId: c.customerId, label: '1' }, ctx(), { adminId: '00000000-0000-0000-0000-000000000001' });
    const created = await adminsService.create(db, { email: `${tag}+a@example.com`, name: 'A' }, { actorType: 'system', audit: { tag } });
    await adminsService.consumeInvite(db, { token: created.inviteToken, newPassword: 'a-pw-shouldnt-matter-12345' }, { audit: { tag }, hibpHasBeenPwned: async () => false });
    const sid = await createSession(db, { userType: 'admin', userId: created.id, ip: '198.51.100.60' });
    await stepUp(db, sid);
    return { customerId: c.customerId, projectId: pj.projectId, phaseId: ph.phaseId, signed: app.signCookie(sid) };
  }

  async function getCsrf(signed, customerId, projectId) {
    const r = await app.inject({ method: 'GET', url: `/admin/customers/${customerId}/projects/${projectId}`, headers: { cookie: 'sid=' + signed } });
    return (r.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  }

  it('default redirects with #phase-<id>', async () => {
    const f = await makeFixture();
    const csrf = await getCsrf(f.signed, f.customerId, f.projectId);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${f.customerId}/projects/${f.projectId}/phases/${f.phaseId}/rename`,
      headers: { cookie: 'sid=' + f.signed, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: csrf, label: '1.5' }).toString(),
    });
    expect([302, 303]).toContain(res.statusCode);
    expect(res.headers.location).toMatch(new RegExp(`/admin/customers/${f.customerId}/projects/${f.projectId}(\\?[^#]*)?#phase-${f.phaseId}$`));
  });

  it('returns row fragment when Accept: text/html-fragment', async () => {
    const f = await makeFixture();
    const csrf = await getCsrf(f.signed, f.customerId, f.projectId);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/customers/${f.customerId}/projects/${f.projectId}/phases/${f.phaseId}/rename`,
      headers: { cookie: 'sid=' + f.signed, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html-fragment' },
      payload: new URLSearchParams({ _csrf: csrf, label: '2' }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(new RegExp(`<li class="phase-row card" id="phase-${f.phaseId}"`));
    expect(res.body).not.toMatch(/<\/html>/i); // fragment, not full page
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/projects/phase-fragment.test.js
```

Expected: first test PASS (existing redirect — but anchor missing, so likely FAIL on the location regex), second test FAIL (no fragment mode yet). Both will go green after Step 4.

- [ ] **Step 3: Add fragment renderer helper**

In `routes/admin/project-phases.js`, replace the existing `back(reply, customerId, projectId, flash)` helper with a richer one that supports:
1. Fragment requests → render `_phase-row.ejs` for the affected phase
2. Default → redirect with `#phase-<id>` anchor

```js
import ejs from 'ejs';
import path from 'node:path';
import { listPhasesByProject } from '../../domain/phases/repo.js';
import { listItemsByPhase } from '../../domain/phase-checklist-items/repo.js';

const VIEWS_DIR = path.resolve(process.cwd(), 'views');

function wantsFragment(req) {
  const acc = String(req.headers['accept'] ?? '');
  if (acc.includes('text/html-fragment')) return true;
  if (typeof req.query?.fragment === 'string' && req.query.fragment === 'row') return true;
  return false;
}

async function renderPhaseFragment(reply, { customer, project, phaseId, csrfToken }) {
  const allPhases = await listPhasesByProject(reply.request.server.db, project.id);
  const idx = allPhases.findIndex(p => p.id === phaseId);
  if (idx === -1) {
    reply.code(404);
    return reply.send('');
  }
  const phase = allPhases[idx];
  const items = await listItemsByPhase(reply.request.server.db, phase.id);
  const html = await ejs.renderFile(
    path.join(VIEWS_DIR, 'components', '_phase-row.ejs'),
    {
      phase: { ...phase, items },
      idx,
      customer,
      project,
      csrfToken,
      phaseListLength: allPhases.length,
    },
    { root: VIEWS_DIR },
  );
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(html);
}

async function back(reply, req, customerId, projectId, phaseId, flash) {
  if (wantsFragment(req)) {
    if (flash) {
      reply.code(422);
      return reply.send(`<div class="alert alert--error" role="alert"><div class="alert__body">${flash.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</div></div>`);
    }
    const customer = await findCustomerById(reply.request.server.db, customerId);
    const project = await findProjectById(reply.request.server.db, projectId);
    const csrfToken = await reply.generateCsrf();
    return renderPhaseFragment(reply, { customer, project, phaseId, csrfToken });
  }
  const anchor = phaseId ? `#phase-${phaseId}` : '';
  if (flash) {
    return reply.redirect(`/admin/customers/${customerId}/projects/${projectId}?phaseError=${encodeURIComponent(flash)}${anchor}`, 303);
  }
  return reply.redirect(`/admin/customers/${customerId}/projects/${projectId}${anchor}`, 303);
}
```

Update the existing call sites in this file: every `back(reply, guards.customer.id, guards.project.id, ...)` becomes `back(reply, req, guards.customer.id, guards.project.id, guards.phase?.id ?? null, ...)`. For the create handler (no phase yet), pass the newly-created phase id (return value of `phasesService.create`).

For the **delete** handler specifically, `wantsFragment(req)` returning true should return `204 No Content` with `HX-Trigger: phaseDeleted=<id>` header (or simpler: respond with `<div data-phase-deleted="<id>"></div>` and let the client handle removal). Pick the simpler option:

```js
if (wantsFragment(req)) {
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(`<div data-phase-deleted="${phaseId}"></div>`);
}
```

Apply the same `wantsFragment` + render-row pattern to `routes/admin/phase-checklist-items.js` — its routes redirect via `back` already (`grep -n "reply.redirect" routes/admin/phase-checklist-items.js` to find them). Since checklist-item changes affect a phase row, the same `renderPhaseFragment` helper applies.

To avoid code duplication, **move** `wantsFragment` + `renderPhaseFragment` into a shared module:

```js
// File: routes/admin/_phase-fragment.js
import ejs from 'ejs';
import path from 'node:path';
import { listPhasesByProject } from '../../domain/phases/repo.js';
import { listItemsByPhase } from '../../domain/phase-checklist-items/repo.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { findProjectById } from '../../domain/projects/repo.js';

const VIEWS_DIR = path.resolve(process.cwd(), 'views');

export function wantsFragment(req) {
  const acc = String(req.headers['accept'] ?? '');
  if (acc.includes('text/html-fragment')) return true;
  if (typeof req.query?.fragment === 'string' && req.query.fragment === 'row') return true;
  return false;
}

export async function renderPhaseFragment(app, reply, { customerId, projectId, phaseId }) {
  const customer = await findCustomerById(app.db, customerId);
  const project = await findProjectById(app.db, projectId);
  if (!customer || !project) { reply.code(404); return reply.send(''); }
  const allPhases = await listPhasesByProject(app.db, project.id);
  const idx = allPhases.findIndex(p => p.id === phaseId);
  if (idx === -1) { reply.code(404); return reply.send(''); }
  const phase = allPhases[idx];
  const items = await listItemsByPhase(app.db, phase.id);
  const csrfToken = await reply.generateCsrf();
  const html = await ejs.renderFile(
    path.join(VIEWS_DIR, 'components', '_phase-row.ejs'),
    { phase: { ...phase, items }, idx, customer, project, csrfToken, phaseListLength: allPhases.length },
    { root: VIEWS_DIR },
  );
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(html);
}
```

Both route files import from this shared module. Update `back` to accept `app` and `phaseId`, and to call `renderPhaseFragment(app, reply, { customerId, projectId, phaseId })` when `wantsFragment(req)` is true.

- [ ] **Step 4: Run test to verify it passes**

```bash
RUN_DB_TESTS=1 npx vitest run tests/integration/projects/phase-fragment.test.js tests/integration/projects tests/integration/admin/project-phases tests/integration/admin/phase-checklist-items 2>/dev/null
```

Expected: PASS — both new fragment cases plus all pre-existing phase tests stay green (the redirect path + anchor are the only behaviour change for non-fragment callers).

- [ ] **Step 5: Write `public/js/phase-editor.js`**

```js
(function () {
  'use strict';
  if (!('fetch' in window)) return;
  var section = document.querySelector('.phase-section');
  if (!section) return;

  function getRow(form) { return form.closest('.phase-row'); }
  function getFormFragmentTarget(form) {
    if (form.dataset.fragment !== 'row') return null;
    return getRow(form);
  }

  async function submitFragment(form) {
    var row = getFormFragmentTarget(form);
    if (!row) return null; // let normal submit happen
    var action = form.action;
    var fd = new FormData(form);
    var res = await fetch(action, {
      method: form.method || 'POST',
      headers: { 'Accept': 'text/html-fragment' },
      body: fd,
      credentials: 'same-origin',
    });
    var html = await res.text();
    if (res.status === 204 || /^\s*<div data-phase-deleted=/.test(html)) {
      row.remove();
      return null;
    }
    if (!res.ok) {
      // Insert error alert above row
      var alert = document.createElement('div');
      alert.innerHTML = html;
      row.parentNode.insertBefore(alert.firstElementChild || alert, row);
      return null;
    }
    var tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    var fresh = tpl.content.firstElementChild;
    if (!fresh) return null;
    row.replaceWith(fresh);
    var first = fresh.querySelector('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
    return fresh;
  }

  section.addEventListener('submit', function (ev) {
    var form = ev.target.closest('form[data-fragment="row"]');
    if (!form) return;
    ev.preventDefault();
    submitFragment(form).catch(function () {
      // Network failure: fall back to native submit.
      form.removeAttribute('data-fragment');
      form.submit();
    });
  });

  // Autosave-on-blur for label inputs.
  section.addEventListener('blur', function (ev) {
    var input = ev.target.closest('input.phase-row__label-input');
    if (!input) return;
    var original = input.dataset.originalValue;
    if (input.value === original) return;
    var form = input.closest('form');
    if (!form) return;
    submitFragment(form);
  }, true);

  // Status menu open/close.
  document.addEventListener('click', function (ev) {
    var statusBtn = ev.target.closest('[data-status-menu] > .status-pill--button');
    if (statusBtn) {
      ev.preventDefault();
      var wrap = statusBtn.parentElement;
      var menu = wrap.querySelector('.status-menu');
      var open = !menu.hasAttribute('hidden');
      closeAllMenus();
      if (!open) { menu.removeAttribute('hidden'); statusBtn.setAttribute('aria-expanded', 'true'); }
      return;
    }
    var statusItem = ev.target.closest('.status-menu__item');
    if (statusItem) {
      ev.preventDefault();
      var wrap = statusItem.closest('[data-status-menu]');
      var form = wrap.querySelector('.phase-row__status-form');
      var input = form.querySelector('[data-status-input]');
      input.value = statusItem.dataset.setStatus;
      closeAllMenus();
      submitFragment(form);
      return;
    }
    var overflowBtn = ev.target.closest('[data-overflow-menu] > .btn');
    if (overflowBtn) {
      ev.preventDefault();
      var wrap = overflowBtn.parentElement;
      var menu = wrap.querySelector('.overflow-menu');
      var open = !menu.hasAttribute('hidden');
      closeAllMenus();
      if (!open) { menu.removeAttribute('hidden'); overflowBtn.setAttribute('aria-expanded', 'true'); }
      return;
    }
    if (!ev.target.closest('.status-menu, .overflow-menu')) closeAllMenus();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeAllMenus();
  });

  function closeAllMenus() {
    document.querySelectorAll('.status-menu, .overflow-menu').forEach(function (m) { m.setAttribute('hidden', ''); });
    document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
  }
})();
```

- [ ] **Step 6: Load the script on the project detail page**

In `views/admin/projects/detail.ejs`, at the end of the file, append:

```ejs
<script src="/static/js/phase-editor.js" nonce="<%= nonce %>"></script>
```

Wrap the phase section in a `class="phase-section"` parent if it isn't already. (Verify `<section class="card phase-section">` is present at line ~84 of detail.ejs — if so, the script's `document.querySelector('.phase-section')` will find it.)

- [ ] **Step 7: Smoke check**

```bash
cd /opt/dbstudio_portal && /usr/local/bin/staging-build.sh "feat(phases): fragment swap + autosave-on-blur"
```

In a browser:
1. Edit a phase label, click outside → no flash, no reload, label persists, focus lands on the new input.
2. Click the status pill → menu opens; click a status → row updates in place.
3. Click `⋯` → menu opens with Move up / Move down / Delete phase.
4. Click Delete phase → confirm dialog → confirm → row disappears (no reload).
5. Toggle a checklist item → done state flips in place.
6. Disable JS in devtools → reload → all forms still work via redirect+anchor (slightly noisier but functional).
7. Confirm scroll position is preserved by anchor scrolling on no-JS path.

- [ ] **Step 8: Commit**

```bash
git add public/js/phase-editor.js views/admin/projects/detail.ejs routes/admin/_phase-fragment.js routes/admin/project-phases.js routes/admin/phase-checklist-items.js tests/integration/projects/phase-fragment.test.js
git commit -m "$(cat <<'EOF'
feat(phases): fragment-swap editor, autosave-on-blur, status + overflow menus

phase-editor.js intercepts form submits with data-fragment="row",
fetches with Accept: text/html-fragment, replaces the row in place,
focuses the first input so screen readers keep context. New shared
routes/admin/_phase-fragment.js renders _phase-row.ejs partial.
Default (non-fragment) callers keep redirect-with-#phase-id behaviour
plus scroll-margin-top so the anchor lands below the sticky chrome.
On network failure the JS removes its listener and lets the form do a
normal POST.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Final smoke + Codex/Kimi review pass

- [ ] **Step 1: Run the full test suite**

```bash
cd /opt/dbstudio_portal && RUN_DB_TESTS=1 npx vitest run
```

Expected: all green. Pay special attention to:
- `tests/integration/credentials/*` (existing + 2 new)
- `tests/integration/projects/*` (existing + 1 new)
- `tests/integration/admin/*`

- [ ] **Step 2: Generate a Codex review prompt**

```bash
codex-review-prompt --repo /opt/dbstudio_portal
```

Then invoke the **superpowers:code-reviewer** skill against `.reviews/codex-review-prompt.md`. Address any BLOCK issues and re-run; merge of APPROVE / APPROVE WITH CHANGES required before deploy gate.

- [ ] **Step 3: Run Kimi design review**

```bash
kimi-design-review --repo /opt/dbstudio_portal
```

Read `.reviews/kimi-design-review.md`. Apply BLOCK fixes inline. If a patch lands at `.reviews/kimi-design.patch`, review it carefully and apply with `external-ai-apply-patch --repo /opt/dbstudio_portal --patch .reviews/kimi-design.patch --source kimi` only after a manual diff read.

- [ ] **Step 4: Manual end-to-end smoke**

Open staging in two browsers (admin + customer accounts):
1. Admin: add credential. Confirm customer Activity feed shows it.
2. Admin: delete credential. Confirm customer Activity feed shows it.
3. Customer: delete a credential via the new dialog. Confirm shape matches `Add a credential`.
4. Admin: edit phase label, change status, reorder, delete. No reload, no scroll jump.
5. Long page: confirm sticky chrome stays pinned, mobile collapse works below 640px.
6. Disable JS: confirm all destructive flows still work via inline `<details>` + form POST + redirect-anchor.

- [ ] **Step 5: Update `docs/build-log.md`**

Append a dated entry under the existing build log:

```markdown
## 2026-05-03 — Portal UX pass

- Shared `_confirm-dialog` component (native `<dialog>` + `<details>` no-JS fallback).
- Sticky `page-header` + `subtabs` on every admin and customer page; mobile collapse below 640px.
- Admin direct add + delete on credentials; customer-visible audit + Phase B digest fan-out keeps the customer's Activity feed honest about admin-side mutations.
- Phase editor: two-row card layout, click status menu, `⋯` overflow menu, autosave-on-blur for labels, fetch+fragment-swap (no full reload). No-JS fallback via `<noscript>` + redirect+anchor.

Spec: `docs/superpowers/specs/2026-05-03-portal-ux-pass-design.md`
Plan: `docs/superpowers/plans/2026-05-03-portal-ux-pass.md`
```

- [ ] **Step 6: Commit final docs + deploy commit**

```bash
git add docs/build-log.md
/usr/local/bin/staging-build.sh "$(cat <<'EOF'
feat(portal): UX pass — phases, sticky chrome, credential CRUD, confirm dialog
EOF
)"
```

(Deploy script handles the commit + push + service restart.)

- [ ] **Step 7: STOP — wait for explicit "DEPLOY TO PRODUCTION"**

Do **not** run `/usr/local/bin/deploy-db-football.sh` (wrong project anyway) or any production deploy script. Production rollout for `dbstudio_portal` is owner-driven. SW bump is needed when this lands on prod (current SW is for db-football; the portal has its own service worker if any — check before bumping).

---

## Self-Review Checklist (run after writing each task)

**1. Spec coverage:** Every spec section has a task.
- Shared `_confirm-dialog` + `dialog.js` → Task 1
- Sticky chrome (CSS + sentinel + JS) → Task 3
- Phase editor (fragment swap + layout + JS) → Tasks 8/9/10
- Admin credential CRUD (createByAdmin, deleteByAdmin, routes, views) → Tasks 4/5/6/7
- Customer credentials button fix → Task 2

**2. Placeholder scan:** No "TBD"/"TODO"/"figure out"/"add validation". Every code step has the actual code.

**3. Type consistency:**
- `_phase-row.ejs` locals: `phase`, `idx`, `customer`, `project`, `csrfToken`, `phaseListLength` — same in Tasks 8, 9, and route helper in Task 10.
- `createByAdmin` signature `{ adminId, customerId, provider, label, payload, projectId }` — same in service def (Task 4), route call (Task 5), and test (Task 4 + Task 5).
- `deleteByAdmin` signature `{ adminId, credentialId }` — same in service def, route call, test.
- Confirm dialog locals: `id, triggerLabel, triggerVariant, triggerSize, confirmLabel, title, body, formAction, csrfToken` — used identically in Tasks 1, 2, 7, 8, 9.
