# Phases + Checklists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-project phases + checklists feature per design spec `docs/superpowers/specs/2026-05-03-phases-checklists-design.md`. Admin manages phases (free-form labels, sparse `display_order`, four-state status enum, up/down reorder) and checklists (CRUD + done-toggle + per-item `visible_to_customer`). Customer reads phases on a new project detail page and sees relevant events in their activity feed and digest.

**Architecture:** Two new domain modules (`domain/phases/`, `domain/phase-checklists/`) with raw-SQL repos and transactional services. Admin extends `views/admin/projects/detail.ejs` plus two new admin route files. Customer gets a brand-new `views/customer/projects/show.ejs` plus a route. Audit rows are written with `visible_to_customer` baked at write time (per Decision 8); the activity feed and digest both honor it automatically. Digest event taxonomy extends `lib/digest-strings.js` and adds `phase_checklist.toggled` to `COALESCING_EVENTS` in `lib/digest.js`. Migration `0013_phases_and_checklists.sql`. **One small change to `lib/activity-feed.js` is required**: extend `SAFE_METADATA_KEYS` to allow `phaseId`, `itemId`, `phaseLabel`, `itemLabel`, `from`, `to`, `done`, `oldLabel`, `newLabel`, `wasVisible`, `parentStatusAtDelete`, `statusAtDelete`, `swappedWith` — without that the customer activity feed strips these fields from phase/checklist audit metadata (Codex review BLOCK #6).

**Tech Stack:** Node 20.19, Postgres (raw SQL templates `sql\`…\`.execute(db)` for repo queries; Kysely `db.insertInto(...)` for `writeAudit` per existing convention), Fastify, EJS, vitest. UUIDv7 PKs (`import { v7 as uuidv7 } from 'uuid'`). CSP-strict views (no inline JS).

**Process gates (per `~/.claude/CLAUDE.md`):** Every code-change task ends with DeepSeek-quick-code (default-on for small/targeted code) + Codex review. UI tasks (admin view extension, customer view) also get Kimi (Instant). No "done" / "approved" wording until Codex APPROVE / APPROVE WITH CHANGES + Kimi APPROVE (or operator waiver).

---

## Pre-flight

- [ ] **Pre-1: Read the design spec** at `docs/superpowers/specs/2026-05-03-phases-checklists-design.md` end-to-end. The "Decisions" table and "Audit taxonomy" table are load-bearing for every later task.
- [ ] **Pre-2: Confirm portal-app group membership.** Run `id portal-app` and `ls -ld /opt/dbstudio_portal/domain`. The PostToolUse hook re-chgrps after each Edit/Write but verify before starting in case the hook is missing.
- [ ] **Pre-3: Confirm the working tree is clean enough.** Run `cd /opt/dbstudio_portal && git status`. Existing review-artefact churn under `.reviews/` is expected and ignored. No source-tree files should be modified before this plan starts.
- [ ] **Pre-4: Stop the portal service before touching tests.** Per RUNBOOK ("Integration tests — stopping portal.service"), every integration test run must go through `sudo bash /opt/dbstudio_portal/scripts/run-tests.sh`. That wrapper stops `portal.service` for the run and restarts it after.

---

## Phase A — Foundation (migration + repos + services)

### Task A0: Extend `lib/activity-feed.js` SAFE_METADATA_KEYS allow-list

**Files:**
- Modify: `lib/activity-feed.js`

The customer activity feed strips audit metadata through an allow-list (`SAFE_METADATA_KEYS` at lines 11–39). Without adding the new phase/checklist metadata keys, the customer-side feed would silently drop `phaseLabel`, `itemLabel`, `from`, `to`, etc., and the F1 end-to-end test assertions on `metadata.from`, `metadata.to`, and `metadata.itemLabel` would all be `undefined`. Add them up-front so every later task can rely on the field.

- [ ] **A0.1 — Append the new keys.**

In `lib/activity-feed.js`, extend the `SAFE_METADATA_KEYS` Set:

```javascript
const SAFE_METADATA_KEYS = new Set([
  'customerId',
  'provider',
  'label',
  'previousLabel',
  'payloadChanged',
  'createdBy',
  'requestId',
  'credentialId',
  'fieldCount',
  'reason',
  // M9 additions — name + email + 2FA + sessions + projects + ndas/docs.
  'previousName',
  'newName',
  'oldEmail',
  'newEmail',
  'restoredEmail',
  'undoneEmail',
  'proof',
  'previousStatus',
  'newStatus',
  'projectId',
  'ndaId',
  'documentId',
  'revokedCount',
  // Post-Phase-G additions — phases + checklists feature.
  'phaseId',
  'itemId',
  'phaseLabel',
  'itemLabel',
  'oldLabel',
  'newLabel',
  'from',
  'to',
  'done',
  'wasVisible',
  'parentStatusAtDelete',
  'statusAtDelete',
  'swappedWith',
]);
```

- [ ] **A0.2 — Restart and run full suite.**

```bash
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: still green. The allow-list extension is additive — no existing test reads any of these keys, so nothing breaks.

- [ ] **A0.3 — Commit.**

```bash
cd /opt/dbstudio_portal
git add lib/activity-feed.js
git commit -m "$(cat <<'EOF'
feat(activity-feed): extend SAFE_METADATA_KEYS for phases + checklists

Allow phase/checklist metadata fields (phaseId, itemId, phaseLabel,
itemLabel, from, to, done, oldLabel, newLabel, statusAtDelete,
parentStatusAtDelete, wasVisible, swappedWith) through the customer
activity-feed allow-list. Without this, the customer slice drops
these fields and the customer-facing render of phase/checklist
events shows only the action name.

Plan: docs/superpowers/plans/2026-05-03-phases-checklists-implementation.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A1: Migration `0013_phases_and_checklists.sql`

**Files:**
- Create: `migrations/0013_phases_and_checklists.sql`

- [ ] **A1.1 — Write the migration file.**

Create `migrations/0013_phases_and_checklists.sql`:

```sql
-- Phase G (post-G4): per-project phases + checklists.
--
-- Phases are admin-managed milestones inside a project (e.g. "0", "0.5",
-- "1", "1.5", "Discovery"). Each phase has a status enum and an optional
-- list of checklist items; items can be admin-only or customer-visible.
--
-- Customer-side visibility (decision 4 of the design spec) is enforced
-- by:
--   (a) the route layer for the customer project detail page (only
--       phases where status != 'not_started' are loaded), AND
--   (b) the visible_to_customer flag baked into each audit_log row at
--       write time using phaseVisible(status) ≡ status IN
--       ('in_progress','blocked','done').
--
-- All audit rows for this feature carry metadata.customerId so the
-- existing lib/activity-feed.js filter (visible_to_customer = TRUE
-- AND metadata->>'customerId' = X) picks them up without modification.

CREATE TABLE project_phases (
  id            UUID        PRIMARY KEY,
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         TEXT        NOT NULL,
  display_order INTEGER     NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'not_started'
                            CHECK (status IN ('not_started','in_progress','blocked','done')),
  started_at    TIMESTAMPTZ NULL,
  completed_at  TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_phases_label_unique
    UNIQUE (project_id, label),
  CONSTRAINT project_phases_order_unique
    UNIQUE (project_id, display_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_project_phases_project_order
  ON project_phases (project_id, display_order);

CREATE TABLE phase_checklist_items (
  id                   UUID        PRIMARY KEY,
  phase_id             UUID        NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
  label                TEXT        NOT NULL,
  display_order        INTEGER     NOT NULL,
  visible_to_customer  BOOLEAN     NOT NULL DEFAULT TRUE,
  done_at              TIMESTAMPTZ NULL,
  done_by_admin_id     UUID        NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phase_checklist_items_order_unique
    UNIQUE (phase_id, display_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_phase_checklist_items_phase_order
  ON phase_checklist_items (phase_id, display_order);
```

- [ ] **A1.2 — Apply the migration.**

Migrations run on portal startup via `migrations/runner.js`. Apply by restarting the portal service:

```bash
sudo systemctl restart portal-pdf.service
sleep 2
sudo systemctl restart portal.service
sudo journalctl -u portal.service -n 50 --no-pager | grep migrated
```

Expected: `migrated: 0013_phases_and_checklists.sql` in the journal.

- [ ] **A1.3 — Verify the schema.**

```bash
sudo -u postgres psql portal_db -c '\d project_phases'
sudo -u postgres psql portal_db -c '\d phase_checklist_items'
sudo -u postgres psql portal_db -c "SELECT name FROM _migrations WHERE name LIKE '0013%';"
```

Expected output: both tables described, indexes present, `_migrations` shows the row.

- [ ] **A1.4 — Smoke test passes.**

```bash
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

Expected: 5/5 green.

- [ ] **A1.5 — Commit.**

```bash
cd /opt/dbstudio_portal
git add migrations/0013_phases_and_checklists.sql
git commit -m "$(cat <<'EOF'
feat(phases): migration 0013 — project_phases + phase_checklist_items

Two new tables for the per-project phases + checklists feature. Both
use UUIDv7 PKs (app-side), CASCADE on the parent FK, DEFERRABLE
unique constraints on display_order so transactional swap-by-update
works without intermediate constraint trips. UNIQUE (project_id, label)
on phases catches accidental duplicate labels within a project.

Schema only — no service or UI yet. Existing projects start with
zero phases (no backfill).

Spec: docs/superpowers/specs/2026-05-03-phases-checklists-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: Phases repo

**Files:**
- Create: `domain/phases/repo.js`
- Create: `tests/integration/phases/repo.test.js`
- Create: `tests/integration/phases/_helpers.js`

The repo is a thin wrapper over raw SQL. All functions take `db` (or a `tx` from `db.transaction()`) as the first arg and accept plain JS objects. No business logic — all that goes in `service.js`.

Functions to implement:
- `findPhaseById(db, id)` — single phase or null.
- `listPhasesByProject(db, projectId)` — ordered by display_order ASC.
- `findPhaseByLabel(db, projectId, label)` — for uniqueness check at the service layer.
- `findMaxDisplayOrder(db, projectId)` — for next-insert position (`COALESCE(MAX, 0) + 100`).
- `findPhaseAtOrder(db, projectId, order)` — for reorder swap.
- `insertPhase(db, { id, projectId, label, displayOrder, status, startedAt, completedAt })`.
- `updatePhaseLabel(db, id, label)`.
- `setPhaseStatus(db, id, { status, startedAt, completedAt })`.
- `setPhaseDisplayOrder(db, id, displayOrder)` — single-row update; the swap is two calls in a tx.
- `deletePhase(db, id)`.

- [ ] **A2.1 — Write the test helper file.**

Create `tests/integration/phases/_helpers.js`:

```javascript
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import * as customersService from '../../../domain/customers/service.js';
import * as adminsService from '../../../domain/admins/service.js';

export function makeTag() {
  return `phasestest_${randomBytes(4).toString('hex')}`;
}

// customers.create + admins.create both require ctx.kek (32-byte Buffer)
// and ctx.portalBaseUrl (string). Without these the service throws at
// the top of create() — see domain/customers/service.js:53-58.
export function baseCtx(tag) {
  return {
    actorType: 'system',
    audit: { tag, reason: 'test' },
    ip: '127.0.0.1',
    userAgentHash: 'test',
    kek: randomBytes(32),
    portalBaseUrl: 'https://portal.test',
  };
}

export async function makeAdmin(db, tag, suffix = 'a') {
  const created = await adminsService.create(db, {
    email: `${tag}+${suffix}-admin@example.com`,
    name: `Admin ${suffix}`,
  }, baseCtx(tag));
  return created.id;
}

export async function makeCustomerAndProject(db, tag, suffix = 'a') {
  const customer = await customersService.create(db, {
    razonSocial: `${tag} ${suffix} S.L.`,
    primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}-user@example.com` },
  }, baseCtx(tag));
  const projectId = uuidv7();
  await sql`
    INSERT INTO projects (id, customer_id, name, status)
    VALUES (${projectId}::uuid, ${customer.customerId}::uuid, ${'Test Project ' + suffix}, 'active')
  `.execute(db);
  return { customerId: customer.customerId, primaryUserId: customer.primaryUserId, projectId };
}

