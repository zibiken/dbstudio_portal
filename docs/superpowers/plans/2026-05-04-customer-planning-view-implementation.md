# Customer Planning View + Phase Date Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the customer's project page with a vertical-timeline planning view, add admin-side per-phase date overrides, fix the admin sticky-subtabs cutoff, and add drag-to-reorder for phases.

**Architecture:** Six task groups. T1 + T2 are server-side (service layer + new POST route for date overrides). T3 + T4 are the customer-facing view (timeline partials + CSS). T5 fixes the admin chrome cutoff (page-header height variable measured at runtime). T6 implements drag-and-drop reorder against a new "set absolute order" service. Each task ships its own commit.

**Tech Stack:** Fastify + EJS + Kysely/Postgres, vitest, native HTML5 Drag and Drop API, native `<details>` for collapsible checklists. No new dependencies.

**Repo:** `/opt/dbstudio_portal/` — main branch, no worktree.

**Spec:** `docs/superpowers/specs/2026-05-04-customer-planning-view-design.md` (commit 08c12c6).
**Kimi visual proposal:** `.reviews/kimi-planning-design.md`.

---

## Conventions

- **Test runner:** vitest. Integration tests run via `sudo bash scripts/run-tests.sh tests/path/to/file.test.js` (wrapper sources `.env`, sets RUN_DB_TESTS=1, runs as `portal-app`).
- **Commit style:** Conventional Commits. Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Live source:** `/opt/dbstudio_portal/` is the running source tree — every server.js / route / service edit hot-reloads into `portal.service` (via the running node process picking up imports on the next request? actually no — node doesn't hot-reload; restart needed for .js. EJS templates DO hot-reload). Plan tasks that touch JS code finish with a `systemctl restart portal.service` after the commit.
- **Static asset cache:** `public/js/*` and `public/styles/app.src.css` are cache-busted via `?v=<assetVersion>` (per-process startup token in `lib/render.js`). Restart picks up CSS / JS changes; users get fresh assets without a hard-refresh.
- **Build:** `sudo -u portal-app env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build` (runs `scripts/build.js` which compiles `app.src.css → app.css`, recompiles email templates, etc.).
- **Deploy:** edits ship via `git push origin main` + build + `sudo systemctl restart portal-pdf.service portal.service` + `sudo bash scripts/smoke.sh`. **Ask user before restarting services.**
- **No SW bump** until production deploy decided by user.
- **Test customer:** real customer "Laura Rouwet" (id `019de247-b8fd-72f5-b6ed-5b0b8bf67bd3`) with test project + 2 phases is on staging. Use it for manual smoke after each task that touches the relevant surface.

---

## Task 1: Service-layer date semantics — explicit-dates-win in `changeStatus`

**Why:** Today `changeStatus` unconditionally writes `started_at = now()` on `in_progress` and `completed_at = now()` on `done`, which overwrites any explicit override. Make the auto-set conditional on the field being null.

**Files:**
- Modify: `domain/phases/service.js:230-260` (the changeStatus auto-date block)
- Test: `tests/integration/phases/service.test.js` — extend with two new cases

- [ ] **Step 1: Read the current changeStatus auto-date block to confirm context**

```bash
sed -n '230,260p' /opt/dbstudio_portal/domain/phases/service.js
```

- [ ] **Step 2: Add the failing test for "explicit started_at survives in_progress transition"**

Append to the existing `describe('changeStatus', ...)` in `tests/integration/phases/service.test.js`:

```js
it('does not overwrite an explicit started_at when transitioning to in_progress', async () => {
  const adminId = await makeAdmin('explicit-start');
  const { customerId, projectId } = await makeProject('explicit-start-co');
  const { phaseId } = await phasesService.create(db,
    { projectId, customerId, label: 'Discovery' }, baseCtx(), { adminId });
  // Backfill an explicit started_at via a direct UPDATE — setPhaseDates
  // doesn't exist yet at this point in the file; we'll exercise it
  // through Task 2.
  await sql`UPDATE project_phases
              SET started_at = '2024-01-15 10:00:00+00'::timestamptz
            WHERE id = ${phaseId}::uuid`.execute(db);

  await phasesService.changeStatus(db,
    { phaseId, customerId }, { newStatus: 'in_progress' },
    baseCtx(), { adminId });

  const row = await sql`SELECT started_at::text AS started_at, completed_at
                          FROM project_phases WHERE id = ${phaseId}::uuid`.execute(db);
  expect(row.rows[0].started_at).toMatch(/^2024-01-15/);
  expect(row.rows[0].completed_at).toBeNull();
});

it('does not overwrite an explicit completed_at when transitioning to done', async () => {
  const adminId = await makeAdmin('explicit-done');
  const { customerId, projectId } = await makeProject('explicit-done-co');
  const { phaseId } = await phasesService.create(db,
    { projectId, customerId, label: 'Build' }, baseCtx(), { adminId });
  await sql`UPDATE project_phases
              SET started_at = '2024-02-01 10:00:00+00'::timestamptz,
                  completed_at = '2024-04-30 18:00:00+00'::timestamptz
            WHERE id = ${phaseId}::uuid`.execute(db);

  await phasesService.changeStatus(db,
    { phaseId, customerId }, { newStatus: 'done' },
    baseCtx(), { adminId });

  const row = await sql`SELECT completed_at::text AS completed_at
                          FROM project_phases WHERE id = ${phaseId}::uuid`.execute(db);
  expect(row.rows[0].completed_at).toMatch(/^2024-04-30/);
});
```

- [ ] **Step 3: Run the tests; expect both to fail (current code overwrites)**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/service.test.js
```

Expected: 2 new failures — assertions on `started_at` / `completed_at` unequal because the existing code reassigns them.

- [ ] **Step 4: Make the auto-set conditional**

Edit `domain/phases/service.js:230-260`. Replace the `if (newStatus === 'in_progress') { ... }` block with:

```js
if (newStatus === 'in_progress') {
  // Auto-set started_at only if it's never been set; an explicit
  // override (typed by an admin via setPhaseDates) wins forever.
  if (!startedAt) startedAt = now;
  // Going back to in_progress from done clears the completed mark
  // — the work is no longer done.
  completedAt = null;
} else if (newStatus === 'done') {
  // Same rule: explicit completed_at wins. Only auto-stamp on the
  // first transition into done.
  if (!completedAt) completedAt = now;
} else if (newStatus === 'not_started') {
  // Reverting to not_started clears both — the work effectively
  // never happened.
  startedAt = null;
  completedAt = null;
} else if (newStatus === 'blocked') {
  // Keep started_at; clear completed_at (work isn't done while blocked).
  completedAt = null;
}
```

- [ ] **Step 5: Run the tests; expect green**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/service.test.js
```

Expected: full file passes including the two new cases.

- [ ] **Step 6: Commit**

```bash
cd /opt/dbstudio_portal && git add domain/phases/service.js tests/integration/phases/service.test.js
git commit -m "$(cat <<'EOF'
feat(phases): explicit started_at/completed_at survive status transitions

Auto-stamping in changeStatus now only fires when the field is currently
NULL. An admin-typed date (typed via the upcoming setPhaseDates path or
backfilled directly) wins forever; clearing the field is the explicit
'revert to auto' signal. Going back to not_started still clears both
because the work effectively never happened.

Two new tests in tests/integration/phases/service.test.js pin the
behaviour for in_progress and done transitions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: New service method `setPhaseDates` + admin POST route

**Why:** Admin needs an explicit way to type or clear the started_at / completed_at fields. Service method takes parsed Dates (or `null`); route accepts `YYYY-MM-DD` strings from the form.

**Files:**
- Modify: `domain/phases/service.js` — add export `setPhaseDates(...)`
- Modify: `domain/phases/repo.js` — add helper `setPhaseDatesById(tx, phaseId, { startedAt, completedAt })` if not already present (Task 1 reused setPhaseStatus which carries these — verify; if so, no repo change)
- Modify: `routes/admin/project-phases.js` — register `app.post('.../phases/:phaseId/dates', ...)` mirroring the existing rename route
- Modify: `views/components/_phase-row.ejs` — add a date-inputs form between rename and status
- Test: `tests/integration/phases/service.test.js` — `setPhaseDates` cases
- Test: `tests/integration/phases/routes.test.js` — HTTP cases

- [ ] **Step 1: Add the failing service test**

```js
describe('setPhaseDates', () => {
  it('writes both dates when provided', async () => {
    const adminId = await makeAdmin('dates-both');
    const { customerId, projectId } = await makeProject('dates-both-co');
    const { phaseId } = await phasesService.create(db,
      { projectId, customerId, label: 'X' }, baseCtx(), { adminId });

    await phasesService.setPhaseDates(db, { phaseId, customerId },
      { startedAt: new Date('2024-03-01T00:00:00Z'),
        completedAt: new Date('2024-04-15T00:00:00Z') },
      baseCtx(), { adminId });

    const row = await sql`SELECT started_at::text AS s, completed_at::text AS c
                            FROM project_phases WHERE id = ${phaseId}::uuid`.execute(db);
    expect(row.rows[0].s).toMatch(/^2024-03-01/);
    expect(row.rows[0].c).toMatch(/^2024-04-15/);
  });

  it('clears a date when null is passed', async () => {
    const adminId = await makeAdmin('dates-clear');
    const { customerId, projectId } = await makeProject('dates-clear-co');
    const { phaseId } = await phasesService.create(db,
      { projectId, customerId, label: 'X' }, baseCtx(), { adminId });
    await phasesService.setPhaseDates(db, { phaseId, customerId },
      { startedAt: new Date('2024-01-01T00:00:00Z'), completedAt: null },
      baseCtx(), { adminId });

    await phasesService.setPhaseDates(db, { phaseId, customerId },
      { startedAt: null, completedAt: null },
      baseCtx(), { adminId });

    const row = await sql`SELECT started_at, completed_at
                            FROM project_phases WHERE id = ${phaseId}::uuid`.execute(db);
    expect(row.rows[0].started_at).toBeNull();
    expect(row.rows[0].completed_at).toBeNull();
  });

  it('rejects when phase belongs to a different customer (CROSS_CUSTOMER)', async () => {
    const adminId = await makeAdmin('dates-cross');
    const a = await makeProject('dates-cross-a');
    const b = await makeProject('dates-cross-b');
    const { phaseId } = await phasesService.create(db,
      { projectId: a.projectId, customerId: a.customerId, label: 'X' },
      baseCtx(), { adminId });

    await expect(
      phasesService.setPhaseDates(db,
        { phaseId, customerId: b.customerId },
        { startedAt: new Date(), completedAt: null },
        baseCtx(), { adminId })
    ).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
  });
});
```

- [ ] **Step 2: Run; expect fails (method does not exist)**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/service.test.js
```

Expected: TypeError "phasesService.setPhaseDates is not a function".

- [ ] **Step 3: Implement `setPhaseDates`**

After `changeStatus` in `domain/phases/service.js`, add:

```js
export class CrossCustomerError extends Error {
  constructor() { super('phase belongs to a different customer'); this.code = 'CROSS_CUSTOMER'; this.name = 'CrossCustomerError'; }
}

export async function setPhaseDates(
  db,
  { phaseId, customerId },
  { startedAt, completedAt },
  ctx = {},
  { adminId } = {},
) {
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    // Phase customer ownership is enforced via the project join; assert
    // here too as defence-in-depth (mirrors the credentials/credential-
    // requests pattern landed in M3 cleanup).
    const own = await sql`SELECT 1 FROM project_phases pp
                            JOIN projects p ON p.id = pp.project_id
                           WHERE pp.id = ${phaseId}::uuid
                             AND p.customer_id = ${customerId}::uuid`.execute(tx);
    if (own.rows.length === 0) throw new CrossCustomerError();

    await repo.setPhaseStatus(tx, phaseId, {
      status: phase.status,
      startedAt: startedAt ?? null,
      completedAt: completedAt ?? null,
    });

    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.dates_overridden',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...auditMeta, customerId,
        startedAt: startedAt?.toISOString() ?? null,
        completedAt: completedAt?.toISOString() ?? null,
      },
      visibleToCustomer: false,
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });

    return { phaseId };
  });
}
```

- [ ] **Step 4: Run; expect green**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/service.test.js
```

Expected: 3 new cases pass.

- [ ] **Step 5: Add the HTTP route**

In `routes/admin/project-phases.js`, after the `/status` POST and before `/reorder`, add:

```js
app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/dates',
  { preHandler: app.csrfProtection },
  async (req, reply) => {
    const guards = await loadGuardsWithPhase(app, req, reply);
    if (!guards) return;
    const body = req.body ?? {};
    function parseYmd(s) {
      if (typeof s !== 'string' || s.trim() === '') return null;
      // Accept YYYY-MM-DD; build a Date at UTC midnight to avoid TZ drift.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
      if (!m) throw new Error('PHASE_DATE_INVALID');
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (Number.isNaN(d.getTime())) throw new Error('PHASE_DATE_INVALID');
      return d;
    }
    let startedAt, completedAt;
    try {
      startedAt = parseYmd(body.started_at);
      completedAt = parseYmd(body.completed_at);
      if (startedAt && completedAt && completedAt < startedAt) {
        throw new Error('PHASE_DATE_RANGE_INVALID');
      }
    } catch (err) {
      const safe =
        err.message === 'PHASE_DATE_INVALID' ? 'Use the date picker — DD/MM/YYYY format.' :
        err.message === 'PHASE_DATE_RANGE_INVALID' ? 'Completed date can’t be earlier than Started.' :
        'Could not save the dates.';
      return back(app, req, reply, guards.customer.id, guards.project.id, guards.phase.id, safe);
    }
    try {
      await phasesService.setPhaseDates(app.db,
        { phaseId: guards.phase.id, customerId: guards.customer.id },
        { startedAt, completedAt },
        ctxFromReq(req),
        { adminId: guards.adminId });
    } catch (err) {
      return back(app, req, reply, guards.customer.id, guards.project.id, guards.phase.id, flashFromError(err));
    }
    return back(app, req, reply, guards.customer.id, guards.project.id, guards.phase.id);
  });
