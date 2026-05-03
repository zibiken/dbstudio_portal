# DB Studio Portal — Follow-ups Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open follow-up in `docs/superpowers/follow-ups.md` that isn't explicitly deferred to v1.1, then explicitly defer the remaining v1.1 work with a tracked next-step.

**Architecture:** Five independent task groups. T1 + T2 + T3 are small (≤ 1 file each). T4 + T5 are deferred-with-scaffolding work that adds the CI gate but does not attempt the full grind in one session.

**Tech Stack:** Fastify + EJS + Kysely/Postgres backend, vitest, axe-core (already in tree), i18next (not yet wired).

**Repo:** `/opt/dbstudio_portal/` — main branch, no worktree.

**Status of follow-ups.md after the 2026-05-03 portal-ux-pass session:** open items remaining are M3, M7, plus the long-running i18n + accessibility passes. M6 (admin credential-requests `err.message`), Vault view-with-decrypt, and the password-reset enumeration UX trade-off were already shipped — `follow-ups.md` was updated in commit `<this-cleanup-commit>` to reflect that.

---

## Conventions

- **Test runner:** vitest. Integration tests run via `sudo bash scripts/run-tests.sh tests/path/to/file.test.js` (the wrapper sources `.env` and runs as `portal-app`).
- **Commit style:** Conventional Commits. Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Live source:** `/opt/dbstudio_portal/` is the running source tree — every edit hot-loads into `portal.service`. After edits, confirm `systemctl is-active portal.service` returns `active`.
- **Deploy:** edits ship via `git push origin main` + `sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm run build` + `sudo systemctl restart portal-pdf.service portal.service` + `sudo bash scripts/smoke.sh`. **Ask user before restarting services.**
- **No SW bump** until production deploy decided by user.

---

## Task 1: M3 — defence-in-depth `customerId` on credential-request + credential service methods

**Open per follow-ups.md M8 review-deferred minors.** Both `cancelByAdmin` (`domain/credential-requests/service.js:355`) and `markNeedsUpdate` (`domain/credentials/service.js:715`) currently take only the target id and trust the route's pre-check. Add a `customerId` param and reject if the target's `customer_id` doesn't match — same shape the existing `assertCustomerUserBelongsTo` / cross-customer guards use elsewhere.

**Files:**
- Modify: `domain/credential-requests/service.js:355` (add `customerId` to `cancelByAdmin` signature + cross-customer assertion)
- Modify: `domain/credentials/service.js:715` (add `customerId` to `markNeedsUpdate` signature + cross-customer assertion)
- Modify: `routes/admin/credential-requests.js` (pass `customerId` to `cancelByAdmin`)
- Modify: every caller of `markNeedsUpdate` — find via `grep -rn "markNeedsUpdate" routes/ scripts/`
- Test: `tests/integration/credential-requests/cancel.test.js` — add cross-customer rejection case
- Test: `tests/integration/credentials/manage.test.js` — extend `markNeedsUpdate` describe block with cross-customer rejection case

- [ ] **Step 1: Write a failing cross-customer test for `cancelByAdmin`**

```js
it('rejects when customerId does not match the request', async () => {
  const a = await makeCustomer('xa');
  const b = await makeCustomer('xb');
  const req = await crService.create(db, {
    customerId: a.customerId, provider: 'aws', label: 'l',
  }, ctx());
  await expect(crService.cancelByAdmin(db, {
    adminId: '00000000-0000-0000-0000-000000000001',
    customerId: b.customerId,
    requestId: req.requestId,
  }, ctx())).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /opt/dbstudio_portal && sudo bash scripts/run-tests.sh tests/integration/credential-requests/cancel.test.js
```

Expected: FAIL with "Cannot read properties of undefined" or signature mismatch.

- [ ] **Step 3: Add `customerId` arg + assertion to `cancelByAdmin`**