export async function cleanupByTag(db, tag) {
  // Phase rows cascade via project deletion; clean projects + customers.
  await sql`DELETE FROM project_phases WHERE project_id IN (
    SELECT p.id FROM projects p JOIN customers c ON c.id = p.customer_id WHERE c.razon_social LIKE ${tag + '%'}
  )`.execute(db);
  await sql`DELETE FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
  await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
  await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
  await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
  await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
}
```

(`adminsService.create` may have a different signature — verify against the actual file. The customer-side ctx requirements are confirmed in `domain/customers/service.js:53-58`.)

- [ ] **A2.2 — Write failing tests for the repo.**

Create `tests/integration/phases/repo.test.js`:

```javascript
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesRepo from '../../../domain/phases/repo.js';
import { makeTag, makeCustomerAndProject, cleanupByTag } from './_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('domain/phases/repo', () => {
  const tag = makeTag();
  let db;
  let projectId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    const ctx = await makeCustomerAndProject(db, tag, 'a');
    projectId = ctx.projectId;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  it('listPhasesByProject returns empty array for a project with no phases', async () => {
    const rows = await phasesRepo.listPhasesByProject(db, projectId);
    expect(rows).toEqual([]);
  });

  it('insertPhase + findPhaseById round-trip', async () => {
    const id = uuidv7();
    await phasesRepo.insertPhase(db, {
      id, projectId, label: '1', displayOrder: 100, status: 'not_started',
      startedAt: null, completedAt: null,
    });
    const row = await phasesRepo.findPhaseById(db, id);
    expect(row.id).toBe(id);
    expect(row.label).toBe('1');
    expect(row.display_order).toBe(100);
    expect(row.status).toBe('not_started');
  });

  it('findMaxDisplayOrder returns 0 for empty project, then 100, then 200', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'b');
    expect(await phasesRepo.findMaxDisplayOrder(db, ctx.projectId)).toBe(0);
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '0', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    expect(await phasesRepo.findMaxDisplayOrder(db, ctx.projectId)).toBe(100);
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '1', displayOrder: 200, status: 'not_started', startedAt: null, completedAt: null });
    expect(await phasesRepo.findMaxDisplayOrder(db, ctx.projectId)).toBe(200);
  });

  it('listPhasesByProject orders by display_order ASC', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'c');
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '2', displayOrder: 300, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '0', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '1', displayOrder: 200, status: 'not_started', startedAt: null, completedAt: null });
    const rows = await phasesRepo.listPhasesByProject(db, ctx.projectId);
    expect(rows.map(r => r.label)).toEqual(['0', '1', '2']);
  });

  it('UNIQUE (project_id, label) rejects duplicate label', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'd');
    await phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '0.5', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await expect(
      phasesRepo.insertPhase(db, { id: uuidv7(), projectId: ctx.projectId, label: '0.5', displayOrder: 200, status: 'not_started', startedAt: null, completedAt: null })
    ).rejects.toThrow(/project_phases_label_unique/);
  });

  it('updatePhaseLabel updates the label', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'e');
    const id = uuidv7();
    await phasesRepo.insertPhase(db, { id, projectId: ctx.projectId, label: 'old', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.updatePhaseLabel(db, id, 'new');
    const row = await phasesRepo.findPhaseById(db, id);
    expect(row.label).toBe('new');
  });

  it('setPhaseStatus updates status + timestamps', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'f');
    const id = uuidv7();
    await phasesRepo.insertPhase(db, { id, projectId: ctx.projectId, label: '1', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    const startedAt = new Date('2026-05-03T12:00:00Z');
    await phasesRepo.setPhaseStatus(db, id, { status: 'in_progress', startedAt, completedAt: null });
    const row = await phasesRepo.findPhaseById(db, id);
    expect(row.status).toBe('in_progress');
    expect(row.started_at?.toISOString()).toBe(startedAt.toISOString());
    expect(row.completed_at).toBeNull();
  });

  it('deferred unique on (project_id, display_order) allows transactional swap', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'g');
    const idA = uuidv7();
    const idB = uuidv7();
    await phasesRepo.insertPhase(db, { id: idA, projectId: ctx.projectId, label: 'A', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.insertPhase(db, { id: idB, projectId: ctx.projectId, label: 'B', displayOrder: 200, status: 'not_started', startedAt: null, completedAt: null });
    await db.transaction().execute(async (tx) => {
      await phasesRepo.setPhaseDisplayOrder(tx, idA, 200);
      await phasesRepo.setPhaseDisplayOrder(tx, idB, 100);
    });
    const rows = await phasesRepo.listPhasesByProject(db, ctx.projectId);
    expect(rows.map(r => r.label)).toEqual(['B', 'A']);
  });

  it('deletePhase removes the row', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'h');
    const id = uuidv7();
    await phasesRepo.insertPhase(db, { id, projectId: ctx.projectId, label: '1', displayOrder: 100, status: 'not_started', startedAt: null, completedAt: null });
    await phasesRepo.deletePhase(db, id);
    expect(await phasesRepo.findPhaseById(db, id)).toBeNull();
  });
});
```

- [ ] **A2.3 — Run tests, expect FAIL with module-not-found.**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/repo.test.js
```

Expected: errors like `Cannot find module 'domain/phases/repo.js'`.

- [ ] **A2.4 — Implement the repo.**

Create `domain/phases/repo.js`:

```javascript
import { sql } from 'kysely';

export async function findPhaseById(db, id) {
  const r = await sql`SELECT * FROM project_phases WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function listPhasesByProject(db, projectId) {
  const r = await sql`
    SELECT * FROM project_phases
     WHERE project_id = ${projectId}::uuid
     ORDER BY display_order ASC
  `.execute(db);
  return r.rows;
}

export async function findPhaseByLabel(db, projectId, label) {
  const r = await sql`
    SELECT * FROM project_phases
     WHERE project_id = ${projectId}::uuid AND label = ${label}
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function findMaxDisplayOrder(db, projectId) {
  const r = await sql`
    SELECT COALESCE(MAX(display_order), 0)::int AS max
      FROM project_phases
     WHERE project_id = ${projectId}::uuid
  `.execute(db);
  return Number(r.rows[0]?.max ?? 0);
}

export async function findPhaseAtOrder(db, projectId, order) {
  const r = await sql`
    SELECT * FROM project_phases
     WHERE project_id = ${projectId}::uuid AND display_order = ${order}
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function insertPhase(db, { id, projectId, label, displayOrder, status, startedAt, completedAt }) {
  await sql`
    INSERT INTO project_phases (id, project_id, label, display_order, status, started_at, completed_at)
    VALUES (${id}::uuid, ${projectId}::uuid, ${label}, ${displayOrder}, ${status}, ${startedAt}, ${completedAt})
  `.execute(db);
}

export async function updatePhaseLabel(db, id, label) {
  await sql`
    UPDATE project_phases
       SET label = ${label}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setPhaseStatus(db, id, { status, startedAt, completedAt }) {
  await sql`
    UPDATE project_phases
       SET status = ${status},
           started_at = ${startedAt},
           completed_at = ${completedAt},
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setPhaseDisplayOrder(db, id, displayOrder) {
  await sql`
    UPDATE project_phases
       SET display_order = ${displayOrder}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function deletePhase(db, id) {
  await sql`DELETE FROM project_phases WHERE id = ${id}::uuid`.execute(db);
}
```

- [ ] **A2.5 — Run tests, expect PASS.**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/repo.test.js
```

Expected: all tests green.

- [ ] **A2.6 — DeepSeek pass on the repo.**

```bash
deepseek-quick-code --repo /opt/dbstudio_portal --task "Review domain/phases/repo.js for raw-SQL hygiene, parametrization, and any divergence from the credentials repo style at domain/credentials/repo.js. Suggest only changes that are clearly improvements; reject scope creep."
```

Read the artefact at `.reviews/deepseek-quick-code.md`. Apply any accepted patches via `external-ai-apply-patch`. Re-run tests.

- [ ] **A2.7 — Commit.**

```bash
cd /opt/dbstudio_portal
git add domain/phases/repo.js tests/integration/phases/_helpers.js tests/integration/phases/repo.test.js
git commit -m "$(cat <<'EOF'
feat(phases): repo + integration tests for project_phases

Raw-SQL repo functions for the project_phases table: find by id /
label / max-order, list by project (ordered by display_order),
insert, update label / status (with timestamps) / display_order,
delete. Tests cover insert, list, max-order math, label uniqueness,
deferred display_order swap inside a transaction, and delete.

No service or audit logic yet — that's Task A3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3: Phases service

**Files:**
- Create: `domain/phases/service.js`
- Create: `tests/integration/phases/service.test.js`

Service responsibilities (per Decisions 3, 5, 7, 8):
- `phaseVisible(status) ≡ status !== 'not_started'` — local helper used to compute `visible_to_customer` on every audit row this service writes.
- `create(db, { projectId, customerId, label }, ctx, { adminId })` — inserts a new phase at `findMaxDisplayOrder + 100`, status `not_started`. Audit `phase.created` with `visible_to_customer = phaseVisible('not_started') = false`. Fan out to admins as `'fyi'`. Customer is NOT fanned out (status is not_started → invisible).
- `rename(db, { phaseId, customerId }, { label }, ctx, { adminId })` — updates label. Validates uniqueness (`findPhaseByLabel`). Audit `phase.renamed` with `visible_to_customer = phaseVisible(currentStatus)`. Fan out to admins always; to customer iff visible.
- `reorder(db, { phaseId, customerId }, { direction: 'up' | 'down' }, ctx, { adminId })` — finds neighbour at `display_order ± 100` (or the next existing phase in the requested direction), swaps both display_order in a transaction (DEFERRABLE constraint allows). Audit `phase.reordered` with `visible_to_customer = false` (per Decision 7, admin-only). Fan out to admins only.
- `changeStatus(db, { phaseId, customerId }, { newStatus }, ctx, { adminId })` — updates status + timestamps. `started_at` written on first `not_started → in_progress`. `completed_at` written on `→ done`, cleared on `done → in_progress` (or any other transition out of done). Audit `phase.status_changed` with `visible_to_customer = phaseVisible(newStatus)` and metadata `{ from, to }`. Fan out to admins always; to customer iff visible.
- `delete(db, { phaseId, customerId }, ctx, { adminId })` — deletes the row (CASCADE removes checklist items). Audit `phase.deleted` with `visible_to_customer = phaseVisible(statusAtDelete)`, metadata `{ phaseLabel }`. Fan out symmetric.

For digest fan-out, each event resolves the customer's `razon_social` and the active admins via existing helpers (`listActiveAdmins`, `findCustomerById`). Use `recordForDigest` from `lib/digest.js` with bucket `'fyi'` for everything in v1 (operator can promote `phase.status_changed → blocked` to `'action'` later — flagged in spec's open items).

- [ ] **A3.1 — Write the failing service test.**

Create `tests/integration/phases/service.test.js`:

```javascript
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesService from '../../../domain/phases/service.js';
import * as phasesRepo from '../../../domain/phases/repo.js';
import { makeTag, makeAdmin, makeCustomerAndProject, baseCtx, cleanupByTag } from './_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('domain/phases/service', () => {
  const tag = makeTag();
  let db;
  let adminId;
  let customerId;
  let projectId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'a');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  async function getAuditRowsFor(action) {
    const r = await sql`
      SELECT * FROM audit_log
       WHERE action = ${action} AND metadata->>'tag' = ${tag}
       ORDER BY ts ASC
    `.execute(db);
    return r.rows;
  }

  it('create writes a not_started phase + admin-only audit + admin digest fan-out', async () => {
    const { phaseId } = await phasesService.create(
      db,
      { projectId, customerId, label: '1' },
      { ...baseCtx(tag), actorType: 'admin' },
      { adminId },
    );
    const row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.label).toBe('1');
    expect(row.status).toBe('not_started');
    expect(row.display_order).toBe(100);

    const auditRows = await getAuditRowsFor('phase.created');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].visible_to_customer).toBe(false);
    expect(auditRows[0].metadata.customerId).toBe(customerId);
    expect(auditRows[0].metadata.projectId).toBe(projectId);
    expect(auditRows[0].metadata.phaseId).toBe(phaseId);
  });

  it('changeStatus not_started → in_progress writes started_at, customer-visible audit, customer digest fan-out', async () => {
    const { phaseId } = await phasesService.create(db, { projectId, customerId, label: '2' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.status).toBe('in_progress');
    expect(row.started_at).not.toBeNull();
    expect(row.completed_at).toBeNull();

    const auditRows = await getAuditRowsFor('phase.status_changed');
    const lastForThisPhase = auditRows.filter(a => a.metadata.phaseId === phaseId).pop();
    expect(lastForThisPhase.visible_to_customer).toBe(true);
    expect(lastForThisPhase.metadata.from).toBe('not_started');
    expect(lastForThisPhase.metadata.to).toBe('in_progress');

    // Customer digest item
    const digestRows = await sql`
      SELECT * FROM pending_digest_items
       WHERE event_type = 'phase.status_changed'
         AND recipient_type = 'customer'
         AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(digestRows.rows.length).toBeGreaterThan(0);
  });

  it('changeStatus in_progress → done writes completed_at; → in_progress again clears it', async () => {
    const { phaseId } = await phasesService.create(db, { projectId, customerId, label: '3' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'done' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    let row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.completed_at).not.toBeNull();
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    row = await phasesRepo.findPhaseById(db, phaseId);
    expect(row.completed_at).toBeNull();
  });

  it('changeStatus → not_started is admin-only audit (visible_to_customer = false)', async () => {
    const { phaseId } = await phasesService.create(db, { projectId, customerId, label: '4' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'not_started' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const auditRows = await getAuditRowsFor('phase.status_changed');
    const lastForThisPhase = auditRows.filter(a => a.metadata.phaseId === phaseId).pop();
    expect(lastForThisPhase.metadata.to).toBe('not_started');
    expect(lastForThisPhase.visible_to_customer).toBe(false);
  });

  it('rename with duplicate label rejects', async () => {
    const a = await phasesService.create(db, { projectId, customerId, label: '5' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.create(db, { projectId, customerId, label: '6' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await expect(
      phasesService.rename(db, { phaseId: a.phaseId, customerId },
        { label: '6' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId }),
    ).rejects.toThrow();
  });

  it('reorder swaps display_order with neighbour and writes admin-only audit', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'reorder');
    const a = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'A' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const b = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'B' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.reorder(db, { phaseId: a.phaseId, customerId: ctx.customerId },
      { direction: 'down' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await phasesRepo.listPhasesByProject(db, ctx.projectId);
    expect(rows.map(r => r.label)).toEqual(['B', 'A']);

    const auditRows = await getAuditRowsFor('phase.reordered');
    const last = auditRows.filter(r => r.metadata.phaseId === a.phaseId).pop();
    expect(last.visible_to_customer).toBe(false);
  });

  it('delete on a customer-visible phase writes a customer-visible audit; on not_started phase writes admin-only audit', async () => {
    const ctx = await makeCustomerAndProject(db, tag, 'del');
    const visible = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'V' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.changeStatus(db, { phaseId: visible.phaseId, customerId: ctx.customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.delete(db, { phaseId: visible.phaseId, customerId: ctx.customerId },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const hidden = await phasesService.create(db, { projectId: ctx.projectId, customerId: ctx.customerId, label: 'H' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await phasesService.delete(db, { phaseId: hidden.phaseId, customerId: ctx.customerId },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    const auditRows = await getAuditRowsFor('phase.deleted');
    const visibleAudit = auditRows.find(r => r.metadata.phaseLabel === 'V');
    const hiddenAudit = auditRows.find(r => r.metadata.phaseLabel === 'H');
    expect(visibleAudit.visible_to_customer).toBe(true);
    expect(hiddenAudit.visible_to_customer).toBe(false);
  });
});
```

- [ ] **A3.2 — Run tests, expect FAIL with module-not-found.**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/service.test.js
```

Expected: errors like `Cannot find module 'domain/phases/service.js'`.

- [ ] **A3.3 — Implement the service.**

Create `domain/phases/service.js`:

```javascript
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import { listActiveAdmins, listActiveCustomerUsers } from '../../lib/digest-fanout.js';
import * as repo from './repo.js';

const VALID_STATUSES = new Set(['not_started', 'in_progress', 'blocked', 'done']);
const STATUS_GAP = 100;

export class PhaseNotFoundError extends Error {
  constructor() { super('phase not found'); this.code = 'PHASE_NOT_FOUND'; }
}
export class PhaseLabelConflictError extends Error {
  constructor() { super('phase label already used in this project'); this.code = 'PHASE_LABEL_CONFLICT'; }
}
export class PhaseInvalidStatusError extends Error {
  constructor() { super('invalid status'); this.code = 'PHASE_INVALID_STATUS'; }
}
export class PhaseReorderEdgeError extends Error {
  constructor() { super('phase already at edge'); this.code = 'PHASE_REORDER_EDGE'; }
}

export function phaseVisible(status) {
  return status === 'in_progress' || status === 'blocked' || status === 'done';
}

function baseAuditMetadata(ctx) {
  return ctx?.audit ?? {};
}

async function findCustomerName(db, customerId) {
  const r = await sql`SELECT razon_social FROM customers WHERE id = ${customerId}::uuid`.execute(db);
  return r.rows[0]?.razon_social ?? null;
}

async function fanOut(tx, {
  customerId,
  projectId,
  phaseId,
  eventType,
  visibleToCustomer,
  varsForAdmin,
  varsForCustomer,
  linkAdmin,
  linkCustomer,
  bucket = 'fyi',
}) {
  // listActiveAdmins / listActiveCustomerUsers come from lib/digest-fanout.js
  // and return { id, name, email, locale }. Admin-side has no status column
  // (every admin is "active"); customer_users active-ness is gated on
  // parent customers.status = 'active' — both implemented in that module.
  const admins = await listActiveAdmins(tx);
  for (const a of admins) {
    await recordForDigest(tx, {
      recipientType: 'admin',
      recipientId: a.id,
      customerId,
      bucket,
      eventType,
      title: titleFor(eventType, a.locale, varsForAdmin),
      linkPath: linkAdmin,
      metadata: { customerId, projectId, phaseId },
      vars: varsForAdmin,
      locale: a.locale,
    });
  }
  if (!visibleToCustomer) return;
  const users = await listActiveCustomerUsers(tx, customerId);
  for (const u of users) {
    await recordForDigest(tx, {
      // The pending_digest_items / digest_schedules CHECK constraint
      // restricts recipient_type to 'customer_user' or 'admin' (see
      // migrations/0010_digest_and_payments.sql). DO NOT use 'customer'.
      recipientType: 'customer_user',
      recipientId: u.id,
      customerId,
      bucket,
      eventType,
      title: titleFor(eventType, u.locale, varsForCustomer),
      linkPath: linkCustomer,
      metadata: { customerId, projectId, phaseId },
      vars: varsForCustomer,
      locale: u.locale,
    });
  }
}

export async function create(db, { projectId, customerId, label }, ctx, { adminId }) {
  if (typeof label !== 'string' || !label.trim()) {
    throw new Error('label required');
  }
  const labelTrimmed = label.trim();
  return await db.transaction().execute(async (tx) => {
    const conflict = await repo.findPhaseByLabel(tx, projectId, labelTrimmed);
    if (conflict) throw new PhaseLabelConflictError();

    const max = await repo.findMaxDisplayOrder(tx, projectId);
    const phaseId = uuidv7();
    await repo.insertPhase(tx, {
      id: phaseId, projectId, label: labelTrimmed,
      displayOrder: max + STATUS_GAP, status: 'not_started',
      startedAt: null, completedAt: null,
    });

    const customerName = await findCustomerName(tx, customerId);
    const visibleToCustomer = phaseVisible('not_started'); // = false
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.created',
      targetType: 'project_phase', targetId: phaseId,
      metadata: { ...baseAuditMetadata(ctx), customerId, projectId, phaseId, phaseLabel: labelTrimmed },
      visibleToCustomer,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId, phaseId,
      eventType: 'phase.created',
      visibleToCustomer,
      varsForAdmin: { customerName, phaseLabel: labelTrimmed, recipient: 'admin' },
      varsForCustomer: { phaseLabel: labelTrimmed, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${projectId}`,
      linkCustomer: `/customer/projects/${projectId}`,
    });

    return { phaseId };
  });
}

export async function rename(db, { phaseId, customerId }, { label }, ctx, { adminId }) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('label required');
  const labelTrimmed = label.trim();
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    const conflict = await repo.findPhaseByLabel(tx, phase.project_id, labelTrimmed);
    if (conflict && conflict.id !== phaseId) throw new PhaseLabelConflictError();
    await repo.updatePhaseLabel(tx, phaseId, labelTrimmed);

    const customerName = await findCustomerName(tx, customerId);
    const visibleToCustomer = phaseVisible(phase.status);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.renamed',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...baseAuditMetadata(ctx), customerId,
        projectId: phase.project_id, phaseId,
        oldLabel: phase.label, newLabel: labelTrimmed,
      },
      visibleToCustomer,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId,
      eventType: 'phase.renamed',
      visibleToCustomer,
      varsForAdmin: { customerName, oldLabel: phase.label, newLabel: labelTrimmed, recipient: 'admin' },
      varsForCustomer: { oldLabel: phase.label, newLabel: labelTrimmed, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

export async function reorder(db, { phaseId, customerId }, { direction }, ctx, { adminId }) {
  if (direction !== 'up' && direction !== 'down') throw new Error('direction must be up or down');
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    const all = await repo.listPhasesByProject(tx, phase.project_id);
    const idx = all.findIndex(p => p.id === phaseId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= all.length) throw new PhaseReorderEdgeError();
    const neighbour = all[swapIdx];

    await repo.setPhaseDisplayOrder(tx, phaseId, neighbour.display_order);
    await repo.setPhaseDisplayOrder(tx, neighbour.id, phase.display_order);

    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.reordered',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...baseAuditMetadata(ctx), customerId,
        projectId: phase.project_id, phaseId,
        from: phase.display_order, to: neighbour.display_order,
        swappedWith: neighbour.id,
      },
      visibleToCustomer: false, // admin-only per Decision 7
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    // Admin-only fan-out (no customer leg) — phase.reordered is admin-only
    // per spec Decision 7.
    const admins = await listActiveAdmins(tx);
    const customerName = await findCustomerName(tx, customerId);
    for (const a of admins) {
      await recordForDigest(tx, {
        recipientType: 'admin',
        recipientId: a.id,
        customerId,
        bucket: 'fyi',
        eventType: 'phase.reordered',
        title: titleFor('phase.reordered', a.locale, { customerName, phaseLabel: phase.label }),
        linkPath: `/admin/customers/${customerId}/projects/${phase.project_id}`,
        metadata: { customerId, projectId: phase.project_id, phaseId },
        vars: { customerName, phaseLabel: phase.label },
        locale: a.locale,
      });
    }

    return {};
  });
}

export async function changeStatus(db, { phaseId, customerId }, { newStatus }, ctx, { adminId }) {
  if (!VALID_STATUSES.has(newStatus)) throw new PhaseInvalidStatusError();
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    if (phase.status === newStatus) return {};

    const now = new Date();
    let startedAt = phase.started_at;
    let completedAt = phase.completed_at;
    if (newStatus === 'in_progress') {
      if (!startedAt) startedAt = now;
      completedAt = null;
    } else if (newStatus === 'done') {
      completedAt = now;
    } else if (newStatus === 'not_started') {
      startedAt = null;
      completedAt = null;
    } else if (newStatus === 'blocked') {
      // keep started_at; clear completed_at
      completedAt = null;
    }
    await repo.setPhaseStatus(tx, phaseId, { status: newStatus, startedAt, completedAt });

    const customerName = await findCustomerName(tx, customerId);
    const visibleToCustomer = phaseVisible(newStatus);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.status_changed',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...baseAuditMetadata(ctx), customerId,
        projectId: phase.project_id, phaseId, phaseLabel: phase.label,
        from: phase.status, to: newStatus,
      },
      visibleToCustomer,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId,
      eventType: 'phase.status_changed',
      visibleToCustomer,
      varsForAdmin: { customerName, phaseLabel: phase.label, from: phase.status, to: newStatus, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, from: phase.status, to: newStatus, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

export async function deletePhaseService(db, { phaseId, customerId }, ctx, { adminId }) {
  return await db.transaction().execute(async (tx) => {
    const phase = await repo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseNotFoundError();
    const statusAtDelete = phase.status;
    const labelAtDelete = phase.label;
    const projectId = phase.project_id;

    await repo.deletePhase(tx, phaseId);

    const customerName = await findCustomerName(tx, customerId);
    const visibleToCustomer = phaseVisible(statusAtDelete);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase.deleted',
      targetType: 'project_phase', targetId: phaseId,
      metadata: {
        ...baseAuditMetadata(ctx), customerId,
        projectId, phaseId, phaseLabel: labelAtDelete,
        statusAtDelete,
      },
      visibleToCustomer,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId, phaseId,
      eventType: 'phase.deleted',
      visibleToCustomer,
      varsForAdmin: { customerName, phaseLabel: labelAtDelete, recipient: 'admin' },
      varsForCustomer: { phaseLabel: labelAtDelete, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${projectId}`,
      linkCustomer: `/customer/projects/${projectId}`,
    });

    return {};
  });
}

// Re-export with the name the route layer uses (avoid keyword collision).
export { deletePhaseService as delete };
```

> Note: `listActiveAdmins` and `listActiveCustomerUsers` come from `lib/digest-fanout.js` (Phase B helper). Do **not** inline equivalents that query non-existent columns like `admins.deactivated_at`. `findCustomerName` is a tiny one-row SELECT used inside the service — fine to keep inline; if a `domain/customers/repo.js` export with the same shape exists, swap to the import in the Codex pass.

- [ ] **A3.4 — Run tests, expect PASS.**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/service.test.js
```

Expected: all green. If any fail, the most likely cause is `titleFor` returning `eventType` because the new event types aren't in `lib/digest-strings.js` yet — that's intentional; we're testing the audit + digest-row shape, not the rendered title. Phase E will add the strings.

- [ ] **A3.5 — DeepSeek pass on the service.**

```bash
deepseek-quick-code --repo /opt/dbstudio_portal --task "Review domain/phases/service.js. Focus on (a) phaseVisible is computed from the post-event status everywhere it appears, (b) audit_log + recordForDigest writes are inside the same transaction, (c) the listActiveAdmins / findCustomerName helpers don't duplicate existing helpers in domain/admins or domain/customers — point me at the existing helper if there is one. Reject scope creep."
```

Apply accepted patches; re-run service tests.

- [ ] **A3.6 — Codex review for Phase A.**

```bash
codex-review-prompt --repo /opt/dbstudio_portal
```

Then invoke the **superpowers:code-reviewer** skill with the prompt artefact at `.reviews/codex-review-prompt.md`. Save Codex's response to `.reviews/codex-code-review.md`. Resolve every BLOCK before moving to Phase B.

- [ ] **A3.7 — Commit.**

```bash
cd /opt/dbstudio_portal
git add domain/phases/service.js tests/integration/phases/service.test.js
git commit -m "$(cat <<'EOF'
feat(phases): service for project_phases (CRUD + reorder + status transitions)

Service methods: create (default not_started), rename (with label
uniqueness check), reorder (up/down swap inside DEFERRABLE constraint
window), changeStatus (writes started_at on first in_progress and
completed_at on done; clears completed_at on revert), and delete.

Every mutation writes an audit_log row with visible_to_customer
computed via phaseVisible(post-event status) per design Decision 8,
and fans out to active admins always; to customer users only when
visible_to_customer is true. phase.reordered is admin-only per
Decision 7.

The titleFor calls in the digest fan-out resolve to event-type strings
until lib/digest-strings.js gets the new event types in Phase E —
intentional; the audit + digest-row shape is the contract being
exercised in tests at this stage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Admin phase UI

### Task B1: Admin phase routes

**Files:**
- Create: `routes/admin/project-phases.js`
- Modify: `server.js` (register the new route group)

Routes (all GET landing pages render the existing `views/admin/projects/detail.ejs` with phases pre-loaded; POST endpoints redirect back to it):

| Method | Path | Body | Calls |
|---|---|---|---|
| POST | `/admin/customers/:customerId/projects/:projectId/phases` | `{ label }` | `service.create` |
| POST | `/admin/customers/:customerId/projects/:projectId/phases/:phaseId/rename` | `{ label }` | `service.rename` |
| POST | `/admin/customers/:customerId/projects/:projectId/phases/:phaseId/status` | `{ status }` | `service.changeStatus` |
| POST | `/admin/customers/:customerId/projects/:projectId/phases/:phaseId/reorder` | `{ direction: 'up' \| 'down' }` | `service.reorder` |
| POST | `/admin/customers/:customerId/projects/:projectId/phases/:phaseId/delete` | (none) | `service.delete` |

All POSTs use `app.csrfProtection`, reflect-redirect to `/admin/customers/:customerId/projects/:projectId`, and surface `err.code` to a flash message via `req.session.flash` (existing pattern).

- [ ] **B1.1 — Read existing admin route conventions.**

```bash
cat /opt/dbstudio_portal/routes/admin/credentials.js | head -120
grep -n "registerAdminCredentialsRoutes\|app.csrfProtection\|requireAdminSession" /opt/dbstudio_portal/server.js
```

Capture: how `requireAdminSession` is awaited, where flash messages live (`req.session.flash` or similar), the redirect convention.

- [ ] **B1.2 — Create the route file.**

Create `routes/admin/project-phases.js`:

```javascript
import { requireAdminSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { findProjectById } from '../../domain/projects/repo.js';
import { findPhaseById } from '../../domain/phases/repo.js';
import * as phasesService from '../../domain/phases/service.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;

function ctxFromReq(req, session) {
  return {
    actorType: 'admin',
    audit: {},
    ip: req.ip,
    userAgentHash: req.headers['user-agent']
      ? req.headers['user-agent'].slice(0, 64)
      : null,
  };
}

function notFound(req, reply) {
  reply.code(404).send({ error: 'not_found' });
}

function back(reply, customerId, projectId, flash) {
  if (flash) {
    // session-based flash if present; fall back to query param
    return reply.redirect(`/admin/customers/${customerId}/projects/${projectId}?phaseError=${encodeURIComponent(flash)}`, 303);
  }
  return reply.redirect(`/admin/customers/${customerId}/projects/${projectId}`, 303);
}

function flashFromError(err) {
  if (err?.code === 'PHASE_LABEL_CONFLICT') return 'A phase with that label already exists.';
  if (err?.code === 'PHASE_REORDER_EDGE')   return 'That phase is already at the edge.';
  if (err?.code === 'PHASE_INVALID_STATUS') return 'Invalid status.';
  if (err?.code === 'PHASE_NOT_FOUND')      return 'Phase not found.';
  return 'Something went wrong; please try again.';
}

async function loadGuards(app, req, reply) {
  const session = await requireAdminSession(app, req, reply);
  if (!session) return null;
  const { customerId, projectId } = req.params ?? {};
  if (!UUID_RE.test(customerId) || !UUID_RE.test(projectId)) { notFound(req, reply); return null; }
  const customer = await findCustomerById(app.db, customerId);
  if (!customer) { notFound(req, reply); return null; }
  const project = await findProjectById(app.db, projectId);
  if (!project || project.customer_id !== customerId) { notFound(req, reply); return null; }
  return { session, customer, project, adminId: session.user_id };
}

// Variant for routes with :phaseId — also resolves the phase row and 404s
// if it doesn't belong to the URL's project. Defense-in-depth against
// admin URL-tampering. Bake this into the very first ship; do NOT defer
// to a later retrofit (Codex review BLOCK #4).
async function loadGuardsWithPhase(app, req, reply) {
  const base = await loadGuards(app, req, reply);
  if (!base) return null;
  const phaseId = req.params?.phaseId;
  if (!UUID_RE.test(phaseId)) { notFound(req, reply); return null; }
  const phase = await findPhaseById(app.db, phaseId);
  if (!phase || phase.project_id !== base.project.id) { notFound(req, reply); return null; }
  return { ...base, phase };
}

export function registerAdminProjectPhasesRoutes(app) {
  app.post('/admin/customers/:customerId/projects/:projectId/phases', { preHandler: app.csrfProtection }, async (req, reply) => {
    const guards = await loadGuards(app, req, reply);
    if (!guards) return;
    const label = (req.body?.label || '').toString();
    try {
      await phasesService.create(app.db, { projectId: guards.project.id, customerId: guards.customer.id, label }, ctxFromReq(req, guards.session), { adminId: guards.adminId });
    } catch (err) {
      return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
    }
    return back(reply, guards.customer.id, guards.project.id);
  });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/rename', { preHandler: app.csrfProtection }, async (req, reply) => {
    const guards = await loadGuardsWithPhase(app, req, reply);
    if (!guards) return;
    const label = (req.body?.label || '').toString();
    try {
      await phasesService.rename(app.db, { phaseId: guards.phase.id, customerId: guards.customer.id }, { label }, ctxFromReq(req, guards.session), { adminId: guards.adminId });
    } catch (err) {
      return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
    }
    return back(reply, guards.customer.id, guards.project.id);
  });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/status', { preHandler: app.csrfProtection }, async (req, reply) => {
    const guards = await loadGuardsWithPhase(app, req, reply);
    if (!guards) return;
    const newStatus = (req.body?.status || '').toString();
    try {
      await phasesService.changeStatus(app.db, { phaseId: guards.phase.id, customerId: guards.customer.id }, { newStatus }, ctxFromReq(req, guards.session), { adminId: guards.adminId });
    } catch (err) {
      return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
    }
    return back(reply, guards.customer.id, guards.project.id);
  });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/reorder', { preHandler: app.csrfProtection }, async (req, reply) => {
    const guards = await loadGuardsWithPhase(app, req, reply);
    if (!guards) return;
    const direction = (req.body?.direction || '').toString();
    try {
      await phasesService.reorder(app.db, { phaseId: guards.phase.id, customerId: guards.customer.id }, { direction }, ctxFromReq(req, guards.session), { adminId: guards.adminId });
    } catch (err) {
      return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
    }
    return back(reply, guards.customer.id, guards.project.id);
  });

  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/delete', { preHandler: app.csrfProtection }, async (req, reply) => {
    const guards = await loadGuardsWithPhase(app, req, reply);
    if (!guards) return;
    try {
      await phasesService.delete(app.db, { phaseId: guards.phase.id, customerId: guards.customer.id }, ctxFromReq(req, guards.session), { adminId: guards.adminId });
    } catch (err) {
      return back(reply, guards.customer.id, guards.project.id, flashFromError(err));
    }
    return back(reply, guards.customer.id, guards.project.id);
  });
}
```

(If `findProjectById` doesn't exist in `domain/projects/repo.js`, replace the import with an inline `sql\`SELECT * FROM projects WHERE id = ${projectId}::uuid\`` query, mirroring the auth-loader inline patterns.)