```

- [ ] **Step 6: Add the date inputs to the admin phase row**

In `views/components/_phase-row.ejs`, after the `phase-row__rename` form (line ~23) and before `.phase-row__status-wrap`, insert:

```ejs
<form class="phase-row__dates" method="post" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/dates" data-fragment="row">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <label class="phase-row__date-cell">
    <span class="visually-hidden">Started</span>
    <input class="phase-row__date" name="started_at" type="date" value="<%= p.started_at ? new Date(p.started_at).toISOString().slice(0,10) : '' %>" data-original-value="<%= p.started_at ? new Date(p.started_at).toISOString().slice(0,10) : '' %>" aria-label="Started date">
  </label>
  <label class="phase-row__date-cell">
    <span class="visually-hidden">Completed</span>
    <input class="phase-row__date" name="completed_at" type="date" value="<%= p.completed_at ? new Date(p.completed_at).toISOString().slice(0,10) : '' %>" data-original-value="<%= p.completed_at ? new Date(p.completed_at).toISOString().slice(0,10) : '' %>" aria-label="Completed date">
  </label>
</form>
```

Also extend the autosave-on-blur in `public/js/phase-editor.js` so date inputs trigger submit on change (currently only `.phase-row__label-input` triggers). Replace the existing blur handler block with:

```js
// Autosave-on-change for label inputs and date inputs.
section.addEventListener('blur', function (ev) {
  var input = ev.target.closest('input.phase-row__label-input, input.phase-row__date');
  if (!input) return;
  var original = input.dataset.originalValue;
  if (input.value === original) return;
  var form = input.closest('form');
  if (!form) return;
  submitFragment(form);
}, true);
```

Add minimal CSS in `public/styles/app.src.css` near the existing `.phase-row__rename` block:

```css
.phase-row__dates {
  display: inline-flex; gap: var(--s-2); align-items: center;
}
.phase-row__date-cell { display: inline-flex; flex-direction: column; }
.phase-row__date {
  font-size: var(--f-sm); padding: var(--s-1) var(--s-2);
  border: 1px solid var(--border-light); border-radius: var(--radius-sm);
  background: var(--bg-light); color: var(--fg-on-light);
}
@media (max-width: 640px) {
  .phase-row__dates { flex-wrap: wrap; gap: var(--s-1); }
}
```

- [ ] **Step 7: Add HTTP test**

In `tests/integration/phases/routes.test.js`, append:

```js
it('POST /dates writes started_at + completed_at and 303-redirects (non-fragment)', async () => {
  const jar = await loginAdmin('dates-happy');
  const csrf = await csrfFromProjectDetail(jar, customerAId, projectAId);
  const create = await postPhaseForm(jar,
    `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
    { _csrf: csrf, label: 'date-target' }, { csrf });
  expect(create.statusCode).toBe(303);
  const phase = await sql`SELECT id::text FROM project_phases
                            WHERE project_id = ${projectAId}::uuid AND label = ${'date-target'}`.execute(db);
  const phaseId = phase.rows[0].id;

  const res = await postPhaseForm(jar,
    `/admin/customers/${customerAId}/projects/${projectAId}/phases/${phaseId}/dates`,
    { _csrf: csrf, started_at: '2024-01-15', completed_at: '2024-03-30' }, { csrf });
  expect(res.statusCode).toBe(303);
  const row = await sql`SELECT started_at::text AS s, completed_at::text AS c
                          FROM project_phases WHERE id = ${phaseId}::uuid`.execute(db);
  expect(row.rows[0].s).toMatch(/^2024-01-15/);
  expect(row.rows[0].c).toMatch(/^2024-03-30/);
});

it('POST /dates with completed_at < started_at flashes safe copy via phaseError', async () => {
  const jar = await loginAdmin('dates-bad-range');
  const csrf = await csrfFromProjectDetail(jar, customerAId, projectAId);
  const create = await postPhaseForm(jar,
    `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
    { _csrf: csrf, label: 'bad-range' }, { csrf });
  const phase = await sql`SELECT id::text FROM project_phases
                            WHERE project_id = ${projectAId}::uuid AND label = ${'bad-range'}`.execute(db);
  const res = await postPhaseForm(jar,
    `/admin/customers/${customerAId}/projects/${projectAId}/phases/${phase.rows[0].id}/dates`,
    { _csrf: csrf, started_at: '2024-05-01', completed_at: '2024-04-01' }, { csrf });
  expect(res.statusCode).toBe(303);
  expect(decodeURIComponent(res.headers.location)).toContain('Completed date can');
});
```

- [ ] **Step 8: Run all phase tests; expect green**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/
```