```js
export async function cancelByAdmin(db, { adminId, customerId, requestId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const reqRow = await repo.lockCredentialRequestById(tx, requestId);
    if (!reqRow) throw new CredentialRequestNotFoundError(requestId);
    if (reqRow.customer_id !== customerId) throw new CrossCustomerError();
    if (reqRow.status !== 'open') throw new CredentialRequestNotOpenError(reqRow.status);
    // … rest unchanged
```

`CrossCustomerError` is exported from `domain/credentials/service.js`; either import it there or define a local `CrossCustomerError` in `domain/credential-requests/service.js` mirroring the existing one (code `CROSS_CUSTOMER`). Pick whichever matches the project's per-domain pattern — read both files first.

- [ ] **Step 4: Update the route call site**

In `routes/admin/credential-requests.js`, find `crService.cancelByAdmin(...)` and pass `customerId: cid`:

```js
await crService.cancelByAdmin(app.db, {
  adminId: session.user_id, customerId: cid, requestId: id,
}, makeCtx(req, session));
```

The existing `safeError` mapping should add a `CROSS_CUSTOMER` case (it already has the other codes — see line 184–187 of that file).

- [ ] **Step 5: Run cancel test**

```bash
sudo bash scripts/run-tests.sh tests/integration/credential-requests/
```

Expected: all green (new cross-customer case passes; existing tests pass because the route always passes the matching `cid`).

- [ ] **Step 6: Repeat for `markNeedsUpdate`**

Same pattern. Add `customerId` arg + cross-customer assertion via comparing `row.customer_id` against the passed `customerId`. Update every caller (route + any scripts).

```js
export async function markNeedsUpdate(db, { adminId, customerId, credentialId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await repo.findCredentialById(tx, credentialId);
    if (!row) throw new CredentialNotFoundError(credentialId);
    if (row.customer_id !== customerId) throw new CrossCustomerError();
    // … rest unchanged
```

- [ ] **Step 7: Run full test suite**

```bash
sudo bash scripts/run-tests.sh
```

Expected: 774 → 776 passing (or whatever the new total is); 0 failing.

- [ ] **Step 8: Commit**

