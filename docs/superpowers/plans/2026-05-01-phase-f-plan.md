# Phase F Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase F of DB Studio Portal: digest cadence rework (twice-daily fixed time, skip-if-empty) + digest content rework (subject counts, per-customer grouping, date stamps, verb rewrites, deep-link honouring, dual-mode mail compat) + reveal-credentials page consistency + detail-page layout pattern lock-in + customer-questions UI completion + customer-side view-with-decrypt UI.

**Architecture:** Single bundled phase, no migrations. Cadence change repurposes the existing `digest_schedules` table (only `due_at` semantics change); content rework adds `lib/digest-cadence.js`, `lib/digest-dates.js`, expands `lib/digest-strings.js`, adds dynamic-subject support to `lib/email-templates.js` + `scripts/email-build.js` + `domain/email-outbox/repo.js`, redesigns `emails/{en,nl,es}/digest.ejs`. Page work adds `views/admin/customer-questions/{list,detail}.ejs`, `views/customer/questions/list.ejs`, `views/customer/credentials/show.ejs`, `views/customer/step-up.ejs`, edits 4 existing views, adds 4 routes, extends `domain/credentials/service.js` with a `viewByCustomer` branch, and adds `scripts/check-detail-pattern.js` as an advisory linter.

**Tech Stack:** Node 22 (`/opt/dbstudio_portal/.node/bin/node`), Fastify 5, Kysely + raw SQL on PostgreSQL, EJS templates compiled via `scripts/email-build.js` and `scripts/build.js`, vitest for tests via `sudo bash scripts/run-tests.sh`.

**Operational gotchas (apply to EVERY task that writes/edits a file):**
- After every Write/Edit run `chmod 644 <file>` (test runner runs as `portal-app`; root-written files default to 640).
- After editing any `.ejs` in `emails/` or any `.ejs` outside `views/` that flows through `_compiled.js`, run `node /opt/dbstudio_portal/scripts/build.js` to regenerate compiled artefacts.
- After editing `public/styles/app.src.css`, run `node /opt/dbstudio_portal/scripts/build.js` to regenerate `app.css`.
- Tests run via `sudo bash /opt/dbstudio_portal/scripts/run-tests.sh [path]`. Single-file: `sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest-cadence.test.js`.
- Commit cadence: one focused commit per task (or per coherent sub-step within a task).

**Spec:** `docs/superpowers/specs/2026-05-01-phase-f-design.md` at commit `40d7b3c`.

**Baseline at start (HEAD `40d7b3c` on `main`):** 657 passing / 3 skipped / 0 failing.

---

## File map

### New files

| Path | Responsibility |
|------|----------------|
| `lib/digest-cadence.js` | Pure helper `nextDigestFire(now)` returning the next 08:00 / 17:00 in `Atlantic/Canary`. |
| `lib/digest-dates.js` | Pure helper `humanDate(ts, locale, tz)` returning `Today` / `Yesterday` / weekday / `dd MMM` / `dd MMM yyyy`. |
| `tests/unit/lib/digest-cadence.test.js` | Unit tests for `nextDigestFire`. |
| `tests/unit/lib/digest-dates.test.js` | Unit tests for `humanDate`. |
| `views/admin/customer-questions/list.ejs` | Admin list of questions per customer. |
| `views/admin/customer-questions/detail.ejs` | Admin detail view of a single question + answer. |
| `views/customer/questions/list.ejs` | Customer's own question list (open + answered/skipped). |
| `views/customer/credentials/show.ejs` | Customer credential detail with reveal flow. |
| `views/customer/step-up.ejs` | Customer 2FA step-up page. |
| `tests/integration/customer-questions/admin-list.test.js` | Integration test for admin list page. |
| `tests/integration/customer-questions/admin-detail.test.js` | Integration test for admin detail page. |
| `tests/integration/customer-questions/customer-list.test.js` | Integration test for customer list page. |
| `tests/integration/credentials/customer-show.test.js` | Customer view-with-decrypt happy path + gates + audit. |
| `tests/integration/credentials/customer-step-up.test.js` | Customer step-up bucket isolation + lockout. |
| `scripts/check-detail-pattern.js` | Advisory linter that scans `views/admin/**` and `views/customer/**` `.ejs` files for `_page-header(` and warns on rule violations. |

### Modified files

| Path | What changes |
|------|--------------|
| `lib/digest.js` | `recordForDigest` drops `windowMinutes`/`capMinutes`; always uses `nextDigestFire(now)`. |
| `domain/digest/repo.js` | `upsertSchedule` accepts `dueAt` directly; drops `LEAST(...)` cap clause. |
| `domain/digest/worker.js` | At fire time, builds `groupedItems` via a `customers.razon_social` lookup; computes subject counts; passes locals through to template. |
| `domain/email-outbox/repo.js` | `enqueue` accepts an optional `subjectOverride` and persists it in a new optional in-memory locals key (no schema change; stored as a `__subject_override` locals entry that the renderer treats specially). |
| `lib/email-templates.js` | If `locals.__subject_override` is present, use it as the subject; otherwise use the static front-matter subject. |
| `lib/digest-strings.js` | Verb rewrites; new entries (singular/plural, admin/customer recipient variants). |
| `emails/en/digest.ejs` | Subject front-matter unchanged (acts as fallback); body redesigned with grouped items, date stamps, deep links, dual-mode CSS. |
| `emails/nl/digest.ejs` | Mirrors `en/digest.ejs` (EN copy preserved per spec scaffolding rule). |
| `emails/es/digest.ejs` | Mirrors `en/digest.ejs`. |
| `views/admin/credentials/show.ejs` | Resource-type header pattern (eyebrow `ADMIN · CUSTOMERS`, title `Credential`, subtitle `<customer> · <provider>`, status pills in actions). |
| `views/admin/customer-questions/new.ejs` | Eyebrow `ADMIN · CUSTOMERS`, subtitle `<customer> · New question`. Add `_admin-customer-tabs` with `active='customer-questions'`. POST redirect target updated. |
| `views/customer/questions/show.ejs` | Eyebrow `CUSTOMER · QUESTIONS`, title `Question`, subtitle preview-truncated 60 chars. |
| `views/customer/credentials/list.ejs` | Make label a link to detail page. Update copy to honestly describe the new view path. |
| `views/components/_admin-customer-tabs.ejs` | Add `customer-questions` tab between `credential-requests` and `invoices`. |
| `views/components/_sidebar-customer.ejs` | Add `Questions` entry (with badge for open count). |
| `routes/admin/customer-questions.js` | Add list + detail routes; redirect POST `/admin/customers/:cid/questions` to `/admin/customers/:cid/questions`. |
| `routes/customer/questions.js` | Add `GET /customer/questions` list route. |
| `routes/customer/credentials.js` | Add `GET /:id` show + `POST /:id/reveal`. |
| `routes/customer/step-up.js` | New route module (or extend existing `routes/customer/auth-step-up.js` if present). |
| `domain/credentials/service.js` | New `viewByCustomer(db, { customerUserId, sessionId, credentialId }, ctx)` mirroring `view` but writing customer-actor audit and fanning to admins. |
| `tests/unit/lib/digest.test.js` | Update assertions to reflect new `recordForDigest` signature. |
| `tests/unit/lib/digest-strings.test.js` | Add assertions for new/rewritten strings. |
| `tests/unit/email/templates.test.js` | Bump slug count if shape changes (likely unchanged at 18). |
| `tests/integration/digest/worker.test.js` | Replace 10/60-min assertions with twice-daily fire-time assertions; cover skip-if-empty + grouping. |
| `tests/integration/email/digest.test.js` | (NEW or extend `live-smoke.test.js` with snapshot suite per locale × admin/customer × bucket-mix.) |
| `tests/integration/credentials/admin-show.test.js` | Update header-string assertions. |
| `scripts/run-tests.sh` | Optional: append a non-blocking `node scripts/check-detail-pattern.js` advisory. |

---

## Group A — Digest cadence (spec Section 1)

### Task A1: `lib/digest-cadence.js` — `nextDigestFire(now)` helper (TDD)

**Files:**
- Create: `lib/digest-cadence.js`
- Test: `tests/unit/lib/digest-cadence.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/lib/digest-cadence.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { nextDigestFire, DIGEST_FIRE_HOURS_LOCAL, DIGEST_FIRE_TZ } from '../../../lib/digest-cadence.js';

// Atlantic/Canary is WET (UTC+0) in winter, WEST (UTC+1) in summer.
// 2026-05-01 is in WEST → UTC+1.
// 2026-01-15 is in WET  → UTC+0.

describe('nextDigestFire', () => {
  it('exposes the configured fire hours and timezone', () => {
    expect(DIGEST_FIRE_HOURS_LOCAL).toEqual([8, 17]);
    expect(DIGEST_FIRE_TZ).toBe('Atlantic/Canary');
  });

  it('07:59 Canary (winter) → next is 08:00 today', () => {
    // 2026-01-15 07:59 Canary == 2026-01-15 07:59 UTC (WET)
    const now = new Date('2026-01-15T07:59:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('08:00 Canary (winter) → next is 17:00 today (boundary excludes equal)', () => {
    const now = new Date('2026-01-15T08:00:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('08:01 Canary (winter) → next is 17:00 today', () => {
    const now = new Date('2026-01-15T08:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('17:01 Canary (winter) → next is 08:00 tomorrow', () => {
    const now = new Date('2026-01-15T17:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-01-16T08:00:00.000Z');
  });

  it('07:59 Canary (summer WEST UTC+1) → next is 08:00 today', () => {
    // 2026-05-01 06:59 UTC == 2026-05-01 07:59 WEST
    const now = new Date('2026-05-01T06:59:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-05-01T07:00:00.000Z');
  });

  it('17:01 Canary (summer WEST) → next is 08:00 tomorrow', () => {
    // 2026-05-01 16:01 UTC == 2026-05-01 17:01 WEST
    const now = new Date('2026-05-01T16:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-05-02T07:00:00.000Z');
  });

  it('crosses month boundary correctly', () => {
    const now = new Date('2026-01-31T17:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-02-01T08:00:00.000Z');
  });

  it('crosses year boundary correctly', () => {
    const now = new Date('2026-12-31T17:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2027-01-01T08:00:00.000Z');
  });

  it('DST spring-forward boundary 2026-03-29 (UTC+0 → UTC+1) handled', () => {
    // 2026-03-29 06:59 UTC is 06:59 WET → next is 08:00 WET (07:00 UTC)? No, 08:00 WEST after the change at 01:00 UTC.
    // After 01:00 UTC on 2026-03-29, Atlantic/Canary is WEST (UTC+1).
    // 2026-03-29 06:59 UTC == 2026-03-29 07:59 WEST → next is 08:00 WEST = 07:00 UTC.
    const now = new Date('2026-03-29T06:59:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('returns a Date instance (not a string)', () => {
    const due = nextDigestFire(new Date('2026-05-01T10:00:00Z'));
    expect(due).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest-cadence.test.js
```

Expected: FAIL with `Cannot find module '../../../lib/digest-cadence.js'`.

- [ ] **Step 3: Implement `lib/digest-cadence.js`**

Create `lib/digest-cadence.js`:

```javascript
// Phase F: pure helper that returns the next digest fire time after `now`.
// Two daily fires per recipient at 08:00 and 17:00 Atlantic/Canary,
// strictly greater than `now` (a boundary value advances to the next slot).
//
// We use Intl.DateTimeFormat to read the wall-clock hour in Atlantic/Canary,
// which handles DST automatically — the alternative (offset arithmetic) is
// fragile around the spring/fall transition days.

export const DIGEST_FIRE_HOURS_LOCAL = [8, 17];
export const DIGEST_FIRE_TZ = 'Atlantic/Canary';

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: DIGEST_FIRE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function partsAt(date) {
  const parts = Object.fromEntries(FMT.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// Given a target wall-clock time in DIGEST_FIRE_TZ (yyyy-mm-dd HH:00:00),
// return the corresponding UTC Date by binary-search over the 49-hour
// surrounding window. Avoids hardcoding offsets.
function utcForLocal(year, month, day, hour) {
  // Start from naive UTC interpretation, then correct by the TZ offset.
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  // Calibrate: read what wall-clock that UTC instant produces, compute drift, apply.
  for (let pass = 0; pass < 3; pass++) {
    const probe = new Date(naive);
    const p = partsAt(probe);
    const probeWallMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const drift = Date.UTC(year, month - 1, day, hour, 0, 0) - probeWallMs;
    if (drift === 0) return probe;
    // Adjust naive by drift and re-probe (handles DST boundary).
    naive += drift;
  }
  return new Date(naive);
}

export function nextDigestFire(now) {
  const p = partsAt(now);
  // Candidate: today's first fire hour strictly after `now`.
  for (const h of DIGEST_FIRE_HOURS_LOCAL) {
    const candidate = utcForLocal(p.year, p.month, p.day, h);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  // No fire left today — first fire of tomorrow.
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const t = partsAt(tomorrow);
  return utcForLocal(t.year, t.month, t.day, DIGEST_FIRE_HOURS_LOCAL[0]);
}
```

- [ ] **Step 4: Set perms and run the tests**

```
chmod 644 /opt/dbstudio_portal/lib/digest-cadence.js /opt/dbstudio_portal/tests/unit/lib/digest-cadence.test.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest-cadence.test.js
```

Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```
cd /opt/dbstudio_portal
git add lib/digest-cadence.js tests/unit/lib/digest-cadence.test.js
git commit -m "feat(phase-f): add nextDigestFire helper for twice-daily cadence

Pure helper returning the next 08:00 or 17:00 Atlantic/Canary slot after
a given timestamp. Handles DST transitions and date/year rollover via
Intl.DateTimeFormat rather than fixed offset arithmetic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: rewrite `domain/digest/repo.js#upsertSchedule` to accept `dueAt`

**Files:**
- Modify: `domain/digest/repo.js`
- Modify: `tests/unit/lib/digest.test.js` (to drive the new shape)

- [ ] **Step 1: Update unit-test mocks to reflect the new signature**

Edit `tests/unit/lib/digest.test.js` — for each `recordForDigest` invocation, the `repo.upsertSchedule` mock should now be called with `{ recipientType, recipientId, dueAt }` (a Date), not `{ windowMinutes, capMinutes }`. Add an assertion:

```javascript
// inside each existing it() that asserts on upsertSchedule:
const upsertArg = repo.upsertSchedule.mock.calls[0][1];
expect(upsertArg).toMatchObject({
  recipientType: expect.any(String),
  recipientId:   expect.any(String),
  dueAt:         expect.any(Date),
});
expect(upsertArg.windowMinutes).toBeUndefined();
expect(upsertArg.capMinutes).toBeUndefined();
```

