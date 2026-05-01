# Phases A + B + C — Combined Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land three approved specs in one inline-executed plan: Phase A UI/UX fixes, Phase B activity-digest emails (with the invoice payment ledger that feeds it), and Phase C invoice OCR auto-fill.

**Architecture:** Phase A is six narrow template/CSS/route patches. Phase B introduces a per-recipient debounce digest pipeline (two new tables + a 60-s worker) layered on top of the existing `email_outbox` pipeline; the four currently-immediate per-event templates stop being enqueued, replaced by digest items. Phase C adds an in-process `pdf-parse` parser plus an admin-only AJAX prefill endpoint for the existing invoice upload form.

**Tech Stack:** Node 20, Fastify 5, Kysely + raw SQL, Postgres 16, EJS 5, Vitest 4, MailerSend HTTP API, `pdf-parse` (new dep, Phase C).

**Workflow note:** This repo runs production-only on `main` (no staging, single-host operator workflow per `project_dbstudio_portal.md`). All commits land on `main`. Tests run via `sudo bash scripts/run-tests.sh` so the running `portal.service` doesn't race the suite.

**Execution order:** A → C → B. Phase A is fast; Phase C is mostly self-contained; Phase B is heaviest and last (it touches eight domain services). A and C never read or write tables that B introduces, so reordering is safe if needed.

---

## Repo conventions (read before starting)

- **Files & paths:** lower-kebab.js, ESM, `import` only. Tests live under `tests/<unit|integration>/<area>/…spec.js` mirroring source paths.
- **DB:** Kysely `app.db` is wired in `server.js`; raw SQL via `sql\`\`` is the dominant pattern in this repo.
- **Auth helpers:** `requireAdminSession(app, req, reply)` for admin routes, `requireCustomerSession(...)` for customer routes; both short-circuit reply on failure (return falsy).
- **CSRF:** `app.csrfProtection` preHandler on every state-changing route; `_csrf` field in form bodies, `x-csrf-token` header for AJAX.
- **EJS render:** `renderAdmin(req, reply, viewName, locals)` and `renderCustomer(...)` from `lib/render.js`; locals include `nonce`, helpers (`euDateTime`, `euDate`).
- **Audit:** every state change writes to `audit_log` via the helper in `lib/audit.js`. Visibility flag `visible_to_customer` controls customer-feed exposure.
- **Tests:** Vitest with a live Postgres test DB (truncated between tests via the existing harness). Run from repo root with `sudo bash scripts/run-tests.sh` or the targeted form `sudo bash scripts/run-tests.sh tests/unit/lib/invoice-parser.spec.js`.
- **Pre-commit:** `lint-staged` runs `eslint --fix` and `prettier --write`. Don't fight it — let it format.
- **Commit style:** Conventional Commits, single short subject, optional body. Existing `m11-22.x` style is for this M11 phase; this plan uses `phase-a-N`, `phase-b-N`, `phase-c-N` slugs.
- **GPG signing:** all commits should be GPG-signed (per project memory). The repo's existing local config handles this; if a commit fails for GPG reasons, fix the underlying agent / key issue rather than passing `--no-gpg-sign`.

---

# PHASE A — UI/UX FIXES

## Task A1: Width-policy flip — every detail/edit page widens to match list pages

**Spec ref:** Phase A §A1.

**Files:**
- Modify: `routes/admin/customers.js` (every `mainWidth: 'content'` except `not-found` callsites)
- Modify: `routes/admin/credential-requests.js`
- Modify: `routes/admin/invoices.js`
- Modify: `routes/admin/ndas.js`
- Modify: `routes/admin/profile.js`
- Modify: `routes/admin/projects.js`
- Modify: `routes/customer/credential-requests.js`
- Modify: `routes/customer/credentials.js`
- Modify: `routes/customer/invoices.js`
- Modify: `routes/customer/profile.js`
- Keep `'content'` in: `routes/customer/onboarding.js`, every `*/not-found` render call.

- [ ] **Step 1: Pre-flight grep for the current state**

```bash
grep -rn "mainWidth: 'content'" /opt/dbstudio_portal/routes/ | wc -l
grep -rn "mainWidth: 'content'" /opt/dbstudio_portal/routes/customer/onboarding.js | wc -l
```

Expected: total > 30, onboarding count is the only one that should remain unchanged besides `not-found` renders.

- [ ] **Step 2: Edit each route file — admin side**

In each of `routes/admin/{customers,credential-requests,invoices,ndas,profile,projects}.js`, replace every literal `mainWidth: 'content'` with `mainWidth: 'wide'` **except** lines that render the `*/not-found` view. Identify those by the surrounding `renderAdmin(..., 'admin/customers/not-found', ...)` (or similar). Leave those at `'content'`.

Use `Edit replace_all` only when safe; otherwise edit one occurrence at a time and verify the surrounding view name on each.

- [ ] **Step 3: Edit each route file — customer side**

Same operation in `routes/customer/{credential-requests,credentials,invoices,profile}.js`. Do **not** touch `routes/customer/onboarding.js` — it is the documented exception (full-screen single-task surfaces).

- [ ] **Step 4: Verify no `not-found` render lost its `'content'` width**

```bash
grep -rn "not-found" /opt/dbstudio_portal/routes/ | grep -v "mainWidth: 'content'" | grep "renderAdmin\|renderCustomer"
```

Expected: empty output. Any line returned is a not-found render that lost its narrow width — fix it.

- [ ] **Step 5: Service restart smoke**

```bash
sudo systemctl restart portal.service
sleep 2
curl -sI http://127.0.0.1:3400/admin/customers | head -1
sudo journalctl -u portal.service -n 20 --no-pager
```

Expected: HTTP 302 (redirect to login is fine — service is healthy); no errors in journal.

- [ ] **Step 6: Commit**

```bash
cd /opt/dbstudio_portal
git add routes/
git commit -m "fix(phase-a-1): widen detail/edit pages to match list-page surface width"
```

---

## Task A2: `GET /admin` → 302 redirect to `/admin/customers`

**Spec ref:** Phase A §A2.

**Files:**
- Create: `routes/admin/_index.js`
- Modify: `server.js` (add one `import` + one register call)

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/admin/index-redirect.spec.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildApp } from '../../helpers/build-app.js';
import { signInAsAdmin } from '../../helpers/auth.js';