- [ ] **B1.3 — Register the route group in server.js.**

```bash
grep -n "registerAdmin.*Routes\|registerCustomer.*Routes" /opt/dbstudio_portal/server.js
```

Add an import + a `registerAdminProjectPhasesRoutes(app)` call alongside the existing admin route registrations:

```javascript
import { registerAdminProjectPhasesRoutes } from './routes/admin/project-phases.js';
// ... in build():
registerAdminProjectPhasesRoutes(app);
```

- [ ] **B1.4 — Restart and smoke.**

```bash
sudo systemctl restart portal.service
sudo journalctl -u portal.service -n 30 --no-pager
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

- [ ] **B1.5 — Manual probe (admin login required).**

Open `https://portal.dbstudio.one/admin` in a browser, sign in as an admin, navigate to a project detail page. The page won't render phases yet (Task B2 adds the UI) but the routes should accept POSTs without 500s. A quick curl probe with a CSRF token is overkill — defer manual verification until B2 lands the UI.

- [ ] **B1.6 — Commit.**

```bash
cd /opt/dbstudio_portal
git add routes/admin/project-phases.js server.js
git commit -m "$(cat <<'EOF'
feat(phases): admin POST routes for phase CRUD + reorder + status

Five POST endpoints under /admin/customers/:customerId/projects/:projectId/phases
covering create, rename, status change, reorder (up/down), and delete.
All gated on requireAdminSession + app.csrfProtection. Cross-customer
mismatches and bad UUIDs return 404 before reaching the service.
Errors map to a flash message via ?phaseError= query param so the
detail page (Task B2) can surface them inline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B2: Admin phase view

**Files:**
- Modify: `views/admin/projects/detail.ejs`
- Modify: `routes/admin/projects.js` (the GET handler that renders detail.ejs — it must now load phases from the repo)
- Modify: `public/styles/app.src.css` (small additions for status pills + reorder buttons)
- Run: `npm run build` to recompile CSS

The view extension renders, beneath the existing project-detail content:

1. A "Phases" section header with eyebrow "PHASES" and an inline create form (single text input + submit, no JS).
2. A list of phases ordered by `display_order` ASC. Per row:
   - Up / down arrow buttons (`disabled` on first / last row).
   - Phase label as a click-to-rename inline form (text input pre-filled, save on submit).
   - Status pill + a dropdown form to change status.
   - Delete button (form with confirm-style submit; rely on browser `<button>` + a `<details>` confirmation block to avoid inline JS).
3. The flash message (from `?phaseError=`) at the top of the section if present.

Status pills reuse the existing `.status-pill` component pattern from `views/admin/projects/detail.ejs:2-7`.

- [ ] **B2.1 — Update the GET handler to load phases.**

In `routes/admin/projects.js`, in the GET that renders `admin/projects/detail`, add a `listPhasesByProject` call alongside the existing project / customer load and pass the rows as `phases` in the locals:

```javascript
import { listPhasesByProject } from '../../domain/phases/repo.js';
// ...
const phases = await listPhasesByProject(app.db, projectId);
return renderAdmin(req, reply, 'admin/projects/detail', {
  title: 'Project · ' + project.name,
  customer, project, phases,
  phaseError: typeof req.query?.phaseError === 'string' ? req.query.phaseError : null,
  mainWidth: 'wide',
  ...customerChrome(customer, 'projects'),
});
```

(Adapt to the actual existing signature; the operator's working plan recorded `mainWidth: 'wide'` standardized in G2.)

- [ ] **B2.2 — Extend the EJS view.**

Open `views/admin/projects/detail.ejs` and append after the existing content (do NOT replace the existing project header / status / metadata blocks — only add):

```ejs
<%
  function statusPillFor(status) {
    var key = status === 'done' ? 'paid'
            : status === 'blocked' ? 'pending'
            : status === 'in_progress' ? 'active'
            : 'archived'; // not_started → muted
    var label = status === 'not_started' ? 'not started'
              : status === 'in_progress' ? 'in progress'
              : status;
    return '<span class="status-pill status-pill--' + key + '">' + label + '</span>';
  }