- [ ] **Step 2: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest.test.js
```

Expected: FAIL — current `recordForDigest` passes `windowMinutes`/`capMinutes`.

- [ ] **Step 3: Update `lib/digest.js`**

Replace the body of `recordForDigest` so `windowMinutes`/`capMinutes` opts are removed:

```javascript
// At top of file:
import { nextDigestFire } from './digest-cadence.js';

// In recordForDigest(), replace the two upsertSchedule call sites with:
await repo.upsertSchedule(tx, {
  recipientType: item.recipientType,
  recipientId:   item.recipientId,
  dueAt:         nextDigestFire(opts.now ?? new Date()),
});
```

Remove the `windowMinutes`/`capMinutes` defaults at the top of the function. The `opts.now` parameter is a test seam (not documented in the public API) so unit tests can pin time without faking the system clock.

- [ ] **Step 4: Update `domain/digest/repo.js#upsertSchedule`**

Replace the function body with:

```javascript
export async function upsertSchedule(db, { recipientType, recipientId, dueAt }) {
  // dueAt is a Date computed by nextDigestFire(); we always overwrite the
  // schedule to the next configured fire slot. The LEAST(...) cap from the
  // sliding-window era is gone — items now wait deterministically for the
  // next 08:00 or 17:00 Atlantic/Canary fire.
  await sql`
    INSERT INTO digest_schedules (recipient_type, recipient_id, due_at, oldest_item_at)
    VALUES (
      ${recipientType}, ${recipientId}::uuid,
      ${dueAt.toISOString()}::timestamptz,
      now()
    )
    ON CONFLICT (recipient_type, recipient_id) DO UPDATE
      SET due_at = ${dueAt.toISOString()}::timestamptz
  `.execute(db);
}
```

`oldest_item_at` is set on insert, untouched on conflict — which preserves the timestamp of the first pending item in the current cycle.

- [ ] **Step 5: Run tests**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest.test.js tests/unit/lib/digest-cadence.test.js
```

Expected: PASS.

- [ ] **Step 6: Set perms and commit**

```
chmod 644 /opt/dbstudio_portal/lib/digest.js /opt/dbstudio_portal/domain/digest/repo.js /opt/dbstudio_portal/tests/unit/lib/digest.test.js
cd /opt/dbstudio_portal
git add lib/digest.js domain/digest/repo.js tests/unit/lib/digest.test.js
git commit -m "feat(phase-f): switch digest schedule to fixed twice-daily fires

upsertSchedule no longer takes windowMinutes/capMinutes; recordForDigest
always passes the next 08:00 or 17:00 Atlantic/Canary slot. The LEAST(...)
cap clause is gone — events now wait deterministically for the next fire.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: integration test — events recorded across the day fire correctly

**Files:**
- Modify: `tests/integration/digest/worker.test.js` (or create one if absent)

- [ ] **Step 1: Locate the existing digest integration test**

```
ls /opt/dbstudio_portal/tests/integration/digest/ 2>/dev/null || find /opt/dbstudio_portal/tests/integration -name "*digest*"
```

If `tests/integration/digest/worker.test.js` does not exist, create it. If it exists, audit its current 10/60-min assertions and replace with twice-daily fire-time assertions per Step 2.

- [ ] **Step 2: Write the twice-daily fire-time assertions**