- [ ] **Step 9: Build assets + restart portal + commit**

```bash
cd /opt/dbstudio_portal && sudo env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
git add domain/phases/service.js routes/admin/project-phases.js views/components/_phase-row.ejs public/js/phase-editor.js public/styles/app.src.css tests/integration/phases/service.test.js tests/integration/phases/routes.test.js
git commit -m "$(cat <<'EOF'
feat(phases): admin date overrides for started_at + completed_at

Adds setPhaseDates service method, POST .../phases/:id/dates route, and
inline date inputs on the admin phase row that save on blur via the
existing fragment-swap pipeline.

Empty value = revert to auto-managed (next status flip writes today).
Non-empty value = explicit override that survives status transitions
(see Task 1). Range validation: completed_at must be >= started_at.
CROSS_CUSTOMER error when the phase doesn't belong to the URL :cid.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Customer timeline view — partials + filter

**Why:** Replace the customer's project page with the vertical-timeline layout from the spec.

**Files:**
- Create: `views/customer/projects/_timeline.ejs`
- Create: `views/customer/projects/_timeline-phase.ejs`
- Create: `views/customer/projects/_timeline-checklist.ejs`
- Modify: `views/customer/projects/show.ejs` (replace phase rendering with `_timeline.ejs` include)
- Modify: `routes/customer/projects.js:54-66` — keep the existing `not_started` filter, ensure items are filtered to `visible_to_customer === true` (already there), and pre-compute the `done` count per phase to avoid a per-item loop in the template

- [ ] **Step 1: Read the current customer/projects/show.ejs to understand the existing structure**

```bash
cat /opt/dbstudio_portal/views/customer/projects/show.ejs
```

Note the existing `_page-header` include + status pill key map at the top. Reuse those.

- [ ] **Step 2: Create `_timeline.ejs`**

```ejs
<%# Customer-facing project timeline.
    Locals:
      phases - array of phases (already filtered to drop not_started),
               each with `items` (already filtered to visible_to_customer)
               and `doneCount` (precomputed in route).