%>

<section class="admin-section" aria-labelledby="phases-heading">
  <header class="admin-section__header">
    <p class="eyebrow">PHASES</p>
    <h2 id="phases-heading">Project phases</h2>
  </header>

  <% if (phaseError) { %>
    <%- include('../../components/_alert', { variant: 'error', body: phaseError }) %>
  <% } %>

  <form class="phase-create-form" method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <label class="form-label" for="phase-create-label">New phase label</label>
    <div class="form-row">
      <input id="phase-create-label" name="label" type="text" class="form-input" placeholder="0, 0.5, 1, 1.5, …" required>
      <button class="btn btn--primary" type="submit">Add phase</button>
    </div>
  </form>

  <% if (!phases || phases.length === 0) { %>
    <p class="empty-state">No phases yet. Add the first one above.</p>
  <% } else { %>
    <ol class="phase-list">
      <% phases.forEach(function(p, idx) { %>
        <li class="phase-row" data-status="<%= p.status %>">
          <div class="phase-row__order">
            <form method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/reorder">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <input type="hidden" name="direction" value="up">
              <button class="btn btn--icon" type="submit" aria-label="Move up" <%= idx === 0 ? 'disabled' : '' %>>↑</button>
            </form>
            <form method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/reorder">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <input type="hidden" name="direction" value="down">
              <button class="btn btn--icon" type="submit" aria-label="Move down" <%= idx === phases.length - 1 ? 'disabled' : '' %>>↓</button>
            </form>
          </div>

          <form class="phase-row__rename" method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/rename">
            <input type="hidden" name="_csrf" value="<%= csrfToken %>">
            <input class="form-input form-input--inline" name="label" type="text" value="<%= p.label %>" required aria-label="Phase label">
            <button class="btn btn--ghost" type="submit">Save</button>
          </form>

          <div class="phase-row__status">
            <%- statusPillFor(p.status) %>
            <form method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/status">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <select name="status" class="form-select form-select--inline" aria-label="Change status">
                <option value="not_started" <%= p.status === 'not_started' ? 'selected' : '' %>>not started</option>
                <option value="in_progress" <%= p.status === 'in_progress' ? 'selected' : '' %>>in progress</option>
                <option value="blocked"     <%= p.status === 'blocked'     ? 'selected' : '' %>>blocked</option>
                <option value="done"        <%= p.status === 'done'        ? 'selected' : '' %>>done</option>
              </select>
              <button class="btn btn--ghost" type="submit">Set</button>
            </form>
          </div>

          <details class="phase-row__delete">
            <summary class="btn btn--ghost btn--danger">Delete</summary>
            <form method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/delete">
              <input type="hidden" name="_csrf" value="<%= csrfToken %>">
              <p class="form-help">This removes the phase and any checklist items inside it. This cannot be undone.</p>
              <button class="btn btn--danger" type="submit">Confirm delete</button>
            </form>
          </details>
        </li>
      <% }) %>
    </ol>
  <% } %>