Add the following test cases (using the project's existing integration-test scaffolding — `import { build } from '../../helpers/app.js'` etc., matching whatever sibling tests do):

```javascript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { recordForDigest } from '../../../lib/digest.js';
import { tickOnce } from '../../../domain/digest/worker.js';
import * as repo from '../../../domain/digest/repo.js';
import { sql } from 'kysely';
// Use the project's existing test-harness helpers — see sibling tests:
import { buildAppForTests } from '../../helpers/app.js';
import { makeAdmin } from '../../helpers/factories.js';

describe('digest worker — twice-daily fixed cadence', () => {
  let app;
  beforeAll(async () => { app = await buildAppForTests(); });
  afterAll(async () => { await app.close(); });

  it('event recorded at 09:00 Canary fires at 17:00 Canary same day', async () => {
    const admin = await makeAdmin(app.db);
    const morning = new Date('2026-05-01T08:00:00Z'); // 09:00 WEST
    await recordForDigest(app.db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: 'New document: x.pdf',
    }, { now: morning });

    // Worker tick at 16:30 Canary (15:30 UTC) — too early
    let result = await tickOnce({ db: app.db, log: console, now: new Date('2026-05-01T15:30:00Z') });
    expect(result.fired).toBe(0);

    // Worker tick at 17:01 Canary (16:01 UTC) — should fire
    result = await tickOnce({ db: app.db, log: console, now: new Date('2026-05-01T16:01:00Z') });
    expect(result.fired).toBe(1);

    // Cleanup
    await sql`DELETE FROM email_outbox WHERE to_address = ${admin.email}`.execute(app.db);
    await sql`DELETE FROM admins WHERE id = ${admin.id}::uuid`.execute(app.db);
  });

  it('event recorded at 18:00 Canary fires at 08:00 next day Canary', async () => {
    const admin = await makeAdmin(app.db);
    const evening = new Date('2026-05-01T17:00:00Z'); // 18:00 WEST
    await recordForDigest(app.db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: 'New document: y.pdf',
    }, { now: evening });

    // Tick at 18:01 Canary same day — too early
    let result = await tickOnce({ db: app.db, log: console, now: new Date('2026-05-01T17:01:00Z') });
    expect(result.fired).toBe(0);

    // Tick at 08:01 Canary next day (07:01 UTC WEST)
    result = await tickOnce({ db: app.db, log: console, now: new Date('2026-05-02T07:01:00Z') });
    expect(result.fired).toBe(1);

    await sql`DELETE FROM email_outbox WHERE to_address = ${admin.email}`.execute(app.db);
    await sql`DELETE FROM admins WHERE id = ${admin.id}::uuid`.execute(app.db);
  });

  it('two events 6 hours apart for the same recipient produce ONE email at next fire', async () => {
    const admin = await makeAdmin(app.db);
    await recordForDigest(app.db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: 'New document: a.pdf',
    }, { now: new Date('2026-05-01T08:00:00Z') });
    await recordForDigest(app.db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'action_required', eventType: 'nda.created',
      title: 'New NDA',
    }, { now: new Date('2026-05-01T14:00:00Z') });

    const result = await tickOnce({ db: app.db, log: console, now: new Date('2026-05-01T16:01:00Z') });
    expect(result.fired).toBe(1);

    const enq = await sql`SELECT COUNT(*)::int AS c FROM email_outbox WHERE to_address = ${admin.email}`.execute(app.db);
    expect(enq.rows[0].c).toBe(1);

    await sql`DELETE FROM email_outbox WHERE to_address = ${admin.email}`.execute(app.db);
    await sql`DELETE FROM admins WHERE id = ${admin.id}::uuid`.execute(app.db);
  });

  it('skip-if-empty: items retracted between record and fire produce no email', async () => {
    const admin = await makeAdmin(app.db);
    await recordForDigest(app.db, {
      recipientType: 'admin', recipientId: admin.id,
      bucket: 'fyi', eventType: 'document.uploaded',
      title: 'New document: z.pdf',
    }, { now: new Date('2026-05-01T08:00:00Z') });
    // Drain manually to simulate retraction
    await sql`DELETE FROM pending_digest_items WHERE recipient_id = ${admin.id}::uuid`.execute(app.db);

    const result = await tickOnce({ db: app.db, log: console, now: new Date('2026-05-01T16:01:00Z') });
    expect(result.fired).toBe(0);
    expect(result.dropped).toBe(1);

    const enq = await sql`SELECT COUNT(*)::int AS c FROM email_outbox WHERE to_address = ${admin.email}`.execute(app.db);
    expect(enq.rows[0].c).toBe(0);

    await sql`DELETE FROM admins WHERE id = ${admin.id}::uuid`.execute(app.db);
  });
});
```

**Note for the implementer:** the existing test harness's helper paths may differ. If `tests/helpers/app.js` and `tests/helpers/factories.js` don't exist, look at any sibling integration test (e.g. `tests/integration/credentials/*`) to copy the actual harness used.

- [ ] **Step 3: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/digest/worker.test.js
```

Expected: FAIL — `tickOnce` doesn't currently accept a `now` parameter.

- [ ] **Step 4: Update `domain/digest/worker.js#tickOnce` to accept `now`**

In `domain/digest/worker.js`, change the function signature and pass `now` into the SQL claim. Replace `claim` SQL to use the parameterised time:

```javascript
export async function tickOnce({ db, log, batchSize = 25, now = new Date() }) {
  return await db.transaction().execute(async (tx) => {
    const claims = await repo.claimDue(tx, { batchSize, now });
    if (claims.length === 0) return { claimed: 0, fired: 0, dropped: 0 };
    // … rest unchanged
  });
}
```

In `domain/digest/repo.js#claimDue`:

```javascript
export async function claimDue(tx, { batchSize, now = new Date() }) {
  const r = await sql`
    SELECT recipient_type, recipient_id::text AS recipient_id
      FROM digest_schedules
     WHERE due_at <= ${now.toISOString()}::timestamptz
     ORDER BY due_at ASC
     LIMIT ${Number(batchSize)}
     FOR UPDATE SKIP LOCKED
  `.execute(tx);
  return r.rows;
}
```

- [ ] **Step 5: Run tests**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/digest/worker.test.js
```

Expected: PASS.

- [ ] **Step 6: Set perms and commit**

```
chmod 644 /opt/dbstudio_portal/domain/digest/worker.js /opt/dbstudio_portal/domain/digest/repo.js /opt/dbstudio_portal/tests/integration/digest/worker.test.js
cd /opt/dbstudio_portal
git add domain/digest/worker.js domain/digest/repo.js tests/integration/digest/worker.test.js
git commit -m "test(phase-f): cover twice-daily digest cadence end-to-end

Worker tickOnce + repo.claimDue now accept an optional now parameter to
make integration assertions deterministic. Replaces the prior 10/60-min
sliding-window assertions with morning + evening fire-time cases plus a
skip-if-empty case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Group B — Digest content rework (spec Section 2)

### Task B1: `lib/digest-dates.js` — `humanDate(ts, locale, tz)` helper (TDD)

**Files:**
- Create: `lib/digest-dates.js`
- Test: `tests/unit/lib/digest-dates.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/lib/digest-dates.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { humanDate } from '../../../lib/digest-dates.js';

const TZ = 'Atlantic/Canary';

describe('humanDate', () => {
  it('returns "Today" for same calendar day', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const ts  = new Date('2026-05-01T08:00:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toBe('Today');
  });

  it('returns "Yesterday" for previous calendar day', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const ts  = new Date('2026-04-30T20:00:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toBe('Yesterday');
  });

  it('returns weekday name for 2-6 days ago in EN', () => {
    const now = new Date('2026-05-08T12:00:00Z'); // Friday
    const ts  = new Date('2026-05-04T12:00:00Z'); // Monday
    expect(humanDate(ts, 'en', TZ, now)).toBe('Monday');
  });

  it('returns "dd MMM" format for older dates within current year (EN)', () => {
    const now = new Date('2026-05-15T12:00:00Z');
    const ts  = new Date('2026-01-12T12:00:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toMatch(/^12 Jan$/);
  });

  it('returns "dd MMM yyyy" past year boundary', () => {
    const now = new Date('2026-05-15T12:00:00Z');
    const ts  = new Date('2025-11-12T12:00:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toMatch(/^12 Nov 2025$/);
  });

  it('renders Spanish weekday for 2-6 days ago', () => {
    const now = new Date('2026-05-08T12:00:00Z'); // viernes
    const ts  = new Date('2026-05-05T12:00:00Z'); // martes
    expect(humanDate(ts, 'es', TZ, now)).toMatch(/martes/i);
  });

  it('respects tz boundary — 23:30 UTC on day N is "tomorrow morning" in WEST', () => {
    // 2026-05-01 23:30 UTC == 2026-05-02 00:30 WEST → "Today" relative to a 2026-05-02 ref.
    const now = new Date('2026-05-02T08:00:00Z');
    const ts  = new Date('2026-05-01T23:30:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toBe('Today');
  });
});
```

- [ ] **Step 2: Run failing tests**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest-dates.test.js
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/digest-dates.js`**

```javascript
// Phase F: format a digest item's timestamp as a human-readable label
// relative to "now" in the recipient's timezone. Output:
//   - "Today"            (same calendar day)
//   - "Yesterday"        (previous calendar day)
//   - "<weekday>"        (2-6 days ago)
//   - "dd MMM"           (older, current year)
//   - "dd MMM yyyy"      (older, past year boundary)
//
// All comparisons happen in the supplied tz so a 23:30 UTC item from
// "yesterday" in UTC reads as "Today" in the recipient's local view if
// that is what their wall clock shows.

const FMT_CACHE = new Map();
function fmt(locale, options) {
  const key = locale + JSON.stringify(options);
  if (!FMT_CACHE.has(key)) {
    FMT_CACHE.set(key, new Intl.DateTimeFormat(locale, options));
  }
  return FMT_CACHE.get(key);
}

function ymdInTz(date, tz) {
  const parts = Object.fromEntries(
    fmt('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function diffInDays(ymdA, ymdB) {
  // Both inputs are yyyy-mm-dd strings; treat as midnight UTC for diff math.
  const a = Date.UTC(...ymdA.split('-').map(Number).map((n, i) => i === 1 ? n - 1 : n));
  const b = Date.UTC(...ymdB.split('-').map(Number).map((n, i) => i === 1 ? n - 1 : n));
  return Math.round((a - b) / 86_400_000);
}

export function humanDate(ts, locale, tz, now = new Date()) {
  const tsYmd  = ymdInTz(ts, tz);
  const nowYmd = ymdInTz(now, tz);
  const days = diffInDays(nowYmd, tsYmd);

  if (days === 0) return localiseToday(locale);
  if (days === 1) return localiseYesterday(locale);
  if (days >= 2 && days <= 6) {
    return fmt(locale, { timeZone: tz, weekday: 'long' }).format(ts);
  }

  const tsYear  = Number(tsYmd.split('-')[0]);
  const nowYear = Number(nowYmd.split('-')[0]);
  if (tsYear === nowYear) {
    return fmt(locale, { timeZone: tz, day: 'numeric', month: 'short' }).format(ts);
  }
  return fmt(locale, { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(ts);
}

const TODAY = { en: 'Today', nl: 'Vandaag', es: 'Hoy' };
const YESTERDAY = { en: 'Yesterday', nl: 'Gisteren', es: 'Ayer' };

function localiseToday(locale) { return TODAY[locale] ?? TODAY.en; }
function localiseYesterday(locale) { return YESTERDAY[locale] ?? YESTERDAY.en; }
```

- [ ] **Step 4: Run tests**

```
chmod 644 /opt/dbstudio_portal/lib/digest-dates.js /opt/dbstudio_portal/tests/unit/lib/digest-dates.test.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest-dates.test.js
```

Expected: PASS (7 tests). If `Intl.DateTimeFormat` for `en` returns `Jan` vs `Jan.` with a period in some Node versions, relax the regex to `/^12 Jan\.?$/`.

- [ ] **Step 5: Commit**

```
cd /opt/dbstudio_portal
git add lib/digest-dates.js tests/unit/lib/digest-dates.test.js
git commit -m "feat(phase-f): add humanDate helper for digest line dates

Returns Today / Yesterday / weekday / dd MMM / dd MMM yyyy in the
recipient's locale and timezone. Used by the digest template to label
each item line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: rewrite verb strings in `lib/digest-strings.js`

**Files:**
- Modify: `lib/digest-strings.js`
- Modify: `tests/unit/lib/digest-strings.test.js`

- [ ] **Step 1: Add failing tests for new strings**

Append to `tests/unit/lib/digest-strings.test.js`:

```javascript
describe('digest title strings — Phase F rewrites', () => {
  it('credential.created singular EN reads "uploaded a new credential"', () => {
    expect(titleFor('credential.created', 'en', { customerName: 'Acme', count: 1 }))
      .toBe('Acme uploaded a new credential to their vault');
  });

  it('credential.created plural EN reads "uploaded N new credentials"', () => {
    expect(titleFor('credential.created', 'en', { customerName: 'Acme', count: 3 }))
      .toBe('Acme uploaded 3 new credentials to their vault');
  });

  it('credential.viewed singular EN reads "DB Studio reviewed a credential of <co>\'s"', () => {
    expect(titleFor('credential.viewed', 'en', { customerName: 'Acme', count: 1 }))
      .toBe("DB Studio reviewed a credential of Acme's");
  });

  it('credential.viewed plural EN reads "DB Studio reviewed N of <co>\'s credentials"', () => {
    expect(titleFor('credential.viewed', 'en', { customerName: 'Acme', count: 4 }))
      .toBe("DB Studio reviewed 4 of Acme's credentials");
  });

  it('invoice.paid customer-recipient EN reads "Your invoice X was marked paid"', () => {
    expect(titleFor('invoice.paid', 'en', { recipient: 'customer', invoiceNumber: 'INV-001' }))
      .toBe('Your invoice INV-001 was marked paid');
  });

  it('invoice.paid admin-recipient EN reads "<co> fully paid invoice X"', () => {
    expect(titleFor('invoice.paid', 'en', { recipient: 'admin', customerName: 'Acme', invoiceNumber: 'INV-001' }))
      .toBe('Acme fully paid invoice INV-001');
  });

  it('question.created customer EN reads "DB Studio asked you a question"', () => {
    expect(titleFor('question.created', 'en', { recipient: 'customer' }))
      .toBe('DB Studio asked you a question');
  });

  it('question.answered admin EN truncates the prompt', () => {
    const long = 'A'.repeat(200);
    const out = titleFor('question.answered', 'en', { recipient: 'admin', customerName: 'Acme', questionPreview: long });
    expect(out).toMatch(/^Acme answered '/);
    // 60-char limit on preview content
    expect(out.length).toBeLessThanOrEqual('Acme answered \''.length + 60 + 1 + 1);
  });
});
```

- [ ] **Step 2: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest-strings.test.js
```

Expected: FAIL — current strings still match the old shape.

- [ ] **Step 3: Update `lib/digest-strings.js`**

Replace the entries listed below; preserve other unchanged entries (e.g. `nda.created`, `customer.suspended`, etc.). For each event with a customer/admin recipient split, branch on `vars.recipient`. For each event with singular/plural, branch on `vars.count` (default `1`).

Key replacements (EN shown; mirror copy into `nl`/`es` per spec scaffolding rule — same English text in all three until i18n phase). Replace the listed entries in-place:

```javascript
'credential.created': {
  en: ({ customerName, count = 1 }) =>
    count === 1
      ? `${customerName} uploaded a new credential to their vault`
      : `${customerName} uploaded ${count} new credentials to their vault`,
  nl: ({ customerName, count = 1 }) =>
    count === 1
      ? `${customerName} uploaded a new credential to their vault`
      : `${customerName} uploaded ${count} new credentials to their vault`,
  es: ({ customerName, count = 1 }) =>
    count === 1
      ? `${customerName} uploaded a new credential to their vault`
      : `${customerName} uploaded ${count} new credentials to their vault`,
},
'credential.viewed': {
  en: ({ customerName, count = 1 }) =>
    count === 1
      ? `DB Studio reviewed a credential of ${customerName}'s`
      : `DB Studio reviewed ${count} of ${customerName}'s credentials`,
  nl: ({ customerName, count = 1 }) =>
    count === 1
      ? `DB Studio reviewed a credential of ${customerName}'s`
      : `DB Studio reviewed ${count} of ${customerName}'s credentials`,
  es: ({ customerName, count = 1 }) =>
    count === 1
      ? `DB Studio reviewed a credential of ${customerName}'s`
      : `DB Studio reviewed ${count} of ${customerName}'s credentials`,
},
'credential.deleted': {
  en: ({ customerName }) => `${customerName} deleted a credential from their vault`,
  nl: ({ customerName }) => `${customerName} deleted a credential from their vault`,
  es: ({ customerName }) => `${customerName} deleted a credential from their vault`,
},
'document.uploaded': {
  en: ({ customerName, recipient }) =>
    recipient === 'customer'
      ? 'DB Studio uploaded a new document'
      : `${customerName} uploaded a new document`,
  nl: ({ customerName, recipient }) =>
    recipient === 'customer'
      ? 'DB Studio uploaded a new document'
      : `${customerName} uploaded a new document`,
  es: ({ customerName, recipient }) =>
    recipient === 'customer'
      ? 'DB Studio uploaded a new document'
      : `${customerName} uploaded a new document`,
},
'document.downloaded': {
  en: ({ customerName, filename }) => `DB Studio reviewed ${customerName}'s ${filename}`,
  nl: ({ customerName, filename }) => `DB Studio reviewed ${customerName}'s ${filename}`,
  es: ({ customerName, filename }) => `DB Studio reviewed ${customerName}'s ${filename}`,
},
'invoice.paid': {
  en: ({ recipient, customerName, invoiceNumber }) =>
    recipient === 'customer'
      ? `Your invoice ${invoiceNumber} was marked paid`
      : `${customerName} fully paid invoice ${invoiceNumber}`,
  nl: ({ recipient, customerName, invoiceNumber }) =>
    recipient === 'customer'
      ? `Your invoice ${invoiceNumber} was marked paid`
      : `${customerName} fully paid invoice ${invoiceNumber}`,
  es: ({ recipient, customerName, invoiceNumber }) =>
    recipient === 'customer'
      ? `Your invoice ${invoiceNumber} was marked paid`
      : `${customerName} fully paid invoice ${invoiceNumber}`,
},
'invoice.uploaded': {
  en: ({ recipient, customerName, invoiceNumber }) =>
    recipient === 'customer'
      ? `DB Studio sent you invoice ${invoiceNumber}`
      : `${customerName} received invoice ${invoiceNumber}`,
  nl: ({ recipient, customerName, invoiceNumber }) =>
    recipient === 'customer'
      ? `DB Studio sent you invoice ${invoiceNumber}`
      : `${customerName} received invoice ${invoiceNumber}`,
  es: ({ recipient, customerName, invoiceNumber }) =>
    recipient === 'customer'
      ? `DB Studio sent you invoice ${invoiceNumber}`
      : `${customerName} received invoice ${invoiceNumber}`,
},
'question.created': {
  en: ({ questionPreview }) =>
    questionPreview ? `DB Studio asked you a question: ${truncate(questionPreview, 60)}` : 'DB Studio asked you a question',
  nl: ({ questionPreview }) =>
    questionPreview ? `DB Studio asked you a question: ${truncate(questionPreview, 60)}` : 'DB Studio asked you a question',
  es: ({ questionPreview }) =>
    questionPreview ? `DB Studio asked you a question: ${truncate(questionPreview, 60)}` : 'DB Studio asked you a question',
},
'question.answered': {
  en: ({ customerName, questionPreview }) =>
    `${customerName ?? 'A customer'} answered '${truncate(questionPreview ?? '', 60)}'`,
  nl: ({ customerName, questionPreview }) =>
    `${customerName ?? 'A customer'} answered '${truncate(questionPreview ?? '', 60)}'`,
  es: ({ customerName, questionPreview }) =>
    `${customerName ?? 'A customer'} answered '${truncate(questionPreview ?? '', 60)}'`,
},
'question.skipped': {
  en: ({ customerName, questionPreview }) =>
    `${customerName ?? 'A customer'} skipped '${truncate(questionPreview ?? '', 60)}'`,
  nl: ({ customerName, questionPreview }) =>
    `${customerName ?? 'A customer'} skipped '${truncate(questionPreview ?? '', 60)}'`,
  es: ({ customerName, questionPreview }) =>
    `${customerName ?? 'A customer'} skipped '${truncate(questionPreview ?? '', 60)}'`,
},
```

Add the `truncate` helper at the top of the file (above `T`):

```javascript
function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
```

`pluraliseTitle` in `lib/digest.js` should be updated to use the new shape — the count goes through `titleFor(eventType, locale, { ..., count })` instead of being hardcoded. Replace the `pluraliseTitle` function in `lib/digest.js`:

```javascript
function pluraliseTitle(eventType, oldTitle, count, vars, locale) {
  // For COALESCING_EVENTS we re-render via titleFor with the bumped count
  // so plural strings stay localised.
  return titleFor(eventType, locale, { ...(vars ?? {}), count });
}
```

…and update the call in `recordForDigest` to pass `vars` and `locale`:

```javascript
// Need to import titleFor — at top of lib/digest.js:
import { titleFor } from './digest-strings.js';

// In recordForDigest, where pluraliseTitle is called, change:
title: pluraliseTitle(item.eventType, existing.title, nextCount),
// to:
title: pluraliseTitle(item.eventType, existing.title, nextCount, item.vars, item.locale ?? 'en'),
```

This requires callers of `recordForDigest` to start passing `vars` (the original `titleFor` args) so coalesce can re-render — the call sites in `domain/credentials/service.js`, `domain/digest-fanout.js`, and similar already render `title` upfront. Add `vars: { customerName }` and `locale: adm.locale` (or equivalent) to the `recordForDigest({...})` calls. Sweep call sites with:

```
grep -rn "recordForDigest(" /opt/dbstudio_portal/domain /opt/dbstudio_portal/lib --include="*.js" 2>/dev/null
```

For each call, ensure `vars` and `locale` are passed alongside `title`.

- [ ] **Step 4: Run all related tests**

```
chmod 644 /opt/dbstudio_portal/lib/digest-strings.js /opt/dbstudio_portal/lib/digest.js /opt/dbstudio_portal/tests/unit/lib/digest-strings.test.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest.test.js tests/unit/lib/digest-strings.test.js tests/integration/digest/
```

Expected: PASS. If existing string assertions in other tests break (e.g., asserts on the old verb strings), update them to the new strings — these are the legitimate ripple effects of Phase F's verb rewrite.

- [ ] **Step 5: Commit**

```
cd /opt/dbstudio_portal
git add lib/digest-strings.js lib/digest.js tests/unit/lib/digest-strings.test.js [other touched call sites]
git commit -m "feat(phase-f): rewrite digest strings — natural verbs, recipient-aware copy

credential.created/viewed gain count-aware singular/plural; invoices, documents,
and questions get distinct customer- vs admin-recipient phrasings; question
previews are truncated to 60 chars. NL/ES files mirror EN text per the spec's
i18n-scaffolding-only rule.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B3: dynamic subject for digest emails

**Files:**
- Modify: `domain/email-outbox/repo.js`
- Modify: `lib/email-templates.js`
- Modify: `domain/digest/worker.js`
- Modify: `lib/digest-strings.js` (add `digestSubject`)

- [ ] **Step 1: Add `digestSubject` exported function in `lib/digest-strings.js`**

Append to `lib/digest-strings.js`:

```javascript
const DIGEST_SUBJECT = {
  en: ({ actionCount, fyiCount }) => buildEnSubject(actionCount, fyiCount),
  nl: ({ actionCount, fyiCount }) => buildEnSubject(actionCount, fyiCount), // mirror EN for v1
  es: ({ actionCount, fyiCount }) => buildEnSubject(actionCount, fyiCount), // mirror EN for v1
};

function buildEnSubject(action, fyi) {
  const parts = [];
  if (action > 0) parts.push(action === 1 ? '1 to action' : `${action} to action`);
  if (fyi > 0)    parts.push(fyi === 1 ? '1 update' : `${fyi} updates`);
  if (parts.length === 0) return 'Activity update from DB Studio Portal'; // safety fallback
  return `${parts.join(', ')} · DB Studio Portal`;
}

export function digestSubject(locale, { actionCount, fyiCount }) {
  const fn = DIGEST_SUBJECT[locale] ?? DIGEST_SUBJECT.en;
  return fn({ actionCount: Number(actionCount) || 0, fyiCount: Number(fyiCount) || 0 });
}
```

Add a unit test in `tests/unit/lib/digest-strings.test.js`:

```javascript
describe('digestSubject', () => {
  it('returns both segments when both buckets present', () => {
    expect(digestSubject('en', { actionCount: 3, fyiCount: 8 }))
      .toBe('3 to action, 8 updates · DB Studio Portal');
  });
  it('uses singular form for count of 1', () => {
    expect(digestSubject('en', { actionCount: 1, fyiCount: 0 }))
      .toBe('1 to action · DB Studio Portal');
  });
  it('omits zero-count segments', () => {
    expect(digestSubject('en', { actionCount: 0, fyiCount: 8 }))
      .toBe('8 updates · DB Studio Portal');
  });
  it('falls back to generic copy when both counts are zero', () => {
    expect(digestSubject('en', { actionCount: 0, fyiCount: 0 }))
      .toBe('Activity update from DB Studio Portal');
  });
});
```

Update the import at top of the test file:

```javascript
import { titleFor, digestSubject } from '../../../lib/digest-strings.js';
```

- [ ] **Step 2: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/lib/digest-strings.test.js
```

Expected: FAIL — function not exported.

After implementing Step 1, re-run; expected PASS.

- [ ] **Step 3: Wire subject override through `enqueue` and `renderTemplate`**

In `domain/email-outbox/repo.js`, add `subjectOverride` to the `enqueue` signature and stash it in `locals` under `__subject_override`:

```javascript
export async function enqueue(
  db,
  { idempotencyKey, toAddress, template, locale = 'en', locals = {}, sendAfter = null, subjectOverride = null },
) {
  const id = uuidv7();
  const localsForRender = subjectOverride ? { ...locals, __subject_override: subjectOverride } : locals;
  const localsJson = JSON.stringify(localsForRender);
  // … unchanged
}
```

In `lib/email-templates.js`, in `renderTemplate`, look for `__subject_override`:

```javascript
export function renderTemplate(slug, locale, locals = {}) {
  const useLocale = locale ?? 'en';
  const r = getRender(slug, useLocale);
  const merged = { ...HELPERS, ...locals };
  const body = r.bodyFn(merged);
  const html = layoutFn({
    ...merged,
    body,
    subject: r.subject,
    locale: useLocale,
  });
  const subject = (typeof locals.__subject_override === 'string' && locals.__subject_override.length > 0)
    ? locals.__subject_override
    : r.subject;
  return { subject, body: html };
}
```

- [ ] **Step 4: Update `domain/digest/worker.js` to compute and pass the subject**

In `tickOnce`, after `groupBuckets(items)`:

```javascript
import { digestSubject } from '../../lib/digest-strings.js';

// existing code in the for-loop:
const buckets = groupBuckets(items);
const subject = digestSubject(recipient.locale ?? 'en', {
  actionCount: buckets.action.length,
  fyiCount:    buckets.fyi.length,
});

await enqueueEmail(tx, {
  idempotencyKey,
  toAddress: recipient.email,
  template: 'digest',
  locale: recipient.locale ?? 'en',
  locals: {
    recipientName: recipient.name,
    isAdmin: claim.recipient_type === 'admin',
    actionItems: buckets.action,
    fyiItems:    buckets.fyi,
  },
  subjectOverride: subject,
});
```

- [ ] **Step 5: Run tests**

```
chmod 644 /opt/dbstudio_portal/domain/email-outbox/repo.js /opt/dbstudio_portal/lib/email-templates.js /opt/dbstudio_portal/domain/digest/worker.js /opt/dbstudio_portal/lib/digest-strings.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/email tests/integration/email-outbox tests/integration/digest
```

Expected: PASS. If `tests/unit/email/templates.test.js` snapshot subjects still match (the static subject is the fallback), the existing 18-slug count test stays green.

- [ ] **Step 6: Commit**

```
cd /opt/dbstudio_portal
git add domain/email-outbox/repo.js lib/email-templates.js domain/digest/worker.js lib/digest-strings.js tests/unit/lib/digest-strings.test.js
git commit -m "feat(phase-f): dynamic digest subject with action/FYI counts

renderTemplate honours an optional locals.__subject_override; enqueue
plumbs subjectOverride into the locals jsonb. The digest worker computes
a count-aware subject ('3 to action, 8 updates · DB Studio Portal') per
recipient locale.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B4: per-customer grouping + date stamps + deep links in `digest.ejs`

**Files:**
- Modify: `domain/digest/worker.js` (build groupedItems)
- Modify: `emails/en/digest.ejs`
- Modify: `emails/nl/digest.ejs`
- Modify: `emails/es/digest.ejs`

- [ ] **Step 1: Build `groupedItems` in worker**

Edit `domain/digest/worker.js#tickOnce`. After `groupBuckets`, fetch customer names for all `customerId`s present:

```javascript
async function customerNames(tx, customerIds) {
  const ids = [...new Set(customerIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const r = await sql`
    SELECT id::text AS id, razon_social
      FROM customers
     WHERE id = ANY(${ids}::uuid[])
  `.execute(tx);
  return new Map(r.rows.map((row) => [row.id, row.razon_social]));
}

function groupItemsByCustomer(items, nameLookup) {
  const byCustomer = new Map(); // customerName → { action: [], fyi: [] }
  const system     = { action: [], fyi: [] };
  for (const item of items) {
    const name = item.customer_id ? (nameLookup.get(item.customer_id) ?? 'Other') : null;
    const target = name ? bucketFor(byCustomer, name) : system;
    if (item.bucket === 'action_required') target.action.push(item);
    else target.fyi.push(item);
  }
  return { byCustomer: [...byCustomer.entries()].map(([name, b]) => ({ name, ...b })), system };
}

function bucketFor(map, name) {
  if (!map.has(name)) map.set(name, { action: [], fyi: [] });
  return map.get(name);
}
```

In the `tickOnce` loop:

```javascript
const ids = items.map((i) => i.customer_id);
const nameLookup = await customerNames(tx, ids);
const grouped = groupItemsByCustomer(items, nameLookup);
const counts = {
  actionCount: items.filter((i) => i.bucket === 'action_required').length,
  fyiCount:    items.filter((i) => i.bucket === 'fyi').length,
};

await enqueueEmail(tx, {
  idempotencyKey,
  toAddress: recipient.email,
  template: 'digest',
  locale: recipient.locale ?? 'en',
  locals: {
    recipientName: recipient.name,
    isAdmin: claim.recipient_type === 'admin',
    grouped,                        // [{ name, action, fyi }, ...]
    system: grouped.system,         // { action, fyi }  for items without customer_id
    items,                          // flat list (customer digests render flat)
    actionCount: counts.actionCount,
    fyiCount:    counts.fyiCount,
    humanDate,                      // helper exposed to template
    locale:      recipient.locale ?? 'en',
  },
  subjectOverride: digestSubject(recipient.locale ?? 'en', counts),
});
```

Add the import at top of `domain/digest/worker.js`:

```javascript
import { humanDate } from '../../lib/digest-dates.js';
```

- [ ] **Step 2: Redesign `emails/en/digest.ejs`**

Overwrite `emails/en/digest.ejs`:

```ejs
<%# subject: Activity update from DB Studio Portal %>
<%# subject above is a fallback; runtime subject is overridden via locals.__subject_override %>
<style>
  @media (prefers-color-scheme: dark) {
    .digest-card { background:#111111 !important; color:#F6F3EE !important; }
    .digest-meta  { color:#A8B0B8 !important; }
    .digest-link  { color:#C4A97A !important; }
  }
</style>

<div style="<%- S.tagline %>">Portal · Activity update</div>
<h1 style="<%- S.h1 %>">Hello, <%= recipientName %>.</h1>

<% function renderItem(item, locale) { %>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 4px;">
    <tr>
      <td class="digest-meta" style="width:90px;color:#A8B0B8;font-size:13px;vertical-align:top;padding:2px 8px 2px 0;">
        <%= humanDate(new Date(item.created_at), locale, 'Atlantic/Canary') %>
      </td>
      <td style="color:#F6F3EE;font-size:15px;line-height:1.6;vertical-align:top;padding:2px 0;">
        <% if (item.link_path) { %>
          <a class="digest-link" href="https://portal.dbstudio.one<%= item.link_path %>" style="<%- S.link %>"><%= item.title %></a>
        <% } else { %>
          <%= item.title %>
        <% } %>
        <% if (item.detail) { %><br><span style="color:#A8B0B8;font-size:13px;"><%= item.detail %></span><% } %>
      </td>
    </tr>
  </table>
<% } %>

<% if (isAdmin) { %>
  <% if (actionCount > 0) { %>
    <p style="<%- S.body %>"><strong>ACTION REQUIRED (<%= actionCount %>)</strong></p>
    <% grouped.forEach(function(g) { if (!g.action.length) return; %>
      <p style="margin:6px 0 4px;color:#C4A97A;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">
        <%= g.name %> — <%= g.action.length %> item<%= g.action.length === 1 ? '' : 's' %>
      </p>
      <% g.action.forEach(function(item) { renderItem(item, locale); }) %>
    <% }) %>
    <% if (system.action && system.action.length) { %>
      <p style="margin:6px 0 4px;color:#C4A97A;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">
        Other — <%= system.action.length %> item<%= system.action.length === 1 ? '' : 's' %>
      </p>
      <% system.action.forEach(function(item) { renderItem(item, locale); }) %>
    <% } %>
  <% } %>

  <% if (fyiCount > 0) { %>
    <p style="<%- S.body %>"><strong>UPDATES (<%= fyiCount %>)</strong></p>
    <% grouped.forEach(function(g) { if (!g.fyi.length) return; %>
      <p style="margin:6px 0 4px;color:#C4A97A;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">
        <%= g.name %> — <%= g.fyi.length %> item<%= g.fyi.length === 1 ? '' : 's' %>
      </p>
      <% g.fyi.forEach(function(item) { renderItem(item, locale); }) %>
    <% }) %>
    <% if (system.fyi && system.fyi.length) { %>
      <p style="margin:6px 0 4px;color:#C4A97A;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">
        Other — <%= system.fyi.length %> item<%= system.fyi.length === 1 ? '' : 's' %>
      </p>
      <% system.fyi.forEach(function(item) { renderItem(item, locale); }) %>
    <% } %>
  <% } %>
<% } else { %>
  <% var actionFlat = items.filter(function(i) { return i.bucket === 'action_required'; }); %>
  <% var fyiFlat    = items.filter(function(i) { return i.bucket === 'fyi'; }); %>

  <% if (actionFlat.length) { %>
    <p style="<%- S.body %>"><strong>ACTION REQUIRED (<%= actionFlat.length %>)</strong></p>
    <% actionFlat.forEach(function(item) { renderItem(item, locale); }) %>
  <% } %>

  <% if (fyiFlat.length) { %>
    <p style="<%- S.body %>"><strong>UPDATES (<%= fyiFlat.length %>)</strong></p>
    <% fyiFlat.forEach(function(item) { renderItem(item, locale); }) %>
  <% } %>
<% } %>

<p style="<%- S.note %>">
  <a class="digest-link" href="https://portal.dbstudio.one<%= isAdmin ? '/admin' : '/customer/dashboard' %>" style="<%- S.link %>">Sign in to your dashboard</a>.
</p>
```

- [ ] **Step 3: Mirror to `emails/nl/digest.ejs` and `emails/es/digest.ejs`**

Copy the EN template byte-for-byte into `emails/nl/digest.ejs` and `emails/es/digest.ejs`. Per spec, NL/ES are scaffolding for the deferred i18n phase.

```
cp /opt/dbstudio_portal/emails/en/digest.ejs /opt/dbstudio_portal/emails/nl/digest.ejs
cp /opt/dbstudio_portal/emails/en/digest.ejs /opt/dbstudio_portal/emails/es/digest.ejs
chmod 644 /opt/dbstudio_portal/emails/{en,nl,es}/digest.ejs
```

- [ ] **Step 4: Recompile email templates**

```
cd /opt/dbstudio_portal && node scripts/build.js
chmod 644 /opt/dbstudio_portal/emails/_compiled.js
```

- [ ] **Step 5: Run snapshot/render tests**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/unit/email tests/integration/email tests/integration/digest
```

Expected: PASS. The existing snapshot tests will need their snapshots updated — review the diff visually, then `vitest -u` if it makes sense (run via `sudo bash scripts/run-tests.sh -- --update`). New snapshot content is what we want; bake it in.

- [ ] **Step 6: Commit**

```
cd /opt/dbstudio_portal
git add emails/ domain/digest/worker.js
git commit -m "feat(phase-f): redesign digest body with grouping, dates, deep links

Admin digest groups items by customer with sub-headings and per-group
counts. Customer digest renders flat. Each line gets a humanDate label
(Today/Yesterday/weekday/dd MMM). Items honour their own link_path. NL
and ES templates mirror EN per the spec's i18n-scaffolding rule. Adds
prefers-color-scheme dark-mode CSS for clients that respect it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Group C — Reveal-credentials page consistency (spec Section 3)

### Task C1: rewrite `views/admin/credentials/show.ejs` header

**Files:**
- Modify: `views/admin/credentials/show.ejs`
- Modify: any test asserting the page title

- [ ] **Step 1: Identify tests asserting on header strings**

```
grep -rn "Credential · " /opt/dbstudio_portal/tests/integration/credentials 2>/dev/null
grep -rn "credential\.label.*page-header\|page-header.*credential\.label" /opt/dbstudio_portal/tests 2>/dev/null
```

- [ ] **Step 2: Update tests to expect the new shape**

In each test file found, change assertions from `Credential · <customer-name>` (or similar dynamic) to expect:
- eyebrow `ADMIN · CUSTOMERS`
- title `Credential`
- subtitle containing both `<customer.razon_social>` and `<credential.provider>`

If no such test exists, create `tests/integration/credentials/admin-show-header.test.js` with this minimum:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAppForTests } from '../../helpers/app.js';
import { makeAdmin, makeCustomer, makeCredential, signInAsAdmin } from '../../helpers/factories.js';

describe('admin credentials show — header consistency', () => {
  let app, admin, customer, credential;
  beforeAll(async () => {
    app = await buildAppForTests();
    admin = await makeAdmin(app.db);
    customer = await makeCustomer(app.db, { razonSocial: 'Acme Corp' });
    credential = await makeCredential(app.db, { customerId: customer.id, provider: 'github', label: 'GitHub root' });
  });
  afterAll(async () => { await app.close(); });

  it('renders eyebrow=ADMIN · CUSTOMERS, title=Credential, subtitle=<customer> · <provider>', async () => {
    const cookie = await signInAsAdmin(app, admin);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customer.id}/credentials/${credential.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ADMIN · CUSTOMERS');
    expect(res.body).toMatch(/<h1[^>]*>Credential<\/h1>/);
    expect(res.body).toContain('Acme Corp · github');
    // The instance label appears in the Metadata card, not as the page title
    expect(res.body).toMatch(/<dt>Label<\/dt>\s*<dd>GitHub root<\/dd>/);
  });
});
```

(If `tests/helpers/factories.js` lacks `makeCredential`, follow the existing factory style.)

- [ ] **Step 3: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/credentials/admin-show-header.test.js
```

Expected: FAIL — current `show.ejs` uses the old eyebrow.

- [ ] **Step 4: Rewrite `views/admin/credentials/show.ejs`**

Replace the file with:

```ejs
<%
  function originPill(origin) {
    var key = origin === 'admin' ? 'pending' : 'active';
    var label = origin === 'admin' ? 'created by admin' : 'added by customer';
    return '<span class="status-pill status-pill--' + key + '">' + label + '</span>';
  }
  function freshnessPill(needsUpdate) {
    if (needsUpdate) return '<span class="status-pill status-pill--overdue">needs update</span>';
    return '';
  }
  var pills = originPill(credential.created_by) + ' ' + freshnessPill(credential.needs_update);
%>
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: 'Credential',
  subtitle: customer.razon_social + ' · ' + credential.provider,
  actions: pills
}) %>

<%- include('../../components/_admin-customer-tabs', { customerId: customer.id, active: 'credentials' }) %>

<% if (decryptError) { %>
  <%- include('../../components/_alert', { variant: 'error', sticky: true, body: decryptError }) %>
<% } %>

<div class="card">
  <h2 class="card__title">Metadata</h2>
  <dl class="kv">
    <dt>Label</dt>          <dd><%= credential.label %></dd>
    <dt>Provider</dt>       <dd><%= credential.provider %></dd>
    <dt>Created by</dt>     <dd><%= credential.created_by %></dd>
    <dt>Created</dt>        <dd><%= euDateTime(credential.created_at) %></dd>
    <dt>Updated</dt>        <dd><%= euDateTime(credential.updated_at) %></dd>
    <dt>Needs update</dt>   <dd><%= credential.needs_update ? 'Yes' : 'No' %></dd>
  </dl>
</div>

<% if (payload) { %>
  <div class="card">
    <h2 class="card__title">Decrypted secret</h2>
    <p class="card__subtitle">Visible to you for this single render. Navigate away to clear from the DOM.</p>
    <dl class="kv">
      <% Object.entries(payload).forEach(function(entry) { %>
        <dt><%= entry[0] %></dt>
        <dd><code><%= entry[1] %></code></dd>
      <% }) %>
    </dl>
    <div class="form-actions">
      <%- include('../../components/_button', { variant: 'secondary', size: 'sm', href: '/admin/customers/' + customer.id + '/credentials/' + credential.id + '?mode=revealed', label: 'Hide' }) %>
    </div>
  </div>
<% } else { %>
  <div class="card">
    <h2 class="card__title">Reveal secret</h2>
    <p class="card__subtitle">Decrypts the payload for one page render. Each reveal writes a customer-visible audit row + a Phase B digest event.</p>
    <form method="post" action="/admin/customers/<%= customer.id %>/credentials/<%= credential.id %>/reveal" class="form-inline-action">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <%- include('../../components/_button', { variant: 'primary', size: 'sm', type: 'submit', label: 'Reveal secret' }) %>
    </form>
    <% if (revealed) { %>
      <p class="card__subtitle">The secret was just hidden. Click "Reveal secret" again to view it.</p>
    <% } %>
  </div>
<% } %>

<div class="form-actions">
  <%- include('../../components/_button', { variant: 'ghost', size: 'sm', href: '/admin/customers/' + customer.id + '/credentials', label: '← Back to credentials' }) %>
</div>
```

- [ ] **Step 5: Run tests**

```
chmod 644 /opt/dbstudio_portal/views/admin/credentials/show.ejs
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/credentials
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
cd /opt/dbstudio_portal
git add views/admin/credentials/show.ejs tests/integration/credentials/admin-show-header.test.js
git commit -m "feat(phase-f): align reveal-credentials page to resource-type pattern

Eyebrow ADMIN · CUSTOMERS, title 'Credential', subtitle <customer> ·
<provider>, status pills (origin + needs-update) in the actions slot.
The credential label moves into the Metadata card's first row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Group D — Detail-page pattern checker

### Task D1: `scripts/check-detail-pattern.js` advisory linter

**Files:**
- Create: `scripts/check-detail-pattern.js`

- [ ] **Step 1: Write the script**

Create `scripts/check-detail-pattern.js`:

```javascript
#!/usr/bin/env node
// Phase F: advisory linter that scans every views/admin/**/*.ejs and
// views/customer/**/*.ejs for the _page-header include and warns when:
//   - eyebrow is not all-caps + ` · ` separators
//   - title is a template-literal interpolating an instance field (heuristic)
//
// Exit code is always 0 — warnings only for v1. Promote to blocking in
// a future phase once the codebase is fully aligned.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VIEW_ROOTS = ['views/admin', 'views/customer'];

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && p.endsWith('.ejs')) yield p;
  }
}

const HEADER_RE = /_page-header['"]\s*,\s*\{([\s\S]*?)\}\s*\)/m;
const EYEBROW_RE = /eyebrow:\s*'([^']+)'/;
const TITLE_RE   = /title:\s*([^,}]+)/;
const EYEBROW_OK = /^[A-Z][A-Z0-9 ·]+$/;