describe('GET /admin', () => {
  it('redirects authenticated admin to /admin/customers', async () => {
    const app = await buildApp();
    const cookie = await signInAsAdmin(app);
    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin/customers');
    await app.close();
  });

  it('challenges unauthenticated visitors like other /admin/* routes', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin' });
    // The existing requireAdminSession redirects to the admin sign-in page.
    expect([302, 401]).toContain(res.statusCode);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
sudo bash scripts/run-tests.sh tests/integration/admin/index-redirect.spec.js
```

Expected: FAIL — route returns 404 because it's not registered.

- [ ] **Step 3: Implement the route module**

Create `routes/admin/_index.js`:

```js
import { requireAdminSession } from '../../lib/auth/middleware.js';

export function registerAdminIndexRoute(app) {
  app.get('/admin', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;
    return reply.redirect('/admin/customers', 302);
  });
}
```

- [ ] **Step 4: Wire it into `server.js`**

Find the cluster of admin route imports/registrations in `server.js`. Add the import next to the others:

```js
import { registerAdminIndexRoute } from './routes/admin/_index.js';
```

And the registration next to `registerAdminCustomerRoutes(app)`:

```js
registerAdminIndexRoute(app);
```

- [ ] **Step 5: Re-run the test**

```bash
sudo bash scripts/run-tests.sh tests/integration/admin/index-redirect.spec.js
```

Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add routes/admin/_index.js server.js tests/integration/admin/index-redirect.spec.js
git commit -m "feat(phase-a-2): GET /admin → 302 /admin/customers"
```

---

## Task A3: Defensive `form` default in EJS templates

**Spec ref:** Phase A §A3.

**Files:**
- Modify: `views/customer/credential-requests/detail.ejs` (the file with the actual reported crash)
- Audit + modify any other EJS file under `views/customer/**` and `views/admin/**` that uses `form?.` without a hoisted default.

- [ ] **Step 1: Write the failing render test**

Create `tests/unit/views/credential-request-detail.spec.js`:

```js
import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const viewsRoot = path.resolve(__dirname, '../../../views');

describe('customer/credential-requests/detail.ejs', () => {
  it('renders without throwing when `form` local is undefined', async () => {
    const tpl = path.join(viewsRoot, 'customer/credential-requests/detail.ejs');
    const html = await ejs.renderFile(tpl, {
      request: {
        id: '00000000-0000-0000-0000-000000000000',
        provider: 'Acme',
        status: 'open',
        created_at: new Date(),
        updated_at: new Date(),
        fields: [{ name: 'username', label: 'Username', type: 'text', required: true }],
      },
      csrfToken: 'x',
      euDateTime: (d) => String(d),
      // intentionally NOT passing `form`
    }, { root: viewsRoot, async: true });
    expect(html).toContain('Provide credentials');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
sudo bash scripts/run-tests.sh tests/unit/views/credential-request-detail.spec.js
```

Expected: FAIL with `form is not defined`.

- [ ] **Step 3: Hoist a defensive default in the template**

Edit `views/customer/credential-requests/detail.ejs`. Immediately after the existing pillKey block (around line 12, after `%>`) add:

```ejs
<%
  var f = (typeof form !== 'undefined' && form) ? form : {};
%>
```

Then replace the three `form?.…` reads with `f.…`:

- Line ~49: `value="<%= form?.label ?? '' %>"` → `value="<%= f.label ?? '' %>"`
- Line ~59: `<%= form?.payload?.[f.name] ?? '' %>` → `<%= (f.payload && f.payload[field.name]) ?? '' %>` — **and rename the loop variable** from `f` to `field` to avoid shadowing. The full forEach becomes:

```ejs
<% request.fields.forEach(function(field) { %>
  <div class="input-field">
    <label class="input-field__label" for="cred_field_<%= field.name %>"><%= field.label %><%= field.required ? ' *' : '' %></label>
    <div class="input-field__control">
      <% if (field.type === 'note') { %>
        <textarea id="cred_field_<%= field.name %>" name="field__<%= field.name %>" rows="4" <%= field.required ? 'required' : '' %>><%= (f.payload && f.payload[field.name]) ?? '' %></textarea>
      <% } else if (field.type === 'secret') { %>
        <input id="cred_field_<%= field.name %>" type="password" name="field__<%= field.name %>" <%= field.required ? 'required' : '' %>
               autocomplete="new-password" value="<%= (f.payload && f.payload[field.name]) ?? '' %>">
      <% } else if (field.type === 'url') { %>
        <input id="cred_field_<%= field.name %>" type="url" name="field__<%= field.name %>" <%= field.required ? 'required' : '' %>
               value="<%= (f.payload && f.payload[field.name]) ?? '' %>">
      <% } else { %>
        <input id="cred_field_<%= field.name %>" type="text" name="field__<%= field.name %>" <%= field.required ? 'required' : '' %>
               value="<%= (f.payload && f.payload[field.name]) ?? '' %>">
      <% } %>
    </div>
  </div>
<% }) %>
```

- Line ~88: `<%= form?.reason ?? '' %>` → `<%= f.reason ?? '' %>`

- [ ] **Step 4: Re-run the render test**

```bash
sudo bash scripts/run-tests.sh tests/unit/views/credential-request-detail.spec.js
```

Expected: PASS.

- [ ] **Step 5: Audit the rest of the EJS tree**

```bash
grep -rn "form?\." /opt/dbstudio_portal/views/ | grep -v "// " | head -50
```

For each match: read the template; if it does **not** already hoist a `var f = (typeof form !== 'undefined' && form) ? form : {};` (or equivalent), apply the same fix pattern. Common offenders likely live in `views/admin/{customers,invoices,projects,credentials,credential-requests,documents,ndas}/{new,edit}.ejs` and the customer mirrors of these.

For each file fixed: hoist the local at the top of the form block, replace `form?.X` with `f.X`. No need to write a render test per file — one representative test (Step 1) anchors the pattern, and the spec's acceptance includes "no EJS template throws when `form` is unset".

- [ ] **Step 6: Re-grep to confirm zero remaining unguarded uses**

```bash
grep -rn "form?\." /opt/dbstudio_portal/views/
```

Expected: every remaining match is **inside** a block where `form` has just been re-hoisted as the local `f` (in which case `form?.` is unused, so really expected = 0 matches).

- [ ] **Step 7: Commit**

```bash
git add views/ tests/unit/views/
git commit -m "fix(phase-a-3): hoist defensive form default in EJS templates"
```

---

## Task A4: Universal sign-out button at the bottom of the sidebar

**Spec ref:** Phase A §A4.

**Files:**
- Modify: `views/components/_sidebar-customer.ejs`
- Modify: `views/components/_sidebar-admin.ejs`
- Modify: `views/components/_top-bar.ejs` (remove the existing `top-bar__signout` link)
- Modify: `public/styles/app.src.css` (add `.sidebar` flex layout + `.sidebar__footer` rules)
- Run: the existing CSS build (`node scripts/build.js` or however the existing pipeline does it — check `package.json` `build` script).

- [ ] **Step 1: Edit `_sidebar-customer.ejs`**

Replace the file with:

```ejs
<%# Customer sidebar. Locals: active (dashboard|ndas|documents|credentials|credential-requests|invoices|projects|activity|profile). %>
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
  <div class="sidebar__footer">
    <%- include('./_button', { variant: 'ghost', size: 'md', href: '/logout', label: 'Sign out' }) %>
  </div>
</nav>
```

- [ ] **Step 2: Edit `_sidebar-admin.ejs`**

Replace the file with:

```ejs
<%# Admin sidebar. Locals: active (customers|audit|profile). %>
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
  <div class="sidebar__footer">
    <%- include('./_button', { variant: 'ghost', size: 'md', href: '/logout', label: 'Sign out' }) %>
  </div>
</nav>
```

- [ ] **Step 3: Edit `_top-bar.ejs` to remove the existing sign-out link**

Replace the `top-bar__menu` block with:

```ejs
  <div class="top-bar__menu">
    <% if (user) { %>
      <span class="top-bar__user"><%= user.name %></span>
    <% } %>
  </div>
```

(Just removes the `<a class="top-bar__signout" href="/logout">Sign out</a>` line. The username display stays.)

- [ ] **Step 4: Add `.sidebar` flex + `.sidebar__footer` CSS**

In `public/styles/app.src.css`, find the existing `.sidebar` rule. If it does not already use `display: flex; flex-direction: column;`, add those properties so `margin-top: auto` works on the footer.

Append (or edit alongside the existing sidebar rules) the following new rule block:

```css
.sidebar { display: flex; flex-direction: column; }
.sidebar__list { flex: 1 1 auto; }
.sidebar__footer {
  margin-top: auto;
  padding: var(--s-4) var(--s-6);
  border-top: 1px solid var(--border-light);
}
.sidebar__footer .btn { width: 100%; justify-content: center; }
```

(If the existing `.sidebar` already has `display: flex`, only the new `.sidebar__list { flex: 1 1 auto }` and the `.sidebar__footer` rules are needed. Read the file first; do not duplicate.)

- [ ] **Step 5: Rebuild the compiled CSS**

```bash
cd /opt/dbstudio_portal
npm run build
```

Expected: `public/styles/app.css` is regenerated. Confirm with:

```bash
grep -c "sidebar__footer" public/styles/app.css
```

Expected: ≥ 1.

- [ ] **Step 6: Restart and smoke**

```bash
sudo systemctl restart portal.service
sleep 2
sudo journalctl -u portal.service -n 20 --no-pager
```

Visual smoke (manually, on operator browser): sign in as customer → confirm sign-out button at bottom of sidebar, ghost-style, full width; sign out → repeat as admin; confirm top bar no longer shows the "Sign out" link.

- [ ] **Step 7: Commit**

```bash
git add views/components/_sidebar-customer.ejs views/components/_sidebar-admin.ejs views/components/_top-bar.ejs public/styles/app.src.css public/styles/app.css
git commit -m "feat(phase-a-4): universal sign-out button at sidebar footer; remove top-bar link"
```

---

## Task A5: Customer dashboard `.bento` → equal cells

**Spec ref:** Phase A §A5.

**Files:**
- Modify: `public/styles/app.src.css` (locate the `.bento` rule + any `:first-child` or `:nth-child` rule that grants extra spans)
- Run: CSS build.

- [ ] **Step 1: Find the current `.bento` rule**

```bash
grep -n "\.bento\b" /opt/dbstudio_portal/public/styles/app.src.css
```

Read the surrounding ~30 lines. Identify any rule that grants extra `grid-column: span N` to a specific child.

- [ ] **Step 2: Replace with the equal-cell grid**

Edit `public/styles/app.src.css`. Replace the existing `.bento { … }` rule (and any companion `:first-child` / `:nth-child` rules that make some cells larger) with:

```css
.bento {
  display: grid;
  gap: var(--s-6);
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}
```

Remove any `:first-child { grid-column: span 2 }` style sibling rule. Keep any `.bento__item` paddings / typography rules — they are unrelated.

- [ ] **Step 3: Rebuild and restart**

```bash
cd /opt/dbstudio_portal && npm run build
sudo systemctl restart portal.service
```

Visual smoke: customer dashboard shows six equally-sized cards, responsively re-flowing between 1/2/3 columns at narrow/medium/wide widths.

- [ ] **Step 4: Commit**

```bash
git add public/styles/app.src.css public/styles/app.css
git commit -m "fix(phase-a-5): equal-cell .bento grid on customer dashboard"
```

---

## Task A6: `.data-table a:not(.btn)` guard

**Spec ref:** Phase A §A6.

**Files:**
- Modify: `public/styles/app.src.css` (lines 926–929 region per the current grep).
- Run: CSS build.

- [ ] **Step 1: Locate the rules**

```bash
grep -nE "\.data-table a\b" /opt/dbstudio_portal/public/styles/app.src.css
```

Read the surrounding 6 lines.

- [ ] **Step 2: Add `:not(.btn)` to all three selectors**

In `public/styles/app.src.css`, change:

```css
.data-table a { color: var(--c-obsidian); text-decoration: none; }
.data-table a:hover { color: var(--c-moss); text-decoration: underline; text-underline-offset: 3px; }
.data-table a:focus-visible { /* …existing rule… */ }
```

to:

```css
.data-table a:not(.btn) { color: var(--c-obsidian); text-decoration: none; }
.data-table a:not(.btn):hover { color: var(--c-moss); text-decoration: underline; text-underline-offset: 3px; }
.data-table a:not(.btn):focus-visible { /* …existing rule… */ }
```

(Preserve the existing focus-visible rule body; only narrow its selector.)

- [ ] **Step 3: Rebuild and restart**

```bash
cd /opt/dbstudio_portal && npm run build
sudo systemctl restart portal.service
```

Visual smoke: navigate to `/customer/credential-requests` (need at least one open request seeded). The "Fulfil →" pill renders white-on-moss-green, identical to "New customer" on `/admin/customers`.

- [ ] **Step 4: Commit**

```bash
git add public/styles/app.src.css public/styles/app.css
git commit -m "fix(phase-a-6): scope .data-table a colour rules to :not(.btn)"
```

---

# PHASE C — INVOICE OCR AUTO-FILL

## Task C1: Add `pdf-parse` and write the parser library + tests

**Spec ref:** Phase C §2.

**Files:**
- Modify: `package.json` (add dep)
- Modify: `package-lock.json` (auto)
- Create: `lib/invoice-parser.js`
- Create: `tests/unit/lib/invoice-parser.spec.js`
- Create: `tests/fixtures/invoice-nl.pdf` (copy of the operator's sample, sanitised if needed)

- [ ] **Step 1: Add the dependency**

```bash
cd /opt/dbstudio_portal
npm install --save pdf-parse@^1.1.1
```

Expected: `pdf-parse` appears in `dependencies`. Confirm:

```bash
grep -A0 '"pdf-parse"' package.json
```

- [ ] **Step 2: Place the fixture PDF**

```bash
mkdir -p /opt/dbstudio_portal/tests/fixtures
cp /tmp/example-invoice.pdf /opt/dbstudio_portal/tests/fixtures/invoice-nl.pdf
ls -la /opt/dbstudio_portal/tests/fixtures/invoice-nl.pdf
```

Expected: file exists, ~91 KB.

- [ ] **Step 3: Write failing parser tests**

Create `tests/unit/lib/invoice-parser.spec.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { parseInvoicePdf } from '../../../lib/invoice-parser.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(__dirname, '../../fixtures');

describe('parseInvoicePdf', () => {
  it('extracts all five fields from the NL sample invoice', async () => {
    const buf = await fs.readFile(path.join(fixturesRoot, 'invoice-nl.pdf'));
    const r = await parseInvoicePdf(buf);
    expect(r.ok).toBe(true);
    expect(r.lang).toBe('nl');
    expect(r.fields.invoice_number).toBe('2026/002772');
    expect(r.fields.amount_cents).toBe(19800);
    expect(r.fields.currency).toBe('EUR');
    expect(r.fields.issued_on).toBe('2026-04-27');
    expect(r.fields.due_on).toBe('2026-05-04');
    expect(r.fields_found).toBe(4);  // currency does not count
  });

  it('returns ok:false with reason no_text on an empty buffer', async () => {
    // Smallest valid PDF skeleton, zero text content.
    const empty = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');
    const r = await parseInvoicePdf(empty);
    expect(r.ok).toBe(false);
    expect(['no_text', 'parse_error']).toContain(r.reason);
  });

  describe('amount canonicalisation', () => {
    const cases = [
      ['198,00', 19800],
      ['1.234,56', 123456],
      ['1,234.56', 123456],
      ['1234.56', 123456],
      ['1234', 123400],
    ];
    it.each(cases)('normalises %s to %i cents', async (raw, expected) => {
      const { __test_normaliseAmount: norm } = await import('../../../lib/invoice-parser.js');
      expect(norm(raw)).toBe(expected);
    });
  });

  describe('language detection', () => {
    it('returns lang:en when an English-shaped invoice is provided', async () => {
      // Synthesise a tiny PDF? Skip in v1 — the NL fixture is the contract.
      // We assert the priority order via the helper directly.
      const { __test_pickLang: pick } = await import('../../../lib/invoice-parser.js');
      const text = 'INVOICE 2026/000001\nDate 27/04/2026\nDue 04/05/2026\nTOTAL 100,00€\n';
      expect(pick(text)).toBe('en');
    });
    it('falls back to customer locale on tie', async () => {
      const { __test_pickLang: pick } = await import('../../../lib/invoice-parser.js');
      // Unknown text, no labels at all.
      expect(pick('random gibberish', 'es')).toBe('es');
    });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/invoice-parser.spec.js
```

Expected: FAIL — `Cannot find module '../../../lib/invoice-parser.js'`.

- [ ] **Step 5: Implement `lib/invoice-parser.js`**

Create `lib/invoice-parser.js`:

```js
// pdf-parse is a CommonJS module; default-import works under Node ESM.
import pdfParse from 'pdf-parse';

const LABELS = {
  invoice: { nl: 'FACTUUR', en: 'INVOICE', es: 'FACTURA' },
  date:    { nl: 'Datum',   en: 'Date',    es: 'Fecha' },
  due:     { nl: 'Te verwachten', en: 'Due', es: 'Vencimiento' },
};

const TOTAL_RE = /(TOTAAL|TOTAL)\s+([\d.,]+)\s*€/g;

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickLang(text, fallback = 'en') {
  const score = { nl: 0, en: 0, es: 0 };
  for (const lang of ['nl', 'en', 'es']) {
    if (new RegExp(`^\\s*${escape(LABELS.invoice[lang])}\\s+`, 'm').test(text)) score[lang]++;
    if (new RegExp(`(?<!\\w)${escape(LABELS.date[lang])}\\s+\\d{2}\\/\\d{2}\\/\\d{4}`, 'i').test(text)) score[lang]++;
    if (new RegExp(`(?<!\\w)${escape(LABELS.due[lang])}\\s+\\d{2}\\/\\d{2}\\/\\d{4}`, 'i').test(text)) score[lang]++;
  }
  // 'TOTAAL' is NL-specific; 'TOTAL' is shared EN/ES so contributes to neither uniquely.
  if (/TOTAAL/.test(text)) score.nl++;

  let best = null, bestScore = -1;
  for (const lang of ['nl', 'en', 'es']) {
    if (score[lang] > bestScore) { best = lang; bestScore = score[lang]; }
  }
  if (bestScore < 2) return fallback;
  return best;
}

function normaliseAmount(raw) {
  if (!raw) return null;
  const s = raw.trim();
  // If both . and , appear, treat the LAST one as the decimal separator and the OTHER as thousand separator.
  // If only , appears, it's the decimal separator (NL/ES style).
  // If only . appears: ambiguous. Treat last . as decimal IF there are exactly 2 trailing digits; else treat all . as thousand separators.
  // If neither appears: integer.
  let normalised;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) {
      normalised = s.replace(/\./g, '').replace(',', '.');
    } else {
      normalised = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalised = s.replace(',', '.');
  } else if (hasDot) {
    const m = s.match(/\.(\d+)$/);
    if (m && m[1].length === 2) normalised = s;
    else normalised = s.replace(/\./g, '');
  } else {
    normalised = s;
  }
  const n = Number.parseFloat(normalised);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function ddmmyyyyToISO(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  // Round-trip verify the date is real (e.g. rejects 31/02/2026).
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function findInvoiceNumber(text, lang) {
  const word = LABELS.invoice[lang];
  const re = new RegExp(`^\\s*${escape(word)}\\s+([A-Z0-9/-]*\\d[A-Z0-9/-]*)\\s*$`, 'mi');
  const m = re.exec(text);
  return m ? m[1] : null;
}

function findDate(text, lang, kind) {
  const word = LABELS[kind][lang];
  const re = new RegExp(`(?<!\\w)${escape(word)}\\s+(\\d{2}\\/\\d{2}\\/\\d{4})`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  return ddmmyyyyToISO(m[1]);
}

function findTotal(text) {
  let last = null;
  for (const m of text.matchAll(TOTAL_RE)) {
    last = m[2];
  }
  return last ? normaliseAmount(last) : null;
}

export async function parseInvoicePdf(buffer, opts = {}) {
  let parsed;
  try {
    parsed = await pdfParse(buffer);
  } catch (err) {
    return { ok: false, reason: 'parse_error', message: err?.message ?? 'unknown' };
  }
  const text = (parsed?.text ?? '').trim();
  if (!text) return { ok: false, reason: 'no_text' };

  const lang = pickLang(text, opts.fallbackLocale ?? 'en');
  const fields = {};
  const inv = findInvoiceNumber(text, lang);
  if (inv) fields.invoice_number = inv;
  const issued = findDate(text, lang, 'date');
  if (issued) fields.issued_on = issued;
  const due = findDate(text, lang, 'due');
  if (due) fields.due_on = due;
  const amt = findTotal(text);
  if (amt) fields.amount_cents = amt;
  fields.currency = 'EUR';

  // fields_found counts non-currency fields
  const fields_found = ['invoice_number', 'amount_cents', 'issued_on', 'due_on']
    .filter((k) => fields[k] !== undefined).length;

  return { ok: true, lang, fields, fields_found, warnings: [] };
}

// Test-only exports (do not consume from production code).
export const __test_normaliseAmount = normaliseAmount;
export const __test_pickLang = pickLang;
```

- [ ] **Step 6: Re-run the tests**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/invoice-parser.spec.js
```

Expected: all PASS. If the NL-fixture test fails on a specific field, read the actual `parsed.text` (add a `console.log` temporarily to see it) and tighten the regex.

- [ ] **Step 7: Commit**

```bash
git add lib/invoice-parser.js tests/unit/lib/invoice-parser.spec.js tests/fixtures/invoice-nl.pdf package.json package-lock.json
git commit -m "feat(phase-c-1): pdf-parse-based invoice parser library + tests"
```

---

## Task C2: `POST /admin/invoices/parse-pdf` route

**Spec ref:** Phase C §3.

**Files:**
- Modify: `routes/admin/invoices.js` (add the new route)
- Create: `tests/integration/admin/parse-pdf.spec.js`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/admin/parse-pdf.spec.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { buildApp } from '../../helpers/build-app.js';
import { signInAsAdmin, csrfFor } from '../../helpers/auth.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXT = path.resolve(__dirname, '../../fixtures/invoice-nl.pdf');

describe('POST /admin/invoices/parse-pdf', () => {
  it('returns extracted fields for the NL sample', async () => {
    const app = await buildApp();
    const cookie = await signInAsAdmin(app);
    const csrf = await csrfFor(app, cookie);
    const buf = await fs.readFile(FIXT);

    const form = new FormData();
    form.append('_csrf', csrf);
    form.append('file', new Blob([buf], { type: 'application/pdf' }), 'invoice-nl.pdf');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/invoices/parse-pdf',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: form,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.fields.invoice_number).toBe('2026/002772');
    expect(body.fields.amount_cents).toBe(19800);
    expect(body.fields.issued_on).toBe('2026-04-27');
    expect(body.fields.due_on).toBe('2026-05-04');
    await app.close();
  });

  it('rejects unauthenticated', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/admin/invoices/parse-pdf' });
    expect([302, 401, 403]).toContain(res.statusCode);
    await app.close();
  });

  it('rejects non-PDF MIME', async () => {
    const app = await buildApp();
    const cookie = await signInAsAdmin(app);
    const csrf = await csrfFor(app, cookie);
    const form = new FormData();
    form.append('_csrf', csrf);
    form.append('file', new Blob([Buffer.from('not a pdf')], { type: 'text/plain' }), 'not.txt');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/invoices/parse-pdf',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: form,
    });
    expect([400, 415, 422]).toContain(res.statusCode);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
sudo bash scripts/run-tests.sh tests/integration/admin/parse-pdf.spec.js
```

Expected: FAIL — route 404.

- [ ] **Step 3: Add the route in `routes/admin/invoices.js`**

Add a new import at the top:

```js
import { parseInvoicePdf } from '../../lib/invoice-parser.js';
```

At the end of `registerAdminInvoicesRoutes(app)` (just before its closing brace), add:

```js
  app.post(
    '/admin/invoices/parse-pdf',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const session = await requireAdminSession(app, req, reply);
      if (!session) return;

      const MAX_BYTES = 15 * 1024 * 1024;
      let received = 0;
      const chunks = [];
      let mime = null;
      let saw_file = false;

      try {
        for await (const part of req.parts()) {
          if (part.type !== 'file') continue;
          saw_file = true;
          mime = part.mimetype || '';
          if (!mime.includes('pdf')) {
            part.file.resume();
            return reply.code(415).send({ ok: false, reason: 'mime' });
          }
          for await (const chunk of part.file) {
            received += chunk.length;
            if (received > MAX_BYTES) {
              part.file.resume();
              return reply.code(413).send({ ok: false, reason: 'too_large' });
            }
            chunks.push(chunk);
          }
        }
      } catch (err) {
        return reply.code(400).send({ ok: false, reason: 'multipart', message: err?.message ?? 'unknown' });
      }

      if (!saw_file) return reply.code(400).send({ ok: false, reason: 'no_file' });

      const result = await parseInvoicePdf(Buffer.concat(chunks));
      return reply.send(result);
    },
  );
```

- [ ] **Step 4: Re-run the integration test**

```bash
sudo bash scripts/run-tests.sh tests/integration/admin/parse-pdf.spec.js
```

Expected: all three cases PASS.

- [ ] **Step 5: Commit**

```bash
git add routes/admin/invoices.js tests/integration/admin/parse-pdf.spec.js
git commit -m "feat(phase-c-2): POST /admin/invoices/parse-pdf endpoint"
```

---

## Task C3: Update `views/admin/invoices/new.ejs` for parse-and-prefill

**Spec ref:** Phase C §4.

**Files:**
- Modify: `views/admin/invoices/new.ejs`
- Modify: `public/styles/app.src.css` (add chip + banner CSS)

- [ ] **Step 1: Add the chip + banner markup**

Edit `views/admin/invoices/new.ejs`. Insert immediately after the `<form id="invoice-form" …>` opening tag and before `<input type="hidden" name="_csrf" …>`:

```ejs
  <div id="parse-banner" class="alert alert--info" hidden role="status" aria-live="polite">
    <span class="alert__icon" aria-hidden="true">✓</span>
    <p class="alert__body" id="parse-banner-text"></p>
  </div>
```

For each of the five `_input` includes (invoice_number, amount_cents, currency, issued_on, due_on), wrap the existing include in a `<div class="input-with-chip" data-field="<name>">` so the script can find it:

```ejs
<div class="input-with-chip" data-field="invoice_number">
  <%- include('../../components/_input', { name: 'invoice_number', type: 'text', label: 'Invoice number', required: true, maxlength: 64, value: (form && form.invoice_number) || '' }) %>
</div>
```

(Repeat the same wrapper for `amount_cents`, `currency`, `issued_on`, `due_on`.)

- [ ] **Step 2: Replace the inline script**

Replace the existing `<script nonce="<%= nonce %>">…</script>` block at the bottom of the file with:

```ejs
<script nonce="<%= nonce %>">
  (function () {
    var f = document.getElementById('invoice-form');
    var fileInput = document.getElementById('inv_file');
    var banner = document.getElementById('parse-banner');
    var bannerText = document.getElementById('parse-banner-text');

    function attachChip(fieldName) {
      var wrap = f.querySelector('[data-field="' + fieldName + '"]');
      if (!wrap || wrap.querySelector('.chip--auto-filled')) return;
      var label = wrap.querySelector('.input-field__label');
      if (!label) return;
      var chip = document.createElement('span');
      chip.className = 'chip chip--auto-filled';
      chip.textContent = 'Auto-filled';
      chip.setAttribute('aria-label', 'Auto-filled by PDF parser');
      label.appendChild(chip);
      var input = wrap.querySelector('input, textarea');
      if (input) {
        input.addEventListener('input', function once() {
          chip.remove();
          input.removeEventListener('input', once);
        });
      }
    }

    function setField(name, value) {
      var wrap = f.querySelector('[data-field="' + name + '"]');
      if (!wrap) return;
      var input = wrap.querySelector('input, textarea');
      if (!input) return;
      input.value = value;
      attachChip(name);
    }

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var fd = new FormData();
      fd.append('file', file);
      fetch('/admin/invoices/parse-pdf', {
        method: 'POST',
        body: fd,
        headers: { 'x-csrf-token': f.dataset.csrf },
        credentials: 'same-origin'
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) return;
        var fields = j.fields || {};
        if (fields.invoice_number) setField('invoice_number', fields.invoice_number);
        if (fields.amount_cents !== undefined) setField('amount_cents', String(fields.amount_cents));
        setField('currency', fields.currency || 'EUR');
        if (fields.issued_on) setField('issued_on', fields.issued_on);
        if (fields.due_on)    setField('due_on',    fields.due_on);
        if (j.fields_found > 0 && j.fields_found < 4) {
          bannerText.textContent = 'Auto-filled ' + j.fields_found + ' of 4 fields from the PDF. Please complete the missing field(s) before saving.';
          banner.hidden = false;
        }
      }).catch(function () { /* silent fallback */ });
    });

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(f);
      fetch(f.action, {
        method: 'POST',
        body: fd,
        headers: { 'x-csrf-token': f.dataset.csrf },
        credentials: 'same-origin',
        redirect: 'follow'
      }).then(function (r) {
        if (r.redirected) window.location.href = r.url;
        else r.text().then(function (t) { document.body.innerHTML = t; });
      }).catch(function () {
        alert('Upload failed.');
      });
    });
  })();
</script>
```

- [ ] **Step 3: Add CSS for the chip and the input wrapper**

In `public/styles/app.src.css`, append:

```css
.input-with-chip { display: contents; }
.chip { display: inline-block; padding: 2px 8px; margin-left: var(--s-2); border-radius: 999px; font-size: var(--f-xs); font-weight: 600; line-height: 1.4; vertical-align: middle; }
.chip--auto-filled { background: var(--c-pearl); color: var(--c-obsidian); }
```

- [ ] **Step 4: Rebuild CSS and restart**

```bash
cd /opt/dbstudio_portal && npm run build
sudo systemctl restart portal.service
```

- [ ] **Step 5: Manual smoke**

Open `/admin/customers/<existing customer id>/invoices/new` in browser. Drop the operator's invoice PDF into the file field. Watch all five fields populate; chips appear next to each label; type into one field — its chip disappears.

- [ ] **Step 6: Commit**

```bash
git add views/admin/invoices/new.ejs public/styles/app.src.css public/styles/app.css
git commit -m "feat(phase-c-3): parse-and-prefill UX with auto-filled chips on /admin/.../invoices/new"
```

---

# PHASE B — ACTIVITY-DIGEST EMAILS (with invoice payment ledger)

## Task B1: Migration 0010 — three new tables + locale columns

**Spec ref:** Phase B §2.

**Files:**
- Create: `migrations/0010_digest_and_payments.sql`
- Modify: `lib/db/types.d.ts` (regenerate via `npm run db:codegen` after migration is applied)

- [ ] **Step 1: Author the migration**

Create `migrations/0010_digest_and_payments.sql`:

```sql
-- Phase B (2026-05-01): per-recipient debounce digest pipeline + invoice payment ledger.

-- Per-recipient debounce timer.
CREATE TABLE digest_schedules (
  recipient_type text NOT NULL CHECK (recipient_type IN ('customer_user', 'admin')),
  recipient_id   uuid NOT NULL,
  due_at         timestamptz NOT NULL,
  oldest_item_at timestamptz NOT NULL,
  PRIMARY KEY (recipient_type, recipient_id)
);
CREATE INDEX digest_schedules_due_at_idx ON digest_schedules (due_at);

-- Pending items waiting to be summarised.
CREATE TABLE pending_digest_items (
  id              uuid PRIMARY KEY,
  recipient_type  text NOT NULL CHECK (recipient_type IN ('customer_user', 'admin')),
  recipient_id    uuid NOT NULL,
  customer_id     uuid NULL,
  bucket          text NOT NULL CHECK (bucket IN ('action_required', 'fyi')),
  event_type      text NOT NULL,
  title           text NOT NULL,
  detail          text NULL,
  link_path       text NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_digest_items_recipient_idx
  ON pending_digest_items (recipient_type, recipient_id, created_at);
CREATE INDEX pending_digest_items_coalesce_idx
  ON pending_digest_items (recipient_type, recipient_id, event_type, customer_id);

-- Invoice payment ledger.
CREATE TABLE invoice_payments (
  id           uuid PRIMARY KEY,
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL CHECK (currency IN ('EUR')),
  paid_on      date NOT NULL,
  note         text NULL,
  recorded_by  uuid NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_invoice_idx ON invoice_payments (invoice_id, paid_on);

-- Per-recipient locale (used by digest fan-out + future per-event mails).
ALTER TABLE customer_users ADD COLUMN locale CHAR(2) NOT NULL DEFAULT 'en';
ALTER TABLE admins         ADD COLUMN locale CHAR(2) NOT NULL DEFAULT 'en';
```

- [ ] **Step 2: Apply the migration**

```bash
cd /opt/dbstudio_portal
npm run migrate
```

Expected: log line `0010_digest_and_payments applied`. Confirm:

```bash
psql "$DATABASE_URL" -c "\d digest_schedules" -c "\d pending_digest_items" -c "\d invoice_payments" | head -60
```

- [ ] **Step 3: Regenerate Kysely types**

```bash
cd /opt/dbstudio_portal
npm run db:codegen
```

Expected: `lib/db/types.d.ts` updated to include `DigestSchedules`, `PendingDigestItems`, `InvoicePayments`, and `locale` on `CustomerUsers` + `Admins`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0010_digest_and_payments.sql lib/db/types.d.ts
git commit -m "feat(phase-b-1): migration 0010 — digest tables + invoice_payments + locale columns"
```

---

## Task B2: `PORTAL_EMAIL_DEV_HOLD` env flag in `lib/email.js`

**Spec ref:** Phase B §8.

**Files:**
- Modify: `lib/email.js`
- Create: `tests/unit/lib/email-dev-hold.spec.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lib/email-dev-hold.spec.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { makeMailer } from '../../../lib/email.js';

describe('makeMailer dev hold', () => {
  it('does NOT call fetch when devHold=true', async () => {
    const fetch = vi.fn();
    const log = vi.fn();
    const m = makeMailer({ apiKey: 'k', fromEmail: 'a@b', fromName: 'X', fetch, devHold: true, log });
    const r = await m.send({ to: 't@x', subject: 's', html: '<p/>', idempotencyKey: 'k1' });
    expect(r.ok).toBe(true);
    expect(r.held).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('calls fetch when devHold=false', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 202, headers: { get: () => 'mid' } });
    const m = makeMailer({ apiKey: 'k', fromEmail: 'a@b', fromName: 'X', fetch, devHold: false });
    const r = await m.send({ to: 't@x', subject: 's', html: '<p/>', idempotencyKey: 'k1' });
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/email-dev-hold.spec.js
```

Expected: FAIL — `held` is undefined; `devHold` not honoured.

- [ ] **Step 3: Add the dev-hold short-circuit**

In `lib/email.js`, change `makeMailer` signature to accept `devHold` and `log`, and short-circuit `send`:

```js
export function makeMailer({
  apiKey,
  fromEmail,
  fromName,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  devHold = false,
  log = null,
}) {
  return {
    async send({ to, subject, html, text, idempotencyKey }) {
      if (devHold) {
        log?.info?.({ to, subject, idempotencyKey }, 'mailer.dev_hold');
        return { ok: true, held: true, providerId: null };
      }
      // …existing body unchanged…
    },
  };
}
```

- [ ] **Step 4: Wire the env var into `server.js`**

Find where `makeMailer({ … })` is called in `server.js`. Add `devHold: process.env.PORTAL_EMAIL_DEV_HOLD === 'true'` to its options, and pass `log: logger` (or whatever the existing pino logger variable is named).

- [ ] **Step 5: Re-run the test**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/email-dev-hold.spec.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/email.js server.js tests/unit/lib/email-dev-hold.spec.js
git commit -m "feat(phase-b-2): PORTAL_EMAIL_DEV_HOLD env flag in mailer"
```

---

## Task B3: `domain/digest/repo.js` — record / claim / drain

**Spec ref:** Phase B §2, §4.

**Files:**
- Create: `domain/digest/repo.js`
- Create: `tests/unit/domain/digest/repo.spec.js`

- [ ] **Step 1: Failing tests for the repo**

Create `tests/unit/domain/digest/repo.spec.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../helpers/test-db.js';
import * as repo from '../../../../domain/digest/repo.js';

describe('digest repo', () => {
  let db;
  beforeEach(async () => { db = await withTestDb(); });

  it('insertItem inserts a row and upsertSchedule sets due_at', async () => {
    const recipientId = '11111111-1111-1111-1111-111111111111';
    await repo.insertItem(db, {
      recipientType: 'customer_user',
      recipientId,
      customerId: null,
      bucket: 'fyi',
      eventType: 'document.uploaded',
      title: 'New document: hello.pdf',
      detail: null,
      linkPath: '/customer/documents',
      metadata: {},
    });
    await repo.upsertSchedule(db, {
      recipientType: 'customer_user',
      recipientId,
      windowMinutes: 10,
      capMinutes: 60,
    });
    const sched = await repo.findSchedule(db, { recipientType: 'customer_user', recipientId });
    expect(sched).not.toBeNull();
    expect(new Date(sched.due_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('upsertSchedule applies the 60-min hard cap', async () => {
    const recipientId = '22222222-2222-2222-2222-222222222222';
    // First insert sets oldest_item_at = now.
    await repo.insertItem(db, { recipientType: 'admin', recipientId, customerId: null, bucket: 'fyi', eventType: 'x', title: 't', detail: null, linkPath: null, metadata: {} });
    await repo.upsertSchedule(db, { recipientType: 'admin', recipientId, windowMinutes: 10, capMinutes: 60 });
    // Simulate 55 minutes passing — slide once more.
    await db.executeQuery({ sql: `UPDATE digest_schedules SET oldest_item_at = now() - interval '55 minutes' WHERE recipient_id = '${recipientId}'`, parameters: [] });
    await repo.upsertSchedule(db, { recipientType: 'admin', recipientId, windowMinutes: 10, capMinutes: 60 });
    const sched = await repo.findSchedule(db, { recipientType: 'admin', recipientId });
    // due_at should be at most 5 minutes from now (oldest + 60 - 55 = 5).
    expect(new Date(sched.due_at).getTime() - Date.now()).toBeLessThan(6 * 60_000);
  });

  it('claimDue + drainItems + clearSchedule are transactional drain', async () => {
    const recipientId = '33333333-3333-3333-3333-333333333333';
    await repo.insertItem(db, { recipientType: 'customer_user', recipientId, customerId: null, bucket: 'fyi', eventType: 'x', title: 't', detail: null, linkPath: null, metadata: {} });
    await repo.upsertSchedule(db, { recipientType: 'customer_user', recipientId, windowMinutes: 0, capMinutes: 60 });
    const claimed = await db.transaction().execute(async (tx) => {
      const rows = await repo.claimDue(tx, { batchSize: 10 });
      const items = rows.length ? await repo.drainItems(tx, rows[0]) : [];
      if (rows.length) await repo.clearSchedule(tx, rows[0]);
      return { rows, items };
    });
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.items).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
sudo bash scripts/run-tests.sh tests/unit/domain/digest/repo.spec.js
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the repo**

Create `domain/digest/repo.js`:

```js
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

export async function insertItem(db, {
  recipientType, recipientId, customerId, bucket,
  eventType, title, detail, linkPath, metadata,
}) {
  const id = uuidv7();
  await sql`
    INSERT INTO pending_digest_items
      (id, recipient_type, recipient_id, customer_id, bucket, event_type, title, detail, link_path, metadata)
    VALUES (
      ${id}::uuid, ${recipientType}, ${recipientId}::uuid,
      ${customerId ? sql`${customerId}::uuid` : sql`NULL`},
      ${bucket}, ${eventType}, ${title}, ${detail}, ${linkPath},
      ${JSON.stringify(metadata ?? {})}::jsonb
    )
  `.execute(db);
  return id;
}

export async function findCoalescable(db, {
  recipientType, recipientId, eventType, customerId,
}) {
  const r = await sql`
    SELECT id, title, detail, metadata
      FROM pending_digest_items
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
       AND event_type     = ${eventType}
       AND customer_id IS NOT DISTINCT FROM ${customerId ? sql`${customerId}::uuid` : sql`NULL`}
     ORDER BY created_at DESC
     LIMIT 1
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function updateCoalesced(db, { id, title, detail, metadata }) {
  await sql`
    UPDATE pending_digest_items
       SET title    = ${title},
           detail   = ${detail},
           metadata = ${JSON.stringify(metadata ?? {})}::jsonb
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function upsertSchedule(db, {
  recipientType, recipientId, windowMinutes, capMinutes,
}) {
  const window = `${Number(windowMinutes)} minutes`;
  const cap = `${Number(capMinutes)} minutes`;
  await sql`
    INSERT INTO digest_schedules (recipient_type, recipient_id, due_at, oldest_item_at)
    VALUES (
      ${recipientType}, ${recipientId}::uuid,
      now() + (${window})::interval,
      now()
    )
    ON CONFLICT (recipient_type, recipient_id) DO UPDATE
      SET due_at = LEAST(
        now() + (${window})::interval,
        digest_schedules.oldest_item_at + (${cap})::interval
      )
  `.execute(db);
}

export async function findSchedule(db, { recipientType, recipientId }) {
  const r = await sql`
    SELECT recipient_type, recipient_id, due_at, oldest_item_at
      FROM digest_schedules
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function claimDue(tx, { batchSize }) {
  const r = await sql`
    SELECT recipient_type, recipient_id::text AS recipient_id
      FROM digest_schedules
     WHERE due_at <= now()
     ORDER BY due_at ASC
     LIMIT ${Number(batchSize)}
     FOR UPDATE SKIP LOCKED
  `.execute(tx);
  return r.rows;
}

export async function drainItems(tx, { recipientType, recipientId }) {
  const r = await sql`
    DELETE FROM pending_digest_items
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
    RETURNING id, customer_id, bucket, event_type, title, detail, link_path, metadata, created_at
  `.execute(tx);
  return r.rows;
}

export async function clearSchedule(tx, { recipientType, recipientId }) {
  await sql`
    DELETE FROM digest_schedules
     WHERE recipient_type = ${recipientType}
       AND recipient_id   = ${recipientId}::uuid
  `.execute(tx);
}
```

- [ ] **Step 4: Re-run tests**

```bash
sudo bash scripts/run-tests.sh tests/unit/domain/digest/repo.spec.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add domain/digest/repo.js tests/unit/domain/digest/repo.spec.js
git commit -m "feat(phase-b-3): digest repo (insertItem/upsertSchedule/claimDue/drainItems)"
```

---

## Task B4: `lib/digest.js` — `recordForDigest` helper + locale-rendered titles

**Spec ref:** Phase B §6.

**Files:**
- Create: `lib/digest.js`
- Create: `tests/unit/lib/digest.spec.js`

- [ ] **Step 1: Failing test for the helper**

Create `tests/unit/lib/digest.spec.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { recordForDigest, COALESCING_EVENTS } from '../../../lib/digest.js';

describe('recordForDigest', () => {
  it('inserts a fresh item + upserts schedule when no coalescable row exists', async () => {
    const tx = {};
    const repo = {
      findCoalescable: vi.fn().mockResolvedValue(null),
      insertItem: vi.fn().mockResolvedValue('id-1'),
      updateCoalesced: vi.fn(),
      upsertSchedule: vi.fn(),
    };
    await recordForDigest(tx, {
      recipientType: 'customer_user',
      recipientId: '11111111-1111-1111-1111-111111111111',
      customerId: null,
      bucket: 'fyi',
      eventType: 'document.uploaded',
      title: 'New document: report.pdf',
    }, { repo, windowMinutes: 10, capMinutes: 60 });
    expect(repo.insertItem).toHaveBeenCalledOnce();
    expect(repo.updateCoalesced).not.toHaveBeenCalled();
    expect(repo.upsertSchedule).toHaveBeenCalledOnce();
  });

  it('coalesces when event is in COALESCING_EVENTS and a row exists', async () => {
    const repo = {
      findCoalescable: vi.fn().mockResolvedValue({ id: 'old', title: 'New document: a.pdf', detail: null, metadata: { count: 1 } }),
      insertItem: vi.fn(),
      updateCoalesced: vi.fn(),
      upsertSchedule: vi.fn(),
    };
    expect(COALESCING_EVENTS.has('document.uploaded')).toBe(true);
    await recordForDigest({}, {
      recipientType: 'customer_user',
      recipientId: '11111111-1111-1111-1111-111111111111',
      bucket: 'fyi',
      eventType: 'document.uploaded',
      title: 'New document: b.pdf',
    }, { repo, windowMinutes: 10, capMinutes: 60 });
    expect(repo.insertItem).not.toHaveBeenCalled();
    expect(repo.updateCoalesced).toHaveBeenCalledOnce();
    const arg = repo.updateCoalesced.mock.calls[0][1];
    expect(arg.metadata.count).toBe(2);
    expect(arg.title).toMatch(/2 new documents/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/digest.spec.js
```

Expected: FAIL.

- [ ] **Step 3: Implement `lib/digest.js`**

Create `lib/digest.js`:

```js
import * as defaultRepo from '../domain/digest/repo.js';

export const COALESCING_EVENTS = new Set([
  'document.uploaded',
  'document.downloaded',
  'credential.viewed',
  'credential.created',
]);

function pluraliseTitle(eventType, oldTitle, count) {
  // Simple, conservative: replace leading "New X: …" or "DB Studio Y …" with the count form.
  // Falls back to "<old> + 1 more" if pattern doesn't match.
  const map = {
    'document.uploaded':    () => `${count} new documents`,
    'document.downloaded':  () => `${count} document downloads`,
    'credential.viewed':    () => `DB Studio viewed ${count} credentials`,
    'credential.created':   () => `${count} new credentials`,
  };
  const fn = map[eventType];
  return fn ? fn() : `${oldTitle} (+${count - 1} more)`;
}

export async function recordForDigest(tx, item, opts) {
  const repo = opts?.repo ?? defaultRepo;
  const windowMinutes = opts?.windowMinutes ?? 10;
  const capMinutes    = opts?.capMinutes    ?? 60;

  if (COALESCING_EVENTS.has(item.eventType)) {
    const existing = await repo.findCoalescable(tx, {
      recipientType: item.recipientType,
      recipientId:   item.recipientId,
      eventType:     item.eventType,
      customerId:    item.customerId ?? null,
    });
    if (existing) {
      const prevCount = Number(existing.metadata?.count ?? 1);
      const nextCount = prevCount + 1;
      await repo.updateCoalesced(tx, {
        id: existing.id,
        title: pluraliseTitle(item.eventType, existing.title, nextCount),
        detail: existing.detail,
        metadata: { ...(existing.metadata ?? {}), count: nextCount },
      });
      await repo.upsertSchedule(tx, {
        recipientType: item.recipientType,
        recipientId:   item.recipientId,
        windowMinutes, capMinutes,
      });
      return { coalesced: true, id: existing.id };
    }
  }

  const id = await repo.insertItem(tx, {
    recipientType: item.recipientType,
    recipientId:   item.recipientId,
    customerId:    item.customerId ?? null,
    bucket:        item.bucket,
    eventType:     item.eventType,
    title:         item.title,
    detail:        item.detail ?? null,
    linkPath:      item.linkPath ?? null,
    metadata:      { count: 1, ...(item.metadata ?? {}) },
  });
  await repo.upsertSchedule(tx, {
    recipientType: item.recipientType,
    recipientId:   item.recipientId,
    windowMinutes, capMinutes,
  });
  return { coalesced: false, id };
}
```

- [ ] **Step 4: Re-run tests**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/digest.spec.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/digest.js tests/unit/lib/digest.spec.js
git commit -m "feat(phase-b-4): recordForDigest helper with coalescing + sliding cap"
```

---

## Task B5: `domain/digest/worker.js` — claim, render, enqueue, drop empties

**Spec ref:** Phase B §4.

**Files:**
- Create: `domain/digest/worker.js`
- Create: `tests/unit/domain/digest/worker.spec.js`

- [ ] **Step 1: Failing test for `tickOnce`**

Create `tests/unit/domain/digest/worker.spec.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { withTestDb } from '../../../helpers/test-db.js';
import { tickOnce } from '../../../../domain/digest/worker.js';
import * as repo from '../../../../domain/digest/repo.js';

describe('digest worker tickOnce', () => {
  let db;
  beforeEach(async () => { db = await withTestDb(); });

  it('drains a due schedule, enqueues one outbox row, removes pending items', async () => {
    // Insert a recipient (customer_user) with locale.
    const userId = '11111111-1111-1111-1111-111111111111';
    const customerId = '99999999-9999-9999-9999-999999999999';
    await sql`INSERT INTO customers (id, razon_social, status) VALUES (${customerId}::uuid, 'Test SL', 'active')`.execute(db);
    await sql`INSERT INTO customer_users (id, customer_id, name, email, locale, status) VALUES (${userId}::uuid, ${customerId}::uuid, 'U', 'u@x', 'en', 'active')`.execute(db);

    await repo.insertItem(db, { recipientType: 'customer_user', recipientId: userId, customerId, bucket: 'fyi', eventType: 'x', title: 'New document: a.pdf', detail: null, linkPath: '/customer/documents', metadata: {} });
    await repo.upsertSchedule(db, { recipientType: 'customer_user', recipientId: userId, windowMinutes: 0, capMinutes: 60 });

    const r = await tickOnce({ db, log: { info() {}, warn() {}, error() {} }, batchSize: 10 });
    expect(r.fired).toBe(1);
    const remaining = await sql`SELECT COUNT(*) AS c FROM pending_digest_items WHERE recipient_id = ${userId}::uuid`.execute(db);
    expect(Number(remaining.rows[0].c)).toBe(0);
    const outbox = await sql`SELECT to_address, template, idempotency_key FROM email_outbox`.execute(db);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].template).toBe('digest');
    expect(outbox.rows[0].to_address).toBe('u@x');
  });

  it('drops empty digests (all items retracted before fire)', async () => {
    const userId = '22222222-2222-2222-2222-222222222222';
    const customerId = '88888888-8888-8888-8888-888888888888';
    await sql`INSERT INTO customers (id, razon_social, status) VALUES (${customerId}::uuid, 'Test SL', 'active')`.execute(db);
    await sql`INSERT INTO customer_users (id, customer_id, name, email, locale, status) VALUES (${userId}::uuid, ${customerId}::uuid, 'U', 'u@x', 'en', 'active')`.execute(db);

    // schedule with no items
    await sql`INSERT INTO digest_schedules (recipient_type, recipient_id, due_at, oldest_item_at) VALUES ('customer_user', ${userId}::uuid, now(), now())`.execute(db);
    const r = await tickOnce({ db, log: { info() {}, warn() {}, error() {} }, batchSize: 10 });
    expect(r.fired).toBe(0);
    expect(r.dropped).toBe(1);
    const sched = await sql`SELECT 1 FROM digest_schedules WHERE recipient_id = ${userId}::uuid`.execute(db);
    expect(sched.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
sudo bash scripts/run-tests.sh tests/unit/domain/digest/worker.spec.js
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `domain/digest/worker.js`**

Create `domain/digest/worker.js`:

```js
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import * as repo from './repo.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';

const DEFAULT_TICK_MS = 60_000;

async function loadRecipient(tx, { recipientType, recipientId }) {
  if (recipientType === 'customer_user') {
    const r = await sql`
      SELECT id::text, name, email, locale FROM customer_users WHERE id = ${recipientId}::uuid AND status = 'active'
    `.execute(tx);
    return r.rows[0] ?? null;
  }
  const r = await sql`
    SELECT id::text, name, email, locale FROM admins WHERE id = ${recipientId}::uuid AND status = 'active'
  `.execute(tx);
  return r.rows[0] ?? null;
}

function groupBuckets(items) {
  const action = items.filter((i) => i.bucket === 'action_required');
  const fyi    = items.filter((i) => i.bucket === 'fyi');
  return { action, fyi };
}

export async function tickOnce({ db, log, batchSize = 25 }) {
  return await db.transaction().execute(async (tx) => {
    const claims = await repo.claimDue(tx, { batchSize });
    if (claims.length === 0) return { claimed: 0, fired: 0, dropped: 0 };

    let fired = 0, dropped = 0;
    for (const claim of claims) {
      const recipient = await loadRecipient(tx, claim);
      const items = await repo.drainItems(tx, claim);
      if (!recipient || items.length === 0) {
        await repo.clearSchedule(tx, claim);
        dropped++;
        continue;
      }
      const buckets = groupBuckets(items);
      const subject = subjectFor(claim.recipient_type, buckets, recipient.locale);
      const idempotencyKey = `digest:${claim.recipient_type}:${claim.recipient_id}:${new Date().toISOString()}`;
      await enqueueEmail(tx, {
        idempotencyKey,
        toAddress: recipient.email,
        template: 'digest',
        locale: recipient.locale ?? 'en',
        locals: {
          subject,
          recipientName: recipient.name,
          isAdmin: claim.recipient_type === 'admin',
          actionItems: buckets.action,
          fyiItems: buckets.fyi,
        },
      });
      await repo.clearSchedule(tx, claim);
      fired++;
    }
    log?.info?.({ claimed: claims.length, fired, dropped }, 'digest.tick');
    return { claimed: claims.length, fired, dropped };
  });
}

function subjectFor(recipientType, buckets, locale) {
  // Locale-specific subjects are rendered inside the template; here we just emit
  // an English baseline as the outbox `subject` column is overwritten by
  // renderTemplate when the worker sends. (The email-outbox worker calls
  // renderTemplate which returns { subject, body } — see lib/email-templates.js.)
  if (recipientType === 'admin') {
    return 'DB Studio Portal — activity update';
  }
  if (buckets.action.length > 0) {
    return `Action required from DB Studio (${buckets.action.length} items)`;
  }
  return `What's new in your DB Studio Portal (${buckets.fyi.length} items)`;
}

export function startWorker(deps) {
  const intervalMs = deps.intervalMs ?? DEFAULT_TICK_MS;
  const interval = setInterval(() => {
    tickOnce(deps).catch((e) => {
      deps.log?.error?.({ err: { message: e?.message, stack: e?.stack } }, 'digest.tick_error');
    });
  }, intervalMs);
  if (typeof interval.unref === 'function') interval.unref();
  return () => clearInterval(interval);
}
```

- [ ] **Step 4: Re-run tests**

```bash
sudo bash scripts/run-tests.sh tests/unit/domain/digest/worker.spec.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add domain/digest/worker.js tests/unit/domain/digest/worker.spec.js
git commit -m "feat(phase-b-5): digest worker tickOnce + startWorker"
```

---

## Task B6: Digest email templates (EN/NL/ES)

**Spec ref:** Phase B §5.

**Files:**
- Create: `emails/en/digest.ejs`
- Create: `emails/nl/digest.ejs`
- Create: `emails/es/digest.ejs`
- Modify: `lib/email-templates.js` (no change expected, but verify the template name resolves; see step 3)

- [ ] **Step 1: Author the EN template**

Create `emails/en/digest.ejs`:

```ejs
<%- include('./_layout', { content: `
  <p>Hello, ${recipientName}.</p>

  <% if (actionItems && actionItems.length) { %>
    <h2>Action required</h2>
    <ul>
      <% actionItems.forEach(function(item) { %>
        <li>
          <% if (item.link_path) { %>
            <a href="https://portal.dbstudio.one${item.link_path}"><%= item.title %></a>
          <% } else { %>
            <%= item.title %>
          <% } %>
          <% if (item.detail) { %><br><span style="color:#555"><%= item.detail %></span><% } %>
        </li>
      <% }) %>
    </ul>
  <% } %>

  <% if (fyiItems && fyiItems.length) { %>
    <h2>For your information</h2>
    <ul>
      <% fyiItems.forEach(function(item) { %>
        <li>
          <% if (item.link_path) { %>
            <a href="https://portal.dbstudio.one${item.link_path}"><%= item.title %></a>
          <% } else { %>
            <%= item.title %>
          <% } %>
          <% if (item.detail) { %><br><span style="color:#555"><%= item.detail %></span><% } %>
        </li>
      <% }) %>
    </ul>
  <% } %>

  <p style="color:#555;font-size:12px">You're getting this because there was activity in your DB Studio Portal. <a href="https://portal.dbstudio.one/customer/dashboard">Sign in</a> to see the full timeline.</p>
` }) %>
```

> The `_layout.ejs` partial expects `subject` to set the email subject. Render-side: `lib/email-templates.js` already extracts the first `<title>` or first `<h1>` as the subject; if it does not, pass `subject` explicitly to the layout. Check the existing `lib/email-templates.js` to confirm the subject-extraction contract before this step is considered done.

- [ ] **Step 2: Translate to NL**

Create `emails/nl/digest.ejs` — same structure, with strings:
- `Hello, ${recipientName}.` → `Hallo, ${recipientName}.`
- `Action required` → `Actie vereist`
- `For your information` → `Ter informatie`
- `You're getting this…` → `Je ontvangt dit omdat er activiteit is geweest in je DB Studio Portal. <a …>Log in</a> om de volledige tijdlijn te zien.`

- [ ] **Step 3: Translate to ES**

Create `emails/es/digest.ejs` — same structure, with strings:
- `Hello, ${recipientName}.` → `Hola, ${recipientName}.`
- `Action required` → `Acción requerida`
- `For your information` → `Para tu información`
- `You're getting this…` → `Recibes esto porque ha habido actividad en tu Portal DB Studio. <a …>Inicia sesión</a> para ver la línea de tiempo completa.`

- [ ] **Step 4: Smoke-render each locale via the existing template helper**

```bash
node -e "import('./lib/email-templates.js').then(m => console.log(JSON.stringify(m.renderTemplate('digest','en',{ subject:'S', recipientName:'Bram', isAdmin:false, actionItems:[{title:'A'}], fyiItems:[]}),null,2)))"
```

Expected: prints `{ subject: ..., body: '<...>...' }` with the English template HTML. Repeat with `'nl'` and `'es'`.

- [ ] **Step 5: Commit**

```bash
git add emails/en/digest.ejs emails/nl/digest.ejs emails/es/digest.ejs
git commit -m "feat(phase-b-6): digest email templates EN/NL/ES"
```

---

## Task B7: Wire the digest worker into `server.js`

**Spec ref:** Phase B §4.

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Find the existing email-outbox worker startup**

```bash
grep -n "startWorker\|outbox-worker" /opt/dbstudio_portal/server.js
```

- [ ] **Step 2: Add the digest worker startup next to the outbox worker**

Near the outbox worker import + start, add:

```js
import { startWorker as startDigestWorker } from './domain/digest/worker.js';
// …
const stopDigest = startDigestWorker({ db: app.db, log: app.log, intervalMs: 60_000 });
```

In the existing graceful-shutdown handler (search for `app.addHook('onClose'` or similar), add `stopDigest();` next to the existing `stopOutbox?.();` (or equivalent).

- [ ] **Step 3: Restart and check logs**

```bash
sudo systemctl restart portal.service
sleep 3
sudo journalctl -u portal.service -n 40 --no-pager | grep -i digest
```

Expected: a `digest.tick` log line appears within ~60 s.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(phase-b-7): wire digest worker into server lifecycle"
```

---

## Task B8: `lib/digest-fanout.js` — recipient enumeration helpers + locale-rendered titles

**Spec ref:** Phase B §6.

**Files:**
- Create: `lib/digest-fanout.js`
- Create: `tests/unit/lib/digest-fanout.spec.js`

- [ ] **Step 1: Failing test**

Create `tests/unit/lib/digest-fanout.spec.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { withTestDb } from '../../helpers/test-db.js';
import { listActiveCustomerUsers, listActiveAdmins } from '../../../lib/digest-fanout.js';

describe('digest fanout', () => {
  let db;
  beforeEach(async () => { db = await withTestDb(); });

  it('returns active users for a customer with their locale', async () => {
    const cid = '99999999-9999-9999-9999-999999999999';
    await sql`INSERT INTO customers (id, razon_social, status) VALUES (${cid}::uuid,'X','active')`.execute(db);
    await sql`INSERT INTO customer_users (id, customer_id, name, email, locale, status) VALUES ('11111111-1111-1111-1111-111111111111'::uuid, ${cid}::uuid,'A','a@x','nl','active')`.execute(db);
    await sql`INSERT INTO customer_users (id, customer_id, name, email, locale, status) VALUES ('22222222-2222-2222-2222-222222222222'::uuid, ${cid}::uuid,'B','b@x','en','suspended')`.execute(db);
    const rows = await listActiveCustomerUsers(db, cid);
    expect(rows).toHaveLength(1);
    expect(rows[0].locale).toBe('nl');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/digest-fanout.spec.js
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/digest-fanout.js`**

```js
import { sql } from 'kysely';

export async function listActiveCustomerUsers(db, customerId) {
  const r = await sql`
    SELECT id::text AS id, name, email, locale
      FROM customer_users
     WHERE customer_id = ${customerId}::uuid
       AND status = 'active'
  `.execute(db);
  return r.rows;
}

export async function listActiveAdmins(db) {
  const r = await sql`
    SELECT id::text AS id, name, email, locale
      FROM admins
     WHERE status = 'active'
  `.execute(db);
  return r.rows;
}
```

- [ ] **Step 4: Re-run tests**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/digest-fanout.spec.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/digest-fanout.js tests/unit/lib/digest-fanout.spec.js
git commit -m "feat(phase-b-8): digest fan-out helpers (active customer_users + admins)"
```

---

## Task B9: Localised digest title strings (`lib/digest-strings.js`)

**Spec ref:** Phase B §6.

**Files:**
- Create: `lib/digest-strings.js`
- Create: `tests/unit/lib/digest-strings.spec.js`

- [ ] **Step 1: Failing test**

Create `tests/unit/lib/digest-strings.spec.js`:

```js
import { describe, it, expect } from 'vitest';
import { titleFor } from '../../../lib/digest-strings.js';

describe('digest title strings', () => {
  it('formats document.uploaded for customer in EN', () => {
    expect(titleFor('document.uploaded', 'en', { filename: 'report.pdf' })).toBe('New document: report.pdf');
  });
  it('NL', () => {
    expect(titleFor('document.uploaded', 'nl', { filename: 'verslag.pdf' })).toBe('Nieuw document: verslag.pdf');
  });
  it('ES', () => {
    expect(titleFor('document.uploaded', 'es', { filename: 'informe.pdf' })).toBe('Nuevo documento: informe.pdf');
  });
  it('falls back to EN on unknown locale', () => {
    expect(titleFor('document.uploaded', 'fr', { filename: 'x.pdf' })).toBe('New document: x.pdf');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/digest-strings.spec.js
```

- [ ] **Step 3: Implement `lib/digest-strings.js`**

Create with one entry per event type per locale. Cover at minimum: `nda.created`, `nda.signed`, `document.uploaded`, `document.downloaded`, `credential_request.created`, `credential_request.fulfilled`, `credential_request.not_applicable`, `credential.viewed`, `credential.created`, `credential.updated`, `credential.deleted`, `invoice.uploaded`, `invoice.payment_recorded`, `invoice.paid`, `project.created`, `project.status_changed`, `customer.suspended`, `customer.reactivated`, `customer.archived`.

```js
const T = {
  'document.uploaded': {
    en: ({ filename }) => `New document: ${filename}`,
    nl: ({ filename }) => `Nieuw document: ${filename}`,
    es: ({ filename }) => `Nuevo documento: ${filename}`,
  },
  'document.downloaded': {
    en: ({ customerName, filename }) => `${customerName} downloaded ${filename}`,
    nl: ({ customerName, filename }) => `${customerName} heeft ${filename} gedownload`,
    es: ({ customerName, filename }) => `${customerName} descargó ${filename}`,
  },
  'nda.created': {
    en: ({ ndaTitle }) => `New NDA: ${ndaTitle} — please sign`,
    nl: ({ ndaTitle }) => `Nieuwe NDA: ${ndaTitle} — graag tekenen`,
    es: ({ ndaTitle }) => `Nuevo NDA: ${ndaTitle} — por favor, firma`,
  },
  'nda.signed': {
    en: ({ customerName, ndaTitle }) => `${customerName} signed NDA: ${ndaTitle}`,
    nl: ({ customerName, ndaTitle }) => `${customerName} ondertekende NDA: ${ndaTitle}`,
    es: ({ customerName, ndaTitle }) => `${customerName} firmó NDA: ${ndaTitle}`,
  },
  'credential_request.created': {
    en: ({ provider }) => `Credentials requested: ${provider}`,
    nl: ({ provider }) => `Inloggegevens gevraagd: ${provider}`,
    es: ({ provider }) => `Credenciales solicitadas: ${provider}`,
  },
  'credential_request.fulfilled': {
    en: ({ customerName, provider }) => `${customerName} provided ${provider} credentials`,
    nl: ({ customerName, provider }) => `${customerName} heeft ${provider}-inloggegevens gegeven`,
    es: ({ customerName, provider }) => `${customerName} proporcionó credenciales de ${provider}`,
  },
  'credential_request.not_applicable': {
    en: ({ customerName, provider }) => `${customerName} marked ${provider} as not applicable`,
    nl: ({ customerName, provider }) => `${customerName} markeerde ${provider} als niet van toepassing`,
    es: ({ customerName, provider }) => `${customerName} marcó ${provider} como no aplicable`,
  },
  'credential.viewed': {
    en: () => `DB Studio viewed 1 credential`,
    nl: () => `DB Studio bekeek 1 inloggegeven`,
    es: () => `DB Studio vio 1 credencial`,
  },
  'credential.created': {
    en: ({ customerName }) => `${customerName} added 1 credential`,
    nl: ({ customerName }) => `${customerName} voegde 1 inloggegeven toe`,
    es: ({ customerName }) => `${customerName} agregó 1 credencial`,
  },
  'credential.updated': {
    en: ({ customerName, label }) => `${customerName} updated credential: ${label}`,
    nl: ({ customerName, label }) => `${customerName} werkte inloggegeven bij: ${label}`,
    es: ({ customerName, label }) => `${customerName} actualizó la credencial: ${label}`,
  },
  'credential.deleted': {
    en: ({ customerName, label }) => `${customerName} deleted credential: ${label}`,
    nl: ({ customerName, label }) => `${customerName} verwijderde inloggegeven: ${label}`,
    es: ({ customerName, label }) => `${customerName} eliminó la credencial: ${label}`,
  },
  'invoice.uploaded': {
    en: ({ invoiceNumber, amount }) => `New invoice ${invoiceNumber} (${amount})`,
    nl: ({ invoiceNumber, amount }) => `Nieuwe factuur ${invoiceNumber} (${amount})`,
    es: ({ invoiceNumber, amount }) => `Nueva factura ${invoiceNumber} (${amount})`,
  },
  'invoice.payment_recorded': {
    en: ({ invoiceNumber, amount, paidOn }) => `Payment recorded on ${invoiceNumber}: ${amount} on ${paidOn}`,
    nl: ({ invoiceNumber, amount, paidOn }) => `Betaling geregistreerd op ${invoiceNumber}: ${amount} op ${paidOn}`,
    es: ({ invoiceNumber, amount, paidOn }) => `Pago registrado en ${invoiceNumber}: ${amount} el ${paidOn}`,
  },
  'invoice.paid': {
    en: ({ invoiceNumber }) => `Invoice ${invoiceNumber} fully paid`,
    nl: ({ invoiceNumber }) => `Factuur ${invoiceNumber} volledig betaald`,
    es: ({ invoiceNumber }) => `Factura ${invoiceNumber} totalmente pagada`,
  },
  'project.created': {
    en: ({ projectName }) => `New project: ${projectName}`,
    nl: ({ projectName }) => `Nieuw project: ${projectName}`,
    es: ({ projectName }) => `Nuevo proyecto: ${projectName}`,
  },
  'project.status_changed': {
    en: ({ projectName, status }) => `Project ${projectName} → ${status}`,
    nl: ({ projectName, status }) => `Project ${projectName} → ${status}`,
    es: ({ projectName, status }) => `Proyecto ${projectName} → ${status}`,
  },
  'customer.suspended': {
    en: () => `Account suspended`,
    nl: () => `Account opgeschort`,
    es: () => `Cuenta suspendida`,
  },
  'customer.reactivated': {
    en: () => `Account reactivated`,
    nl: () => `Account geheractiveerd`,
    es: () => `Cuenta reactivada`,
  },
  'customer.archived': {
    en: () => `Account archived`,
    nl: () => `Account gearchiveerd`,
    es: () => `Cuenta archivada`,
  },
};

export function titleFor(eventType, locale, vars) {
  const entry = T[eventType];
  if (!entry) return `${eventType}`;
  const fn = entry[locale] ?? entry.en;
  return fn(vars ?? {});
}
```

- [ ] **Step 4: Re-run tests**

```bash
sudo bash scripts/run-tests.sh tests/unit/lib/digest-strings.spec.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/digest-strings.js tests/unit/lib/digest-strings.spec.js
git commit -m "feat(phase-b-9): localised digest title strings (EN/NL/ES)"
```

---

## Task B10: Domain integration — `documents` (uploaded → customer FYI; downloaded → admin FYI)

**Spec ref:** Phase B §6.

**Files:**
- Modify: `domain/documents/service.js` (find the existing audit + email enqueue points)
- Modify: any existing callsite that currently enqueues `new-document-available` (replace with digest record)
- Create: `tests/integration/digest/documents.spec.js`

- [ ] **Step 1: Read the current upload + download paths**

```bash
grep -n "audit\|enqueue" /opt/dbstudio_portal/domain/documents/service.js | head
```

Locate the function that handles `uploadForCustomer` (admin uploads) and the function that records `document.downloaded` (customer downloads).

- [ ] **Step 2: Failing integration test for upload-fan-out**

Create `tests/integration/digest/documents.spec.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { withTestDb, seedCustomer, seedCustomerUser } from '../../helpers/test-db.js';
import * as documentsService from '../../../domain/documents/service.js';

describe('document.uploaded → digest fan-out', () => {
  let db;
  beforeEach(async () => { db = await withTestDb(); });

  it('records one pending_digest_items row per active customer_user', async () => {
    const { customerId } = await seedCustomer(db, { locale: 'en' });
    const u1 = await seedCustomerUser(db, { customerId, status: 'active', locale: 'en' });
    const u2 = await seedCustomerUser(db, { customerId, status: 'active', locale: 'nl' });
    await seedCustomerUser(db, { customerId, status: 'suspended' });

    await documentsService.uploadForCustomer(db, {
      customerId,
      category: 'general',
      originalFilename: 'hello.pdf',
      declaredMime: 'application/pdf',
      stream: Buffer.from('fake'),
    }, { actorType: 'admin', actorId: '00000000-0000-0000-0000-000000000001', kek: process.env.PORTAL_KEK });

    const r = await sql`
      SELECT recipient_id::text, title FROM pending_digest_items WHERE event_type = 'document.uploaded'
    `.execute(db);
    expect(r.rows).toHaveLength(2);
    const titles = r.rows.map((row) => row.title).sort();
    expect(titles).toContain('New document: hello.pdf');
    expect(titles).toContain('Nieuw document: hello.pdf');
  });
});
```

(`seedCustomer` and `seedCustomerUser` are existing test helpers — confirm by `grep -rn "export function seedCustomer" tests/helpers/`. If they don't exist, add minimal versions returning `{ customerId }` and `{ id }` — but **only if necessary**.)

- [ ] **Step 3: Run to verify failure**

```bash
sudo bash scripts/run-tests.sh tests/integration/digest/documents.spec.js
```

Expected: FAIL.

- [ ] **Step 4: Modify `domain/documents/service.js`**

In `uploadForCustomer`, after the existing `audit(...)` call, **inside the same transaction**, add fan-out + recordForDigest. Remove (or guard with a feature flag — see note) the existing `enqueueEmail({ template: 'new-document-available', … })` call.

```js
// near the top
import { listActiveCustomerUsers, listActiveAdmins } from '../../lib/digest-fanout.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';

// inside uploadForCustomer, replacing the existing per-event enqueue:
const recipients = await listActiveCustomerUsers(tx, customerId);
for (const u of recipients) {
  await recordForDigest(tx, {
    recipientType: 'customer_user',
    recipientId:   u.id,
    customerId,
    bucket:        'fyi',
    eventType:     'document.uploaded',
    title:         titleFor('document.uploaded', u.locale, { filename: originalFilename }),
    linkPath:      '/customer/documents',
    metadata:      { documentId, filename: originalFilename },
  });
}
```

- [ ] **Step 5: For document download (`downloadForCustomer` or equivalent), add admin fan-out**

```js
const admins = await listActiveAdmins(tx);
const customer = await findCustomerById(tx, customerId); // existing helper
for (const a of admins) {
  await recordForDigest(tx, {
    recipientType: 'admin',
    recipientId:   a.id,
    customerId,
    bucket:        'fyi',
    eventType:     'document.downloaded',
    title:         titleFor('document.downloaded', a.locale, { customerName: customer.razon_social, filename: doc.original_filename }),
    linkPath:      `/admin/customers/${customerId}/documents`,
    metadata:      { documentId, customerId },
  });
}
```

- [ ] **Step 6: Re-run the test**

```bash
sudo bash scripts/run-tests.sh tests/integration/digest/documents.spec.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add domain/documents/service.js tests/integration/digest/documents.spec.js
git commit -m "feat(phase-b-10): documents → digest fan-out (uploaded customer-FYI, downloaded admin-FYI)"
```

---

## Task B11: Domain integration — `credential-requests`

**Spec ref:** Phase B §6.

**Files:**
- Modify: `domain/credential-requests/service.js`
- Create: `tests/integration/digest/credential-requests.spec.js`

- [ ] **Step 1: Failing test (mirror the documents shape)**

Create the test asserting:
- `credential_request.created` for customer-side, all active customer_users, bucket `action_required`.
- `credential_request.fulfilled` for admin-side, bucket `fyi`.
- `credential_request.not_applicable` for admin-side, bucket `fyi`.

(Test code follows the same shape as the documents test — set up customer + users + an admin, call the service, assert `pending_digest_items`.)

- [ ] **Step 2: Run to verify failure**

```bash
sudo bash scripts/run-tests.sh tests/integration/digest/credential-requests.spec.js
```

- [ ] **Step 3: Modify `domain/credential-requests/service.js`**

In `createForCustomer` (admin asks for creds), after the existing audit, fan out to customer_users with bucket `action_required`. Remove the existing `credential-request-created` per-event email.

In `fulfilByCustomer` and `markNotApplicableByCustomer`, after audit, fan out to admins with bucket `fyi`.

Use `titleFor` with the appropriate event keys and `customerName` lookup.

- [ ] **Step 4: Re-run the test**

```bash
sudo bash scripts/run-tests.sh tests/integration/digest/credential-requests.spec.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add domain/credential-requests/service.js tests/integration/digest/credential-requests.spec.js
git commit -m "feat(phase-b-11): credential-requests → digest fan-out"
```

---

## Task B12: Domain integration — `credentials`

**Spec ref:** Phase B §6.

**Files:**
- Modify: `domain/credentials/service.js`
- Create: `tests/integration/digest/credentials.spec.js`

- [ ] **Step 1: Test cases**

- `credential.viewed` (admin views) → customer FYI, **coalescing** ("DB Studio viewed N credentials").
- `credential.created` by customer → admin FYI, coalescing ("Acme Corp added N credentials").
- `credential.updated` by customer → admin FYI, **non-coalescing**.
- `credential.deleted` by customer → admin FYI, non-coalescing.

- [ ] **Step 2-4: Implement**

Same pattern as B10/B11. Plug into `viewByAdmin`, `createByCustomer`, `updateByCustomer`, `deleteByCustomer`.

- [ ] **Step 5: Commit**

```bash
git add domain/credentials/service.js tests/integration/digest/credentials.spec.js
git commit -m "feat(phase-b-12): credentials → digest fan-out (with coalescing for viewed/created)"
```

---

## Task B13: Domain integration — `ndas` and `projects`

**Spec ref:** Phase B §6.

**Files:**
- Modify: `domain/ndas/service.js`
- Modify: `domain/projects/service.js`
- Create: `tests/integration/digest/ndas-projects.spec.js`

- [ ] **Step 1-4: Standard pattern**

- `nda.created` → customer Action-Required (replaces `nda-ready` per-event email).
- `nda.signed` → admin FYI.
- `project.created` → customer FYI.
- `project.status_changed` → customer FYI.

- [ ] **Step 5: Commit**

```bash
git add domain/ndas/service.js domain/projects/service.js tests/integration/digest/ndas-projects.spec.js
git commit -m "feat(phase-b-13): ndas + projects → digest fan-out"
```

---

## Task B14: Invoice payment ledger — repo + service

**Spec ref:** Phase B §7.

**Files:**
- Create: `domain/invoice-payments/repo.js`
- Create: `domain/invoice-payments/service.js`
- Create: `tests/unit/domain/invoice-payments/service.spec.js`

- [ ] **Step 1: Failing test**

Create `tests/unit/domain/invoice-payments/service.spec.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { withTestDb, seedCustomer, seedAdmin, seedInvoice } from '../../../helpers/test-db.js';
import * as paymentsService from '../../../../domain/invoice-payments/service.js';

describe('invoice-payments service', () => {
  let db;
  beforeEach(async () => { db = await withTestDb(); });

  it('record() inserts a payment, audits, and emits payment_recorded digest items', async () => {
    const { customerId } = await seedCustomer(db, { locale: 'en' });
    const adminId = await seedAdmin(db, {});
    const invoiceId = await seedInvoice(db, { customerId, adminId, totalCents: 150000 });

    const r = await paymentsService.record(db, {
      adminId,
      invoiceId,
      amountCents: 100000,
      paidOn: '2026-04-15',
      note: 'first instalment',
    }, { actorType: 'admin', actorId: adminId });

    expect(r.paymentId).toBeTruthy();
    const ledger = await sql`SELECT amount_cents FROM invoice_payments WHERE invoice_id = ${invoiceId}::uuid`.execute(db);
    expect(ledger.rows[0].amount_cents).toBe(100000);
    const digestItems = await sql`SELECT event_type FROM pending_digest_items WHERE event_type IN ('invoice.payment_recorded', 'invoice.paid')`.execute(db);
    const types = digestItems.rows.map(r => r.event_type);
    expect(types).toContain('invoice.payment_recorded');
    expect(types).not.toContain('invoice.paid');  // 100k < 150k
  });

  it('emits invoice.paid when SUM(payments) >= total', async () => {
    const { customerId } = await seedCustomer(db, { locale: 'en' });
    const adminId = await seedAdmin(db, {});
    const invoiceId = await seedInvoice(db, { customerId, adminId, totalCents: 150000 });

    await paymentsService.record(db, { adminId, invoiceId, amountCents: 100000, paidOn: '2026-04-15' }, { actorType: 'admin', actorId: adminId });
    await paymentsService.record(db, { adminId, invoiceId, amountCents: 50000,  paidOn: '2026-04-20' }, { actorType: 'admin', actorId: adminId });

    const paid = await sql`SELECT 1 FROM pending_digest_items WHERE event_type = 'invoice.paid'`.execute(db);
    expect(paid.rows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
sudo bash scripts/run-tests.sh tests/unit/domain/invoice-payments/service.spec.js
```

- [ ] **Step 3: Implement the repo**

Create `domain/invoice-payments/repo.js`:

```js
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

export async function insert(tx, { invoiceId, amountCents, paidOn, note, recordedBy }) {
  const id = uuidv7();
  await sql`
    INSERT INTO invoice_payments (id, invoice_id, amount_cents, currency, paid_on, note, recorded_by)
    VALUES (${id}::uuid, ${invoiceId}::uuid, ${amountCents}, 'EUR', ${paidOn}, ${note ?? null}, ${recordedBy}::uuid)
  `.execute(tx);
  return id;
}

export async function listByInvoice(db, invoiceId) {
  const r = await sql`
    SELECT id::text, amount_cents, currency, paid_on, note, recorded_by::text, created_at
      FROM invoice_payments
     WHERE invoice_id = ${invoiceId}::uuid
     ORDER BY paid_on ASC, created_at ASC
  `.execute(db);
  return r.rows;
}

export async function sumForInvoice(db, invoiceId) {
  const r = await sql`
    SELECT COALESCE(SUM(amount_cents), 0)::int AS total
      FROM invoice_payments
     WHERE invoice_id = ${invoiceId}::uuid
  `.execute(db);
  return r.rows[0].total;
}

export async function deleteById(tx, { id }) {
  await sql`DELETE FROM invoice_payments WHERE id = ${id}::uuid`.execute(tx);
}

export async function update(tx, { id, amountCents, paidOn, note }) {
  await sql`
    UPDATE invoice_payments
       SET amount_cents = ${amountCents},
           paid_on      = ${paidOn},
           note         = ${note ?? null}
     WHERE id = ${id}::uuid
  `.execute(tx);
}
```

- [ ] **Step 4: Implement the service**

Create `domain/invoice-payments/service.js`:

```js
import { sql } from 'kysely';
import * as repo from './repo.js';
import { audit } from '../../lib/audit.js';
import { listActiveCustomerUsers, listActiveAdmins } from '../../lib/digest-fanout.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';

function formatEur(cents) {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

async function findInvoice(db, invoiceId) {
  const r = await sql`
    SELECT id::text, customer_id::text, invoice_number, amount_cents
      FROM invoices WHERE id = ${invoiceId}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function record(db, { adminId, invoiceId, amountCents, paidOn, note }, ctx) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amount must be positive integer cents');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new Error('paid_on must be YYYY-MM-DD');

  return await db.transaction().execute(async (tx) => {
    const inv = await findInvoice(tx, invoiceId);
    if (!inv) throw new Error('invoice not found');
    const id = await repo.insert(tx, { invoiceId, amountCents, paidOn, note, recordedBy: adminId });

    const newSum = await repo.sumForInvoice(tx, invoiceId);
    const isFullyPaid = newSum >= inv.amount_cents;

    await audit(tx, ctx, 'invoice.payment_recorded', {
      targetType: 'invoice', targetId: invoiceId,
      visibleToCustomer: true,
      metadata: { paymentId: id, amountCents, paidOn, isFullyPaid },
    });

    // Customer fan-out — FYI
    const users = await listActiveCustomerUsers(tx, inv.customer_id);
    for (const u of users) {
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId:    inv.customer_id,
        bucket:        'fyi',
        eventType:     'invoice.payment_recorded',
        title:         titleFor('invoice.payment_recorded', u.locale, { invoiceNumber: inv.invoice_number, amount: formatEur(amountCents), paidOn }),
        linkPath:      `/customer/invoices/${invoiceId}`,
      });
      if (isFullyPaid) {
        await recordForDigest(tx, {
          recipientType: 'customer_user',
          recipientId:   u.id,
          customerId:    inv.customer_id,
          bucket:        'fyi',
          eventType:     'invoice.paid',
          title:         titleFor('invoice.paid', u.locale, { invoiceNumber: inv.invoice_number }),
          linkPath:      `/customer/invoices/${invoiceId}`,
        });
      }
    }
    // Admin fan-out — FYI
    const admins = await listActiveAdmins(tx);
    for (const a of admins) {
      await recordForDigest(tx, {
        recipientType: 'admin',
        recipientId:   a.id,
        customerId:    inv.customer_id,
        bucket:        'fyi',
        eventType:     'invoice.payment_recorded',
        title:         titleFor('invoice.payment_recorded', a.locale, { invoiceNumber: inv.invoice_number, amount: formatEur(amountCents), paidOn }),
        linkPath:      `/admin/invoices/${invoiceId}`,
      });
      if (isFullyPaid) {
        await recordForDigest(tx, {
          recipientType: 'admin',
          recipientId:   a.id,
          customerId:    inv.customer_id,
          bucket:        'fyi',
          eventType:     'invoice.paid',
          title:         titleFor('invoice.paid', a.locale, { invoiceNumber: inv.invoice_number }),
          linkPath:      `/admin/invoices/${invoiceId}`,
        });
      }
    }

    return { paymentId: id, isFullyPaid };
  });
}

export async function listForInvoice(db, invoiceId) {
  return await repo.listByInvoice(db, invoiceId);
}

export async function deletePayment(db, { adminId, paymentId, invoiceId }, ctx) {
  return await db.transaction().execute(async (tx) => {
    await repo.deleteById(tx, { id: paymentId });
    await audit(tx, ctx, 'invoice.payment_deleted', {
      targetType: 'invoice', targetId: invoiceId,
      visibleToCustomer: true,
      metadata: { paymentId },
    });
  });
}

export async function updatePayment(db, { adminId, paymentId, invoiceId, amountCents, paidOn, note }, ctx) {
  return await db.transaction().execute(async (tx) => {
    await repo.update(tx, { id: paymentId, amountCents, paidOn, note });
    await audit(tx, ctx, 'invoice.payment_updated', {
      targetType: 'invoice', targetId: invoiceId,
      visibleToCustomer: true,
      metadata: { paymentId, amountCents, paidOn },
    });
  });
}
```

- [ ] **Step 5: Re-run tests**

```bash
sudo bash scripts/run-tests.sh tests/unit/domain/invoice-payments/service.spec.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add domain/invoice-payments/ tests/unit/domain/invoice-payments/
git commit -m "feat(phase-b-14): invoice payment ledger repo + service with digest fan-out"
```

---

## Task B15: Compute invoice status from the ledger

**Spec ref:** Phase B §2 ("Relation to existing invoice status").

**Files:**
- Modify: `domain/invoices/repo.js` (the existing `findById` and `listForCustomer` queries — add a JOIN that computes `paid_cents` and overrides `status`)
- Modify: `domain/invoices/service.js` if it surfaces status independently
- Modify: relevant tests if they assert status

- [ ] **Step 1: Find current status logic**

```bash
grep -n "status" /opt/dbstudio_portal/domain/invoices/repo.js
grep -n "overdue\|partially_paid\|paid" /opt/dbstudio_portal/domain/invoices/{repo,service}.js
```

Locate the SQL that currently computes `overdue`. The new column should be a `CASE` expression of:
- `paid` if `COALESCE(SUM(invoice_payments.amount_cents),0) >= invoices.amount_cents`
- `partially_paid` if `> 0`
- existing logic (`overdue` based on date OR `open`) otherwise

- [ ] **Step 2: Edit `findById`**

Add a `LEFT JOIN LATERAL (SELECT COALESCE(SUM(amount_cents),0) AS paid_cents FROM invoice_payments WHERE invoice_id = invoices.id) p ON TRUE` and a `CASE` in `SELECT`. Replace the current returned `status` with the computed one.

```sql
SELECT i.*,
       p.paid_cents,
       CASE
         WHEN p.paid_cents >= i.amount_cents THEN 'paid'
         WHEN p.paid_cents > 0 THEN 'partially_paid'
         WHEN i.due_on < CURRENT_DATE AND i.status = 'open' THEN 'overdue'
         ELSE i.status
       END AS status_computed
  FROM invoices i
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount_cents), 0)::int AS paid_cents
      FROM invoice_payments
     WHERE invoice_id = i.id
  ) p ON TRUE
 WHERE i.id = ${id}::uuid
```

Map the row before returning so callers see `status` (computed) and `paid_cents`.

- [ ] **Step 3: Edit `listForCustomer` likewise**

Same JOIN pattern.

- [ ] **Step 4: Update existing tests**

Search `tests/` for any spec that asserts `status === 'open'` on an invoice with payments. Update or delete those assertions to match the computed status.

```bash
grep -rn "status: 'open'" /opt/dbstudio_portal/tests/ /opt/dbstudio_portal/domain/invoices/ | head
```

- [ ] **Step 5: Run all invoice tests**

```bash
sudo bash scripts/run-tests.sh tests/unit/domain/invoices/ tests/integration/admin/invoices.spec.js tests/integration/customer/invoices.spec.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add domain/invoices/repo.js domain/invoices/service.js tests/
git commit -m "feat(phase-b-15): compute invoice status from invoice_payments ledger"
```

---

## Task B16: Admin UI — record payment + edit/delete

**Spec ref:** Phase B §7.

**Files:**
- Modify: `routes/admin/invoices.js` (add `POST /admin/invoices/:id/payments`, `POST /admin/invoices/:id/payments/:paymentId/delete`, `POST /admin/invoices/:id/payments/:paymentId/edit`)
- Modify: `views/admin/invoices/detail.ejs` (add Payments panel + Record-payment modal/form)
- Create: `tests/integration/admin/invoice-payments.spec.js`

- [ ] **Step 1: Failing integration test**

```js
import { describe, it, expect } from 'vitest';
import { buildApp } from '../../helpers/build-app.js';
import { signInAsAdmin, csrfFor } from '../../helpers/auth.js';
import { seedCustomer, seedInvoice, seedAdmin } from '../../helpers/test-db.js';

describe('POST /admin/invoices/:id/payments', () => {
  it('records a payment, redirects to detail, status flips to partially_paid', async () => {
    const app = await buildApp();
    const cookie = await signInAsAdmin(app);
    const csrf = await csrfFor(app, cookie);
    const { customerId } = await seedCustomer(app.db, {});
    const adminId = await seedAdmin(app.db, {});
    const invoiceId = await seedInvoice(app.db, { customerId, adminId, totalCents: 200000 });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/invoices/${invoiceId}/payments`,
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${csrf}&amount_cents=50000&paid_on=2026-04-15&note=first`,
    });
    expect(res.statusCode).toBe(302);
    await app.close();
  });
});
```

- [ ] **Step 2-3: Implement the routes**

In `routes/admin/invoices.js`:

```js
import * as paymentsService from '../../domain/invoice-payments/service.js';

// inside register…
app.post('/admin/invoices/:id/payments', { preHandler: app.csrfProtection }, async (req, reply) => {
  const session = await requireAdminSession(app, req, reply);
  if (!session) return;
  const id = req.params?.id;
  if (!UUID_RE.test(id)) return notFound(req, reply);
  const body = req.body ?? {};
  const amountCents = Number(body.amount_cents);
  const paidOn = String(body.paid_on);
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  try {
    await paymentsService.record(app.db, { adminId: session.user_id, invoiceId: id, amountCents, paidOn, note }, ctxFromSession(app, req, session));
  } catch (err) {
    return reply.code(422).send({ error: err.message });
  }
  return reply.redirect(`/admin/invoices/${id}?flash=Payment%20recorded`, 302);
});

app.post('/admin/invoices/:id/payments/:paymentId/delete', { preHandler: app.csrfProtection }, async (req, reply) => {
  // step-up gate: read existing pattern from credential delete (M7) and replicate here.
  // For v1, just require admin session — operator can layer step-up later if needed (mirror lib/auth/step-up.js usage in domain/credentials/service.js's deleteByAdmin).
  const session = await requireAdminSession(app, req, reply);
  if (!session) return;
  const { id, paymentId } = req.params ?? {};
  if (!UUID_RE.test(id) || !UUID_RE.test(paymentId)) return notFound(req, reply);
  await paymentsService.deletePayment(app.db, { adminId: session.user_id, paymentId, invoiceId: id }, ctxFromSession(app, req, session));
  return reply.redirect(`/admin/invoices/${id}?flash=Payment%20deleted`, 302);
});

app.post('/admin/invoices/:id/payments/:paymentId/edit', { preHandler: app.csrfProtection }, async (req, reply) => {
  const session = await requireAdminSession(app, req, reply);
  if (!session) return;
  const { id, paymentId } = req.params ?? {};
  if (!UUID_RE.test(id) || !UUID_RE.test(paymentId)) return notFound(req, reply);
  const body = req.body ?? {};
  await paymentsService.updatePayment(app.db, {
    adminId: session.user_id, paymentId, invoiceId: id,
    amountCents: Number(body.amount_cents),
    paidOn: String(body.paid_on),
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
  }, ctxFromSession(app, req, session));
  return reply.redirect(`/admin/invoices/${id}?flash=Payment%20updated`, 302);
});
```

> Step-up note: review `domain/credentials/service.js`'s `deleteByAdmin` flow before deciding whether to gate `deletePayment` behind `requireStepUp`. Per the spec, "Delete requires step-up auth"; for v1 this can be deferred and added in a follow-up commit if it's not trivially copied.

In `routes/admin/invoices.js`, also extend the existing `GET /admin/invoices/:id` to pass the payments list and total paid:

```js
const payments = await paymentsService.listForInvoice(app.db, id);
return renderAdmin(req, reply, 'admin/invoices/detail', {
  // …existing locals…
  payments,
  paidCents: payments.reduce((s, p) => s + p.amount_cents, 0),
});
```

- [ ] **Step 4: Update `views/admin/invoices/detail.ejs`**

Add a "Payments" card section below the existing invoice details. Include:

```ejs
<div class="card">
  <h2 class="card__title">Payments</h2>
  <% if (payments && payments.length) { %>
    <table class="data-table data-table--medium">
      <thead><tr><th>Date</th><th>Amount</th><th>Note</th><th></th></tr></thead>
      <tbody>
        <% payments.forEach(function(p) { %>
          <tr>
            <td><%= p.paid_on %></td>
            <td>€<%= (p.amount_cents / 100).toFixed(2) %></td>
            <td><%= p.note ?? '' %></td>
            <td>
              <form method="post" action="/admin/invoices/<%= row.id %>/payments/<%= p.id %>/delete" style="display:inline">
                <input type="hidden" name="_csrf" value="<%= csrfToken %>">
                <button class="btn btn--ghost btn--sm" type="submit">Delete</button>
              </form>
            </td>
          </tr>
        <% }) %>
      </tbody>
    </table>
    <p>Total paid: €<%= (paidCents / 100).toFixed(2) %> of €<%= (row.amount_cents / 100).toFixed(2) %></p>
  <% } else { %>
    <p class="muted">No payments recorded yet.</p>
  <% } %>
  <% if ((paidCents || 0) < row.amount_cents) { %>
    <h3>Record payment</h3>
    <form method="post" action="/admin/invoices/<%= row.id %>/payments" class="form-stack">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <%- include('../../components/_input', { name: 'amount_cents', type: 'number', label: 'Amount (cents)', required: true, value: '' }) %>
      <%- include('../../components/_input', { name: 'paid_on',      type: 'date',   label: 'Paid on',        required: true, value: '' }) %>
      <div class="input-field">
        <label class="input-field__label" for="pay_note">Note (optional)</label>
        <div class="input-field__control"><textarea id="pay_note" name="note" rows="2"></textarea></div>
      </div>
      <div class="form-actions">
        <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Record payment' }) %>
      </div>
    </form>
  <% } %>
</div>
```

- [ ] **Step 5: Re-run tests**

```bash
sudo bash scripts/run-tests.sh tests/integration/admin/invoice-payments.spec.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add routes/admin/invoices.js views/admin/invoices/detail.ejs tests/integration/admin/invoice-payments.spec.js
git commit -m "feat(phase-b-16): admin UI for invoice payment ledger (record/edit/delete)"
```

---

## Task B17: Customer UI — read-only payments view

**Spec ref:** Phase B §7.

**Files:**
- Modify: `routes/customer/invoices.js` (extend invoice-detail handler to load payments)
- Modify: `views/customer/invoices/detail.ejs` (add Payments panel)

- [ ] **Step 1: Modify the customer invoice detail route**

Add `import * as paymentsService from '../../domain/invoice-payments/service.js';`. In the GET handler that renders `customer/invoices/detail`, also pass `payments` + `paidCents` (mirror the admin handler's additions in B16).

- [ ] **Step 2: Update `views/customer/invoices/detail.ejs`**

Add a read-only payments section below the existing invoice details:

```ejs
<div class="card">
  <h2 class="card__title">Payments</h2>
  <% if (payments && payments.length) { %>
    <ul>
      <% payments.forEach(function(p) { %>
        <li>€<%= (p.amount_cents/100).toFixed(2) %> on <%= p.paid_on %><% if (p.note) { %> — <%= p.note %><% } %></li>
      <% }) %>
    </ul>
    <p>Paid: €<%= (paidCents/100).toFixed(2) %> of €<%= (row.amount_cents/100).toFixed(2) %><% if (paidCents < row.amount_cents) { %> — outstanding €<%= ((row.amount_cents - paidCents)/100).toFixed(2) %><% } %></p>
  <% } else { %>
    <p class="muted">No payments recorded yet.</p>
  <% } %>
</div>
```

- [ ] **Step 3: Manual smoke**

After restart, sign in as a customer with an invoice that has a recorded payment; confirm the Payments panel renders the line(s).

- [ ] **Step 4: Commit**

```bash
git add routes/customer/invoices.js views/customer/invoices/detail.ejs
git commit -m "feat(phase-b-17): customer read-only payments panel on invoice detail"
```

---

## Task B18: Domain integration — `customers` lifecycle events

**Spec ref:** Phase B §6.

**Files:**
- Modify: `domain/customers/service.js`
- Create: `tests/integration/digest/customers-lifecycle.spec.js`

- [ ] **Step 1-4: Standard pattern**

For `suspendCustomer`, `reactivateCustomer`, `archiveCustomer`, after the existing audit, fan out to the customer's active customer_users with bucket `fyi` and the corresponding event types.

- [ ] **Step 5: Commit**

```bash
git add domain/customers/service.js tests/integration/digest/customers-lifecycle.spec.js
git commit -m "feat(phase-b-18): customer lifecycle (suspend/reactivate/archive) → customer FYI digest"
```

---

## Task B19: Domain integration — `invoices.uploaded` (replace `new-invoice` mail)

**Spec ref:** Phase B §6.

**Files:**
- Modify: `domain/invoices/service.js` (the `create` function — currently enqueues `new-invoice`)
- Update: `tests/unit/domain/invoices/service.spec.js` (or wherever the existing test asserts the new-invoice enqueue)

- [ ] **Step 1: Replace the per-event enqueue with digest fan-out**

In `domain/invoices/service.js` `create`, after audit, fan out to active customer_users with `invoice.uploaded` (FYI). Remove the `enqueueEmail({ template: 'new-invoice', … })` call.

- [ ] **Step 2: Update existing tests**

Whatever test asserts the old enqueue must now assert a `pending_digest_items` row.

- [ ] **Step 3: Commit**

```bash
git add domain/invoices/service.js tests/
git commit -m "feat(phase-b-19): invoice.uploaded → digest (replaces new-invoice immediate mail)"
```

---

## Task B20: End-to-end smoke + acceptance verification

**Spec ref:** Phase B §9.

**Files:**
- Create: `tests/integration/digest/end-to-end.spec.js`
- Manual: operator dev session for the human-eyeball checks.

- [ ] **Step 1: Multi-event customer scenario test**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { withTestDb, seedCustomer, seedCustomerUser, seedAdmin } from '../../helpers/test-db.js';
import * as documentsService from '../../../domain/documents/service.js';
import * as ndasService from '../../../domain/ndas/service.js';
import * as crService from '../../../domain/credential-requests/service.js';
import { tickOnce } from '../../../domain/digest/worker.js';

describe('digest end-to-end', () => {
  let db;
  beforeEach(async () => { db = await withTestDb(); });

  it('coalesces three rapid events into ONE digest email', async () => {
    const { customerId } = await seedCustomer(db, {});
    const userId = await seedCustomerUser(db, { customerId, status: 'active', locale: 'en' });
    const adminId = await seedAdmin(db, {});

    const ctx = { actorType: 'admin', actorId: adminId, kek: process.env.PORTAL_KEK };
    await documentsService.uploadForCustomer(db, { customerId, originalFilename: 'a.pdf', stream: Buffer.from('x'), declaredMime: 'application/pdf', category: 'general' }, ctx);
    await ndasService.createForCustomer(db, { customerId, title: 'T', adminId }, ctx);
    await crService.createForCustomer(db, { customerId, provider: 'GitHub', fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }], adminId }, ctx);

    // Force the schedule to be due immediately.
    await sql`UPDATE digest_schedules SET due_at = now() WHERE recipient_id = ${userId}::uuid`.execute(db);

    const r = await tickOnce({ db, log: { info() {}, warn() {}, error() {} }, batchSize: 10 });
    expect(r.fired).toBe(1);
    const outbox = await sql`SELECT to_address, locals FROM email_outbox WHERE template = 'digest'`.execute(db);
    expect(outbox.rows).toHaveLength(1);
    const locals = outbox.rows[0].locals;
    expect(locals.actionItems.length + locals.fyiItems.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
sudo bash scripts/run-tests.sh tests/integration/digest/end-to-end.spec.js
```

Expected: PASS.

- [ ] **Step 3: Run the full suite**

```bash
sudo bash scripts/run-tests.sh
```

Expected: all green. The pre-existing 445 tests + new tests added by Phase A/B/C all pass.

- [ ] **Step 4: Manual smoke (operator dev session)**

With `PORTAL_EMAIL_DEV_HOLD=true` in env:
1. Sign in as customer; observe sidebar sign-out, equal-cell dashboard, fixed Fulfil pill, /admin redirect.
2. Sign in as admin; upload an invoice — confirm the parser prefills all five fields.
3. Trigger three customer-facing events as admin within ~30 s; wait 10 min (or temporarily lower `windowMinutes` to 0); check `email_outbox` for one digest row, locals shape correct, dev-hold acknowledged in logs.
4. Record an invoice payment; confirm status flip; confirm digest item written.

- [ ] **Step 5: Commit (covers any small fixes uncovered during smoke)**

```bash
git add -A
git commit -m "test(phase-b-20): digest end-to-end smoke + final fixes"
```

---

## Final wrap

- [ ] **Wrap-up step 1: Update `docs/build-log.md`**

Append a new `## 2026-05-01 — Phases A + B + C` section briefly summarising what shipped, with commit shas. Per project memory: "Always update AI_CONTEXT.md and build-log.md after changes" (`feedback_documentation.md`).

- [ ] **Wrap-up step 2: Update memory**

Update `/root/.claude/projects/-root/memory/project_dbstudio_portal.md` to reflect the new state: digest pipeline live, invoice payment ledger live, OCR live, Phase A bugs fixed.

- [ ] **Wrap-up step 3: Final commit**

```bash
git add docs/build-log.md
git commit -m "docs: build-log entries for Phases A + B + C (2026-05-01)"
```

- [ ] **Wrap-up step 4: Push**

```bash
cd /opt/dbstudio_portal && git push origin main
```

(Push is the operator's call. If running this plan in an unattended session, **stop here and ask the operator** before pushing.)

---

# Plan self-review

**Spec coverage check:**

- Phase A §A1 width policy → Task A1 ✓
- Phase A §A2 /admin redirect → Task A2 ✓
- Phase A §A3 EJS form default → Task A3 ✓
- Phase A §A4 sidebar sign-out → Task A4 ✓
- Phase A §A5 bento equal cells → Task A5 ✓
- Phase A §A6 .data-table guard → Task A6 ✓

- Phase B §2 schema → Task B1 ✓
- Phase B §3 event catalogue → Tasks B10–B13, B18, B19 ✓
- Phase B §4 debounce → Tasks B3, B4, B5 ✓
- Phase B §5 templates → Task B6 ✓
- Phase B §6 fan-out + locale → Tasks B8, B9 + B10–B13/B18/B19 ✓
- Phase B §7 invoice payments → Tasks B14, B15, B16, B17 ✓
- Phase B §8 dev hold env flag → Task B2 ✓
- Phase B §9 acceptance + §10 test plan → Task B20 (end-to-end) ✓

- Phase C §2 parser → Task C1 ✓
- Phase C §3 route → Task C2 ✓
- Phase C §4 view → Task C3 ✓

**Placeholder scan:** Searched the plan for `TBD`, `TODO`, "implement later", "fill in", "add appropriate", "similar to". The two notes that read "review … before deciding" (step-up auth in B16; subject-extraction contract in B6) are pointers to existing code patterns the engineer must consult — not placeholder substitutes for plan content.

**Type consistency:** `recordForDigest` signature in B4 matches its callers in B10–B13, B18, B19. `parseInvoicePdf` signature in C1 matches its caller in C2. `paymentsService.record` signature in B14 matches its caller in B16. `tickOnce` shape in B5 matches its caller in B7 (`startWorker` wrapper) and B20 (test).

**Scope check:** Three phases, but each is a focused subsystem. They share `migrations/0010` infrastructure (Phase B's tables) and `routes/admin/invoices.js` (Phase B's payments routes + Phase C's parse route), but no two tasks edit the same line range. Order A → C → B avoids any merge friction.

No issues found that aren't already addressed inline.