%>
<% if (!phases || phases.length === 0) { %>
  <%- include('../../components/_empty-state', {
    headline: 'No active phases yet',
    lead: 'Once we start work on a phase, you will see it here with its progress and any checklist items.'
  }) %>
<% } else { %>
  <ol class="customer-timeline">
    <% phases.forEach(function(phase, idx) { %>
      <%- include('_timeline-phase', { phase: phase, isLast: idx === phases.length - 1 }) %>
    <% }) %>
  </ol>
<% } %>
```

- [ ] **Step 3: Create `_timeline-phase.ejs`**

```ejs
<%# Single phase row in the customer timeline.
    Locals: phase, isLast %>
<%
  var statusKey = phase.status === 'done' ? 'phase-done'
                : phase.status === 'blocked' ? 'phase-blocked'
                : phase.status === 'in_progress' ? 'phase-in-progress'
                : 'phase-not-started';
  var statusLabel = phase.status === 'in_progress' ? 'in progress'
                  : phase.status === 'not_started' ? 'not started'
                  : phase.status;
  var total = (phase.items || []).length;
  var done = phase.doneCount ?? 0;
%>
<li class="customer-timeline__item<%= isLast ? ' customer-timeline__item--last' : '' %>">
  <span class="customer-timeline__rail" aria-hidden="true">
    <span class="customer-timeline__node"></span>
  </span>
  <article class="customer-timeline__card">
    <header class="customer-timeline__header">
      <h2 class="customer-timeline__title"><%= phase.label %></h2>
      <span class="status-pill status-pill--<%= statusKey %>"><%= statusLabel %></span>
    </header>
    <p class="customer-timeline__meta">
      <% if (phase.started_at) { %>Started <%= euDate(phase.started_at) %><% } %>
      <% if (phase.started_at && phase.completed_at) { %> &middot; <% } %>
      <% if (phase.completed_at) { %>Completed <%= euDate(phase.completed_at) %><% } %>
    </p>
    <% if (total > 0) { %>
      <details class="customer-timeline__details">
        <summary class="customer-timeline__summary"><%= done %> of <%= total %> done <span class="customer-timeline__summary-toggle">— Show checklist</span></summary>
        <%- include('_timeline-checklist', { items: phase.items }) %>
      </details>
    <% } else { %>
      <p class="customer-timeline__summary">No checklist items yet.</p>
    <% } %>
  </article>
</li>
```

- [ ] **Step 4: Create `_timeline-checklist.ejs`**

```ejs
<%# Checklist body inside an open <details>. Splits into Outstanding
    then Completed. Locals: items %>
<%
  var outstanding = items.filter(function(i) { return !i.done_at; });
  var completed = items.filter(function(i) { return !!i.done_at; });
%>
<div class="customer-timeline__checklist">
  <% if (outstanding.length > 0) { %>
    <h3 class="customer-timeline__checklist-group">Still to do</h3>
    <ul>
      <% outstanding.forEach(function(it) { %>
        <li class="customer-timeline__checklist-item">
          <span class="customer-timeline__checklist-icon" aria-hidden="true">☐</span>
          <span class="customer-timeline__checklist-label"><%= it.label %></span>
        </li>
      <% }) %>
    </ul>
  <% } %>
  <% if (completed.length > 0) { %>
    <h3 class="customer-timeline__checklist-group">Done</h3>
    <ul>
      <% completed.forEach(function(it) { %>
        <li class="customer-timeline__checklist-item customer-timeline__checklist-item--done">
          <span class="customer-timeline__checklist-icon" aria-hidden="true">☑</span>
          <span class="customer-timeline__checklist-label"><%= it.label %></span>
        </li>
      <% }) %>
    </ul>
  <% } %>