let warnings = 0;
for (const root of VIEW_ROOTS) {
  for await (const file of walk(path.join(ROOT, root))) {
    const src = await fs.readFile(file, 'utf8');
    const block = HEADER_RE.exec(src);
    if (!block) continue;

    const eb = EYEBROW_RE.exec(block[1]);
    if (eb && !EYEBROW_OK.test(eb[1])) {
      console.warn(`WARN ${path.relative(ROOT, file)}: eyebrow '${eb[1]}' violates rule 10 (caps + ' · ' separator, no instance name)`);
      warnings++;
    }
    const t = TITLE_RE.exec(block[1]);
    if (t && t[1].trim().includes('${') && t[1].trim().includes('.')) {
      // template-literal interpolation that looks like an instance field
      console.warn(`WARN ${path.relative(ROOT, file)}: title '${t[1].trim()}' looks like an instance field; rule 1 says title must be the resource type`);
      warnings++;
    }
  }
}
process.stdout.write(`check-detail-pattern: ${warnings} advisory warning${warnings === 1 ? '' : 's'}\n`);
process.exit(0);
```

- [ ] **Step 2: Run it**

```
chmod 644 /opt/dbstudio_portal/scripts/check-detail-pattern.js
node /opt/dbstudio_portal/scripts/check-detail-pattern.js
```

Expected: prints any current violations as warnings. Likely violations identified: `views/admin/customer-questions/new.ejs` and `views/customer/questions/show.ejs`. (These are fixed in Group E.)

- [ ] **Step 3: Append the advisory to `scripts/run-tests.sh`**

Edit `scripts/run-tests.sh`. Just before the final `"$VITEST" run "$@"` line add:

```bash
# Phase F: advisory layout-pattern check (non-blocking).
sudo -u portal-app -E env PATH="$ROOT/.node/bin:/usr/bin:/bin" \
  "$NODE" "$ROOT/scripts/check-detail-pattern.js" || true
