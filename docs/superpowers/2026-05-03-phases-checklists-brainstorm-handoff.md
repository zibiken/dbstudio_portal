# Hand-off — Phases + Checklists feature brainstorm

**Date prepared:** 2026-05-03
**Use:** paste the block below into a fresh Claude Code session in `/opt/dbstudio_portal`. Claude must invoke the `superpowers:brainstorming` skill before producing any design or code.

---

## Verbatim brainstorm prompt

> I want to brainstorm a new feature for the DB Studio Portal: per-project **phases + checklists**. The repo is at `/opt/dbstudio_portal`. Read `SAFETY.md`, `RUNBOOK.md`, and `docs/superpowers/follow-ups.md` before starting; then read `docs/superpowers/plans/2026-05-03-phase-g-working-plan.md` so you have the operator's intent.
>
> **The operator's verbatim ask (2026-05-03):**
>
> > A new brainstorm will be required for this: We work in certain phases in a project (phase 0, phase 1, 2, 3, 4, ... — sometimes even a 0.5 or 1.5 etc..) and with checklists. So it would be a very nice feature to add the phases (with easy ordering) as admin into projects, as well as checklists that we can check off (and customers get notifications from it in the digests too) so they can see how far along we are in the phase. Make sure all of it is in the audit log, admins should see all, customers only what related is to them.
>
> **What I want from this brainstorm:**
>
> 1. Use the `superpowers:brainstorming` skill — explore intent, requirements, and design before any implementation.
> 2. Drive the operator through these decisions explicitly (one round-trip per decision unless they answer them in advance):
>    - **Phase identity scheme.** Strings like "0", "0.5", "1", "1.5", "2"? Numeric with `decimal(4,1)`? Lexicographic ordering vs an explicit `display_order` column? How does "0.5" sort between "0" and "1" if we go numeric? What about a future "1.25"?
>    - **Phase template scope.** Per-project (each project defines its own phases), per-customer (template applies across all of a customer's projects), or global (DB Studio's standard phases applied everywhere)? Or all three layered?
>    - **Phase status model.** `not-started` / `in-progress` / `done` / `blocked`? Or just `done` boolean on each? Per-checklist-item status only and the phase status is computed?
>    - **Checklist visibility.** Per checklist item: admin-only / customer-visible / both? Default? How does the customer-visible flag interact with the customer-only audit-log filter we already have (`visible_to_customer`)?
>    - **Notification surface.** Already-existing twice-daily digest? An immediate "your project moved to phase 2" notification? A banner on the customer dashboard? Or all three with operator-tunable preferences?
>    - **Reordering UX.** Drag-and-drop (needs JS), up/down buttons (no JS, accessible), or just edit a number field? Phase G3 sets the precedent of CSP-strict no-inline-JS; whichever path picked must respect that.
>    - **Audit log.** Operator wants every event audited. Confirm event taxonomy: `phase.created` / `phase.renamed` / `phase.reordered` / `phase.deleted` / `phase.moved-into` / `checklist.created` / `checklist.toggled` / `checklist.deleted`. Each gets a `visible_to_customer` flag based on the item's visibility setting.
>    - **Customer-side filtering.** Customer activity feed shows only `visible_to_customer=true` rows (already implemented in `lib/activity-feed.js:100`). Confirm phases/checklists writes follow that contract.
>    - **Data model.** Likely two tables: `project_phases (id, project_id, label, display_order, status, created_at, updated_at)` and `phase_checklist_items (id, phase_id, label, visible_to_customer, done_at, done_by, created_at, updated_at)`. Confirm or push back. FK cascades — RESTRICT or CASCADE on `project_id` / `phase_id`?
>    - **Out-of-scope guards.** What does v1 of this feature explicitly NOT do? (e.g. dependencies between checklist items, due dates per item, file attachments per item, comments per item — all probably v1.1)
> 3. After the operator has answered every decision, produce a *one-page* design spec at `docs/superpowers/specs/2026-05-XX-phases-checklists-design.md`. Then STOP and wait for "go" before writing the implementation plan or any code.
>
> **Constraints carrying over from earlier phases (do NOT relitigate):**
>
> - Schema is Postgres + Kysely. Migrations live in `migrations/00XX_…sql` with the runner pattern in `migrations/runner.js`. Apply via `psql` after `INSERT INTO _migrations`.
> - Routes are Fastify; views are EJS. CSP-strict (use `<script nonce="<%= nonce %>">` if any inline JS is needed).
> - The portal runs as systemd user `portal-app`. Files under `/opt/dbstudio_portal` MUST be group-owned by `portal-app` — setgid is set on every directory and a Claude PostToolUse hook chgrps automatically.
> - Every code change goes through DeepSeek (small/targeted) and Codex (final). Every UI change goes through Kimi (Instant mode). The completion gate forbids "done"/"approved"/"ready to deploy" until those reviews APPROVE or are explicitly waived.
> - Server-side password rule is `PASSWORD_MIN_LENGTH = 12` only — irrelevant here, just noting nothing else.
>
> **Where this lands in the phase order:**
>
> Phase G1, G2, G3, G4 shipped + pushed to origin/main as of 2026-05-03. Phase G5 (i18n + a11y grind) and G6 (v1.1 minor bundle) are queued AFTER this brainstorm + its implementation phase, per the operator's directive that phases/checklists outrank i18n.
>
> **Existing feature interaction notes worth surfacing in the brainstorm:**
>
> - `domain/credentials/service.js` (post-G4) already has a `credential.project_changed` audit and a `visible_to_customer` flag on every credential audit. Use that as the precedent for phase/checklist audit shape.
> - `lib/digest-fanout.js` and `lib/digest.js` are how a new event reaches the twice-daily digest. New event types need a `lib/digest-strings.js` entry per locale (EN-only ships in v1, but the structure must support per-locale text).
> - `views/admin/projects/detail.ejs` is where the per-project phase admin UI most naturally lands. The customer-side surface is `views/customer/projects/list.ejs` (no detail page exists yet — decision point: do we add one?).
>
> Start by invoking `superpowers:brainstorming` and asking me the first decision question.

---

## How to use this hand-off

1. Open a new Claude Code session in `/opt/dbstudio_portal`.
2. Paste the entire `> ` block above (verbatim — it tells Claude what to read and what to ask).
3. Answer Claude's brainstorm questions one at a time. The output should be a one-page design spec in `docs/superpowers/specs/`. Don't let Claude jump to a plan or code until that spec is written and you've explicitly said "go".
4. After the spec is approved, ask Claude to write the implementation plan (`superpowers:writing-plans`) — that's a separate session step.

---

## Commits this hand-off depends on

Phase G shipped these (already on origin/main):

- `c9fa6ec` — customer login flow + UI fixes (pre-G).
- `b4af9cf` — G1+G2: skip-button merge, mainWidth wide pass.
- `8de137d` — G3: unified `_password` partial with strength meter + rule compliance.
- `010142d` — G4: per-project credential scope (migration 0012, domain, UI, audit).
- `0d35685` — G4 review artifact.