</section>
```

(Verify `csrfToken` is in view globals — check `lib/render.js` and the layout. If it's a different name like `req.csrfToken()` invoked via a helper, mirror what the existing admin forms in `views/admin/credentials/list.ejs` do.)

- [ ] **B2.3 — Add CSS.**

Append to `public/styles/app.src.css`:

```css
.phase-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.phase-row {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border-subtle, #e5e7eb);
  border-radius: 8px;
}
.phase-row[data-status="not_started"] { opacity: 0.7; }
.phase-row[data-status="blocked"] { border-left: 3px solid var(--color-warning, #f59e0b); }
.phase-row__order { display: inline-flex; gap: 4px; }
.phase-row__rename { display: inline-flex; gap: 8px; align-items: center; }
.phase-row__status { display: inline-flex; gap: 8px; align-items: center; }
.phase-row__delete > summary { cursor: pointer; list-style: none; }
.btn--icon { padding: 4px 8px; min-width: 32px; }
.btn--icon[disabled] { opacity: 0.4; cursor: not-allowed; }
.form-input--inline, .form-select--inline { display: inline-block; width: auto; }
.empty-state { color: var(--color-ink-500, #64748b); font-style: italic; }
```

- [ ] **B2.4 — Build CSS.**

```bash
sudo -u portal-app env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

- [ ] **B2.5 — Manual probe in a browser.**

Sign into admin, open a customer's project detail page, exercise:
- Add a phase ("0"), then ("1"), then ("0.5").
- Reorder "0.5" up and down.
- Rename "0.5" to "0.5 — discovery".
- Set status to in_progress, then done, then back to in_progress.
- Delete a phase.

After each action, page should reload to the same URL with up-to-date phase list. Errors should appear in the inline alert at the top of the section.

- [ ] **B2.6 — Kimi design review.**

```bash
kimi-design-review --repo /opt/dbstudio_portal
```

Read `.reviews/kimi-design-review.md`, apply any accepted patches via `external-ai-apply-patch --repo /opt/dbstudio_portal --patch <path> --source kimi`. Re-build, re-restart, re-probe.

- [ ] **B2.7 — Codex review for Phase B.**

```bash
codex-review-prompt --repo /opt/dbstudio_portal
```

Invoke superpowers:code-reviewer; resolve BLOCKs.

- [ ] **B2.8 — Commit.**

```bash
cd /opt/dbstudio_portal
git add views/admin/projects/detail.ejs routes/admin/projects.js public/styles/app.src.css public/styles/app.css
git commit -m "$(cat <<'EOF'
feat(phases): admin UI section on project detail page (CRUD + reorder + status)

Adds a "Phases" section under project detail with an inline create
form, an ordered list of phases, up/down reorder buttons that respect
edge state (disabled on first/last row), inline rename form, status
pill + dropdown, and a <details>-confirmed delete button. Fully
server-rendered, no inline JS — sticks to the CSP-strict precedent
from Phase G3.

Errors flow through the ?phaseError= query param to the inline alert
at the top of the section. CSS additions follow the existing design-
token system with the same status-pill shape used elsewhere.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Checklist layer

### Task C1: Checklist repo

**Files:**
- Create: `domain/phase-checklists/repo.js`
- Create: `tests/integration/phase-checklists/repo.test.js`
- Modify: `tests/integration/phases/_helpers.js` (extend with `cleanupChecklistsByTag` if needed — checklist rows cascade via phase deletion which cascades via project deletion, so the existing cleanup is sufficient).

Functions to implement (mirror Task A2):
- `findItemById(db, id)`
- `listItemsByPhase(db, phaseId)` — ordered by display_order ASC
- `findMaxItemDisplayOrder(db, phaseId)`
- `insertItem(db, { id, phaseId, label, displayOrder, visibleToCustomer })`
- `updateItemLabel(db, id, label)`
- `setItemVisibility(db, id, visibleToCustomer)`
- `setItemDone(db, id, { doneAt, doneByAdminId })`
- `setItemDisplayOrder(db, id, displayOrder)` (for future reorder; not exposed in v1 routes but handy for tests)
- `deleteItem(db, id)`

- [ ] **C1.1 — Write failing repo tests.**

Create `tests/integration/phase-checklists/repo.test.js`:

```javascript
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesRepo from '../../../domain/phases/repo.js';
import * as checklistRepo from '../../../domain/phase-checklists/repo.js';
import { makeTag, makeCustomerAndProject, cleanupByTag } from '../phases/_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('domain/phase-checklists/repo', () => {
  const tag = makeTag();
  let db;
  let phaseId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    const ctx = await makeCustomerAndProject(db, tag, 'cl');
    phaseId = uuidv7();
    await phasesRepo.insertPhase(db, {
      id: phaseId, projectId: ctx.projectId, label: '1', displayOrder: 100,
      status: 'in_progress', startedAt: new Date(), completedAt: null,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  it('listItemsByPhase empty for fresh phase', async () => {
    expect(await checklistRepo.listItemsByPhase(db, phaseId)).toEqual([]);
  });

  it('insertItem + findItemById + listItemsByPhase ordered', async () => {
    const a = uuidv7(), b = uuidv7(), c = uuidv7();
    await checklistRepo.insertItem(db, { id: a, phaseId, label: 'A', displayOrder: 200, visibleToCustomer: true });
    await checklistRepo.insertItem(db, { id: b, phaseId, label: 'B', displayOrder: 100, visibleToCustomer: true });
    await checklistRepo.insertItem(db, { id: c, phaseId, label: 'C', displayOrder: 300, visibleToCustomer: false });
    const rows = await checklistRepo.listItemsByPhase(db, phaseId);
    expect(rows.map(r => r.label)).toEqual(['B', 'A', 'C']);
    expect(rows[2].visible_to_customer).toBe(false);
  });

  it('findMaxItemDisplayOrder', async () => {
    expect(await checklistRepo.findMaxItemDisplayOrder(db, phaseId)).toBe(300);
  });

  it('updateItemLabel', async () => {
    const id = uuidv7();
    await checklistRepo.insertItem(db, { id, phaseId, label: 'old', displayOrder: 1000, visibleToCustomer: true });
    await checklistRepo.updateItemLabel(db, id, 'new');
    expect((await checklistRepo.findItemById(db, id)).label).toBe('new');
  });

  it('setItemVisibility flips the flag', async () => {
    const id = uuidv7();
    await checklistRepo.insertItem(db, { id, phaseId, label: 'v', displayOrder: 1100, visibleToCustomer: true });
    await checklistRepo.setItemVisibility(db, id, false);
    expect((await checklistRepo.findItemById(db, id)).visible_to_customer).toBe(false);
  });

  it('setItemDone writes done_at + done_by_admin_id; passing null clears them', async () => {
    const id = uuidv7();
    await checklistRepo.insertItem(db, { id, phaseId, label: 'd', displayOrder: 1200, visibleToCustomer: true });
    const adminId = uuidv7();
    await sql`
      INSERT INTO admins (id, email, name, password_hash, totp_secret_enc)
      VALUES (${adminId}::uuid, ${'doneby@example.com'}, ${'X'}, ${'x'}, ${'x'})
    `.execute(db);
    const doneAt = new Date('2026-05-03T13:00:00Z');
    await checklistRepo.setItemDone(db, id, { doneAt, doneByAdminId: adminId });
    let row = await checklistRepo.findItemById(db, id);
    expect(row.done_at?.toISOString()).toBe(doneAt.toISOString());
    expect(row.done_by_admin_id).toBe(adminId);
    await checklistRepo.setItemDone(db, id, { doneAt: null, doneByAdminId: null });
    row = await checklistRepo.findItemById(db, id);
    expect(row.done_at).toBeNull();
    expect(row.done_by_admin_id).toBeNull();
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
  });

  it('deleteItem removes the row', async () => {
    const id = uuidv7();
    await checklistRepo.insertItem(db, { id, phaseId, label: 'x', displayOrder: 1300, visibleToCustomer: true });
    await checklistRepo.deleteItem(db, id);
    expect(await checklistRepo.findItemById(db, id)).toBeNull();
  });
});
```

- [ ] **C1.2 — Run tests, expect FAIL.**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phase-checklists/repo.test.js
```

- [ ] **C1.3 — Implement the repo.**

Create `domain/phase-checklists/repo.js`:

```javascript
import { sql } from 'kysely';

export async function findItemById(db, id) {
  const r = await sql`SELECT * FROM phase_checklist_items WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function listItemsByPhase(db, phaseId) {
  const r = await sql`
    SELECT * FROM phase_checklist_items
     WHERE phase_id = ${phaseId}::uuid
     ORDER BY display_order ASC
  `.execute(db);
  return r.rows;
}

export async function findMaxItemDisplayOrder(db, phaseId) {
  const r = await sql`
    SELECT COALESCE(MAX(display_order), 0)::int AS max
      FROM phase_checklist_items
     WHERE phase_id = ${phaseId}::uuid
  `.execute(db);
  return Number(r.rows[0]?.max ?? 0);
}

export async function insertItem(db, { id, phaseId, label, displayOrder, visibleToCustomer }) {
  await sql`
    INSERT INTO phase_checklist_items (id, phase_id, label, display_order, visible_to_customer)
    VALUES (${id}::uuid, ${phaseId}::uuid, ${label}, ${displayOrder}, ${visibleToCustomer})
  `.execute(db);
}

export async function updateItemLabel(db, id, label) {
  await sql`
    UPDATE phase_checklist_items
       SET label = ${label}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setItemVisibility(db, id, visibleToCustomer) {
  await sql`
    UPDATE phase_checklist_items
       SET visible_to_customer = ${visibleToCustomer}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setItemDone(db, id, { doneAt, doneByAdminId }) {
  await sql`
    UPDATE phase_checklist_items
       SET done_at = ${doneAt},
           done_by_admin_id = ${doneByAdminId},
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setItemDisplayOrder(db, id, displayOrder) {
  await sql`
    UPDATE phase_checklist_items
       SET display_order = ${displayOrder}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function deleteItem(db, id) {
  await sql`DELETE FROM phase_checklist_items WHERE id = ${id}::uuid`.execute(db);
}
```

- [ ] **C1.4 — Run tests, expect PASS.**
- [ ] **C1.5 — DeepSeek pass + apply patch + re-run.**
- [ ] **C1.6 — Commit.**

```bash
cd /opt/dbstudio_portal
git add domain/phase-checklists/repo.js tests/integration/phase-checklists/repo.test.js
git commit -m "feat(phases): checklist items repo + tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C2: Checklist service

**Files:**
- Create: `domain/phase-checklists/service.js`
- Create: `tests/integration/phase-checklists/service.test.js`

Service responsibilities (per Decisions 4, 7, 8):
- Local helper `audibleVisible(item, parentPhase) ≡ item.visible_to_customer && phaseVisible(parentPhase.status)`.
- `create(db, { phaseId, customerId }, { label, visibleToCustomer = true }, ctx, { adminId })` — inserts at `findMaxItemDisplayOrder + 100`. Audit `phase_checklist.created` with `visible_to_customer = audibleVisible(item, parentPhase)`. Fan out symmetric.
- `rename(db, { itemId, customerId }, { label }, ctx, { adminId })` — mirrors phases service.
- `setVisibility(db, { itemId, customerId }, { visibleToCustomer }, ctx, { adminId })` — flips the flag. Audit `phase_checklist.visibility_changed` is **always** `visible_to_customer = false` (per Decision 7 — admin-only). Fan out admin-only.
- `toggleDone(db, { itemId, customerId }, { done }, ctx, { adminId })` — when `done = true`, writes `done_at = now()` + `done_by_admin_id = adminId`. When `false`, clears both. Audit `phase_checklist.toggled` with metadata `{ done, phaseLabel, itemLabel }`.
- `delete(db, { itemId, customerId }, ctx, { adminId })` — deletes. Audit `phase_checklist.deleted`. Snapshots both `item.visible_to_customer` and `parentPhase.status` at delete time for the visibility computation.

The service needs to look up the parent phase on every mutation to compute `phaseVisible(parentPhase.status)`. It also needs the `customerId` — currently passed as a param; the route layer resolves it from the URL and passes it through, same as the phase service.

- [ ] **C2.1 — Write failing service test.**

Create `tests/integration/phase-checklists/service.test.js`:

```javascript
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesService from '../../../domain/phases/service.js';
import * as checklistService from '../../../domain/phase-checklists/service.js';
import * as checklistRepo from '../../../domain/phase-checklists/repo.js';
import { makeTag, makeAdmin, makeCustomerAndProject, baseCtx, cleanupByTag } from '../phases/_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('domain/phase-checklists/service', () => {
  const tag = makeTag();
  let db, adminId, customerId, projectId, phaseId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'cl-svc');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
    const phase = await phasesService.create(db, { projectId, customerId, label: '1' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    phaseId = phase.phaseId;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  async function audit(action) {
    const r = await sql`
      SELECT * FROM audit_log
       WHERE action = ${action} AND metadata->>'tag' = ${tag}
       ORDER BY ts ASC
    `.execute(db);
    return r.rows;
  }

  it('create on a not_started phase: audit visible_to_customer = false (parent phase invisible)', async () => {
    const { itemId } = await checklistService.create(db, { phaseId, customerId },
      { label: 'A', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const item = await checklistRepo.findItemById(db, itemId);
    expect(item.label).toBe('A');
    const rows = await audit('phase_checklist.created');
    expect(rows[0].visible_to_customer).toBe(false);
  });

  it('after parent phase moves to in_progress, NEW create writes customer-visible audit', async () => {
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.create(db, { phaseId, customerId },
      { label: 'B', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await audit('phase_checklist.created');
    const lastForB = rows.find(r => r.metadata.itemLabel === 'B');
    expect(lastForB.visible_to_customer).toBe(true);
  });

  it('admin-only item (visibleToCustomer=false) on in_progress phase still writes admin-only audit', async () => {
    await checklistService.create(db, { phaseId, customerId },
      { label: 'internal', visibleToCustomer: false },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await audit('phase_checklist.created');
    const last = rows.find(r => r.metadata.itemLabel === 'internal');
    expect(last.visible_to_customer).toBe(false);
  });

  it('toggleDone writes done_at + done_by_admin_id, then clearing', async () => {
    const { itemId } = await checklistService.create(db, { phaseId, customerId },
      { label: 'toggle', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.toggleDone(db, { itemId, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    let row = await checklistRepo.findItemById(db, itemId);
    expect(row.done_at).not.toBeNull();
    expect(row.done_by_admin_id).toBe(adminId);
    await checklistService.toggleDone(db, { itemId, customerId }, { done: false },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    row = await checklistRepo.findItemById(db, itemId);
    expect(row.done_at).toBeNull();
    expect(row.done_by_admin_id).toBeNull();
  });

  it('setVisibility audit row is always admin-only', async () => {
    const { itemId } = await checklistService.create(db, { phaseId, customerId },
      { label: 'flip', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.setVisibility(db, { itemId, customerId }, { visibleToCustomer: false },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await audit('phase_checklist.visibility_changed');
    expect(rows.every(r => r.visible_to_customer === false)).toBe(true);
  });

  it('delete snapshots phaseLabel + itemLabel + the visibility flags', async () => {
    const { itemId } = await checklistService.create(db, { phaseId, customerId },
      { label: 'del', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    await checklistService.delete(db, { itemId, customerId },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const rows = await audit('phase_checklist.deleted');
    const last = rows.find(r => r.metadata.itemLabel === 'del');
    expect(last.metadata.phaseLabel).toBe('1');
    expect(last.metadata.itemLabel).toBe('del');
    expect(last.visible_to_customer).toBe(true); // parent in_progress + item visible
  });
});
```

- [ ] **C2.2 — Run, expect FAIL.**
- [ ] **C2.3 — Implement the service.**

Create `domain/phase-checklists/service.js`:

```javascript
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import { listActiveAdmins, listActiveCustomerUsers } from '../../lib/digest-fanout.js';
import * as repo from './repo.js';
import * as phasesRepo from '../phases/repo.js';
import { phaseVisible } from '../phases/service.js';

const ITEM_GAP = 100;

export class ItemNotFoundError extends Error {
  constructor() { super('checklist item not found'); this.code = 'ITEM_NOT_FOUND'; }
}
export class PhaseGoneError extends Error {
  constructor() { super('parent phase missing'); this.code = 'ITEM_PARENT_GONE'; }
}

function baseAuditMetadata(ctx) { return ctx?.audit ?? {}; }

async function findCustomerName(db, customerId) {
  const r = await sql`SELECT razon_social FROM customers WHERE id = ${customerId}::uuid`.execute(db);
  return r.rows[0]?.razon_social ?? null;
}

function audibleVisible(itemVisible, parentStatus) {
  return !!itemVisible && phaseVisible(parentStatus);
}

async function fanOut(tx, {
  customerId, projectId, phaseId, itemId,
  eventType, visibleToCustomer, varsForAdmin, varsForCustomer,
  linkAdmin, linkCustomer, bucket = 'fyi',
}) {
  const admins = await listActiveAdmins(tx);
  for (const a of admins) {
    await recordForDigest(tx, {
      recipientType: 'admin',
      recipientId: a.id,
      customerId,
      bucket,
      eventType,
      title: titleFor(eventType, a.locale, varsForAdmin),
      linkPath: linkAdmin,
      metadata: { customerId, projectId, phaseId, itemId },
      vars: varsForAdmin,
      locale: a.locale,
    });
  }
  if (!visibleToCustomer) return;
  const users = await listActiveCustomerUsers(tx, customerId);
  for (const u of users) {
    await recordForDigest(tx, {
      // 'customer_user' — see CHECK constraint in 0010 migration.
      recipientType: 'customer_user',
      recipientId: u.id,
      customerId,
      bucket,
      eventType,
      title: titleFor(eventType, u.locale, varsForCustomer),
      linkPath: linkCustomer,
      metadata: { customerId, projectId, phaseId, itemId },
      vars: varsForCustomer,
      locale: u.locale,
    });
  }
}

export async function create(db, { phaseId, customerId }, { label, visibleToCustomer = true }, ctx, { adminId }) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('label required');
  const labelTrimmed = label.trim();
  return await db.transaction().execute(async (tx) => {
    const phase = await phasesRepo.findPhaseById(tx, phaseId);
    if (!phase) throw new PhaseGoneError();
    const max = await repo.findMaxItemDisplayOrder(tx, phaseId);
    const itemId = uuidv7();
    await repo.insertItem(tx, {
      id: itemId, phaseId, label: labelTrimmed,
      displayOrder: max + ITEM_GAP, visibleToCustomer: !!visibleToCustomer,
    });

    const customerName = await findCustomerName(tx, customerId);
    const visible = audibleVisible(visibleToCustomer, phase.status);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.created',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...baseAuditMetadata(ctx),
        customerId, projectId: phase.project_id, phaseId, itemId,
        phaseLabel: phase.label, itemLabel: labelTrimmed,
      },
      visibleToCustomer: visible,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId, itemId,
      eventType: 'phase_checklist.created',
      visibleToCustomer: visible,
      varsForAdmin: { customerName, phaseLabel: phase.label, itemLabel: labelTrimmed, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, itemLabel: labelTrimmed, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return { itemId };
  });
}

export async function rename(db, { itemId, customerId }, { label }, ctx, { adminId }) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('label required');
  const labelTrimmed = label.trim();
  return await db.transaction().execute(async (tx) => {
    const item = await repo.findItemById(tx, itemId);
    if (!item) throw new ItemNotFoundError();
    const phase = await phasesRepo.findPhaseById(tx, item.phase_id);
    if (!phase) throw new PhaseGoneError();
    await repo.updateItemLabel(tx, itemId, labelTrimmed);

    const customerName = await findCustomerName(tx, customerId);
    const visible = audibleVisible(item.visible_to_customer, phase.status);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.renamed',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...baseAuditMetadata(ctx),
        customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
        phaseLabel: phase.label, oldLabel: item.label, newLabel: labelTrimmed,
      },
      visibleToCustomer: visible,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
      eventType: 'phase_checklist.renamed',
      visibleToCustomer: visible,
      varsForAdmin: { customerName, phaseLabel: phase.label, oldLabel: item.label, newLabel: labelTrimmed, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, oldLabel: item.label, newLabel: labelTrimmed, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

export async function setVisibility(db, { itemId, customerId }, { visibleToCustomer }, ctx, { adminId }) {
  return await db.transaction().execute(async (tx) => {
    const item = await repo.findItemById(tx, itemId);
    if (!item) throw new ItemNotFoundError();
    const phase = await phasesRepo.findPhaseById(tx, item.phase_id);
    if (!phase) throw new PhaseGoneError();
    await repo.setItemVisibility(tx, itemId, !!visibleToCustomer);

    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.visibility_changed',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...baseAuditMetadata(ctx),
        customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
        phaseLabel: phase.label, itemLabel: item.label,
        from: item.visible_to_customer, to: !!visibleToCustomer,
      },
      visibleToCustomer: false, // admin-only per Decision 7
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    // Admin-only fan-out (no customer leg) — visibility flips are admin-only
    // per spec Decision 7.
    const admins = await listActiveAdmins(tx);
    const customerName = await findCustomerName(tx, customerId);
    for (const a of admins) {
      await recordForDigest(tx, {
        recipientType: 'admin', recipientId: a.id, customerId,
        bucket: 'fyi',
        eventType: 'phase_checklist.visibility_changed',
        title: titleFor('phase_checklist.visibility_changed', a.locale, { customerName, phaseLabel: phase.label, itemLabel: item.label }),
        linkPath: `/admin/customers/${customerId}/projects/${phase.project_id}`,
        metadata: { customerId, projectId: phase.project_id, phaseId: phase.id, itemId },
        vars: { customerName, phaseLabel: phase.label, itemLabel: item.label },
        locale: a.locale,
      });
    }
    return {};
  });
}

export async function toggleDone(db, { itemId, customerId }, { done }, ctx, { adminId }) {
  return await db.transaction().execute(async (tx) => {
    const item = await repo.findItemById(tx, itemId);
    if (!item) throw new ItemNotFoundError();
    const phase = await phasesRepo.findPhaseById(tx, item.phase_id);
    if (!phase) throw new PhaseGoneError();

    const doneAt = done ? new Date() : null;
    const doneBy = done ? adminId : null;
    await repo.setItemDone(tx, itemId, { doneAt, doneByAdminId: doneBy });

    const customerName = await findCustomerName(tx, customerId);
    const visible = audibleVisible(item.visible_to_customer, phase.status);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.toggled',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...baseAuditMetadata(ctx),
        customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
        phaseLabel: phase.label, itemLabel: item.label, done: !!done,
      },
      visibleToCustomer: visible,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
      eventType: 'phase_checklist.toggled',
      visibleToCustomer: visible,
      varsForAdmin: { customerName, phaseLabel: phase.label, itemLabel: item.label, done: !!done, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, itemLabel: item.label, done: !!done, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

export async function deleteItemService(db, { itemId, customerId }, ctx, { adminId }) {
  return await db.transaction().execute(async (tx) => {
    const item = await repo.findItemById(tx, itemId);
    if (!item) throw new ItemNotFoundError();
    const phase = await phasesRepo.findPhaseById(tx, item.phase_id);
    if (!phase) throw new PhaseGoneError();
    const itemVisibleAtDelete = item.visible_to_customer;
    const phaseStatusAtDelete = phase.status;
    const itemLabelAtDelete = item.label;

    await repo.deleteItem(tx, itemId);

    const customerName = await findCustomerName(tx, customerId);
    const visible = audibleVisible(itemVisibleAtDelete, phaseStatusAtDelete);
    await writeAudit(tx, {
      actorType: 'admin', actorId: adminId,
      action: 'phase_checklist.deleted',
      targetType: 'phase_checklist_item', targetId: itemId,
      metadata: {
        ...baseAuditMetadata(ctx),
        customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
        phaseLabel: phase.label, itemLabel: itemLabelAtDelete,
        wasVisible: itemVisibleAtDelete, parentStatusAtDelete: phaseStatusAtDelete,
      },
      visibleToCustomer: visible,
      ip: ctx?.ip ?? null, userAgentHash: ctx?.userAgentHash ?? null,
    });

    await fanOut(tx, {
      customerId, projectId: phase.project_id, phaseId: phase.id, itemId,
      eventType: 'phase_checklist.deleted',
      visibleToCustomer: visible,
      varsForAdmin: { customerName, phaseLabel: phase.label, itemLabel: itemLabelAtDelete, recipient: 'admin' },
      varsForCustomer: { phaseLabel: phase.label, itemLabel: itemLabelAtDelete, recipient: 'customer' },
      linkAdmin: `/admin/customers/${customerId}/projects/${phase.project_id}`,
      linkCustomer: `/customer/projects/${phase.project_id}`,
    });

    return {};
  });
}

export { deleteItemService as delete };
```

- [ ] **C2.4 — Run, expect PASS.**
- [ ] **C2.5 — DeepSeek + Codex.**
- [ ] **C2.6 — Commit.**

```bash
cd /opt/dbstudio_portal
git add domain/phase-checklists/service.js tests/integration/phase-checklists/service.test.js
git commit -m "feat(phases): checklist items service (CRUD + toggle + visibility)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C3: Admin checklist routes

**Files:**
- Create: `routes/admin/phase-checklist-items.js`
- Modify: `server.js` (register the new route group)

Routes (5 POSTs):

| Path | Body | Service call |
|---|---|---|
| `POST .../phases/:phaseId/items` | `{ label, visibleToCustomer }` | `service.create` |
| `POST .../phases/:phaseId/items/:itemId/rename` | `{ label }` | `service.rename` |
| `POST .../phases/:phaseId/items/:itemId/visibility` | `{ visibleToCustomer }` | `service.setVisibility` |
| `POST .../phases/:phaseId/items/:itemId/toggle` | `{ done }` | `service.toggleDone` |
| `POST .../phases/:phaseId/items/:itemId/delete` | (none) | `service.delete` |

All paths share the prefix `/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items`.

- [ ] **C3.1 — Create the route file.**

Create `routes/admin/phase-checklist-items.js`:

```javascript
import { requireAdminSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import { findProjectById } from '../../domain/projects/repo.js';
import { findPhaseById } from '../../domain/phases/repo.js';
import { findItemById } from '../../domain/phase-checklists/repo.js';
import * as checklistService from '../../domain/phase-checklists/service.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;

function ctxFromReq(req) {
  return {
    actorType: 'admin',
    audit: {},
    ip: req.ip,
    userAgentHash: req.headers['user-agent'] ? req.headers['user-agent'].slice(0, 64) : null,
  };
}

function notFound(req, reply) { reply.code(404).send({ error: 'not_found' }); }

function back(reply, customerId, projectId, flash) {
  if (flash) return reply.redirect(`/admin/customers/${customerId}/projects/${projectId}?phaseError=${encodeURIComponent(flash)}`, 303);
  return reply.redirect(`/admin/customers/${customerId}/projects/${projectId}`, 303);
}

function flashFromError(err) {
  if (err?.code === 'ITEM_NOT_FOUND')   return 'Checklist item not found.';
  if (err?.code === 'ITEM_PARENT_GONE') return 'Parent phase no longer exists.';
  if (err?.code === 'PHASE_NOT_FOUND')  return 'Phase not found.';
  return 'Something went wrong; please try again.';
}

async function loadPhaseGuards(app, req, reply) {
  const session = await requireAdminSession(app, req, reply);
  if (!session) return null;
  const { customerId, projectId, phaseId } = req.params ?? {};
  if (!UUID_RE.test(customerId) || !UUID_RE.test(projectId) || !UUID_RE.test(phaseId)) {
    notFound(req, reply); return null;
  }
  const customer = await findCustomerById(app.db, customerId);
  if (!customer) { notFound(req, reply); return null; }
  const project = await findProjectById(app.db, projectId);
  if (!project || project.customer_id !== customerId) { notFound(req, reply); return null; }
  const phase = await findPhaseById(app.db, phaseId);
  if (!phase || phase.project_id !== projectId) { notFound(req, reply); return null; }
  return { session, customer, project, phase, adminId: session.user_id };
}

async function loadItemGuards(app, req, reply) {
  const base = await loadPhaseGuards(app, req, reply);
  if (!base) return null;
  const itemId = req.params?.itemId;
  if (!UUID_RE.test(itemId)) { notFound(req, reply); return null; }
  const item = await findItemById(app.db, itemId);
  if (!item || item.phase_id !== base.phase.id) { notFound(req, reply); return null; }
  return { ...base, itemId, item };
}

export function registerAdminPhaseChecklistItemsRoutes(app) {
  // Create
  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadPhaseGuards(app, req, reply);
      if (!g) return;
      const label = (req.body?.label || '').toString();
      const visibleToCustomer = req.body?.visibleToCustomer === 'true';
      try {
        await checklistService.create(
          app.db,
          { phaseId: g.phase.id, customerId: g.customer.id },
          { label, visibleToCustomer },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });

  // Rename
  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items/:itemId/rename',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadItemGuards(app, req, reply);
      if (!g) return;
      const label = (req.body?.label || '').toString();
      try {
        await checklistService.rename(
          app.db,
          { itemId: g.itemId, customerId: g.customer.id },
          { label },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });

  // Visibility flip
  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items/:itemId/visibility',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadItemGuards(app, req, reply);
      if (!g) return;
      const visibleToCustomer = req.body?.visibleToCustomer === 'true';
      try {
        await checklistService.setVisibility(
          app.db,
          { itemId: g.itemId, customerId: g.customer.id },
          { visibleToCustomer },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });

  // Toggle done
  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items/:itemId/toggle',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadItemGuards(app, req, reply);
      if (!g) return;
      const done = req.body?.done === 'true';
      try {
        await checklistService.toggleDone(
          app.db,
          { itemId: g.itemId, customerId: g.customer.id },
          { done },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });

  // Delete
  app.post('/admin/customers/:customerId/projects/:projectId/phases/:phaseId/items/:itemId/delete',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const g = await loadItemGuards(app, req, reply);
      if (!g) return;
      try {
        await checklistService.delete(
          app.db,
          { itemId: g.itemId, customerId: g.customer.id },
          ctxFromReq(req),
          { adminId: g.adminId },
        );
      } catch (err) {
        return back(reply, g.customer.id, g.project.id, flashFromError(err));
      }
      return back(reply, g.customer.id, g.project.id);
    });
}
```

(If `findProjectById` doesn't exist as an export in `domain/projects/repo.js`, replace with an inline `sql\`SELECT * FROM projects WHERE id = ${projectId}::uuid\``. Same for `findCustomerById`.)

Note `loadPhaseGuards` adds the **cross-project / cross-customer integrity check** (`project.customer_id !== customerId` and `phase.project_id !== projectId`). The phase routes from B1 should be retrofitted with the same `phase.project_id !== projectId` check — apply that as a small follow-up edit during this task: in `routes/admin/project-phases.js`, change `loadGuards` to also resolve the phase row and assert ownership when a `phaseId` param is present. Without this check, an admin could in theory POST to `/admin/customers/A/projects/X/phases/<phaseId-of-project-Y>/rename` and the service would write to project Y. Defense-in-depth.

- [ ] **C3.2 — Register in `server.js`** alongside the other admin route registrations:

```javascript
import { registerAdminPhaseChecklistItemsRoutes } from './routes/admin/phase-checklist-items.js';
// ... in build():
registerAdminPhaseChecklistItemsRoutes(app);
```

- [ ] **C3.3 — Restart and smoke.**

```bash
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

- [ ] **C3.4 — Commit.**

The cross-project ownership check on phase routes is already baked into B1's `loadGuardsWithPhase` (no retrofit needed). The item routes here use their own `loadItemGuards` which loads the item and asserts `item.phase_id === phaseId`.

```bash
cd /opt/dbstudio_portal
git add routes/admin/phase-checklist-items.js server.js
git commit -m "$(cat <<'EOF'
feat(phases): admin POST routes for checklist items

Five POST endpoints (create / rename / visibility / toggle / delete)
under .../phases/:phaseId/items, gated on requireAdminSession +
app.csrfProtection. loadItemGuards resolves both the parent phase
(via loadPhaseGuards) and the item itself, asserting
project.customer_id === customerId, phase.project_id === projectId,
and item.phase_id === phaseId. Defense-in-depth against admin
URL-tampering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C4: Admin checklist UI on the project detail page

**Files:**
- Modify: `views/admin/projects/detail.ejs` (extend the per-phase row to include checklist items)
- Modify: `routes/admin/projects.js` (the GET handler — load items per phase via `listItemsByPhase`, group as `phasesWithItems`)
- Modify: `public/styles/app.src.css` (add `.checklist-list` etc.)

Rendering target: each `<li class="phase-row">` from B2 grows a sub-area showing checklist items + a per-phase "add item" form. The `<details>` element wraps the checklist UI so the admin can collapse phases that aren't currently active.

- [ ] **C4.1 — Update GET handler to load items.**

```javascript
const phases = await listPhasesByProject(app.db, projectId);
const phasesWithItems = await Promise.all(phases.map(async (p) => ({
  ...p,
  items: await checklistRepo.listItemsByPhase(app.db, p.id),
})));
return renderAdmin(req, reply, 'admin/projects/detail', {
  // ...
  phases: phasesWithItems,
  // ...
});
```

- [ ] **C4.2 — Extend the EJS view.**

Inside the existing `<li class="phase-row">` in B2.2, after the delete `<details>` and before the closing `</li>`, add:

```ejs
<details class="phase-row__checklist" <%= p.status !== 'not_started' ? 'open' : '' %>>
  <summary>Checklist (<%= p.items.length %><%= p.items.length === 0 ? '' : ', ' + p.items.filter(function(i){ return i.done_at; }).length + ' done' %>)</summary>

  <ul class="checklist-list">
    <% p.items.forEach(function(it) { %>
      <li class="checklist-item" data-done="<%= it.done_at ? 'true' : 'false' %>">
        <form method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/toggle" class="checklist-toggle-form">
          <input type="hidden" name="_csrf" value="<%= csrfToken %>">
          <input type="hidden" name="done" value="<%= it.done_at ? 'false' : 'true' %>">
          <button class="btn btn--icon" type="submit" aria-label="<%= it.done_at ? 'Mark as not done' : 'Mark done' %>">
            <%= it.done_at ? '☑' : '☐' %>
          </button>
        </form>

        <form method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/rename" class="checklist-rename-form">
          <input type="hidden" name="_csrf" value="<%= csrfToken %>">
          <input class="form-input form-input--inline" name="label" type="text" value="<%= it.label %>" required aria-label="Item label">
          <button class="btn btn--ghost" type="submit">Save</button>
        </form>

        <form method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/visibility" class="checklist-visibility-form">
          <input type="hidden" name="_csrf" value="<%= csrfToken %>">
          <input type="hidden" name="visibleToCustomer" value="<%= it.visible_to_customer ? 'false' : 'true' %>">
          <button class="btn btn--ghost" type="submit" aria-label="<%= it.visible_to_customer ? 'Hide from customer' : 'Show to customer' %>">
            <%= it.visible_to_customer ? '👁 visible' : '🔒 admin only' %>
          </button>
        </form>

        <form method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items/<%= it.id %>/delete" class="checklist-delete-form">
          <input type="hidden" name="_csrf" value="<%= csrfToken %>">
          <button class="btn btn--ghost btn--danger" type="submit" aria-label="Delete item">×</button>
        </form>
      </li>
    <% }) %>
  </ul>

  <form class="checklist-create-form" method="POST" action="/admin/customers/<%= customer.id %>/projects/<%= project.id %>/phases/<%= p.id %>/items">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <div class="form-row">
      <input class="form-input" name="label" type="text" placeholder="New checklist item" required aria-label="New checklist item label">
      <label class="form-checkbox">
        <input type="checkbox" name="visibleToCustomer" value="true" checked>
        Visible to customer
      </label>
      <button class="btn btn--primary" type="submit">Add</button>
    </div>
  </form>
</details>
```

> Note the `name="visibleToCustomer"` checkbox: per Fastify formbody, an unchecked checkbox is absent from `req.body`. The route should treat `req.body.visibleToCustomer === 'true'` as truthy and anything else as falsy. Verify the route handler (C3) does this.

- [ ] **C4.3 — Append CSS.**

```css
.phase-row__checklist > summary { cursor: pointer; padding: 4px 0; color: var(--color-ink-700, #334155); }
.checklist-list { list-style: none; padding: 8px 0 0 24px; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.checklist-item {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 8px;
  align-items: center;
}
.checklist-item[data-done="true"] .form-input--inline { text-decoration: line-through; opacity: 0.7; }
.checklist-create-form { padding: 8px 0 0 24px; }
.form-checkbox { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; }
```

- [ ] **C4.4 — Build, restart, smoke, manual probe.**

```bash
sudo -u portal-app env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

In a browser, on a project detail page: expand a phase's checklist, add an item, toggle it done, rename it, flip its visibility, delete it. Verify the page reloads correctly between actions.

- [ ] **C4.5 — Kimi review on the extended detail page.**
- [ ] **C4.6 — Codex review for Phase C.**
- [ ] **C4.7 — Commit.**

```bash
cd /opt/dbstudio_portal
git add views/admin/projects/detail.ejs routes/admin/projects.js public/styles/app.src.css public/styles/app.css routes/admin/phase-checklist-items.js server.js
git commit -m "$(cat <<'EOF'
feat(phases): admin checklist UI on project detail page + 5 POST routes

Per-phase <details> block surfaces the checklist with toggle / rename /
visibility / delete controls and a per-phase add-item form. New routes
under .../phases/:phaseId/items handle each verb; all CSP-strict (no
inline JS), all gated on requireAdminSession + app.csrfProtection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase D — Customer surface (new project detail page)

### Task D1: Customer project detail route

**Files:**
- Create or modify: `routes/customer/projects.js` (extend existing customer projects list to also serve `/customer/projects/:projectId`)
- Server.js already registers `registerCustomerProjectsRoutes` — no further wiring needed.

Behaviour: GET `/customer/projects/:projectId` resolves the customer's session and ensures the project belongs to their customer; loads phases where `status != 'not_started'`; for each phase loads checklist items where `visible_to_customer = true`; renders the new `customer/projects/show` view. NDA gate via `requireNdaSigned`.

- [ ] **D1.1 — Read the existing customer projects list route.**

```bash
cat /opt/dbstudio_portal/routes/customer/projects.js
```

Capture: `requireCustomerSession`, `requireNdaSigned`, the `customer_id` resolution from session, `renderCustomer`.

- [ ] **D1.2 — Extend with the detail route.**

In `routes/customer/projects.js`, add:

```javascript
import { sql } from 'kysely';
import { listPhasesByProject } from '../../domain/phases/repo.js';
import { listItemsByPhase } from '../../domain/phase-checklists/repo.js';

// inside registerCustomerProjectsRoutes(app):
app.get('/customer/projects/:projectId', async (req, reply) => {
  const session = await requireCustomerSession(app, req, reply);
  if (!session) return;
  if (!requireNdaSigned(req, reply, session)) return;
  const projectId = req.params?.projectId;
  if (typeof projectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(projectId)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const userR = await sql`
    SELECT customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
  `.execute(app.db);
  const customerId = userR.rows[0]?.customer_id;
  if (!customerId) return reply.redirect('/', 302);

  const projectR = await sql`
    SELECT id, name, objeto_proyecto, status, created_at
      FROM projects
     WHERE id = ${projectId}::uuid AND customer_id = ${customerId}::uuid
  `.execute(app.db);
  const project = projectR.rows[0];
  if (!project) return reply.code(404).send({ error: 'not_found' });

  const allPhases = await listPhasesByProject(app.db, projectId);
  const visiblePhases = allPhases.filter(p => p.status !== 'not_started');
  const phasesWithItems = await Promise.all(visiblePhases.map(async (p) => {
    const items = await listItemsByPhase(app.db, p.id);
    return { ...p, items: items.filter(i => i.visible_to_customer) };
  }));

  return renderCustomer(req, reply, 'customer/projects/show', {
    title: project.name,
    project,
    phases: phasesWithItems,
    activeNav: 'projects',
    mainWidth: 'wide',
    sectionLabel: 'PROJECTS',
  });
});
```

- [ ] **D1.3 — Restart, smoke.**

The view doesn't exist yet — Task D2. The route would 500 on render. Don't probe until D2 lands.

- [ ] **D1.4 — Commit (held until D2 to keep the change atomic).**

---

### Task D2: Customer project detail view

**Files:**
- Create: `views/customer/projects/show.ejs`
- Modify: `views/customer/projects/list.ejs` (wrap each project card with a link to `/customer/projects/:id`)

The view renders, per phase: status pill (re-using the same `statusPillFor` helper as admin but customer-facing labels), label as h3, started_at / completed_at timestamps, and the checklist items as a read-only list with a `☑` / `☐` indicator. No write controls.

- [ ] **D2.1 — Create the view.**

Create `views/customer/projects/show.ejs`:

```ejs
<%
  function statusPillFor(status) {
    var key = status === 'done' ? 'paid'
            : status === 'blocked' ? 'pending'
            : status === 'in_progress' ? 'active'
            : 'archived';
    var label = status === 'in_progress' ? 'in progress'
              : status === 'blocked' ? 'blocked — waiting on us'
              : status; // done | not_started (shouldn't appear)
    return '<span class="status-pill status-pill--' + key + '">' + label + '</span>';
  }
%>

<%- include('../../components/_page-header', {
  eyebrow: 'PROJECTS',
  title: project.name,
  subtitle: project.objeto_proyecto || ''
}) %>

<% if (!phases || phases.length === 0) { %>
  <p class="empty-state">No active phases yet. Once we start work, you'll see progress here.</p>
<% } else { %>
  <ol class="customer-phase-list">
    <% phases.forEach(function(p) { %>
      <article class="customer-phase" data-status="<%= p.status %>">
        <header class="customer-phase__header">
          <h3 class="customer-phase__label"><%= p.label %></h3>
          <%- statusPillFor(p.status) %>
        </header>
        <% if (p.started_at) { %>
          <p class="customer-phase__meta">
            In progress since <%= euDate(p.started_at) %>
            <% if (p.completed_at) { %> · completed <%= euDate(p.completed_at) %><% } %>
          </p>
        <% } %>

        <% if (p.items && p.items.length > 0) { %>
          <ul class="customer-checklist">
            <% p.items.forEach(function(it) { %>
              <li class="customer-checklist__item" data-done="<%= it.done_at ? 'true' : 'false' %>">
                <span class="customer-checklist__icon" aria-hidden="true"><%= it.done_at ? '☑' : '☐' %></span>
                <span class="customer-checklist__label"><%= it.label %></span>
                <% if (it.done_at) { %>
                  <span class="customer-checklist__when">done <%= euDate(it.done_at) %></span>
                <% } %>
              </li>
            <% }) %>
          </ul>
        <% } %>
      </article>
    <% }) %>
  </ol>
<% } %>
```

- [ ] **D2.2 — Update the projects list view to link.**

In `views/customer/projects/list.ejs`, wrap the existing `<article class="card">…</article>` in `<a class="card-link" href="/customer/projects/<%= p.id %>">…</a>` (or set the article's outer wrapper to be a link — match the existing pattern for clickable cards if one exists).

- [ ] **D2.3 — Append CSS.**

```css
.customer-phase-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 16px; }
.customer-phase {
  padding: 16px 20px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border-subtle, #e5e7eb);
  border-radius: 10px;
}
.customer-phase[data-status="blocked"] { border-left: 3px solid var(--color-warning, #f59e0b); }
.customer-phase[data-status="done"] { opacity: 0.85; }
.customer-phase__header { display: flex; align-items: center; gap: 12px; }
.customer-phase__label { margin: 0; font-size: 18px; }
.customer-phase__meta { margin: 6px 0 12px 0; color: var(--color-ink-500, #64748b); font-size: 14px; }
.customer-checklist { list-style: none; padding: 0; margin: 8px 0 0 0; display: flex; flex-direction: column; gap: 4px; }
.customer-checklist__item { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; }
.customer-checklist__item[data-done="true"] .customer-checklist__label { text-decoration: line-through; opacity: 0.65; }
.customer-checklist__icon { width: 16px; }
.customer-checklist__when { color: var(--color-ink-500, #64748b); font-size: 12px; }
```

- [ ] **D2.4 — Build, restart, smoke.**

```bash
sudo -u portal-app env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

- [ ] **D2.5 — Manual probe (customer login).**

Sign in as a test customer, navigate to /customer/projects, click a project. The new detail page should render with phases (only `in_progress`/`blocked`/`done`) and visible-to-customer checklist items. Phases in `not_started` MUST be absent.

- [ ] **D2.6 — Kimi review on the new customer view.**
- [ ] **D2.7 — Codex review for Phase D.**
- [ ] **D2.8 — Commit (covers both D1 + D2).**

```bash
cd /opt/dbstudio_portal
git add routes/customer/projects.js views/customer/projects/show.ejs views/customer/projects/list.ejs public/styles/app.src.css public/styles/app.css
git commit -m "$(cat <<'EOF'
feat(phases): customer-side project detail page with phases + checklist

New GET /customer/projects/:projectId route renders a read-only
phase + checklist view scoped to the customer. Filter rules per
design Decision 4: phases in status not_started are filtered out at
the route layer; items where visible_to_customer = false are also
filtered out. The list page now links each card to the new detail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase E — Digest

### Task E1: Add new event types to `lib/digest-strings.js`

**Files:**
- Modify: `lib/digest-strings.js`

Insert ten new entries in the top-level `T` map (one per `action` from the audit taxonomy), each with `en` / `nl` / `es` keys returning a string. NL/ES mirror EN until the deferred i18n grind, matching the existing convention for `credential.created` etc.

- [ ] **E1.1 — Append the new entries.**

Open `lib/digest-strings.js` and add the following entries inside the `T` object, alphabetically grouped near the existing `phase.*` entries (`project.created` / `project.status_changed`):

```javascript
'phase.created': {
  en: ({ customerName, phaseLabel, recipient }) => recipient === 'customer'
    ? `New project phase added: ${phaseLabel}`
    : `${customerName ?? 'Customer'} got a new project phase: ${phaseLabel}`,
  nl: ({ customerName, phaseLabel, recipient }) => recipient === 'customer'
    ? `New project phase added: ${phaseLabel}`
    : `${customerName ?? 'Customer'} got a new project phase: ${phaseLabel}`,
  es: ({ customerName, phaseLabel, recipient }) => recipient === 'customer'
    ? `New project phase added: ${phaseLabel}`
    : `${customerName ?? 'Customer'} got a new project phase: ${phaseLabel}`,
},
'phase.renamed': {
  en: ({ customerName, oldLabel, newLabel, recipient }) => recipient === 'customer'
    ? `Phase ${oldLabel} renamed to ${newLabel}`
    : `${customerName ?? 'Customer'}: phase ${oldLabel} → ${newLabel}`,
  nl: ({ customerName, oldLabel, newLabel, recipient }) => recipient === 'customer'
    ? `Phase ${oldLabel} renamed to ${newLabel}`
    : `${customerName ?? 'Customer'}: phase ${oldLabel} → ${newLabel}`,
  es: ({ customerName, oldLabel, newLabel, recipient }) => recipient === 'customer'
    ? `Phase ${oldLabel} renamed to ${newLabel}`
    : `${customerName ?? 'Customer'}: phase ${oldLabel} → ${newLabel}`,
},
'phase.reordered': {
  en: ({ customerName, phaseLabel }) => `${customerName ?? 'Customer'}: reordered phase ${phaseLabel}`,
  nl: ({ customerName, phaseLabel }) => `${customerName ?? 'Customer'}: reordered phase ${phaseLabel}`,
  es: ({ customerName, phaseLabel }) => `${customerName ?? 'Customer'}: reordered phase ${phaseLabel}`,
},
'phase.deleted': {
  en: ({ customerName, phaseLabel, recipient }) => recipient === 'customer'
    ? `Phase ${phaseLabel} was removed from your project`
    : `${customerName ?? 'Customer'}: phase ${phaseLabel} removed`,
  nl: ({ customerName, phaseLabel, recipient }) => recipient === 'customer'
    ? `Phase ${phaseLabel} was removed from your project`
    : `${customerName ?? 'Customer'}: phase ${phaseLabel} removed`,
  es: ({ customerName, phaseLabel, recipient }) => recipient === 'customer'
    ? `Phase ${phaseLabel} was removed from your project`
    : `${customerName ?? 'Customer'}: phase ${phaseLabel} removed`,
},
'phase.status_changed': {
  en: ({ customerName, phaseLabel, to, recipient }) => {
    var stateText = to === 'in_progress' ? 'is now in progress'
                  : to === 'blocked' ? 'is blocked — waiting on us'
                  : to === 'done' ? 'is complete'
                  : 'reset to not started';
    return recipient === 'customer'
      ? `Phase ${phaseLabel} ${stateText}`
      : `${customerName ?? 'Customer'}: phase ${phaseLabel} ${stateText}`;
  },
  nl: ({ customerName, phaseLabel, to, recipient }) => {
    var stateText = to === 'in_progress' ? 'is now in progress'
                  : to === 'blocked' ? 'is blocked — waiting on us'
                  : to === 'done' ? 'is complete'
                  : 'reset to not started';
    return recipient === 'customer'
      ? `Phase ${phaseLabel} ${stateText}`
      : `${customerName ?? 'Customer'}: phase ${phaseLabel} ${stateText}`;
  },
  es: ({ customerName, phaseLabel, to, recipient }) => {
    var stateText = to === 'in_progress' ? 'is now in progress'
                  : to === 'blocked' ? 'is blocked — waiting on us'
                  : to === 'done' ? 'is complete'
                  : 'reset to not started';
    return recipient === 'customer'
      ? `Phase ${phaseLabel} ${stateText}`
      : `${customerName ?? 'Customer'}: phase ${phaseLabel} ${stateText}`;
  },
},
'phase_checklist.created': {
  en: ({ customerName, phaseLabel, itemLabel, recipient }) => recipient === 'customer'
    ? `New item in phase ${phaseLabel}: ${itemLabel}`
    : `${customerName ?? 'Customer'}: new checklist item in phase ${phaseLabel} — ${itemLabel}`,
  nl: ({ customerName, phaseLabel, itemLabel, recipient }) => recipient === 'customer'
    ? `New item in phase ${phaseLabel}: ${itemLabel}`
    : `${customerName ?? 'Customer'}: new checklist item in phase ${phaseLabel} — ${itemLabel}`,
  es: ({ customerName, phaseLabel, itemLabel, recipient }) => recipient === 'customer'
    ? `New item in phase ${phaseLabel}: ${itemLabel}`
    : `${customerName ?? 'Customer'}: new checklist item in phase ${phaseLabel} — ${itemLabel}`,
},
'phase_checklist.renamed': {
  en: ({ customerName, phaseLabel, oldLabel, newLabel, recipient }) => recipient === 'customer'
    ? `Updated checklist item in phase ${phaseLabel}: ${oldLabel} → ${newLabel}`
    : `${customerName ?? 'Customer'}: phase ${phaseLabel} item ${oldLabel} → ${newLabel}`,
  nl: ({ customerName, phaseLabel, oldLabel, newLabel, recipient }) => recipient === 'customer'
    ? `Updated checklist item in phase ${phaseLabel}: ${oldLabel} → ${newLabel}`
    : `${customerName ?? 'Customer'}: phase ${phaseLabel} item ${oldLabel} → ${newLabel}`,
  es: ({ customerName, phaseLabel, oldLabel, newLabel, recipient }) => recipient === 'customer'
    ? `Updated checklist item in phase ${phaseLabel}: ${oldLabel} → ${newLabel}`
    : `${customerName ?? 'Customer'}: phase ${phaseLabel} item ${oldLabel} → ${newLabel}`,
},
'phase_checklist.toggled': {
  en: ({ customerName, phaseLabel, itemLabel, done, count = 1, recipient }) => {
    if (count > 1) {
      return recipient === 'customer'
        ? `${count} checklist items updated in phase ${phaseLabel}`
        : `${customerName ?? 'Customer'}: ${count} items updated in phase ${phaseLabel}`;
    }
    var verb = done ? 'completed' : 'reopened';
    return recipient === 'customer'
      ? `${verb === 'completed' ? 'We completed' : 'We reopened'} a checklist item in phase ${phaseLabel}: ${itemLabel}`
      : `${customerName ?? 'Customer'}: ${verb} item in phase ${phaseLabel} — ${itemLabel}`;
  },
  nl: ({ customerName, phaseLabel, itemLabel, done, count = 1, recipient }) => {
    if (count > 1) {
      return recipient === 'customer'
        ? `${count} checklist items updated in phase ${phaseLabel}`
        : `${customerName ?? 'Customer'}: ${count} items updated in phase ${phaseLabel}`;
    }
    var verb = done ? 'completed' : 'reopened';
    return recipient === 'customer'
      ? `${verb === 'completed' ? 'We completed' : 'We reopened'} a checklist item in phase ${phaseLabel}: ${itemLabel}`
      : `${customerName ?? 'Customer'}: ${verb} item in phase ${phaseLabel} — ${itemLabel}`;
  },
  es: ({ customerName, phaseLabel, itemLabel, done, count = 1, recipient }) => {
    if (count > 1) {
      return recipient === 'customer'
        ? `${count} checklist items updated in phase ${phaseLabel}`
        : `${customerName ?? 'Customer'}: ${count} items updated in phase ${phaseLabel}`;
    }
    var verb = done ? 'completed' : 'reopened';
    return recipient === 'customer'
      ? `${verb === 'completed' ? 'We completed' : 'We reopened'} a checklist item in phase ${phaseLabel}: ${itemLabel}`
      : `${customerName ?? 'Customer'}: ${verb} item in phase ${phaseLabel} — ${itemLabel}`;
  },
},
'phase_checklist.visibility_changed': {
  en: ({ customerName, phaseLabel, itemLabel }) => `${customerName ?? 'Customer'}: visibility flipped on item in phase ${phaseLabel} — ${itemLabel}`,
  nl: ({ customerName, phaseLabel, itemLabel }) => `${customerName ?? 'Customer'}: visibility flipped on item in phase ${phaseLabel} — ${itemLabel}`,
  es: ({ customerName, phaseLabel, itemLabel }) => `${customerName ?? 'Customer'}: visibility flipped on item in phase ${phaseLabel} — ${itemLabel}`,
},
'phase_checklist.deleted': {
  en: ({ customerName, phaseLabel, itemLabel, recipient }) => recipient === 'customer'
    ? `Removed a checklist item from phase ${phaseLabel}: ${itemLabel}`
    : `${customerName ?? 'Customer'}: removed item from phase ${phaseLabel} — ${itemLabel}`,
  nl: ({ customerName, phaseLabel, itemLabel, recipient }) => recipient === 'customer'
    ? `Removed a checklist item from phase ${phaseLabel}: ${itemLabel}`
    : `${customerName ?? 'Customer'}: removed item from phase ${phaseLabel} — ${itemLabel}`,
  es: ({ customerName, phaseLabel, itemLabel, recipient }) => recipient === 'customer'
    ? `Removed a checklist item from phase ${phaseLabel}: ${itemLabel}`
    : `${customerName ?? 'Customer'}: removed item from phase ${phaseLabel} — ${itemLabel}`,
},
```

- [ ] **E1.2 — Restart and verify titleFor outputs sane strings.**

```bash
sudo systemctl restart portal.service
sudo -u portal-app /opt/dbstudio_portal/.node/bin/node -e '
import("./lib/digest-strings.js").then(({ titleFor }) => {
  console.log(titleFor("phase.status_changed", "en", { customerName: "Acme", phaseLabel: "1", to: "in_progress", recipient: "admin" }));
  console.log(titleFor("phase_checklist.toggled", "en", { phaseLabel: "1", itemLabel: "Send invoice", done: true, recipient: "customer", count: 1 }));
  console.log(titleFor("phase_checklist.toggled", "en", { phaseLabel: "1", count: 3, recipient: "customer" }));
});
'
```

Expected sample output:
```
Acme: phase 1 is now in progress
We completed a checklist item in phase 1: Send invoice
3 checklist items updated in phase 1
```

- [ ] **E1.3 — Commit.**

```bash
cd /opt/dbstudio_portal
git add lib/digest-strings.js
git commit -m "feat(phases): titleFor strings for the 10 new phase/checklist event types

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task E2: Add `phase_checklist.toggled` to `COALESCING_EVENTS`

**Files:**
- Modify: `lib/digest.js`

- [ ] **E2.1 — Add the entry.**

In `lib/digest.js`, change the `COALESCING_EVENTS` Set:

```javascript
export const COALESCING_EVENTS = new Set([
  'document.uploaded',
  'document.downloaded',
  'credential.viewed',
  'credential.created',
  'phase_checklist.toggled',
]);
```

- [ ] **E2.2 — Verify the existing pluraliseTitle path uses `titleFor` for the new event type.**

The `pluraliseTitle` function already calls `titleFor(eventType, locale, { ...vars, count })` when `vars + locale` are passed (the post-Phase-F path). The Phase-B legacy fallback `map` at lines 27–32 doesn't have an entry for `phase_checklist.toggled`; reaching it would return `${oldTitle} (+${count - 1} more)`. The service ALWAYS passes `vars + locale` (we set them in `recordForDigest` calls in Tasks A3 / C2), so the `titleFor` path is taken — and `phase_checklist.toggled.en(...)` honours `count` properly. No change to `pluraliseTitle` required.

- [ ] **E2.3 — Restart, smoke.**
- [ ] **E2.4 — Commit.**

```bash
cd /opt/dbstudio_portal
git add lib/digest.js
git commit -m "feat(phases): coalesce phase_checklist.toggled per recipient

Eight checkbox toggles in 10 minutes become a single digest line
'3 checklist items updated in phase 1' instead of three lines, per
design Decision 5. Other phase.* events remain non-coalescing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task E3: Digest fan-out test — coalescing for `phase_checklist.toggled`

**Files:**
- Create: `tests/integration/phase-checklists/digest-coalescing.test.js`

- [ ] **E3.1 — Write the test.**

```javascript
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesService from '../../../domain/phases/service.js';
import * as checklistService from '../../../domain/phase-checklists/service.js';
import { makeTag, makeAdmin, makeCustomerAndProject, baseCtx, cleanupByTag } from '../phases/_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('phase_checklist.toggled coalesces per phase per recipient', () => {
  const tag = makeTag();
  let db, adminId, customerId, projectId, phaseId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'coal');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
    const phase = await phasesService.create(db, { projectId, customerId, label: 'P' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    phaseId = phase.phaseId;
    await phasesService.changeStatus(db, { phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  it('three toggles within the window produce one coalesced digest row per recipient', async () => {
    const items = [];
    for (let i = 0; i < 3; i++) {
      const it = await checklistService.create(db, { phaseId, customerId },
        { label: `i${i}`, visibleToCustomer: true },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });
      items.push(it.itemId);
    }
    for (const id of items) {
      await checklistService.toggleDone(db, { itemId: id, customerId }, { done: true },
        { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    }

    const customerRows = await sql`
      SELECT * FROM pending_digest_items
       WHERE event_type = 'phase_checklist.toggled'
         AND recipient_type = 'customer'
         AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(customerRows.rows).toHaveLength(1);
    expect(Number(customerRows.rows[0].metadata.count)).toBe(3);
    expect(customerRows.rows[0].title).toMatch(/3 checklist items updated/i);
  });
});
```

- [ ] **E3.2 — Run, expect PASS** (`recordForDigest` already implements coalescing for events in `COALESCING_EVENTS`; we're confirming the new entry works).

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phase-checklists/digest-coalescing.test.js
```

- [ ] **E3.3 — Codex review for Phase E.**
- [ ] **E3.4 — Commit.**

```bash
cd /opt/dbstudio_portal
git add tests/integration/phase-checklists/digest-coalescing.test.js
git commit -m "test(phases): coalescing for phase_checklist.toggled

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase F — Acceptance

### Task F1: End-to-end integration test

**Files:**
- Create: `tests/integration/phases/end-to-end.test.js`

Single test that walks the full happy path: admin creates phase + checklist items → opens phase → toggles items → completes phase → verifies customer activity feed shows the right events and admin activity feed shows everything.

- [ ] **F1.1 — Write the test.**

```javascript
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as phasesService from '../../../domain/phases/service.js';
import * as checklistService from '../../../domain/phase-checklists/service.js';
import { listActivityForCustomer } from '../../../lib/activity-feed.js';
import { makeTag, makeAdmin, makeCustomerAndProject, baseCtx, cleanupByTag } from './_helpers.js';

const skip = process.env.RUN_DB_TESTS !== '1';

describe.skipIf(skip)('phases + checklists end-to-end', () => {
  const tag = makeTag();
  let db, adminId, customerId, projectId;

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    adminId = await makeAdmin(db, tag);
    const ctx = await makeCustomerAndProject(db, tag, 'e2e');
    customerId = ctx.customerId;
    projectId = ctx.projectId;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanupByTag(db, tag);
    await db.destroy();
  });

  it('full lifecycle: create phase → open → checklist toggle → done → customer activity feed', async () => {
    // 1. Admin creates phase 1 (not_started — invisible to customer).
    const p1 = await phasesService.create(db, { projectId, customerId, label: '1' },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    // 2. Admin pre-populates checklist while phase is not_started — also invisible.
    const i1 = await checklistService.create(db, { phaseId: p1.phaseId, customerId },
      { label: 'Spec the schema', visibleToCustomer: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    const i2 = await checklistService.create(db, { phaseId: p1.phaseId, customerId },
      { label: 'Internal review', visibleToCustomer: false },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    // Customer activity feed: nothing yet.
    let feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    expect(feed.filter(r => r.action.startsWith('phase'))).toHaveLength(0);

    // 3. Admin opens the phase.
    await phasesService.changeStatus(db, { phaseId: p1.phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    // Customer NOW sees: phase.status_changed (to in_progress).
    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const statusChanges = feed.filter(r => r.action === 'phase.status_changed');
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0].metadata.to).toBe('in_progress');

    // 4. Admin toggles a customer-visible item done.
    await checklistService.toggleDone(db, { itemId: i1.itemId, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    // Toggle the admin-only item done — must NOT appear in customer feed.
    await checklistService.toggleDone(db, { itemId: i2.itemId, customerId }, { done: true },
      { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const toggles = feed.filter(r => r.action === 'phase_checklist.toggled');
    expect(toggles).toHaveLength(1);
    expect(toggles[0].metadata.itemLabel).toBe('Spec the schema');

    // 5. Admin marks phase done.
    await phasesService.changeStatus(db, { phaseId: p1.phaseId, customerId },
      { newStatus: 'done' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const finalStatusChange = feed.filter(r => r.action === 'phase.status_changed').pop();
    expect(finalStatusChange.metadata.to).toBe('done');

    // 6. Admin reverts to in_progress (admin-only).
    await phasesService.changeStatus(db, { phaseId: p1.phaseId, customerId },
      { newStatus: 'in_progress' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });

    // The customer DOES see this (still phaseVisible). Different from a → not_started revert.
    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const reopened = feed.filter(r => r.action === 'phase.status_changed' && r.metadata.from === 'done').pop();
    expect(reopened).toBeTruthy();
    expect(reopened.metadata.to).toBe('in_progress');

    // 7. Admin reverts all the way to not_started — customer must NOT see it.
    await phasesService.changeStatus(db, { phaseId: p1.phaseId, customerId },
      { newStatus: 'not_started' }, { ...baseCtx(tag), actorType: 'admin' }, { adminId });
    feed = await listActivityForCustomer(db, customerId, { limit: 50 });
    const toNotStarted = feed.filter(r => r.action === 'phase.status_changed' && r.metadata.to === 'not_started');
    expect(toNotStarted).toHaveLength(0); // admin-only audit
  });
});
```

> Verified export: `listActivityForCustomer(db, customerId, opts)` in `lib/activity-feed.js:76` (Codex review).

- [ ] **F1.2 — Run, expect PASS.**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/phases/end-to-end.test.js
```

- [ ] **F1.3 — Run the FULL test suite.**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: every existing test still green; new tests green.

- [ ] **F1.4 — Commit.**

```bash
cd /opt/dbstudio_portal
git add tests/integration/phases/end-to-end.test.js
git commit -m "test(phases): end-to-end happy-path covering admin workflow + customer feed filter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task F2: Final reviews + follow-ups update

**Files:**
- Modify: `docs/superpowers/follow-ups.md`

- [ ] **F2.1 — Final Codex review of the entire feature.**

```bash
codex-review-prompt --repo /opt/dbstudio_portal
```

Invoke superpowers:code-reviewer; resolve every BLOCK. APPROVE or APPROVE WITH CHANGES is the gate.

- [ ] **F2.2 — Final Kimi review of the UI surfaces.**

```bash
kimi-design-review --repo /opt/dbstudio_portal
```

- [ ] **F2.3 — Update follow-ups.md.**

In `docs/superpowers/follow-ups.md`:
- Add a new section under "✅ Shipped in Phase G" (or create that section if missing):
  ```
  ### ✅ Shipped post-Phase-G — phases + checklists (2026-05-XX)

  - Migration 0013, two new domains (phases, phase-checklists), admin
    UI extension on project detail, new customer project detail page.
    Audit + digest fan-out wired with visible_to_customer baked at
    write time per design Decision 8.

  Spec: docs/superpowers/specs/2026-05-03-phases-checklists-design.md
  Plan: docs/superpowers/plans/2026-05-03-phases-checklists-implementation.md
  Commits: <list final commit shas after they exist>
  ```
- Confirm the "Items deferred to a separate brainstorming session" entry for phases is gone (it was the trigger for this work).
- Leave the "Digest cadence revert (Phase G #1)" still pending — that's a separate ticket.

- [ ] **F2.4 — Smoke test.**

```bash
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

- [ ] **F2.5 — Final commit.**

```bash
cd /opt/dbstudio_portal
git add docs/superpowers/follow-ups.md
git commit -m "docs(phases): record phases+checklists ship in follow-ups.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **F2.6 — Hold on push.**

Per `~/.claude/CLAUDE.md`, do NOT `git push` without an explicit operator instruction. Once the operator says "push it" or "deploy it", run `git push origin main` and follow the standard portal deploy procedure documented in RUNBOOK.md.

---

## Self-review checklist (engineer runs at end)

- [ ] All 10 design decisions implemented somewhere in the plan above.
- [ ] No file references types or functions that aren't defined in earlier tasks.
- [ ] Every test that asserts an audit row's `visible_to_customer` value matches the rule from spec's "Audit taxonomy" table.
- [ ] No inline JS in any new EJS view (CSP-strict precedent from G3).
- [ ] All POST routes use `app.csrfProtection`.
- [ ] All service mutations are inside `db.transaction()`.
- [ ] `recordForDigest` is called for both admins and customers per the visibility rule.
- [ ] Cross-project / cross-customer integrity guards in place: every admin route with `:phaseId` resolves the phase and 404s if `phase.project_id !== projectId`; every admin route with `:itemId` resolves the item and 404s if `item.phase_id !== phaseId`.
- [ ] Verified imports / exports (Codex review pass): `requireAdminSession` from `lib/auth/middleware.js`; `listActivityForCustomer` from `lib/activity-feed.js`; `listActiveAdmins` + `listActiveCustomerUsers` from `lib/digest-fanout.js`; `recipientType` is `'customer_user'` (not `'customer'`) per the CHECK constraint in migration 0010.
- [ ] `findCustomerById` / `findProjectById` exports verified — if they don't exist in their domain repos, the routes use inline `sql\`SELECT…\`` lookups instead.
- [ ] `lib/activity-feed.js` `SAFE_METADATA_KEYS` extended (Task A0) so phase/checklist metadata reaches the customer slice. Without this the F1 end-to-end test assertions on `metadata.from`, `metadata.to`, `metadata.itemLabel` will see `undefined`.
- [ ] Test helper `baseCtx(tag)` includes `kek: randomBytes(32)` and `portalBaseUrl: 'https://portal.test'` — `domain/customers/service.js` aborts at line 53 without these.

If any check fails, fix it before declaring the feature done.

---

## Out-of-scope reminders

- Digest cadence revert (Phase G #1): still pending. The phases/checklists feature works under twice-daily cadence; the operator-facing UX of "8 toggles within 10 minutes coalesce into one digest line within ~10 minutes" only holds after that revert ships. Track separately.
- "Copy phases from another project" admin convenience action: not in v1.
- Customer write actions on phases / checklists: not in v1.
- Phase / item due dates, dependencies, attachments, comments: not in v1.

---

## Execution choice

After saving this plan, choose execution mode:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using the `superpowers:executing-plans` skill, batch with checkpoints for review.

Reply with **1** or **2**.