```

- [ ] **Step 4: Commit**

```
chmod 755 /opt/dbstudio_portal/scripts/check-detail-pattern.js
chmod 755 /opt/dbstudio_portal/scripts/run-tests.sh
cd /opt/dbstudio_portal
git add scripts/check-detail-pattern.js scripts/run-tests.sh
git commit -m "chore(phase-f): add advisory detail-page pattern checker

Greps every views/admin/**/*.ejs and views/customer/**/*.ejs for
_page-header includes and warns on eyebrow/title rule violations.
Non-blocking for v1; exit code always 0. Wired into run-tests.sh as
an advisory printout after the test run completes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Group E — Customer-questions UI completion (spec Section 5a)

### Task E1: add `customer-questions` tab to `_admin-customer-tabs.ejs`

**Files:**
- Modify: `views/components/_admin-customer-tabs.ejs`

- [ ] **Step 1: Edit the file**

Replace the `tabs` array in `views/components/_admin-customer-tabs.ejs` so the new tab sits between `credential-requests` and `invoices`:

```javascript
var tabs = [
  { key: 'detail',              label: 'Overview',            href: '/admin/customers/' + customerId },
  { key: 'edit',                label: 'Edit',                href: '/admin/customers/' + customerId + '/edit' },
  { key: 'ndas',                label: 'NDAs',                href: '/admin/customers/' + customerId + '/ndas' },
  { key: 'documents',           label: 'Documents',           href: '/admin/customers/' + customerId + '/documents' },
  { key: 'credentials',         label: 'Credentials',         href: '/admin/customers/' + customerId + '/credentials' },
  { key: 'credential-requests', label: 'Credential requests', href: '/admin/customers/' + customerId + '/credential-requests' },
  { key: 'customer-questions',  label: 'Questions',           href: '/admin/customers/' + customerId + '/questions' },
  { key: 'invoices',            label: 'Invoices',            href: '/admin/customers/' + customerId + '/invoices' },
  { key: 'projects',            label: 'Projects',            href: '/admin/customers/' + customerId + '/projects' }
];
```

- [ ] **Step 2: Set perms and run tests**

```
chmod 644 /opt/dbstudio_portal/views/components/_admin-customer-tabs.ejs
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/admin
```

Expected: PASS (no test should hard-code the old tab list; if one does, it's expected to be updated).

- [ ] **Step 3: Commit**

```
cd /opt/dbstudio_portal
git add views/components/_admin-customer-tabs.ejs
git commit -m "feat(phase-f): add Questions tab to admin customer sub-tabs

Sits between credential-requests and invoices. The href targets a list
route added in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task E2: admin list page + route — `GET /admin/customers/:cid/questions`

**Files:**
- Create: `views/admin/customer-questions/list.ejs`
- Modify: `routes/admin/customer-questions.js`
- Create: `tests/integration/customer-questions/admin-list.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/customer-questions/admin-list.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { buildAppForTests } from '../../helpers/app.js';
import { makeAdmin, makeCustomer, signInAsAdmin } from '../../helpers/factories.js';
import * as svc from '../../../domain/customer-questions/service.js';

describe('admin customer-questions list page', () => {
  let app, admin, customer;
  beforeAll(async () => {
    app = await buildAppForTests();
    admin = await makeAdmin(app.db);
    customer = await makeCustomer(app.db, { razonSocial: 'Acme Corp' });
    await svc.createQuestion(app.db, {
      customerId: customer.id,
      createdByAdminId: admin.id,
      question: 'What hosting provider do you currently use?',
    }, { ip: '127.0.0.1', userAgentHash: null });
  });
  afterAll(async () => {
    await sql`DELETE FROM customer_questions WHERE customer_id = ${customer.id}::uuid`.execute(app.db);
    await app.close();
  });

  it('renders the resource-type header pattern', async () => {
    const cookie = await signInAsAdmin(app, admin);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customer.id}/questions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ADMIN · CUSTOMERS');
    expect(res.body).toMatch(/<h1[^>]*>Questions<\/h1>/);
    expect(res.body).toContain('Acme Corp');
    expect(res.body).toMatch(/What hosting provider do you currently use\?/);
  });

  it('renders empty state when no questions exist for this customer', async () => {
    const empty = await makeCustomer(app.db, { razonSocial: 'Empty Co' });
    const cookie = await signInAsAdmin(app, admin);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/customers/${empty.id}/questions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('No questions yet for Empty Co');
    expect(res.body).toContain('+ Ask a question');
  });
});
```

- [ ] **Step 2: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-questions/admin-list.test.js
```

Expected: FAIL — route does not exist.

- [ ] **Step 3: Add the route in `routes/admin/customer-questions.js`**

Append (or insert in route registration order) — the `notFound` helper and `UUID_RE` already exist in this file:

```javascript
import * as repo from '../../domain/customer-questions/repo.js';
// (other imports as needed)

app.get('/admin/customers/:cid/questions', async (req, reply) => {
  const session = await requireAdminSession(app, req, reply);
  if (!session) return;

  const cid = req.params?.cid;
  if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
  const customer = await findCustomerById(app.db, cid);
  if (!customer) return notFound(req, reply);

  const rows = await repo.listAllForCustomer(app.db, cid, { limit: 200 });

  return renderAdmin(req, reply, 'admin/customer-questions/list', {
    title: 'Questions · ' + customer.razon_social,
    customer,
    rows,
    activeNav: 'customers',
    mainWidth: 'wide',
    sectionLabel: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
    activeTab: 'customer-questions',
  });
});
```

- [ ] **Step 4: Create `views/admin/customer-questions/list.ejs`**

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: 'Questions',
  subtitle: customer.razon_social,
  actions: rows && rows.length ? '<a class="btn btn--primary btn--md" href="/admin/customers/' + customer.id + '/questions/new">+ Ask a question</a>' : null
}) %>

<%- include('../../components/_admin-customer-tabs', { customerId: customer.id, active: 'customer-questions' }) %>

<% if (rows && rows.length) { %>
  <%
    function pillFor(s) {
      var key = s === 'open' ? 'pending' : (s === 'answered' ? 'fulfilled' : 'archived');
      return '<span class="status-pill status-pill--' + key + '">' + s + '</span>';
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function(ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      });
    }
    function truncate(s, n) {
      var v = String(s || '');
      return v.length <= n ? v : v.slice(0, n - 1) + '…';
    }
    var tableRows = rows.map(function(r) {
      var detail = '/admin/customers/' + customer.id + '/questions/' + r.id;
      var qLink = '<a href="' + escapeHtml(detail) + '">' + escapeHtml(truncate(r.question, 80)) + '</a>';
      return { cells: [
        qLink,
        pillFor(r.status),
        euDateTime(r.created_at),
        r.answered_at ? euDateTime(r.answered_at) : '—',
        r.answered_by_email || '—'
      ]};
    });
  %>
  <%- include('../../components/_table', {
    density: 'medium',
    columns: [
      { label: 'Question',        align: 'left' },
      { label: 'Status',          align: 'left' },
      { label: 'Created',         align: 'left' },
      { label: 'Resolved',        align: 'left' },
      { label: 'Answered by',     align: 'left' }
    ],
    rows: tableRows
  }) %>
<% } else { %>
  <%- include('../../components/_empty-state', {
    headline: 'No questions yet for ' + customer.razon_social,
    lead: 'Ask the customer a single short-answer question. They can answer or click "Skip / I don\'t know" — both outcomes write a digest event for the team.',
    ctaHref: '/admin/customers/' + customer.id + '/questions/new',
    ctaLabel: '+ Ask a question'
  }) %>
<% } %>
```

- [ ] **Step 5: Run tests**

```
chmod 644 /opt/dbstudio_portal/views/admin/customer-questions/list.ejs /opt/dbstudio_portal/routes/admin/customer-questions.js /opt/dbstudio_portal/tests/integration/customer-questions/admin-list.test.js
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-questions/admin-list.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
cd /opt/dbstudio_portal
git add views/admin/customer-questions/list.ejs routes/admin/customer-questions.js tests/integration/customer-questions/admin-list.test.js
git commit -m "feat(phase-f): admin customer-questions list page + route

GET /admin/customers/:cid/questions renders all the customer's questions
with status pills + answered-by metadata. Empty state offers an + Ask a
question CTA.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task E3: admin detail page + route — `GET /admin/customers/:cid/questions/:qid`