```bash
git add domain/credential-requests/service.js domain/credentials/service.js routes/admin/credential-requests.js tests/integration/credential-requests/cancel.test.js tests/integration/credentials/manage.test.js
git commit -m "$(cat <<'EOF'
fix(credentials): defence-in-depth customerId on cancelByAdmin + markNeedsUpdate

Closes M8 review-deferred M3. Both service methods now take customerId
and assert the target's customer_id matches before mutating; routes
already pass the URL :cid. Prevents a future caller from skipping the
route-layer guard and reaching the service with a mismatched id pair.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Mark M3 shipped in `follow-ups.md`**

Replace the open M3 bullet with `~~M3 — defence-in-depth …~~ — SHIPPED <date> in <commit>` and the change summary.

---

## Task 2: M7 — HTTP-layer integration tests for credential-requests routes

**Open per follow-ups.md M7 review-deferred items.** `tests/integration/credential-requests/` today has only `workflow.test.js` (service-layer flows). The HTTP routes (`routes/admin/credential-requests.js` + `routes/customer/credential-requests.js`) lack per-route tests for CSRF gating, UUID validation, cross-customer / cross-project 404s, and the typed-error → flash mapping.

Goal: write `tests/integration/credential-requests/admin-routes.test.js` + `tests/integration/credential-requests/customer-routes.test.js` that mirror the shape of `tests/integration/phases/routes.test.js` (a known-good model — that file is the pattern to copy).

**Files:**
- Test: `tests/integration/credential-requests/admin-routes.test.js` (new)
- Test: `tests/integration/credential-requests/customer-routes.test.js` (new)

- [ ] **Step 1: Read the model test**

```bash
head -250 tests/integration/phases/routes.test.js
```

Note: `parseSetCookies`, `cookieHeader`, `mergeCookies`, `extractInputValue`, `urlencoded` helpers; the `loginAdmin(suffix)` flow that returns a cookie jar; the per-test fixture customers (A and B) for cross-customer 404 cases.

- [ ] **Step 2: Identify the routes that need coverage**

```bash
grep -nE "^  app\.(get|post)" routes/admin/credential-requests.js routes/customer/credential-requests.js
```

Expected (subject to verify): admin list / new / detail / cancel; customer list / detail / fulfil. Each gets:
- non-admin / non-customer 401/302
- CSRF 403 on POST
- UUID-mismatched param 404
- cross-customer 404
- happy-path 302/303 redirect
- typed-error → flash on validation rejection (e.g. `CREDENTIAL_REQUEST_NOT_OPEN`)

- [ ] **Step 3: Write the admin-routes test**

Use the `tests/integration/phases/routes.test.js` skeleton verbatim. Replace the project-phases-specific helpers with credential-request analogues: `csrfFromAdminListPage(jar, customerId)` instead of `csrfFromProjectDetail`, `postCancelForm(...)` instead of `postPhaseForm`. Cover at minimum:

```
describe('admin credential-requests routes (HTTP)', () => {
  it('GET /admin/customers/:cid/credential-requests requires admin session');
  it('POST /admin/customers/:cid/credential-requests rejects without CSRF');
  it('POST without CSRF returns 403 Invalid csrf token');
  it('GET /:cid/credential-requests/:id 404s when id belongs to a different customer');
  it('POST /:cid/credential-requests/:id/cancel happy-path 302');
  it('POST /:cid/credential-requests/:id/cancel maps CREDENTIAL_REQUEST_NOT_OPEN to safe copy');
  it('POST /:cid/credential-requests/:id/cancel maps CROSS_CUSTOMER to safe copy after Task 1');
});
```

- [ ] **Step 4: Run the admin-routes test**

```bash
sudo bash scripts/run-tests.sh tests/integration/credential-requests/admin-routes.test.js
```

Expected: all pass (or fail with specific assertions to fix incrementally).

- [ ] **Step 5: Write the customer-routes test**

Same shape; gate is `requireCustomerSession` + `requireNdaSigned`. Confirm fulfilment via `service.createByAdminFromRequest` is exercised end-to-end (hits a customer-side fulfil route or an admin-side fulfil — read the actual routes first).

- [ ] **Step 6: Run both new tests + full credential-requests suite**

```bash
sudo bash scripts/run-tests.sh tests/integration/credential-requests/
```

- [ ] **Step 7: Commit**

```bash
git add tests/integration/credential-requests/admin-routes.test.js tests/integration/credential-requests/customer-routes.test.js
git commit -m "$(cat <<'EOF'
test(credential-requests): HTTP-layer route tests for admin + customer

Closes M7 review-deferred. Mirrors tests/integration/phases/routes.test.js
shape: CSRF, UUID validation, cross-customer 404, typed-error → flash
mapping. Service-layer behaviour stays in workflow.test.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Mark M7 shipped in `follow-ups.md`**

---

## Task 3: Accessibility — focus trap on the new `<dialog>`

The `_confirm-dialog` component shipped 2026-05-03 (commit `4844334`) opens a native `<dialog>` via `dialog.showModal()`. `showModal()` provides a top-layer rendering context but does NOT trap Tab focus by default — Tab can escape to the rest of the document while the dialog is open. Kimi flagged this in their initial design review as nominal-but-deferred.

**Files:**
- Modify: `public/js/dialog.js` — add a Tab-key handler that wraps focus within the open `<dialog>`
- Test: manual smoke (Tab through the dialog with devtools open; verify focus loops between Cancel and the danger-variant submit button)

- [ ] **Step 1: Add the Tab-trap to `dialog.js`**

After the `Escape` keydown handler, before the IIFE close:

```js
document.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Tab') return;
  var dlg = document.querySelector('dialog.confirm-dialog__dialog[open]');
  if (!dlg) return;
  var focusable = dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length === 0) return;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
});
```

- [ ] **Step 2: Manual smoke**

After `npm run build` + service restart (ask user first), open `/customer/credentials`, click Delete on any row, Tab through the dialog. Focus should loop Cancel → Delete → Cancel → ... never escaping to the page below.

- [ ] **Step 3: Commit**

```bash
git add public/js/dialog.js
git commit -m "$(cat <<'EOF'
fix(a11y): add Tab focus-trap to confirm-dialog

showModal() puts the dialog in the top layer but does not trap Tab
focus. Adds a document-level Tab handler that wraps focus between the
first and last focusable elements inside the open dialog.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: i18n — defer to v1.1, add tracking

`scripts/i18n-audit.js` reports **810 candidate offenders across 118 files** (verified 2026-05-03, up from 620/79 at M9-M10). The full pass is multi-day: wire i18next + i18next-fs-backend through `lib/render.js`, populate `locales/en/{public,admin,customer,emails}.json` from the audit output, add CI gate.

This task does **not** attempt the grind. It does:
1. Verify the audit baseline.
2. Add a v1.1-tracking note to `follow-ups.md` with the current 810 number.
3. Keep the audit advisory (non-blocking) per existing convention.

- [ ] **Step 1: Run the audit and capture the baseline**

```bash
cd /opt/dbstudio_portal && /opt/dbstudio_portal/.node/bin/node scripts/i18n-audit.js 2>&1 | tail -3
```

Record the exact "N candidate offenders across M files" line.

- [ ] **Step 2: Update `follow-ups.md` "i18n localisation" section**

Replace the current paragraph that says "scripts/i18n-audit.js reports 620 candidate offenders across 79 files as of the M9 → M10 checkpoint" with:

> `scripts/i18n-audit.js` reports **<N> candidate offenders across <M> files** as of <date>. The localisation grind remains v1.1 work per spec §2.11. The audit is wired into `scripts/run-tests.sh` as advisory; promote to blocking when the v1.1 i18n branch lands and gets the count to zero.

Keep the existing "Concrete next step" five-point plan — it's still the right approach.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/follow-ups.md
git commit -m "docs(followups): refresh i18n audit baseline (810 offenders, 118 files)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Accessibility pass — add real axe-core CI gate (defer the fix-up)

`scripts/a11y-check.js` exists today as a static checker (regex over EJS forbidding `onsubmit="return confirm()"` etc.). The follow-ups.md "Accessibility pass" section calls for a real axe-core run via puppeteer-core or jsdom.

This task adds the CI scaffolding and one example view; the per-view fix-up remains deferred.

**Files:**
- Modify: `scripts/a11y-check.js` (add an axe-core JSDOM mode behind `RUN_A11Y_AXE=1` env)
- Test: manual run

- [ ] **Step 1: Confirm axe-core is in node_modules**

```bash
ls /opt/dbstudio_portal/node_modules/axe-core 2>&1
```

If missing, add it: `sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm install --save-dev axe-core jsdom`. Confirm with user before installing.

- [ ] **Step 2: Add JSDOM-axe mode**

Append to `scripts/a11y-check.js` (after the existing static checks) a section that:
1. Builds the app via `await build({ skipSafetyCheck: true })`.
2. For each main view (login, customer dashboard, customer credentials, admin customers list, admin project detail), `app.inject({ method: 'GET', url, headers })` to render HTML.
3. Loads HTML into a JSDOM, runs `axe.run(window.document)`, prints any impact ≥ 'serious' violation.
4. Exits non-zero if any serious violations and `RUN_A11Y_AXE_BLOCKING=1` is set.

(If this turns out to be more than ~80 lines of script work, stop and check in — full implementation is its own task.)

- [ ] **Step 3: Run advisory**

```bash
RUN_A11Y_AXE=1 sudo -u portal-app /opt/dbstudio_portal/.node/bin/node scripts/a11y-check.js
```

Capture the violations list; do **not** attempt to fix them in this session.

- [ ] **Step 4: Update `follow-ups.md`**

Add a "Tracked violations baseline as of <date>" sub-section with the list. Each violation gets a per-view bullet so the v1.1 a11y branch has a punch list.

- [ ] **Step 5: Commit**

```bash
git add scripts/a11y-check.js docs/superpowers/follow-ups.md package-lock.json package.json
git commit -m "$(cat <<'EOF'
chore(a11y): add axe-core CI scaffolding behind RUN_A11Y_AXE