</div>
```

- [ ] **Step 5: Replace the body of `views/customer/projects/show.ejs`**

Read first:

```bash
cat /opt/dbstudio_portal/views/customer/projects/show.ejs
```

Keep the `_page-header` include and any wrapping section, replace the existing phase loop / empty-state with:

```ejs
<%- include('_timeline', { phases: phases }) %>
```

If the existing file has an admin/customer status-key var at the top that's now duplicated in `_timeline-phase.ejs`, remove it from the show.ejs (the partial owns it now).

- [ ] **Step 6: Modify `routes/customer/projects.js` to precompute doneCount**

In the existing `phasesWithItems` map (around line 58), update to:

```js
const phasesWithItems = await Promise.all(visiblePhases.map(async (p) => {
  const items = await listItemsByPhase(app.db, p.id);
  const visible = items.filter(i => i.visible_to_customer);
  const doneCount = visible.filter(i => i.done_at).length;
  return { ...p, items: visible, doneCount };
}));
```

- [ ] **Step 7: Add the customer timeline CSS**

Append to `public/styles/app.src.css`, after the existing `confirm-dialog` block:

```css
/* === Customer planning timeline (2026-05-04) === */
.customer-timeline { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--s-6); }
.customer-timeline__item { display: grid; grid-template-columns: var(--s-8) 1fr; gap: var(--s-4); align-items: stretch; position: relative; }
.customer-timeline__rail { display: flex; flex-direction: column; align-items: center; position: relative; }
.customer-timeline__rail::before {
  content: ''; position: absolute; top: var(--s-3); bottom: calc(var(--s-6) * -1);
  left: 50%; width: 2px; background: var(--border-light); transform: translateX(-50%);
}
.customer-timeline__item--last .customer-timeline__rail::before { display: none; }
.customer-timeline__node {
  display: block; width: var(--s-3); height: var(--s-3); border-radius: 50%;
  background: var(--fg-on-light); margin-top: var(--s-2); position: relative; z-index: 1;
}
.customer-timeline__card {
  background: var(--bg-light); border: 1px solid var(--border-light);
  border-radius: var(--radius-md); padding: var(--s-4);
}
.customer-timeline__header { display: flex; justify-content: space-between; align-items: center; gap: var(--s-3); margin: 0 0 var(--s-2); }
.customer-timeline__title { font-size: var(--f-md); font-weight: 600; margin: 0; }
.customer-timeline__meta { color: var(--fg-on-light-muted); font-size: var(--f-sm); margin: 0 0 var(--s-3); }
.customer-timeline__details { margin: var(--s-2) 0 0; }
.customer-timeline__summary { font-size: var(--f-sm); cursor: pointer; user-select: none; }
.customer-timeline__summary-toggle { color: var(--fg-on-light-muted); }
.customer-timeline__checklist { padding: var(--s-3) 0 0; }
.customer-timeline__checklist-group { font-size: var(--f-xs); color: var(--fg-on-light-muted); text-transform: uppercase; letter-spacing: 0.05em; margin: var(--s-3) 0 var(--s-1); }
.customer-timeline__checklist-group:first-child { margin-top: 0; }
.customer-timeline__checklist ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--s-1); }
.customer-timeline__checklist-item { display: flex; align-items: center; gap: var(--s-2); font-size: var(--f-sm); }
.customer-timeline__checklist-icon { font-size: var(--f-md); width: 1.2em; text-align: center; color: var(--fg-on-light-muted); }
.customer-timeline__checklist-item--done .customer-timeline__checklist-icon { color: var(--c-success); }
.customer-timeline__checklist-item--done .customer-timeline__checklist-label { color: var(--fg-on-light-muted); text-decoration: line-through; }
@media (max-width: 640px) {
  .customer-timeline__item { grid-template-columns: var(--s-4) 1fr; gap: var(--s-3); }
  .customer-timeline__rail::before { display: none; }
  .customer-timeline__header { flex-wrap: wrap; }
}
```

- [ ] **Step 8: Run the customer-projects tests if any exist; otherwise smoke**

```bash
ls /opt/dbstudio_portal/tests/integration/customer/projects/ 2>&1
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer/
```

If no project-specific tests exist, manual smoke after restart: log in as Laura's user, hit `/customer/projects/<id>`, confirm timeline renders with rail, status pill, dates, and the `<details>` summary.

- [ ] **Step 9: Build, restart, commit**

```bash
cd /opt/dbstudio_portal && sudo env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal.service && sudo bash scripts/smoke.sh
git add views/customer/projects/ routes/customer/projects.js public/styles/app.src.css
git commit -m "$(cat <<'EOF'
feat(customer): vertical-timeline planning view for /customer/projects/:id

Replaces the per-phase card list with a left-rail timeline of dots and
connecting lines, status pills on the right, started/completed dates,
and a collapsed-by-default <details> expander showing the full
checklist split into Outstanding then Completed groups.

Reuses existing design tokens (--bg-light, --border-light, --c-success,
spacing scale, status-pill--phase-* classes). New customer-timeline__*
class set per the Kimi design proposal at .reviews/kimi-planning-design.md.

Mobile reflow drops the rail line, keeps the dot, content goes full-width.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Fix admin sticky-subtabs cutoff

**Why:** The page-header is `position: sticky; top: 0` (z-index 30) and `.subtabs` is `position: sticky; top: var(--page-header-height)` (z-index 29). `--page-header-height` is hard-coded to 96px, but the actual page-header height varies — admin customer detail is ~140-150px (eyebrow + title + subtitle + actions row + min-height: 92px from `.page-header`). The subtabs stick at 96px, so the bottom 40-50px of the page-header is occluded by the subtabs bar. The user describes this as "the top bit is cut off".

Fix: measure the real page-header height at load + on resize and write it into the CSS variable.

**Files:**
- Modify: `public/js/sticky-chrome.js` — replace the no-op stub with the measure-and-set logic

- [ ] **Step 1: Replace `public/js/sticky-chrome.js`**

Read first:

```bash
cat /opt/dbstudio_portal/public/js/sticky-chrome.js
```

Replace the file contents with:

```js
// Sticky chrome height sync. The .subtabs bar uses
//   position: sticky; top: var(--page-header-height);
// so it parks immediately below the sticky page-header. The static
// 96px default in app.src.css is the minimum case; admin customer
// pages with eyebrow + title + subtitle + actions can be 140-160px,
// causing the subtabs bar to overlap and cut off the bottom of the
// page-header.
//
// Measure the real height on load + on resize + when the header's
// content changes, and write it into the CSS variable.
(function () {
  'use strict';
  var header = document.querySelector('.page-header');
  if (!header) return;

  function sync() {
    // Use offsetHeight to include border + padding. The page-header has
    // a margin-bottom that should NOT be added — the subtabs sit beside
    // the next-element start, not below margin.
    var h = header.offsetHeight;
    document.documentElement.style.setProperty('--page-header-height', h + 'px');
  }

  sync();
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(sync);
    ro.observe(header);
  } else {
    window.addEventListener('resize', sync);
  }
})();
```

