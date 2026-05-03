---
name: Phases + Checklists — design
date: 2026-05-03
status: DESIGN — awaiting operator review before implementation plan
predecessor: docs/superpowers/plans/2026-05-03-phase-g-working-plan.md (item #12)
target migration: 0013_phases_and_checklists.sql
---

# Phases + Checklists — design spec

## Goal

Per-project phases (e.g. `0`, `0.5`, `1`, `1.5`, `2`, …) with an attached checklist per phase. Admins create and progress phases; customers see status + visible checklist items in their activity feed and twice-daily digest, so they can see how far along we are.

Operator's verbatim ask, 2026-05-03:

> We work in certain phases in a project (phase 0, phase 1, 2, 3, 4, … — sometimes even a 0.5 or 1.5 etc.) and with checklists. So it would be a very nice feature to add the phases (with easy ordering) as admin into projects, as well as checklists that we can check off (and customers get notifications from it in the digests too) so they can see how far along we are in the phase. Make sure all of it is in the audit log, admins should see all, customers only what related is to them.

## Decisions (confirmed 2026-05-03)

| # | Question | Decision |
|---|----------|----------|
| 1 | Phase identity | `label TEXT` free-form + `display_order INTEGER` sparse (gap-numbered 100/200/300, midpoint inserts). UNIQUE `(project_id, label)`. |
| 2 | Template scope | Per-project only. No templates, no per-customer reuse, no "copy from another project" action in v1. |
| 3 | Status model | Explicit four-state enum `not_started | in_progress | blocked | done`, admin-only writes. Service writes `started_at` on first transition into `in_progress`, `completed_at` on transition into `done`, clears `completed_at` on revert. |
| 4 | Checklist visibility | Per-item `visible_to_customer BOOLEAN`, default `TRUE`. Phase-status filter for the customer surface: items only render when phase is `in_progress`, `blocked`, or `done`. `not_started` phases are entirely invisible to the customer. `blocked` shows the phase + checklist + a "blocked" badge. |
| 5 | Notification surface | Digest + activity feed only. No new banner, no immediate emails. Coalescing split: `phase.*` non-coalescing, `phase_checklist.toggled` coalescing per phase, `phase_checklist.created/renamed/deleted` non-coalescing. |
| 6 | Reordering UX | Up/down buttons per row, server-side POST per swap. No JS. First/last-row buttons render `disabled`. |
| 7 | Audit taxonomy | See table below. All admin-actor in v1. `metadata.customerId` always set. `phase.reordered` and `phase_checklist.visibility_changed` are admin-only (`visible_to_customer = FALSE`). |
| 8 | Customer filtering contract | `metadata.customerId` is the load-bearing field for `lib/activity-feed.js`. `target_type` is `project_phase` or `phase_checklist_item`. No change required to `lib/activity-feed.js` or `lib/audit-query.js`. The phase-status visibility filter (Decision 4) is **baked into `visible_to_customer` at audit-write time** — the activity feed and digest both honor it automatically, and there is no separate fan-out filter. |
| 9 | Data model | Two tables, UUIDv7 PKs (matching portal convention). FK CASCADE on `project_id` and `phase_id`, SET NULL on `done_by_admin_id`. UNIQUE `(project_id, display_order)` and `(phase_id, display_order)` DEFERRABLE INITIALLY DEFERRED to allow transactional swaps. |
| 10 | Out-of-scope (v1) | No item dependencies, no due dates, no attachments, no comments, no assignment, no customer write actions, no templates, no bulk actions, no immediate emails / banners, no analytics view, no backfill of historical projects. |

## Data model

Migration: `migrations/0013_phases_and_checklists.sql`.

```sql
-- Phase G (post-G4): per-project phases + checklists.
--
-- Phases are admin-managed milestones inside a project (e.g. "0", "0.5",
-- "1", "1.5", "Discovery"). Each phase has a status enum and an optional
-- list of checklist items; items can be admin-only or customer-visible.
--
-- Customer-side rendering filter (applied in the route + digest layer,
-- NOT in the schema): customers see phases only when status is
-- in_progress / blocked / done. Phases in not_started are admin-only.
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

No backfill. Existing projects start with zero phases.

## Audit taxonomy

`actor_type = 'admin'` for every event in v1. `target_type` is `project_phase` or `phase_checklist_item`. `metadata.customerId` and `metadata.projectId` are always set; `metadata.phaseId` and `metadata.itemId` set where relevant; deletion events also snapshot `metadata.phaseLabel` / `metadata.itemLabel`.

The `visible_to_customer` flag on each audit row is computed from Decision 4 at write time. Define:

- `phaseVisible(status)` ≡ `status ∈ {in_progress, blocked, done}` (i.e. NOT `not_started`).

Then the per-event rule:

| `action` | `visible_to_customer` | Coalescing? |
|---|---|---|
| `phase.created` | `phaseVisible(post-event status)` — usually `FALSE` since new phases default to `not_started` | no |
| `phase.renamed` | `phaseVisible(current status)` | no |
| `phase.reordered` | `FALSE` (admin-only) | — |
| `phase.deleted` | `phaseVisible(status at delete)` | no |
| `phase.status_changed` | `phaseVisible(new status)` — i.e. transitions *into* `not_started` are admin-only | no |
| `phase_checklist.created` | `item.visible_to_customer AND phaseVisible(parent status)` | no |
| `phase_checklist.renamed` | `item.visible_to_customer AND phaseVisible(parent status)` | no |
| `phase_checklist.toggled` | `item.visible_to_customer AND phaseVisible(parent status)` | **yes**, per phase |
| `phase_checklist.visibility_changed` | `FALSE` (admin-only) | — |
| `phase_checklist.deleted` | `item.visible_to_customer at delete time AND phaseVisible(parent status at delete time)` | no |

Consequence: events while a phase is `not_started` (admin pre-populating the phase + checklist before opening it) are admin-only. The customer's first awareness of a phase is the `phase.status_changed` row when the admin moves it into `in_progress`; the customer's project detail view re-queries the live tables and shows the phase + currently-visible checklist items at that point.

`phase.status_changed` `metadata` carries `from` and `to` so digest copy can render the specific transition ("now in progress" / "marked as done" / "blocked"). `phase_checklist.toggled` `metadata` carries `done` (true / false), `phaseLabel`, and `itemLabel` so the coalesced digest line can say "Completed N/M items in Phase 1".

## Customer visibility table

| Phase status | Customer sees |
|---|---|
| `not_started` | invisible |
| `in_progress` | phase + checklist (visible items only) |
| `blocked` | phase + checklist (visible items only) + "blocked" badge |
| `done` | phase + checklist (visible items only) as history |

Admin always sees everything regardless of status or per-item flag.

## UI surfaces

**Admin-side** (existing surface, extend):
- `views/admin/projects/detail.ejs` — list of phases per project with inline create form, up/down arrows, status dropdown, label edit. Each phase shows its checklist items with a toggle, edit, delete and visibility checkbox per row, plus an "add item" form. CSP-strict — no inline JS.

**Customer-side** (NEW surface):
- `views/customer/projects/show.ejs` — new view; the current `views/customer/projects/list.ejs` has no detail page. The new detail page renders the customer-visible phases table with status badges and the visible checklist items per phase. No write controls.
- New route in `routes/customer/projects.js` (or equivalent) for the GET.

**Digest copy**: extends `lib/digest-strings.js` with the new event types and English/Dutch/Spanish title functions following the post-Phase-F natural-verb / recipient-aware shape. `COALESCING_EVENTS` in `lib/digest.js` gains `phase_checklist.toggled`.

## File-level touchpoints (preview, not exhaustive)

- `migrations/0013_phases_and_checklists.sql` (new)
- `domain/phases/repo.js`, `domain/phases/service.js` (new) — same shape as `domain/credentials/`
- `domain/phase-checklists/repo.js`, `domain/phase-checklists/service.js` (new)
- `routes/admin/project-phases.js` (new) — phase CRUD + reorder
- `routes/admin/phase-checklist-items.js` (new) — item CRUD + toggle + visibility flip
- `routes/customer/projects.js` (new or extended) — GET `/customer/projects/:id`
- `views/admin/projects/detail.ejs` (extended)
- `views/customer/projects/show.ejs` (new)
- `lib/digest.js` — add the new event types to `COALESCING_EVENTS` (only `phase_checklist.toggled`)
- `lib/digest-strings.js` — add title functions for each new `action`
- `lib/digest-fanout.js` — no behavioural change required; the existing `visible_to_customer` filter is sufficient because the audit-write computes it correctly per the rule above
- Tests: integration tests under `tests/integration/phases/` covering CRUD, audit shape, customer visibility filter (including the not_started → in_progress reveal flow), digest fan-out, coalescing.

## Open / out-of-scope items (tracked, not blocking this feature)

- **Digest cadence revert (Phase G item #1).** Phase G working plan recorded "Path A — pure revert" but the revert never landed; `lib/digest-cadence.js` still implements fixed twice-daily fires at 08:00 + 17:00 Atlantic/Canary (last touched in commit `6d57456`, Phase F). Phases/checklists is cadence-agnostic — events fan out the same way under either cadence — but the operator-facing UX of "8 toggles within 10 minutes coalesce into one digest line within ~10 minutes" only holds after that revert ships. Track separately.
- "Copy phases from another project" admin action (Decision 2) is not in v1; can be added later without schema change.
- Customer-side write actions (toggle their own items, comment on a phase) are intentionally absent. v1.1 candidate if there's evidence of a need.

## Process gates

Per `~/.claude/CLAUDE.md` global policy:
- Migration + service + route work goes through DeepSeek (default-on for small/targeted code) followed by Codex review at the end of each shippable bundle.
- `views/admin/projects/detail.ejs` and `views/customer/projects/show.ejs` go through Kimi (Instant mode) for design review.
- No "done" / "approved" / "ready to deploy" wording until both gates pass or are explicitly waived.

## Sequencing inside this feature

Suggested implementation order (will be expanded in the implementation plan, not here):

1. Migration + repo layer.
2. Phase service + admin route + admin view (CRUD + reorder + status).
3. Checklist service + admin routes + admin view (CRUD + toggle + visibility).
4. Customer route + customer view (new detail page).
5. Digest fan-out + strings + coalescing.
6. Tests across integration + audit + digest fan-out.

Each step has its own commit. Codex review at the end; Kimi review after step 2 / step 3 / step 4 (UI bits).