Adds a JSDOM-axe mode to scripts/a11y-check.js that renders each main
view via app.inject() and reports impact >= 'serious' violations.
Advisory only (non-blocking) until the v1.1 a11y branch fixes the
baseline. Tracked violations recorded in follow-ups.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final cleanup + push

- [ ] **Step 1: Confirm the full suite still passes**

```bash
cd /opt/dbstudio_portal && sudo bash scripts/run-tests.sh
```

Expected: all green; new tests added by Task 1 + Task 2 are in the count.

- [ ] **Step 2: Confirm portal.service stayed healthy**

```bash
systemctl is-active portal.service portal-pdf.service
curl -s http://127.0.0.1:3400/health
```

Expected: both `active`, `/health` returns `{"ok":true,"version":"0.1.0"}`.

- [ ] **Step 3: Push to origin (no service restart unless user authorises)**

```bash
cd /opt/dbstudio_portal && git push origin main
```

- [ ] **Step 4: Ask user before deploying**

The portal hot-loads source changes already. To pick up CSS / JS changes (none introduced by this plan) the operator runs:

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal-pdf.service
sleep 2
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

Don't run those without explicit user approval per the global server-safety rule.

---

## Items intentionally NOT in this plan

The following remain in `follow-ups.md` as accepted-policy or v1.1 work and should not be touched in this session:

- **N+1 in admin project detail GET** — accepted; revisit when a project has > 30 phases.
- **303 vs 302 redirect inconsistency** — accepted; opportunistic migration only.
- **i18n localisation grind** (the actual 810-string conversion) — v1.1 branch, multi-day. Task 4 just refreshes the baseline.
- **Accessibility per-view fix-up** — deferred to v1.1 branch. Task 5 just adds the CI scaffolding so the v1.1 branch has a baseline to start from.
- **TOTP regen otpauth URI** (M7 M9-review item) — re-classified as M11 visual-redesign work.
- Password-reset enumeration options (c) and (d) — explicitly operator-decision, deferred.

If any of those need to ship, they get their own dedicated plan.

---

## Self-Review Checklist

**1. Spec coverage:** every truly-open follow-up item has a task.
- M3 → Task 1 ✓
- M7 → Task 2 ✓
- `<dialog>` focus trap (Kimi nominal) → Task 3 ✓
- i18n baseline refresh → Task 4 ✓
- a11y CI scaffolding → Task 5 ✓
- Already-shipped items (Vault decrypt, M6 credential-requests, password-reset UX) → cleaned up in `follow-ups.md` in this session

**2. Placeholder scan:** no "TBD"/"TODO"/"figure out"/"add validation". Every code step has the actual code or a precise pointer to the model file (`tests/integration/phases/routes.test.js`).

**3. Type consistency:**
- `cancelByAdmin` signature: `{ adminId, customerId, requestId }` — same in service (Task 1 Step 3), route (Task 1 Step 4), test (Task 1 Step 1).
- `markNeedsUpdate` signature: `{ adminId, customerId, credentialId }` — same in service (Task 1 Step 6) and all callers.
- `CrossCustomerError` code: `CROSS_CUSTOMER` (matches existing usage in `domain/credentials/service.js`).