- [ ] **Step 2: Build + restart**

```bash
cd /opt/dbstudio_portal && sudo env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal.service && sudo bash scripts/smoke.sh
```

- [ ] **Step 3: Manual smoke**

Visit the admin customer detail (or any admin customer sub-tab page). Scroll. Confirm:
- Page-header pins at top with full visible height (no cut-off bottom).
- Subtabs pin immediately below the page-header.
- No flicker (the IntersectionObserver-based shrink behaviour was removed in the previous bundle).

- [ ] **Step 4: Commit**

```bash
git add public/js/sticky-chrome.js
git commit -m "$(cat <<'EOF'
fix(admin): subtabs no longer occlude page-header bottom

The 96px default for --page-header-height matched the simplest header
(eyebrow + title only). Admin customer pages stack
eyebrow + title + subtitle + actions and grow to ~140-160px, so the
sticky subtabs at top: 96px sat in front of the lower portion of the
header — visible to the user as "the top bit is cut off".

sticky-chrome.js now measures .page-header.offsetHeight on load + on
ResizeObserver fire + on window resize and writes the value into
--page-header-height. Subtabs follow correctly on every page surface.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Drag-to-reorder phases

**Why:** The 6-dot handle (`.phase-row__handle`) signals draggability via `cursor: grab` but no JS implements it. The user expects to drag a phase to any position; today only adjacent up/down via the overflow menu works.

Approach: native HTML5 Drag and Drop API on the handle. On drop, compute the new index and POST to a new "set absolute order" route. Keep the existing up/down route for keyboard / no-JS users.

**Files:**
- Modify: `domain/phases/service.js` — new `setPhaseOrder(db, { phaseId, customerId }, { targetIndex }, ctx, { adminId })`
- Modify: `domain/phases/repo.js` — helper that atomically renumbers display_order in the project
- Modify: `routes/admin/project-phases.js` — new `POST .../phases/:phaseId/set-order` route
- Modify: `views/components/_phase-row.ejs` — add `draggable="true"` + `data-phase-id` attributes on the row root
- Modify: `public/js/phase-editor.js` — add drag handlers
- Modify: `public/styles/app.src.css` — add `.phase-row--dragging` + `.phase-row--drop-before` / `.phase-row--drop-after` visual states
- Test: `tests/integration/phases/service.test.js` — setPhaseOrder cases
- Test: `tests/integration/phases/routes.test.js` — HTTP cases

- [ ] **Step 1: Add the failing service test**

```js
describe('setPhaseOrder', () => {
  it('moves a phase to a target index, renumbering siblings 0..N-1', async () => {
    const adminId = await makeAdmin('order-1');
    const { customerId, projectId } = await makeProject('order-1-co');
    const a = (await phasesService.create(db, { projectId, customerId, label: 'A' }, baseCtx(), { adminId })).phaseId;
    const b = (await phasesService.create(db, { projectId, customerId, label: 'B' }, baseCtx(), { adminId })).phaseId;
    const c = (await phasesService.create(db, { projectId, customerId, label: 'C' }, baseCtx(), { adminId })).phaseId;
    // initial: A=0, B=1, C=2

    await phasesService.setPhaseOrder(db,
      { phaseId: c, customerId }, { targetIndex: 0 },
      baseCtx(), { adminId });

    const rows = await sql`SELECT id::text AS id, display_order
                             FROM project_phases
                            WHERE project_id = ${projectId}::uuid
                            ORDER BY display_order`.execute(db);
    expect(rows.rows.map(r => r.id)).toEqual([c, a, b]);
    expect(rows.rows.map(r => r.display_order)).toEqual([0, 1, 2]);
  });

  it('rejects targetIndex out of range', async () => {
    const adminId = await makeAdmin('order-bad');
    const { customerId, projectId } = await makeProject('order-bad-co');
    const a = (await phasesService.create(db, { projectId, customerId, label: 'A' }, baseCtx(), { adminId })).phaseId;
    await expect(
      phasesService.setPhaseOrder(db, { phaseId: a, customerId },
        { targetIndex: 5 }, baseCtx(), { adminId })
    ).rejects.toMatchObject({ code: 'PHASE_ORDER_OUT_OF_RANGE' });
  });

  it('rejects when phase belongs to a different customer', async () => {
    const adminId = await makeAdmin('order-cross');
    const a = await makeProject('order-cross-a');
    const b = await makeProject('order-cross-b');
    const phaseInA = (await phasesService.create(db,
      { projectId: a.projectId, customerId: a.customerId, label: 'X' },
      baseCtx(), { adminId })).phaseId;
    await expect(
      phasesService.setPhaseOrder(db, { phaseId: phaseInA, customerId: b.customerId },
        { targetIndex: 0 }, baseCtx(), { adminId })
    ).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
  });
});
```

- [ ] **Step 2: Run; expect fails**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/service.test.js
```

- [ ] **Step 3: Add `setPhaseOrder` to the service**

After `setPhaseDates` in `domain/phases/service.js`:

```js
export class PhaseOrderOutOfRangeError extends Error {
  constructor() { super('targetIndex is out of range'); this.code = 'PHASE_ORDER_OUT_OF_RANGE'; this.name = 'PhaseOrderOutOfRangeError'; }
}

export async function setPhaseOrder(
  db,
  { phaseId, customerId },
  { targetIndex },
  ctx = {},
  { adminId } = {},
) {
  if (!Number.isInteger(targetIndex) || targetIndex < 0) throw new PhaseOrderOutOfRangeError();
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    const own = await sql`SELECT 1 FROM project_phases pp
                            JOIN projects p ON p.id = pp.project_id
                           WHERE pp.id = ${phaseId}::uuid
                             AND p.customer_id = ${customerId}::uuid`.execute(tx);
    if (own.rows.length === 0) throw new CrossCustomerError();

    // Lock all sibling rows to serialize concurrent drag operations.
    const siblings = await sql`SELECT id::text AS id, display_order
                                 FROM project_phases
                                WHERE project_id = ${phase.project_id}::uuid
                             ORDER BY display_order
                                  FOR UPDATE`.execute(tx);
    const ids = siblings.rows.map(r => r.id);
    if (targetIndex >= ids.length) throw new PhaseOrderOutOfRangeError();

    // Build the new ordering by splicing the moved phase out of its
    // current position and into the targetIndex slot.
    const without = ids.filter(id => id !== phaseId);
    without.splice(targetIndex, 0, phaseId);

    // Renumber 0..N-1 atomically.
    for (let i = 0; i < without.length; i++) {
      await sql`UPDATE project_phases SET display_order = ${i}, updated_at = now()
                 WHERE id = ${without[i]}::uuid`.execute(tx);
    }

    const auditMeta = baseAuditMetadata(ctx);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.reordered',
      targetType: 'project_phase', targetId: phaseId,
      metadata: { ...auditMeta, customerId, projectId: phase.project_id, targetIndex },
      visibleToCustomer: false,
      ip: ctx?.ip ?? null,
      userAgentHash: ctx?.userAgentHash ?? null,
    });

    return { phaseId, targetIndex };
  });
}
```