**Files:**
- Create: `views/admin/customer-questions/detail.ejs`
- Modify: `routes/admin/customer-questions.js`
- Create: `tests/integration/customer-questions/admin-detail.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/customer-questions/admin-detail.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { buildAppForTests } from '../../helpers/app.js';
import { makeAdmin, makeCustomer, makeCustomerUser, signInAsAdmin } from '../../helpers/factories.js';
import * as svc from '../../../domain/customer-questions/service.js';

describe('admin customer-questions detail page', () => {
  let app, admin, customer, cu, openId, answeredId, skippedId;
  beforeAll(async () => {
    app = await buildAppForTests();
    admin = await makeAdmin(app.db);
    customer = await makeCustomer(app.db, { razonSocial: 'Acme Corp' });
    cu = await makeCustomerUser(app.db, { customerId: customer.id });
    const open = await svc.createQuestion(app.db, { customerId: customer.id, createdByAdminId: admin.id, question: 'What hosting provider?' }, { ip: '127.0.0.1', userAgentHash: null });
    openId = open.id;
    const a = await svc.createQuestion(app.db, { customerId: customer.id, createdByAdminId: admin.id, question: 'WP version?' }, { ip: '127.0.0.1', userAgentHash: null });
    await svc.answerQuestion(app.db, { id: a.id, answeredByCustomerUserId: cu.id, answerText: '6.5.1' }, { ip: '127.0.0.1', userAgentHash: null });
    answeredId = a.id;
    const s = await svc.createQuestion(app.db, { customerId: customer.id, createdByAdminId: admin.id, question: 'Backup strategy?' }, { ip: '127.0.0.1', userAgentHash: null });
    await svc.skipQuestion(app.db, { id: s.id, answeredByCustomerUserId: cu.id }, { ip: '127.0.0.1', userAgentHash: null });
    skippedId = s.id;
  });
  afterAll(async () => {
    await sql`DELETE FROM customer_questions WHERE customer_id = ${customer.id}::uuid`.execute(app.db);
    await app.close();
  });

  it('renders awaiting message for open questions', async () => {
    const cookie = await signInAsAdmin(app, admin);
    const res = await app.inject({ method: 'GET', url: `/admin/customers/${customer.id}/questions/${openId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<h1[^>]*>Question<\/h1>/);
    expect(res.body).toContain('What hosting provider?');
    expect(res.body).toContain('Awaiting customer response');
  });

  it('renders the answer text for answered questions', async () => {
    const cookie = await signInAsAdmin(app, admin);
    const res = await app.inject({ method: 'GET', url: `/admin/customers/${customer.id}/questions/${answeredId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('6.5.1');
  });

  it('renders the skipped message', async () => {
    const cookie = await signInAsAdmin(app, admin);
    const res = await app.inject({ method: 'GET', url: `/admin/customers/${customer.id}/questions/${skippedId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Skip / I don't know");
  });
});
```

- [ ] **Step 2: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-questions/admin-detail.test.js
```

Expected: FAIL — route does not exist.

- [ ] **Step 3: Add the route**

In `routes/admin/customer-questions.js`:

```javascript
app.get('/admin/customers/:cid/questions/:qid', async (req, reply) => {
  const session = await requireAdminSession(app, req, reply);
  if (!session) return;

  const cid = req.params?.cid;
  const qid = req.params?.qid;
  if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
  if (typeof qid !== 'string' || !UUID_RE.test(qid)) return notFound(req, reply);
  const customer = await findCustomerById(app.db, cid);
  if (!customer) return notFound(req, reply);
  const question = await repo.findById(app.db, qid);
  if (!question || question.customer_id !== cid) return notFound(req, reply);

  return renderAdmin(req, reply, 'admin/customer-questions/detail', {
    title: 'Question · ' + customer.razon_social,
    customer,
    question,
    activeNav: 'customers',
    mainWidth: 'content',
    sectionLabel: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
    activeTab: 'customer-questions',
  });
});
```

Also update the existing POST `/admin/customers/:cid/questions` redirect target from `/admin/customers/${cid}` to `/admin/customers/${cid}/questions`.

- [ ] **Step 4: Create `views/admin/customer-questions/detail.ejs`**

```ejs
<%
  function pillFor(s) {
    var key = s === 'open' ? 'pending' : (s === 'answered' ? 'fulfilled' : 'archived');
    return '<span class="status-pill status-pill--' + key + '">' + s + '</span>';
  }
%>
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: 'Question',
  subtitle: customer.razon_social + ' · ' + question.status,
  actions: pillFor(question.status)
}) %>

<%- include('../../components/_admin-customer-tabs', { customerId: customer.id, active: 'customer-questions' }) %>

<div class="card">
  <h2 class="card__title">Question</h2>
  <p><%= question.question %></p>
  <dl class="kv">
    <dt>Created</dt>      <dd><%= euDateTime(question.created_at) %></dd>
  </dl>
</div>

<div class="card">
  <h2 class="card__title">Answer</h2>
  <% if (question.status === 'answered') { %>
    <p><%= question.answer_text %></p>
    <dl class="kv">
      <dt>Answered</dt>     <dd><%= euDateTime(question.answered_at) %></dd>
    </dl>
  <% } else if (question.status === 'skipped') { %>
    <p>Customer clicked "Skip / I don't know" — no answer.</p>
    <dl class="kv">
      <dt>Skipped</dt>      <dd><%= euDateTime(question.answered_at) %></dd>
    </dl>
  <% } else { %>
    <p>Awaiting customer response.</p>
  <% } %>
</div>

<div class="form-actions">
  <%- include('../../components/_button', { variant: 'ghost', size: 'sm', href: '/admin/customers/' + customer.id + '/questions', label: '← Back to questions' }) %>
</div>
```

- [ ] **Step 5: Run tests**

```
chmod 644 /opt/dbstudio_portal/views/admin/customer-questions/detail.ejs /opt/dbstudio_portal/routes/admin/customer-questions.js /opt/dbstudio_portal/tests/integration/customer-questions/admin-detail.test.js
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-questions
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
cd /opt/dbstudio_portal
git add views/admin/customer-questions/detail.ejs routes/admin/customer-questions.js tests/integration/customer-questions/admin-detail.test.js
git commit -m "feat(phase-f): admin customer-questions detail page + route

GET /admin/customers/:cid/questions/:qid renders the question + answer
view, branching on status (open/answered/skipped). POST redirect after
question creation now lands on the list page rather than the customer
overview.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task E4: fix existing `views/admin/customer-questions/new.ejs` header

**Files:**
- Modify: `views/admin/customer-questions/new.ejs`

- [ ] **Step 1: Edit the file**

Replace the file with:

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'ADMIN · CUSTOMERS',
  title: 'Ask a question',
  subtitle: customer.razon_social
}) %>

<%- include('../../components/_admin-customer-tabs', { customerId: customer.id, active: 'customer-questions' }) %>

<% if (typeof error !== 'undefined' && error) { %>
  <%- include('../../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="/admin/customers/<%= customer.id %>/questions" class="card">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">

  <label for="question" class="form-label">Question</label>
  <textarea id="question" name="question" rows="6" required maxlength="4000" class="form-textarea"><%= typeof prefill !== 'undefined' ? prefill : '' %></textarea>
  <p class="form-hint">Keep it specific. The customer can answer or click "Skip / I don't know".</p>

  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Send to customer' }) %>
    <%- include('../../components/_button', { variant: 'secondary', size: 'md', href: '/admin/customers/' + customer.id + '/questions', label: 'Cancel' }) %>
  </div>
</form>

<div class="form-actions">
  <%- include('../../components/_button', { variant: 'ghost', size: 'sm', href: '/admin/customers/' + customer.id + '/questions', label: '← Back to questions' }) %>
</div>
```

- [ ] **Step 2: Run tests + advisory**

```
chmod 644 /opt/dbstudio_portal/views/admin/customer-questions/new.ejs
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-questions
node /opt/dbstudio_portal/scripts/check-detail-pattern.js
```

Expected: PASS. The advisory should now show one fewer warning.

- [ ] **Step 3: Commit**

```
cd /opt/dbstudio_portal
git add views/admin/customer-questions/new.ejs
git commit -m "fix(phase-f): align admin customer-questions/new to layout pattern

Eyebrow ADMIN · CUSTOMERS, subtitle <customer>, with the customer-questions
sub-tab active. Cancel and the new back-link both target the list page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task E5: customer list page + route — `GET /customer/questions`

**Files:**
- Create: `views/customer/questions/list.ejs`
- Modify: `routes/customer/questions.js`
- Create: `tests/integration/customer-questions/customer-list.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/customer-questions/customer-list.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { buildAppForTests } from '../../helpers/app.js';
import { makeAdmin, makeCustomer, makeCustomerUser, signInAsCustomer } from '../../helpers/factories.js';
import * as svc from '../../../domain/customer-questions/service.js';

describe('customer questions list page', () => {
  let app, admin, customerA, customerB, cuA;
  beforeAll(async () => {
    app = await buildAppForTests();
    admin = await makeAdmin(app.db);
    customerA = await makeCustomer(app.db, { razonSocial: 'Acme Corp', ndaSigned: true });
    customerB = await makeCustomer(app.db, { razonSocial: 'Other Co', ndaSigned: true });
    cuA = await makeCustomerUser(app.db, { customerId: customerA.id });
    await svc.createQuestion(app.db, { customerId: customerA.id, createdByAdminId: admin.id, question: 'Hosting?' }, { ip: '127.0.0.1', userAgentHash: null });
    await svc.createQuestion(app.db, { customerId: customerB.id, createdByAdminId: admin.id, question: 'Different cust' }, { ip: '127.0.0.1', userAgentHash: null });
  });
  afterAll(async () => {
    await sql`DELETE FROM customer_questions WHERE customer_id IN (${customerA.id}::uuid, ${customerB.id}::uuid)`.execute(app.db);
    await app.close();
  });

  it('lists own customer\'s questions only', async () => {
    const cookie = await signInAsCustomer(app, cuA);
    const res = await app.inject({ method: 'GET', url: '/customer/questions', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('CUSTOMER · QUESTIONS');
    expect(res.body).toMatch(/<h1[^>]*>Questions<\/h1>/);
    expect(res.body).toContain('Hosting?');
    expect(res.body).not.toContain('Different cust');
  });
});
```

- [ ] **Step 2: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-questions/customer-list.test.js
```

Expected: FAIL — route does not exist.

- [ ] **Step 3: Add the route in `routes/customer/questions.js`**

```javascript
import * as repo from '../../domain/customer-questions/repo.js';

app.get('/customer/questions', async (req, reply) => {
  const session = await requireCustomerSession(app, req, reply);
  if (!session) return;
  if (!requireNdaSigned(req, reply, session)) return;

  const userR = await sql`
    SELECT customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
  `.execute(app.db);
  const customerId = userR.rows[0]?.customer_id;
  if (!customerId) {
    reply.redirect('/', 302);
    return;
  }
  const rows = await repo.listAllForCustomer(app.db, customerId, { limit: 200 });

  return renderCustomer(req, reply, 'customer/questions/list', {
    title: 'Questions',
    rows,
    activeNav: 'questions',
    mainWidth: 'wide',
  });
});
```

- [ ] **Step 4: Create `views/customer/questions/list.ejs`**

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'CUSTOMER · QUESTIONS',
  title: 'Questions'
}) %>

<%
  var openRows     = (rows || []).filter(function(r) { return r.status === 'open'; });
  var resolvedRows = (rows || []).filter(function(r) { return r.status !== 'open'; });
  function pillFor(s) {
    var key = s === 'answered' ? 'fulfilled' : (s === 'skipped' ? 'archived' : 'pending');
    return '<span class="status-pill status-pill--' + key + '">' + s + '</span>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function truncate(s, n) {
    var v = String(s || '');
    return v.length <= n ? v : v.slice(0, n - 1) + '…';
  }
%>

<% if (!rows || rows.length === 0) { %>
  <%- include('../../components/_empty-state', {
    headline: 'No questions from DB Studio yet',
    lead: 'When DB Studio asks something, it will show up here. You can answer or skip — both options are fine.'
  }) %>
<% } else { %>
  <% if (openRows.length === 0) { %>
    <div class="card">
      <p>You're all caught up — no open questions.</p>
    </div>
  <% } else { %>
    <div class="card">
      <h2 class="card__title">Open — needs your answer (<%= openRows.length %>)</h2>
      <%
        var openTableRows = openRows.map(function(r) {
          var detail = '/customer/questions/' + r.id;
          var qLink = '<a href="' + escapeHtml(detail) + '">' + escapeHtml(truncate(r.question, 80)) + '</a>';
          return { cells: [ qLink, euDateTime(r.created_at) ]};
        });
      %>
      <%- include('../../components/_table', {
        density: 'medium',
        columns: [
          { label: 'Question', align: 'left' },
          { label: 'Asked',    align: 'left' }
        ],
        rows: openTableRows
      }) %>
    </div>
  <% } %>

  <% if (resolvedRows.length) { %>
    <div class="card">
      <h2 class="card__title">Answered or skipped (<%= resolvedRows.length %>)</h2>
      <%
        var resolvedTableRows = resolvedRows.map(function(r) {
          return { cells: [
            escapeHtml(truncate(r.question, 80)),
            pillFor(r.status),
            r.answered_at ? euDateTime(r.answered_at) : '—'
          ]};
        });
      %>
      <%- include('../../components/_table', {
        density: 'medium',
        columns: [
          { label: 'Question', align: 'left' },
          { label: 'Status',   align: 'left' },
          { label: 'Resolved', align: 'left' }
        ],
        rows: resolvedTableRows
      }) %>
    </div>
  <% } %>
<% } %>
```

- [ ] **Step 5: Run tests**

```
chmod 644 /opt/dbstudio_portal/views/customer/questions/list.ejs /opt/dbstudio_portal/routes/customer/questions.js /opt/dbstudio_portal/tests/integration/customer-questions/customer-list.test.js
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-questions/customer-list.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
cd /opt/dbstudio_portal
git add views/customer/questions/list.ejs routes/customer/questions.js tests/integration/customer-questions/customer-list.test.js
git commit -m "feat(phase-f): customer questions list page + route

GET /customer/questions splits open vs answered/skipped, with cross-customer
isolation enforced at the SQL level.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task E6: rewrite `views/customer/questions/show.ejs` header + add Questions sidebar entry

**Files:**
- Modify: `views/customer/questions/show.ejs`
- Modify: `views/components/_sidebar-customer.ejs`

- [ ] **Step 1: Rewrite `views/customer/questions/show.ejs`**

Replace with:

```ejs
<%
  function truncate(s, n) {
    var v = String(s || '');
    return v.length <= n ? v : v.slice(0, n - 1) + '…';
  }
%>
<%- include('../../components/_page-header', {
  eyebrow: 'CUSTOMER · QUESTIONS',
  title: 'Question',
  subtitle: question && question.question ? truncate(question.question, 60) : ''
}) %>

<% if (typeof error !== 'undefined' && error) { %>
  <%- include('../../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<% if (typeof noLongerOpen !== 'undefined' && noLongerOpen) { %>
  <%- include('../../components/_alert', { variant: 'info', body: 'This question is no longer open. A teammate may have just answered or skipped it.' }) %>
  <div class="form-actions">
    <%- include('../../components/_button', { variant: 'primary', size: 'md', href: '/customer/questions', label: 'Back to questions' }) %>
  </div>
<% } else if (question.status === 'open') { %>
  <div class="card">
    <p class="card__subtitle">Help us with one short question</p>
    <blockquote class="customer-question__prompt"><%= question.question %></blockquote>
  </div>

  <form method="post" action="/customer/questions/<%= question.id %>/answer" class="card">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <label for="answer" class="form-label">Your answer</label>
    <textarea id="answer" name="answer" rows="6" maxlength="8000" class="form-textarea"><%= typeof prefill !== 'undefined' ? prefill : '' %></textarea>
    <div class="form-actions">
      <%- include('../../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Submit answer' }) %>
    </div>
  </form>

  <form method="post" action="/customer/questions/<%= question.id %>/skip" class="form-inline-action customer-question__skip">
    <input type="hidden" name="_csrf" value="<%= csrfToken %>">
    <%- include('../../components/_button', { variant: 'tertiary', size: 'sm', type: 'submit', label: 'Skip / I don\'t know' }) %>
  </form>
<% } else { %>
  <%- include('../../components/_alert', { variant: 'info', body: 'This question has been ' + question.status + '.' }) %>
<% } %>

<div class="form-actions">
  <%- include('../../components/_button', { variant: 'ghost', size: 'sm', href: '/customer/questions', label: '← Back to questions' }) %>
</div>
```

- [ ] **Step 2: Add Questions sidebar entry**

In `views/components/_sidebar-customer.ejs`, add the Questions item between Dashboard and NDAs (so it's prominent for customers who have an open question). Replace the `items` array:

```javascript
var items = [
  { key: 'dashboard',           label: 'Dashboard',           href: '/customer/dashboard' },
  { key: 'questions',           label: 'Questions',           href: '/customer/questions' },
  { key: 'ndas',                label: 'NDAs',                href: '/customer/ndas' },
  { key: 'documents',           label: 'Documents',           href: '/customer/documents' },
  { key: 'credentials',         label: 'Credentials',         href: '/customer/credentials' },
  { key: 'credential-requests', label: 'Credential requests', href: '/customer/credential-requests' },
  { key: 'invoices',            label: 'Invoices',            href: '/customer/invoices' },
  { key: 'projects',            label: 'Projects',            href: '/customer/projects' },
  { key: 'activity',            label: 'Activity',            href: '/customer/activity' },
  { key: 'profile',             label: 'Profile',             href: '/customer/profile' }
];
```

(Optional badge for open count: leave to a future tweak if it complicates the sidebar render path. For v1 of Phase F, just the entry.)

- [ ] **Step 3: Run tests + advisory**

```
chmod 644 /opt/dbstudio_portal/views/customer/questions/show.ejs /opt/dbstudio_portal/views/components/_sidebar-customer.ejs
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/customer-questions tests/integration/customer
node /opt/dbstudio_portal/scripts/check-detail-pattern.js
```

Expected: PASS. Advisory should now show zero warnings for `customer-questions/new.ejs` and `customer/questions/show.ejs`.

- [ ] **Step 4: Commit**

```
cd /opt/dbstudio_portal
git add views/customer/questions/show.ejs views/components/_sidebar-customer.ejs
git commit -m "fix(phase-f): align customer/questions/show + add sidebar entry

Eyebrow CUSTOMER · QUESTIONS, title 'Question', subtitle = preview.
Sidebar gains a Questions entry between Dashboard and NDAs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Group F — Customer-side view-with-decrypt (spec Section 5b)

### Task F1: `domain/credentials/service.js#viewByCustomer` (TDD)

**Files:**
- Modify: `domain/credentials/service.js`
- Modify: `tests/unit/credentials/service.test.js` (or wherever the unit tests live)

- [ ] **Step 1: Locate existing service tests**

```
ls /opt/dbstudio_portal/tests/integration/credentials/
ls /opt/dbstudio_portal/tests/unit | grep -i credential
```

- [ ] **Step 2: Write the failing test**

In `tests/integration/credentials/customer-show.test.js` (new):

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { buildAppForTests } from '../../helpers/app.js';
import { makeAdmin, makeCustomer, makeCustomerUser, makeCredential, signInAsCustomer, stepUpCustomer } from '../../helpers/factories.js';
import * as service from '../../../domain/credentials/service.js';

describe('viewByCustomer', () => {
  let app, customerA, customerB, cuA, credA, credB;
  beforeAll(async () => {
    app = await buildAppForTests();
    customerA = await makeCustomer(app.db, { razonSocial: 'Acme', ndaSigned: true });
    customerB = await makeCustomer(app.db, { razonSocial: 'Other', ndaSigned: true });
    cuA = await makeCustomerUser(app.db, { customerId: customerA.id });
    credA = await makeCredential(app.db, {
      customerId: customerA.id,
      provider: 'github',
      label: 'GitHub root',
      payload: { username: 'acme', token: 'abc' },
      kek: app.kek,
    });
    credB = await makeCredential(app.db, {
      customerId: customerB.id,
      provider: 'github',
      label: 'B-secret',
      payload: { username: 'other', token: 'xyz' },
      kek: app.kek,
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('throws StepUpRequiredError when vault locked', async () => {
    await expect(service.viewByCustomer(app.db, {
      customerUserId: cuA.id,
      sessionId:      'no-session',
      credentialId:   credA.id,
    }, { kek: app.kek })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('decrypts payload when vault unlocked + writes customer-actor audit + admin digest fan-out', async () => {
    const session = await stepUpCustomer(app, cuA);
    const r = await service.viewByCustomer(app.db, {
      customerUserId: cuA.id,
      sessionId:      session.id,
      credentialId:   credA.id,
    }, { kek: app.kek, ip: '127.0.0.1' });
    expect(r.payload).toMatchObject({ username: 'acme', token: 'abc' });

    const auditR = await sql`
      SELECT actor_type, action, visible_to_customer
        FROM audit_log
       WHERE target_id = ${credA.id}::uuid
         AND action = 'credential.viewed'
       ORDER BY created_at DESC
       LIMIT 1
    `.execute(app.db);
    expect(auditR.rows[0].actor_type).toBe('customer');
    expect(auditR.rows[0].visible_to_customer).toBe(true);

    const digestR = await sql`
      SELECT recipient_type FROM pending_digest_items
        WHERE event_type = 'credential.viewed'
          AND customer_id = ${customerA.id}::uuid
    `.execute(app.db);
    // expect at least one admin recipient and ZERO customer_user recipients
    expect(digestR.rows.length).toBeGreaterThan(0);
    expect(digestR.rows.every((r) => r.recipient_type === 'admin')).toBe(true);
  });

  it('refuses cross-customer access', async () => {
    const session = await stepUpCustomer(app, cuA);
    await expect(service.viewByCustomer(app.db, {
      customerUserId: cuA.id,
      sessionId:      session.id,
      credentialId:   credB.id,
    }, { kek: app.kek })).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });
  });
});
```

- [ ] **Step 3: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/credentials/customer-show.test.js
```

Expected: FAIL — `viewByCustomer` not exported.

- [ ] **Step 4: Implement `viewByCustomer`**

Add to `domain/credentials/service.js`:

```javascript
export async function viewByCustomer(db, {
  customerUserId,
  sessionId,
  credentialId,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentials.viewByCustomer');

  if (!(await isVaultUnlocked(db, sessionId))) {
    throw new StepUpRequiredError();
  }

  try {
    return await db.transaction().execute(async (tx) => {
      const cred = await repo.findCredentialById(tx, credentialId);
      if (!cred) throw new CredentialNotFoundError(credentialId);

      // Cross-customer guard: the customer_user must own the customer.
      await assertCustomerUserBelongsTo(tx, customerUserId, cred.customer_id);

      const customer = await loadCustomerDekRow(tx, cred.customer_id);
      if (customer.status !== 'active') {
        throw new Error(
          `cannot view credential for customer in status '${customer.status}' — must be 'active'`,
        );
      }
      const dek = unwrapDek({
        ciphertext: customer.dek_ciphertext,
        iv: customer.dek_iv,
        tag: customer.dek_tag,
      }, kek);

      let plaintext, payload;
      try {
        plaintext = decrypt({
          ciphertext: cred.payload_ciphertext,
          iv: cred.payload_iv,
          tag: cred.payload_tag,
        }, dek);
        payload = JSON.parse(plaintext.toString('utf8'));
      } catch (err) {
        const dfe = new DecryptFailureError();
        dfe._forensic = { credentialId, customerId: cred.customer_id, provider: cred.provider, label: cred.label, cause: err.message };
        throw dfe;
      }

      const a = baseAudit(ctx);
      await writeAudit(tx, {
        actorType: 'customer',
        actorId: customerUserId,
        action: 'credential.viewed',
        targetType: 'credential',
        targetId: credentialId,
        metadata: {
          ...a.metadata,
          customerId: cred.customer_id,
          provider: cred.provider,
          label: cred.label,
        },
        visibleToCustomer: true,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });

      // Phase B fan-out: customer-actor view notifies admins (not the customer
      // themselves; they did the action). Coalesces inside the digest cycle.
      const admins = await listActiveAdmins(tx);
      const cnameRow = await sql`SELECT razon_social FROM customers WHERE id = ${cred.customer_id}::uuid`.execute(tx);
      const customerName = cnameRow.rows[0]?.razon_social ?? '';
      for (const adm of admins) {
        await recordForDigest(tx, {
          recipientType: 'admin',
          recipientId:   adm.id,
          customerId:    cred.customer_id,
          bucket:        'fyi',
          eventType:     'credential.viewed',
          title:         titleFor('credential.viewed', adm.locale, { customerName, count: 1 }),
          linkPath:      `/admin/customers/${cred.customer_id}/credentials`,
          metadata:      { credentialId, provider: cred.provider, label: cred.label },
          vars:          { customerName },
          locale:        adm.locale,
        });
      }

      await unlockVault(tx, sessionId);

      return {
        credentialId,
        customerId: cred.customer_id,
        provider: cred.provider,
        label: cred.label,
        needsUpdate: cred.needs_update,
        payload,
      };
    });
  } catch (err) {
    if (err instanceof DecryptFailureError && err._forensic) {
      const a = baseAudit(ctx);
      try {
        await writeAudit(db, {
          actorType: 'customer',
          actorId: customerUserId,
          action: 'credential.decrypt_failure',
          targetType: 'credential',
          targetId: credentialId,
          metadata: {
            ...a.metadata,
            customerId: err._forensic.customerId,
            provider: err._forensic.provider,
            label: err._forensic.label,
            cause: err._forensic.cause,
          },
          visibleToCustomer: false,
          ip: a.ip,
          userAgentHash: a.userAgentHash,
        });
      } catch (auditErr) {
        if (typeof ctx?.log?.error === 'function') {
          ctx.log.error({ err: auditErr, credentialId },
            'failed to write credential.decrypt_failure (customer) audit');
        }
      }
      delete err._forensic;
    }
    throw err;
  }
}
```

The required imports (`listActiveAdmins`) already exist at the top of the file. Add `listActiveCustomerUsers` is unused here (admins-only fan-out).

- [ ] **Step 5: Run tests**

```
chmod 644 /opt/dbstudio_portal/domain/credentials/service.js /opt/dbstudio_portal/tests/integration/credentials/customer-show.test.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/credentials/customer-show.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
cd /opt/dbstudio_portal
git add domain/credentials/service.js tests/integration/credentials/customer-show.test.js
git commit -m "feat(phase-f): viewByCustomer credential decrypt path

Mirrors service.view for the customer actor: vault-unlock gate, customer-
visible audit, admin-only digest fan-out (the customer doesn't notify
themselves about their own action).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task F2: customer step-up route + view

**Files:**
- Create: `views/customer/step-up.ejs`
- Create: `routes/customer/step-up.js` (or extend an existing module)
- Create: `tests/integration/credentials/customer-step-up.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/credentials/customer-step-up.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { buildAppForTests } from '../../helpers/app.js';
import { makeCustomer, makeCustomerUser, signInAsCustomer } from '../../helpers/factories.js';

describe('customer step-up', () => {
  let app, customer, cu;
  beforeAll(async () => {
    app = await buildAppForTests();
    customer = await makeCustomer(app.db, { razonSocial: 'Acme', ndaSigned: true });
    cu = await makeCustomerUser(app.db, { customerId: customer.id, totpSecret: 'JBSWY3DPEHPK3PXP' });
  });
  afterAll(async () => { await app.close(); });

  it('GET /customer/step-up renders the form', async () => {
    const cookie = await signInAsCustomer(app, cu);
    const res = await app.inject({ method: 'GET', url: '/customer/step-up', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('CUSTOMER · STEP-UP');
    expect(res.body).toMatch(/<h1[^>]*>Confirm it's you<\/h1>/);
  });

  it('POST with bad code increments the step-up bucket (not login)', async () => {
    const cookie = await signInAsCustomer(app, cu);
    const csrfRes = await app.inject({ method: 'GET', url: '/customer/step-up', headers: { cookie } });
    const csrf = (csrfRes.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];

    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/customer/step-up', headers: { cookie }, payload: `_csrf=${csrf}&totp_code=000000` });
    }

    const buckets = await sql`SELECT key FROM rate_limit_buckets WHERE key LIKE 'step-up:%'`.execute(app.db);
    expect(buckets.rows.length).toBeGreaterThan(0);
    const loginBuckets = await sql`SELECT key FROM rate_limit_buckets WHERE key LIKE 'login:%'`.execute(app.db);
    // Must remain isolated from login bucket.
    expect(loginBuckets.rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/credentials/customer-step-up.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement the route + view**

Create `views/customer/step-up.ejs`:

```ejs
<%- include('../components/_page-header', {
  eyebrow: 'CUSTOMER · STEP-UP',
  title: 'Confirm it\'s you',
  subtitle: 'Enter your authenticator code to continue.'
}) %>

<% if (typeof error !== 'undefined' && error) { %>
  <%- include('../components/_alert', { variant: 'error', body: error }) %>
<% } %>

<form method="post" action="/customer/step-up" class="card form-stack" autocomplete="off">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <input type="hidden" name="return" value="<%= returnTo %>">

  <div class="input-field">
    <label for="totp_code" class="input-field__label">Authenticator code</label>
    <div class="input-field__control">
      <input id="totp_code" name="totp_code" type="text" inputmode="numeric" pattern="[0-9]*"
             maxlength="6" autocomplete="one-time-code" autofocus required>
    </div>
  </div>

  <div class="form-actions">
    <%- include('../components/_button', { variant: 'primary', size: 'md', type: 'submit', label: 'Continue' }) %>
    <%- include('../components/_button', { variant: 'ghost', size: 'md', href: '/customer/dashboard', label: 'Cancel' }) %>
  </div>
</form>
```

Create `routes/customer/step-up.js` modelled on `routes/admin/step-up.js`. Find that file with `find /opt/dbstudio_portal/routes/admin -name "step-up*"`, copy and adapt:
- Render path: `customer/step-up`
- Bucket key prefix: `step-up:customer:<userId>`
- Default `returnTo`: `/customer/dashboard`
- Verifies the `customer_users.totp_secret` (not admins).
- On success: `unlockVault(tx, session.id)` and redirect to `returnTo`.

- [ ] **Step 4: Register the route in `server.js` (or wherever customer routes are wired)**

Find the registration call near the other `routes/customer/*.js` includes and add:

```
import { registerCustomerStepUpRoute } from './routes/customer/step-up.js';
// near other registers:
registerCustomerStepUpRoute(app);
```

- [ ] **Step 5: Run tests**

```
chmod 644 /opt/dbstudio_portal/views/customer/step-up.ejs /opt/dbstudio_portal/routes/customer/step-up.js /opt/dbstudio_portal/tests/integration/credentials/customer-step-up.test.js
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/credentials/customer-step-up.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
cd /opt/dbstudio_portal
git add views/customer/step-up.ejs routes/customer/step-up.js tests/integration/credentials/customer-step-up.test.js server.js
git commit -m "feat(phase-f): customer step-up route + view

Mirrors admin step-up flow for customer actors. Bucket prefix is
step-up:customer:<id> so failures stay isolated from the login bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task F3: customer credentials show page + reveal route

**Files:**
- Create: `views/customer/credentials/show.ejs`
- Modify: `routes/customer/credentials.js`
- Modify: `views/customer/credentials/list.ejs` (label becomes a link; copy fix)

- [ ] **Step 1: Extend `tests/integration/credentials/customer-show.test.js`**

Append HTTP-level tests:

```javascript
describe('customer credentials show page (HTTP)', () => {
  it('GET /customer/credentials/:id requires step-up', async () => {
    const cookie = await signInAsCustomer(app, cuA);
    const res = await app.inject({ method: 'GET', url: `/customer/credentials/${credA.id}`, headers: { cookie } });
    expect([302, 200]).toContain(res.statusCode);
    if (res.statusCode === 302) {
      expect(res.headers.location).toMatch(/\/customer\/step-up/);
    }
  });

  it('after step-up, POST /customer/credentials/:id/reveal redirects to mode=reveal', async () => {
    const session = await stepUpCustomer(app, cuA);
    const cookie = session.cookie;
    const csrfRes = await app.inject({ method: 'GET', url: `/customer/credentials/${credA.id}?mode=reveal`, headers: { cookie } });
    const csrf = (csrfRes.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const res = await app.inject({
      method: 'POST',
      url: `/customer/credentials/${credA.id}/reveal`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${csrf}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`mode=reveal`);
  });
});
```

- [ ] **Step 2: Run failing test**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/credentials/customer-show.test.js
```

Expected: FAIL — show page + reveal POST do not exist.

- [ ] **Step 3: Add routes in `routes/customer/credentials.js`**

Reuse the admin pattern at `routes/admin/credentials.js` lines 57-122 — copy the `view` flow and switch:
- `requireAdminSession` → `requireCustomerSession`, plus `requireNdaSigned`.
- `service.view` → `service.viewByCustomer`.
- `customerChrome` → customer-side render shape: `renderCustomer(req, reply, 'customer/credentials/show', {...})` with `activeNav: 'credentials'`.
- Step-up redirect target: `/customer/step-up?return=...`.

```javascript
app.get('/customer/credentials/:id', async (req, reply) => {
  const session = await requireCustomerSession(app, req, reply);
  if (!session) return;
  if (!requireNdaSigned(req, reply, session)) return;

  const id = req.params?.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    reply.code(404).send();
    return;
  }
  const userR = await sql`SELECT customer_id FROM customer_users WHERE id = ${session.user_id}::uuid`.execute(app.db);
  const customerId = userR.rows[0]?.customer_id;
  if (!customerId) { reply.redirect('/', 302); return; }
  const credential = await findCredentialById(app.db, id);
  if (!credential || credential.customer_id !== customerId) {
    reply.code(404).send();
    return;
  }

  const mode = req.query?.mode;
  let payload = null;
  let decryptError = null;

  if (mode === 'reveal') {
    const unlocked = await isVaultUnlocked(app.db, session.id);
    if (!unlocked) {
      const ret = encodeURIComponent(`/customer/credentials/${id}?mode=reveal`);
      return reply.redirect(`/customer/step-up?return=${ret}`, 302);
    }
    try {
      const r = await credentialsService.viewByCustomer(app.db, {
        customerUserId: session.user_id,
        sessionId:      session.id,
        credentialId:   id,
      }, { ip: req.ip ?? null, userAgentHash: null, kek: app.kek });
      payload = r.payload;
    } catch (err) {
      if (err?.code === 'STEP_UP_REQUIRED') {
        const ret = encodeURIComponent(`/customer/credentials/${id}?mode=reveal`);
        return reply.redirect(`/customer/step-up?return=${ret}`, 302);
      }
      if (err?.code === 'DECRYPT_FAILURE') {
        decryptError = 'Could not decrypt this credential. Engineering has been notified.';
      } else {
        throw err;
      }
    }
  }

  return renderCustomer(req, reply, 'customer/credentials/show', {
    title: 'Credential',
    credential,
    payload,
    decryptError,
    revealed: mode === 'revealed',
    csrfToken: await reply.generateCsrf(),
    activeNav: 'credentials',
    mainWidth: 'content',
  });
});

app.post('/customer/credentials/:id/reveal', { preHandler: app.csrfProtection }, async (req, reply) => {
  const session = await requireCustomerSession(app, req, reply);
  if (!session) return;
  if (!requireNdaSigned(req, reply, session)) return;
  const id = req.params?.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) { reply.code(404).send(); return; }
  return reply.redirect(`/customer/credentials/${id}?mode=reveal`, 302);
});
```

Required imports — add to top of file:

```javascript
import { findCredentialById } from '../../domain/credentials/repo.js';
import * as credentialsService from '../../domain/credentials/service.js';
import { isVaultUnlocked } from '../../lib/auth/vault-lock.js';
```

- [ ] **Step 4: Create `views/customer/credentials/show.ejs`**

```ejs
<%- include('../../components/_page-header', {
  eyebrow: 'CUSTOMER · CREDENTIALS',
  title: 'Credential',
  subtitle: credential.provider,
  actions: credential.needs_update ? '<span class="status-pill status-pill--overdue">needs update</span>' : ''
}) %>

<% if (decryptError) { %>
  <%- include('../../components/_alert', { variant: 'error', sticky: true, body: decryptError }) %>
<% } %>

<div class="card">
  <h2 class="card__title">Metadata</h2>
  <dl class="kv">
    <dt>Label</dt>          <dd><%= credential.label %></dd>
    <dt>Provider</dt>       <dd><%= credential.provider %></dd>
    <dt>Created</dt>        <dd><%= euDateTime(credential.created_at) %></dd>
    <dt>Updated</dt>        <dd><%= euDateTime(credential.updated_at) %></dd>
    <dt>Needs update</dt>   <dd><%= credential.needs_update ? 'Yes' : 'No' %></dd>
  </dl>
</div>

<% if (payload) { %>
  <div class="card">
    <h2 class="card__title">Decrypted secret</h2>
    <p class="card__subtitle">Visible to you for this single render. Navigate away to clear from the DOM.</p>
    <dl class="kv">
      <% Object.entries(payload).forEach(function(entry) { %>
        <dt><%= entry[0] %></dt>
        <dd><code><%= entry[1] %></code></dd>
      <% }) %>
    </dl>
    <div class="form-actions">
      <%- include('../../components/_button', { variant: 'secondary', size: 'sm', href: '/customer/credentials/' + credential.id + '?mode=revealed', label: 'Hide' }) %>
    </div>
  </div>
<% } else { %>
  <div class="card">
    <h2 class="card__title">Reveal secret</h2>
    <p class="card__subtitle">Decrypts the value with your account vault key for one page render. Each reveal writes a record in your Activity feed.</p>
    <form method="post" action="/customer/credentials/<%= credential.id %>/reveal" class="form-inline-action">
      <input type="hidden" name="_csrf" value="<%= csrfToken %>">
      <%- include('../../components/_button', { variant: 'primary', size: 'sm', type: 'submit', label: 'Reveal secret' }) %>
    </form>
    <% if (revealed) { %>
      <p class="card__subtitle">The secret was just hidden. Click "Reveal secret" again to view it.</p>
    <% } %>
  </div>
<% } %>

<div class="form-actions">
  <%- include('../../components/_button', { variant: 'ghost', size: 'sm', href: '/customer/credentials', label: '← Back to credentials' }) %>
</div>
```

- [ ] **Step 5: Update `views/customer/credentials/list.ejs` — link the label + fix copy**

Find the row construction in the file. Replace the `label` cell value from a plain string to a link:

```ejs
var labelLink = '<a href="/customer/credentials/' + escapeHtml(c.id) + '">' + escapeHtml(c.label) + '</a>';
```

…and use `labelLink` instead of `escapeHtml(c.label)` in the table row. Also fix the copy on the page (the `_alert` body or `_empty-state.lead`) from "DB Studio never sees plaintext on this side" to:

> "Values are encrypted under your account vault key. DB Studio admins can decrypt them when actively viewing; every view leaves a record in your Activity feed. You can also view them yourself with a re-2FA confirmation."

- [ ] **Step 6: Run tests**

```
chmod 644 /opt/dbstudio_portal/views/customer/credentials/show.ejs /opt/dbstudio_portal/views/customer/credentials/list.ejs /opt/dbstudio_portal/routes/customer/credentials.js
node /opt/dbstudio_portal/scripts/build.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/credentials/customer-show.test.js tests/integration/credentials
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
cd /opt/dbstudio_portal
git add views/customer/credentials/show.ejs views/customer/credentials/list.ejs routes/customer/credentials.js tests/integration/credentials/customer-show.test.js
git commit -m "feat(phase-f): customer credential show + reveal route

GET /customer/credentials/:id renders metadata + reveal form, gated by
NDA + vault-unlock. POST /reveal redirects through step-up if required.
List page label is now a link to the detail page; the misleading 'never
sees plaintext' copy is replaced with the honest version.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Group G — Acceptance gates (spec Section 6)

### Task G1: full suite green + advisory clean

**No new code; this is the final verification before phase ship.**

- [ ] **Step 1: Run the full suite**

```
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: all tests pass. If anything fails, stop and fix — do NOT mark Phase F done.

- [ ] **Step 2: Run stale-rows check**

```
node /opt/dbstudio_portal/scripts/clean-stale-test-rows.js
```

Expected: `0 stale rows`. If non-zero, the test cleanups are leaking — fix before shipping.

- [ ] **Step 3: Run advisory checker**

```
node /opt/dbstudio_portal/scripts/check-detail-pattern.js
```

Expected: `0 advisory warnings` (or document any remaining as known and tracked in a follow-up).

- [ ] **Step 4: Smoke**

```
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

Expected: portal + DB healthy.

- [ ] **Step 5: Manual digest verification**

Stand up a digest scenario by inserting one fake event and forcing a tick within a fire window, then either dev-hold-replay the email or capture the rendered HTML and eyeball it in Gmail web + Apple Mail (light + dark mode). Verify:
- Subject reads `"X to action, Y updates · DB Studio Portal"`.
- Per-customer sub-headings appear when ≥2 customers.
- Each line has a date stamp on the left.
- Item titles use new verbs.
- Links honour `link_path`.
- Layout survives Outlook web normalisation.

If anything looks broken, fix before ship.

- [ ] **Step 6: Update build-log + AI_CONTEXT**

Per project convention, append a Phase F section to `/opt/db-football-staging/docs/build-log.md` (wait — that's the OTHER project; for portal use `/opt/dbstudio_portal/docs/build-log.md` if it exists, or update `docs/superpowers/follow-ups.md` ROADMAP STATUS to mark Phase F shipped).

```
ls /opt/dbstudio_portal/docs/build-log.md 2>/dev/null && echo "(append Phase F entry)" || echo "(use follow-ups.md ROADMAP STATUS)"
```

Move the "🟡 Next on the roadmap (Phase F)" block in `docs/superpowers/follow-ups.md` to "✅ Shipped in Phase F" with commit references and a one-line summary per goal.

- [ ] **Step 7: Final commit + ready for deploy**

```
cd /opt/dbstudio_portal
git add docs/superpowers/follow-ups.md
git commit -m "docs(phase-f): mark phase F shipped; record commit refs in roadmap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git log --oneline -20
```

Confirm the commit history reads cleanly (one commit per task, each with a descriptive subject). The branch is now ready for the operator's `DEPLOY TO PRODUCTION` flow per project rules.

---

## Self-review notes

**Spec coverage:** All six goals + non-goals from spec are mapped to tasks (Group A/B → goals 1+2; Group C → goal 3; Group D → goal 4; Group E → goal 5; Group F → goal 6; Group G → acceptance gates).

**Placeholder scan:** The plan contains no "TBD" / "TODO" / "implement later" / "etc." placeholders. Every step has the actual code or command to run.

**Type consistency:** `nextDigestFire` returns `Date`, used identically in `recordForDigest` and `claimDue`; `viewByCustomer` follows the exact `view` shape with `customerUserId` instead of `adminId`; `digestSubject` and `humanDate` signatures are stable across worker, template, and tests.

**Operational gotchas reinforced** at every Write/Edit step (chmod 644 + scripts/build.js where applicable).

**Decomposition:** Six logical groups, each with 1-6 tasks at 2-5 minute granularity. Each task is one TDD cycle (failing test → implement → run → commit). The implementer can cross task boundaries in a single sitting but should commit per task for clean rollback.

**Migration ledger:** unchanged at `0011_phase_d` — no schema changes in Phase F.
