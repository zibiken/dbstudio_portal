# DB Studio Portal — Customer Planning View + Phase Date Overrides

> **Status:** Draft for review. Once approved, this becomes the source of truth for the implementation plan in `docs/superpowers/plans/`.

## Goal

Replace the customer-facing project page (`views/customer/projects/show.ejs`) with a vertical-timeline planning view that:

1. Shows phases as a chronological journal with status pills, started/completed dates, and a per-phase collapsed checklist.
2. Handles 30+ checklist items per phase without dominating the page.
3. Lets admins **override** auto-managed `started_at` / `completed_at` dates so historical projects can be backfilled accurately.

## Scope decisions (locked from brainstorm)

| Decision | Choice |
|---|---|
| Layout archetype | Vertical timeline (left rail with dots/lines + cards) |
| Long checklists | Collapsed by default behind native `<details>`, then split into "Outstanding" then "Completed" groups inside the expander |
| Date override UI | Inline `<input type="date">` pair on each admin phase card, beside the status pill |
| Date semantics | **Explicit dates win.** Once a Started or Completed date is non-empty, status transitions never overwrite it. Clearing the field reverts to auto-managed (next status flip writes today). |
| Customer visibility | `not_started` phases stay hidden (existing rule, unchanged) |
| Visual refinement | Kimi proposal folded in (see `.reviews/kimi-planning-design.md`) |

## Architecture

### Schema

No migration needed. `project_phases.started_at` and `project_phases.completed_at` already exist as `timestamptz`. The override semantics live entirely in the service layer.

Add one new column **only if** we need to disambiguate "explicit" from "auto" — but the user-chosen semantics (explicit wins forever) don't actually need a flag: the absence/presence of the value is sufficient.

### Service layer

`domain/phases/service.js` changes:

- New service method `setPhaseDates(db, { phaseId, customerId }, { startedAt, completedAt }, ctx, { adminId })`. Accepts `Date | null` for each. Updates the row, writes a `phase.dates_overridden` audit row (`visible_to_customer = false` — internal admin action). Idempotent.
- `changeStatus(...)` (existing) is amended: when transitioning to `in_progress`, only set `started_at = now()` if it's currently `NULL`. When transitioning to `done`, only set `completed_at = now()` if it's currently `NULL`. Existing `not_started → ...` reset path is unchanged (clearing dates on revert to not_started is correct because the work never happened).

### Routes

- New: `POST /admin/customers/:cid/projects/:pid/phases/:phaseId/dates` — accepts `started_at`, `completed_at` as `YYYY-MM-DD` strings (or empty for null). CSRF-protected. Same fragment-swap pattern as label rename: returns the re-rendered `_phase-row.ejs` partial. Errors mapped to safe copy.
- Existing customer route `GET /customer/projects/:projectId` re-renders to use the new partial chain.

### Views

**Admin phase row** (`views/components/_phase-row.ejs`):

Add two `<input type="date">` fields beside the status pill, names `started_at` / `completed_at`, in their own form (`data-fragment="row"`, action = the new dates route). Save-on-blur via existing `phase-editor.js` infrastructure. Empty input means "auto-manage". Shows the current effective date as `value` attribute.

**Customer planning view** — new partials per Kimi's proposal:

1. `views/customer/projects/_timeline.ejs` — outer `<ol class="customer-timeline">` container. Inputs: `phases` array (already filtered to drop `not_started`, ordered chronologically by `display_order` then `started_at`).
2. `views/customer/projects/_timeline-phase.ejs` — single `<li class="customer-timeline__item">`. Inputs: `phase`, `isLast` boolean. Renders rail + node + card.
3. `views/customer/projects/_timeline-checklist.ejs` — checklist body inside the phase's `<details>`. Inputs: `items` array. Splits into "Outstanding" (`!done_at`) followed by "Completed" (`done_at`).

Replace `views/customer/projects/show.ejs` to delegate to `_timeline.ejs`.

### CSS (`public/styles/app.src.css`)

New block under a `/* === Customer planning timeline === */` heading. Reuses existing tokens; introduces `customer-timeline__*` classes only:

```text
--bg-light, --fg-on-light, --fg-on-light-muted,
--border-light, --radius-md, --c-success,
--s-1..--s-12, --f-xs, --f-sm, --f-md, --f-lg
```

Class structure:

| Class | Purpose |
|---|---|
| `.customer-timeline` | Reset list, set positioning context |
| `.customer-timeline__item` | Flex row: rail node on left, card on right |
| `.customer-timeline__rail` | Absolute left track; line via `::before` pseudo-element, color `--border-light` |
| `.customer-timeline__node` | Circular dot, size `--s-3`, fill `--fg-on-light`. Last item's node has no trailing rail descender. |
| `.customer-timeline__card` | `--bg-light`, 1px `--border-light`, `--radius-md`, padding `--s-4` |
| `.customer-timeline__header` | Flex row: title + status pill |
| `.customer-timeline__title` | Phase label, `--f-md`, weight 600 |
| `.customer-timeline__meta` | Dates row, `--f-sm`, color `--fg-on-light-muted` |
| `.customer-timeline__summary` | "X of Y done" line, `--f-sm` |
| `.customer-timeline__details` | Native `<details>` wrapper |
| `.customer-timeline__checklist` | Item list inside expanded `<details>` |
| `.customer-timeline__checklist-group` | Subdivider for "Outstanding" / "Completed" |
| `.customer-timeline__checklist-item` | Icon + label row |
| `.customer-timeline__checklist-item--done` | Icon color `--c-success` |
| `.customer-timeline__hint` | Visible-to-customer note text, `--f-xs`, `--fg-on-light-muted` |

Spacing scale (Kimi proposal, accepted):

- Item gap: `--s-6`
- Rail width desktop: `--s-8` ; mobile: `--s-4`
- Node size: `--s-3`
- Card internal padding: `--s-4`
- Card corner radius: `--radius-md`

Mobile (≤ 640px): the rail collapses to a small dot positioned at the left of the card, content takes full width. No timeline line on mobile (signal-to-noise too low at narrow widths).

### Copy strings

- Empty state: *"No active phases to display. Check back once work has started."*
- Checklist summary: *"`<%= done %>` of `<%= total %>` done"*
- Details summary trigger text: *"Show checklist"*
- Date labels: *"Started `<%= date %>`"* / *"Completed `<%= date %>`"*
- Outstanding group heading: *"Still to do"*
- Completed group heading: *"Done"*

All dates use `euDateTime` / `euDate` (DD/MM/YYYY) for consistency with existing portal surfaces.

## Data flow

**Admin overrides a date:**

1. Admin types in the Started date input on a phase row.
2. Blur fires → `phase-editor.js` posts urlencoded to `/admin/.../phases/:id/dates` with `_csrf` + `started_at=<YYYY-MM-DD>`.
3. Route validates UUID + CSRF + customer/project ownership, parses date (or `null` if empty).
4. `setPhaseDates` writes the row + an audit entry.
5. Route re-renders `_phase-row.ejs` and returns it as a fragment.
6. JS swaps the row in place. Save-confirmation announced to AT via `aria-live`.

**Status flip with explicit Started already set:**

1. Admin clicks Status → "Done".
2. `changeStatus` checks: `phase.started_at` is non-null → leave alone. Sets `completed_at = now()` only if currently null.
3. Audit row + digest fan-out unchanged.

**Customer loads planning page:**

1. `GET /customer/projects/:projectId` collects the project, loads phases (filtered: `status !== 'not_started'`), loads each phase's items (filtered: `visible_to_customer === true`).
2. Renders `_timeline.ejs` with phases.
3. Each item card includes the `<details>` wrapper. Closed by default. Inside the wrapper, items split into Outstanding then Completed.

## Error handling

- Invalid date string → re-render fragment with `error` flash on the row, no DB mutation.
- Service-layer error → typed error → safe-copy mapping (same pattern as the existing M6 cancel-route mapping).
- Customer routes degrade gracefully: empty phase list shows the empty state copy.

## Testing

- Service: tests in `tests/integration/phases/service.test.js` for the new override semantics + setPhaseDates.
- Route: tests in `tests/integration/phases/routes.test.js` for `POST /dates` (CSRF, UUID, cross-customer 404, error → safe copy, fragment shape).
- View: smoke render of customer/projects/show with a 30+ item phase to confirm the `<details>` collapse + Outstanding/Completed grouping.
- Static a11y check (`scripts/a11y-check.js`) must pass on the new partials.

## Out of scope (deferred to v1.1 unless escalated)

- Drag-to-reorder phases on the timeline (admin can already reorder via overflow menu).
- Inline edit of checklist items from the customer view (customer is read-only for checklists today).
- Filtering / search on the planning view.
- Per-checklist-item dates.
- A "compact" customer-view density toggle.

## Self-review

- ✅ No "TBD" / "TODO" / vague requirements.
- ✅ No internal contradictions: explicit-dates-win is implemented uniformly across `changeStatus` and `setPhaseDates`.
- ✅ Scope is single-plan-sized (one schema-free migration, one new route, one new partial set, one CSS block, two test files updated).
- ✅ Ambiguity check: every requirement maps to one implementation choice. The "auto vs override" question is collapsed to "non-empty value = override; empty = auto" — no parallel column, no flag.