- [ ] **Step 4: Run service tests; expect green**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/service.test.js
```

- [ ] **Step 5: Add the HTTP route**

In `routes/admin/project-phases.js`, after the existing `/reorder` POST:

```js
app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/set-order',
  { preHandler: app.csrfProtection },
  async (req, reply) => {
    const guards = await loadGuardsWithPhase(app, req, reply);
    if (!guards) return;
    const targetIndex = Number.parseInt(String(req.body?.target_index ?? ''), 10);
    if (!Number.isInteger(targetIndex)) {
      return back(app, req, reply, guards.customer.id, guards.project.id, guards.phase.id, 'Invalid target position.');
    }
    try {
      await phasesService.setPhaseOrder(app.db,
        { phaseId: guards.phase.id, customerId: guards.customer.id },
        { targetIndex },
        ctxFromReq(req),
        { adminId: guards.adminId });
    } catch (err) {
      const safe =
        err?.code === 'PHASE_ORDER_OUT_OF_RANGE' ? 'That position is out of range.' :
        flashFromError(err);
      return back(app, req, reply, guards.customer.id, guards.project.id, guards.phase.id, safe);
    }
    return back(app, req, reply, guards.customer.id, guards.project.id, guards.phase.id);
  });
```

- [ ] **Step 6: Add HTTP test**

In `tests/integration/phases/routes.test.js`:

```js
it('POST /set-order moves a phase to the requested index and 303-redirects', async () => {
  const jar = await loginAdmin('order-http');
  const csrf = await csrfFromProjectDetail(jar, customerAId, projectAId);
  // Create A, B, C
  for (const lbl of ['A2', 'B2', 'C2']) {
    const r = await postPhaseForm(jar,
      `/admin/customers/${customerAId}/projects/${projectAId}/phases`,
      { _csrf: csrf, label: lbl }, { csrf });
    expect(r.statusCode).toBe(303);
  }
  const phases = await sql`SELECT id::text AS id, label FROM project_phases
                            WHERE project_id = ${projectAId}::uuid AND label IN ('A2','B2','C2')
                            ORDER BY display_order`.execute(db);
  const cId = phases.rows.find(r => r.label === 'C2').id;

  const res = await postPhaseForm(jar,
    `/admin/customers/${customerAId}/projects/${projectAId}/phases/${cId}/set-order`,
    { _csrf: csrf, target_index: '0' }, { csrf });
  expect(res.statusCode).toBe(303);

  const after = await sql`SELECT label FROM project_phases
                           WHERE project_id = ${projectAId}::uuid AND label IN ('A2','B2','C2')
                           ORDER BY display_order`.execute(db);
  expect(after.rows.map(r => r.label)).toEqual(['C2', 'A2', 'B2']);
});
```

- [ ] **Step 7: Add the drag JS**

In `views/components/_phase-row.ejs`, add `draggable="true"` and `data-phase-id="<%= p.id %>"` to the outermost `<li>` (the `phase-row` container — confirm element name from the file).

In `public/js/phase-editor.js`, add this block before the closing IIFE:

```js
// Drag-to-reorder phases. The 6-dot handle (.phase-row__handle) signals
// draggability via CSS; we attach the actual drag listeners to the
// row root (which carries draggable=true). On drop, compute the new
// index from the array of all rows and POST to /set-order.
(function () {
  if (!section) return;
  var draggingId = null;
  var draggingEl = null;

  section.addEventListener('dragstart', function (ev) {
    var row = ev.target.closest('li.phase-row[data-phase-id]');
    if (!row) return;
    draggingEl = row;
    draggingId = row.getAttribute('data-phase-id');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', draggingId);
    setTimeout(function () { row.classList.add('phase-row--dragging'); }, 0);
  });

  section.addEventListener('dragend', function () {
    if (draggingEl) draggingEl.classList.remove('phase-row--dragging');
    section.querySelectorAll('.phase-row--drop-before, .phase-row--drop-after').forEach(function (r) {
      r.classList.remove('phase-row--drop-before', 'phase-row--drop-after');
    });
    draggingEl = null; draggingId = null;
  });

  section.addEventListener('dragover', function (ev) {
    var target = ev.target.closest('li.phase-row[data-phase-id]');
    if (!target || target === draggingEl) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    var rect = target.getBoundingClientRect();
    var before = (ev.clientY - rect.top) < rect.height / 2;
    section.querySelectorAll('.phase-row--drop-before, .phase-row--drop-after').forEach(function (r) {
      r.classList.remove('phase-row--drop-before', 'phase-row--drop-after');
    });
    target.classList.add(before ? 'phase-row--drop-before' : 'phase-row--drop-after');
  });

  section.addEventListener('drop', function (ev) {
    var target = ev.target.closest('li.phase-row[data-phase-id]');
    if (!target || !draggingId || target === draggingEl) return;
    ev.preventDefault();
    var rect = target.getBoundingClientRect();
    var before = (ev.clientY - rect.top) < rect.height / 2;
    var allRows = Array.from(section.querySelectorAll('li.phase-row[data-phase-id]'));
    var withoutDragged = allRows.filter(function (r) { return r !== draggingEl; });
    var targetIdx = withoutDragged.indexOf(target);
    var insertAt = before ? targetIdx : targetIdx + 1;

    // Find any form with a CSRF token to reuse (every fragment form on
    // this page carries the same _csrf).
    var anyForm = section.querySelector('form input[name="_csrf"]');
    var csrf = anyForm ? anyForm.value : '';
    var url = '/admin/customers/' + window.__phaseSectionCustomerId
            + '/projects/' + window.__phaseSectionProjectId
            + '/phases/' + draggingId + '/set-order';

    var params = new URLSearchParams();
    params.append('_csrf', csrf);
    params.append('target_index', String(insertAt));

    fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      credentials: 'same-origin',
    }).then(function (res) {
      if (res.redirected || res.ok) {
        // Reorder is a project-wide change — easier to just reload the
        // section than to swap N rows. The redirect already targets the
        // project detail with the right hash.
        window.location.reload();
      }
    });
  });
})();
```

For the `window.__phaseSectionCustomerId` / `__phaseSectionProjectId` variables: add a `<script>` block in `views/admin/projects/detail.ejs` BEFORE the phase-editor.js include:

```ejs
<script nonce="<%= nonce %>">
  window.__phaseSectionCustomerId = <%- JSON.stringify(customer.id) %>;
  window.__phaseSectionProjectId = <%- JSON.stringify(project.id) %>;
</script>
```

- [ ] **Step 8: Add visual drop states to CSS**

Append to `public/styles/app.src.css` in the existing phases section:

```css
.phase-row[draggable="true"] { cursor: default; }
.phase-row__handle { cursor: grab; }
.phase-row--dragging { opacity: 0.5; }
.phase-row--drop-before { box-shadow: 0 -3px 0 0 var(--c-success); }
.phase-row--drop-after  { box-shadow:  0 3px 0 0 var(--c-success); }
```

- [ ] **Step 9: Run all phase tests; build, restart, manual smoke**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/
cd /opt/dbstudio_portal && sudo env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal.service && sudo bash scripts/smoke.sh
```

Manual smoke: drag a phase row over another, confirm the green drop indicator shows above/below the target, drop → page reloads with new order.

- [ ] **Step 10: Commit**

```bash
git add domain/phases/service.js routes/admin/project-phases.js views/components/_phase-row.ejs views/admin/projects/detail.ejs public/js/phase-editor.js public/styles/app.src.css tests/integration/phases/service.test.js tests/integration/phases/routes.test.js
git commit -m "$(cat <<'EOF'
feat(phases): drag-to-reorder via HTML5 Drag and Drop

The 6-dot handle had cursor: grab styling but no JS — only the overflow
menu's Move up/Move down worked. Adds setPhaseOrder service method
that atomically renumbers display_order siblings 0..N-1, a
POST .../phases/:id/set-order route, and dragstart/dragover/drop
handlers in phase-editor.js with above/below visual indicators.

Up/down route stays for keyboard + no-JS users (still wired through
the overflow menu).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final cleanup, full suite, push

- [ ] **Step 1: Run the full suite**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: all green, count is up by the new tests added in Tasks 1, 2, 5.

- [ ] **Step 2: Confirm services are healthy**

```bash
systemctl is-active portal.service portal-pdf.service
curl -s http://127.0.0.1:3400/health
```

- [ ] **Step 3: Run Codex + Kimi reviews on the bundle**

```bash
codex-review-prompt --repo /opt/dbstudio_portal
kimi-design-review --repo /opt/dbstudio_portal
```

Then dispatch the `superpowers:code-reviewer` subagent (per the global CLAUDE.md gate). Resolve any BLOCK findings inline. APPROVE WITH CHANGES is the gate's pass condition.

- [ ] **Step 4: Push**

```bash
cd /opt/dbstudio_portal && git push origin main
```

- [ ] **Step 5: Ask the user before final deploy**

If any service-affecting code changed (it did — phase-editor.js, sticky-chrome.js, EJS partials, CSS), confirm with the user before:

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal-pdf.service
sleep 2
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

The `assetVersion` cache-bust will pick up the new JS/CSS automatically — no hard-refresh needed for users on next page load.

---

## Items intentionally NOT in this plan

- Drag-and-drop on touch devices (requires Pointer Events polyfill or hammer.js — out of scope; mobile users can use the overflow menu Move up/down).
- Animated transitions on drop (would interfere with `prefers-reduced-motion`; ship static).
- Visual indicator on the customer timeline for the "current" phase (e.g. pulse on the in_progress dot). v1.1 if requested.
- Inline edit of checklist items from the customer view (read-only on customer side today; out of scope).
- Calendar / date-range picker UI on the admin date inputs (native `<input type="date">` is enough; the user explicitly asked for "specify own start dates" — picker UI is browser-native).

---

## Self-Review Checklist

**1. Spec coverage:** Every section of the spec has at least one task.
- Schema (no migration) ✓ (Task 1, 2 — in-place semantics)
- Service-layer changes ✓ (Task 1: changeStatus override; Task 2: setPhaseDates; Task 5: setPhaseOrder)
- Routes ✓ (Task 2: /dates; Task 5: /set-order)
- Admin UI date inputs ✓ (Task 2 Step 6)
- Customer timeline partials ✓ (Task 3: 3 new partials + show.ejs replacement)
- CSS class set ✓ (Task 3 Step 7 — full customer-timeline__* block)
- Mobile reflow ✓ (Task 3 Step 7 — `@media (max-width: 640px)`)
- Copy strings ✓ (Task 3 Steps 2-4)
- Empty state ✓ (Task 3 Step 2)
- 30+ items handling: Outstanding / Completed split ✓ (Task 3 Step 4)
- Subtabs cutoff (out of spec but folded into plan per user request) ✓ (Task 4)
- Drag-to-reorder (out of spec but folded in per user request) ✓ (Task 5)

**2. Placeholder scan:** No TBD / TODO / "fill in details" / vague-error-handling. Every code step shows the exact code or a precise diff target.

**3. Type consistency:**
- `setPhaseDates({ phaseId, customerId }, { startedAt, completedAt })` — same in service (Task 2 Step 3), route (Task 2 Step 5), tests (Task 2 Step 1).
- `setPhaseOrder({ phaseId, customerId }, { targetIndex })` — same in service (Task 5 Step 3), route (Task 5 Step 5), tests (Task 5 Step 1).
- Error codes: `CROSS_CUSTOMER`, `PHASE_ORDER_OUT_OF_RANGE`, `PHASE_DATE_INVALID`, `PHASE_DATE_RANGE_INVALID` — all consistent across uses.
- `display_order` always 0-indexed. `targetIndex` always 0-indexed. No off-by-one between service and route.
