# Phase G — working plan (post-Phase-F operator feedback)

**Author:** Claude (drafted 2026-05-03 from operator feedback in conversation, audit findings against `/opt/dbstudio_portal` as of `c9fa6ec`)
**Status:** DRAFT — awaiting operator review before any implementation
**Predecessor:** `2026-05-01-phase-f-plan.md` (shipped at `c9fa6ec`)

---

## How to read this plan

- The operator's two lists were merged: (a) the v1.1 backlog from `docs/superpowers/follow-ups.md`, and (b) the 13 new items posted on 2026-05-03.
- Each entry is labelled with current status: **DONE** / **NOT DONE** / **PARTIAL** / **DESIGN DECISION** / **NEEDS BROWSER REPRO**.
- "DONE" items have no work to do — they are listed for completeness so the operator can see what was already taken care of.
- The plan groups the remaining work into shippable phases G1–G5. The phases/checklists feature (item 12) is flagged for a separate brainstorming session and is not scoped here.

---

## Status audit — full list

### v1.1 backlog items (from follow-ups.md)

| Item | Status | Notes |
|------|--------|-------|
| i18n localisation grind (~620 strings) | NOT DONE | v1 ships EN-only per spec §2.11; multi-day work tracked for v1.1 |
| Accessibility pass (axe-core + skip-link + heading-order) | NOT DONE | scaffolding pending |
| Admin credential-edit UI (M7 deferred minor) | NOT DONE | edit existing credential is nice-to-have |
| Layout advisory warnings (customers/detail.ejs, projects/detail.ejs) | NOT DONE | pre-existing, flagged by Phase F checker, not Phase F scope |
| M3 — LIKE pattern underscore wildcards | NOT DONE | escape `_` in prefix list |
| M5 — audit_log metadata `customerId` expression index | NOT DONE | needed once table grows |
| M6 — raw `err.message` in customer credentials delete | NOT DONE | map to controlled vocab |
| M9 — `scripts/i18n-audit.js` regex backreference bug | NOT DONE | bare backtick inflates count |
| M10 — TOCTOU note on customer credentials delete | NOT DONE | defensive comment only |
| I3 — email-verify session-bounce UX | NOT DONE | fresh-browser users land at /login with old email |
| Reset-email-typo soft hardening (a)+(b) | NOT DONE | tagged for Phase E bundle but didn't land |

### New operator items (posted 2026-05-03)

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Digest revert: digest-first then 10-min coalesce window, then notify (customer + admin) | DESIGN DECISION | Phase F shipped fixed twice-daily intentionally — `lib/digest-cadence.js`. Operator now wants the pre-Phase-F sliding-window behavior back. Conflicts with Phase F design rationale; needs explicit decision before implementation. |
| 2 | Unified password strength + compliance UI in welcome / onboarding / change-password | NOT DONE | No reusable `_password.ejs` component; only a single bare input in `views/customer/onboarding/set-password.ejs`. |
| 3 | Page sizes inconsistent (admin reveal credentials / admin new question / admin ask new question / customer answer question are smaller than other pages) | PARTIAL | `routes/admin/credentials.js:15` uses `mainWidth:'content'`; `routes/admin/customer-questions.js:15` uses `mainWidth:'content'`; `routes/customer/questions.js:69` uses `mainWidth:'wide'`. Admin customer detail uses default. |
| 4 | Invisible question box (admin ask question + customer answer question) | NEEDS BROWSER REPRO | No CSS `opacity/visibility/display` issues found in `.form-textarea` styling at `public/styles/app.src.css:1010-1028`. Browser repro needed before fix. |
| 5 | Skip / "I don't know" button outside the box on customer answer-a-question | PARTIAL | Skip is in a separate `<form>` outside the answer form — `views/customer/questions/show.ejs:28-40`. Need to merge into the same `.form-actions` row. |
| 6 | customer/waiting page not styled | DONE | `views/customer/waiting.ejs` already uses the design system (eyebrow/title/subtitle pattern, `_alert` component, `customer-waiting__panel` tokens). Operator may have seen a stale build — confirm in browser. |
| 7 | Customer login bug (info@brainzr.eu — must reset password every time, last repro 2026-05-01 21:36 WEST) | NOT DONE | `tests/integration/auth/reset-then-signin.test.js` covers admins only — no customer equivalent. Phase D batch item #5 added admin-side regression but did not extend to customer side. |
| 8 | Questions banner CTA on customer dashboard not obvious enough | PARTIAL | Banner uses bare link styling with no button affordance — `views/customer/dashboard.ejs:20-34`. |
| 9 | Credentials: company-wide vs assignable to specific project | NOT DONE | `credentials` table has no `project_id` column (`migrations/0001_init.sql`). Schema change + UI + scope-aware visibility required. |
| 10 | Customer add credential → 500 "form is not defined" | NOT DONE (bug confirmed) | `routes/customer/credentials.js:59` GET handler renders the view without passing a `form` local; `views/customer/credentials/new.ejs:18-21` references `form && form.provider`. POST error path passes `form` correctly (line 96) — only the initial GET is broken. |
| 11 | Customer dashboard "0 documents" but 4 actually present (Laura Rouwet) | NOT DONE (bug confirmed) | `lib/customer-summary.js:70-72` excludes `nda-draft` category from the dashboard count, while `views/customer/documents` shows all categories. The two queries diverge. |
| 12 | Phases + checklists feature (admin sets phases 0/0.5/1/1.5/…, customer sees progress in digest) | NOT DONE — needs brainstorm | No `phases` / `checklists` tables, domains, or migrations exist. Operator flagged this themselves as needing a brainstorm. |
| 13 | Audit log filtering (admin sees all, customer sees only relevant) | DONE | `lib/activity-feed.js:100` filters customer view by `visible_to_customer = TRUE`; `lib/audit-query.js:62-78` admin path has no such filter — admin sees everything. Already implemented correctly. |

---

## Items already DONE (no work needed)

- **#6 customer/waiting** — already styled. Verify by clearing browser cache and reloading.
- **#13 audit log filtering** — already correct.

If the operator still sees the old behavior, the issue is likely cache / SW / a stale build — not code.

---

## Items requiring an operator decision before scoping

- **#1 digest cadence revert** — Phase F's hard switch to twice-daily was intentional and shipped. Reverting to the sliding-window+10-min-coalesce pattern undoes that work. Two paths:
  - **DECISION 2026-05-03: Path A — pure revert.** Restore the sliding-window code from pre-`6d57456`. ~1 day. Re-apply the per-customer grouping + dynamic subject improvements from Phase F on top where they don't conflict with the sliding window.

---

## Phase G — proposed phasing

### G1 — fast bug fixes (≤1 day, ship as a bundle)

These are confirmed bugs with simple fixes. No design decision needed.

- **G1-1** Customer add credential 500: pass `form: null` to the GET render in `routes/customer/credentials.js`, OR change the view to use `locals.form` with a default. (#10)
- **G1-2** Customer dashboard 0/4 mismatch: drop the `nda-draft` exclusion from `lib/customer-summary.js:70-72` so the dashboard count equals the documents-page list. (Operator decision 2026-05-03 — count follows the visible list.) (#11)
- **G1-3** Customer login regression test: add `tests/integration/auth/reset-then-signin-customer.test.js` mirroring the admin test. Investigate `info@brainzr.eu` against the live DB: check `customer_users.password_hash` after a reset, check whether the login bucket is hitting `2fa:*` instead of `login:*`, and check whether their browser has a cached old password. (#7)
- **G1-4** Skip-button placement on customer answer view: merge the two forms in `views/customer/questions/show.ejs:28-40` into a single `<form>` with a single `.form-actions` row containing both buttons (or use formaction to differentiate). (#5)
- **G1-5** Reproduce #4 invisible-question-box in a browser. Audit found no CSS issue — likely a stale CSS file or browser cache, or a more specific selector. Fix only after repro.

**Codex review** at end of G1. Kimi review for G1-4 (UI change).

### G2 — UI consistency pass (1–2 days)

- **G2-1** Page-size unification: standardize on `mainWidth: 'wide'`. (Operator decision 2026-05-03.) Audit + change all narrower pages — `routes/admin/credentials.js:15` (`'content'` → `'wide'`), `routes/admin/customer-questions.js:15` (`'content'` → `'wide'`), and any other `mainWidth: 'content'` mismatches found in route handlers. (#3)
- **G2-2** Questions banner CTA: replace the bare link with a button-styled call-to-action component, or wrap the whole banner in a hover-able card. Use the existing `_button` partial. (#8)
- **G2-3** Reset-email typo soft hardening (a)+(b): soften wording to "if your address is registered…" and add a domain-spelling suggestion for known TLD typos. Spec is in `follow-ups.md`. (v1.1 queued)

**Kimi design review** for G2-1, G2-2, G2-3 (all UI/copy). **Codex review** at end of G2.

### G3 — password unification (1–1.5 days)

- **G3-1** Build a reusable `views/_partials/_password.ejs` component:
  - `<input type="password">` with eye-toggle (already exists on credential request — reuse pattern from Phase E commit `70c0d0e`).
  - Live rule-compliance display (min length, uppercase, digit, symbol — pull from `lib/password-rules.js` if it exists, else create).
  - Strength meter (use zxcvbn-ts or a homegrown 4-tier scorer).
- **G3-2** Apply to: welcome flow (`views/public/welcome*.ejs` if exists), onboarding (`views/customer/onboarding/set-password.ejs`), change-password admin & customer views.
- **G3-3** Tests: each view has a unit test for compliance state + strength label.

**Kimi design review** for the component. **Codex review** at end of G3.

### G4 — credentials scope (per-project + company-wide) (2–3 days)

- **G4-1** Migration `0012_credentials_project_scope.sql`: add `project_id BIGINT NULL REFERENCES projects(id) ON DELETE RESTRICT` to `credentials`. Backfill nothing — existing rows stay company-wide (`project_id` NULL).
- **G4-2** Domain: `domain/credentials/service.js` listByCustomer / view / create / update / delete now respect `project_id`. Add `listByProject(customerId, projectId)`.
- **G4-3** UI: admin + customer credential forms add a project picker (default = company-wide). Credential list groups by project + a "Company-wide" section. Project detail page shows scoped credentials.
- **G4-4** Audit: every project-scope change writes an audit row.
- **G4-5** Tests: scoped-list, scope-change-audit, cross-project view denial.

**Kimi review** for the picker + list grouping. **Codex review** at end of G4. **DeepSeek** assist for the migration + service edits.

### G5 — i18n + a11y v1.1 grind (multi-day, ship in chunks)

This is the v1.1 milestone proper. Best to break out into its own phase document when the operator wants to start.

- **G5-1** i18n scaffolding: `lib/i18n.js` with `i18next` + `i18next-fs-backend`, namespace per route group, `t()` wired into `lib/render.js`.
- **G5-2** i18n grind: ~620 hand-edits per `scripts/i18n-audit.js`, batched per route group. Reviewable PR per namespace.
- **G5-3** Accessibility pass: `scripts/a11y-check.js` with axe-core + puppeteer-core; one commit per main view family fixing impact ≥ 'serious'; CI gate.
- **G5-4** Skip-link from brand header to `<main>`.
- **G5-5** Heading-order audit per main view.

### v1.1 minor items — bundle as G6 if/when wanted

These are small and can be batched in one PR:

- M3 escape `_` in LIKE prefix list (`routes/admin/audit.js`, `routes/customer/activity.js`)
- M5 add expression index `idx_audit_metadata_customer ON audit_log ((metadata->>'customerId')) WHERE visible_to_customer`
- M6 controlled error vocabulary for `routes/customer/credentials.js` delete path
- M9 fix `scripts/i18n-audit.js` regex backreference bug
- M10 TOCTOU defensive comment on `routes/customer/credentials.js` delete
- I3 email-verify session-bounce UX (path b — inline message on bounce)
- Admin credential-edit UI (M7 deferred minor)
- Layout advisory warnings on `customers/detail.ejs` + `projects/detail.ejs`

---

## Items deferred to a separate brainstorming session

- **#12 phases + checklists feature.** Operator flagged this needs a brainstorm. Run `superpowers:brainstorming` when ready to scope it. Likely sub-decisions:
  - phase ordering scheme (string `1`, `1.5`, `2` vs. numeric with decimals vs. lexicographic)
  - per-project vs. global phase templates
  - checklist visibility (admin-only / customer-visible / mixed per item)
  - notification surface (digest line, immediate notification, or banner)
  - audit-log integration

---

## Process gates (per CLAUDE.md global policy)

- Each phase ends with a Codex review (`codex-review-prompt --repo /opt/db-football-staging` style, but for `/opt/dbstudio_portal`).
- UI/UX phases (G1-4, G2, G3, G4 UI bits) get a Kimi design review in **Instant mode** (post-2026-05-03 default).
- Small/targeted code work in any phase invokes DeepSeek by default (matches the post-2026-05-03 default-on policy in `~/.claude/CLAUDE.md`).
- No "done" / "approved" / "ready to deploy" wording until both gates pass or are explicitly waived.

---

## Operator decisions (confirmed 2026-05-03)

1. **Digest cadence (#1):** **Path A — pure revert** to pre-Phase-F sliding-window + 10-min coalesce. Re-applies the per-customer grouping + dynamic subject improvements on top where they don't conflict.
2. **Page-size unification (#3):** **Standardize on `wide`.** All admin form pages and customer answer pages move to `mainWidth: 'wide'`.
3. **Documents count (#11):** **Dashboard count must match what the documents page shows.** Drop the `nda-draft` exclusion from `lib/customer-summary.js` so the count equals the list.
4. **Phases/checklists (#12):** **Brainstorm AFTER Phase G ships and is committed.** Ranked above i18n + a11y. Sequence:
   - G1 (bug fixes + QoL) → G2 (UI consistency) → G3 (password) → G4 (credentials per-project) → commit + push → **brainstorm phases/checklists** → then G5 (i18n) + G6 (v1.1 minor bundle).

## Sequencing

G1 starts now. G2 follows G1. G3, G4 sequential after that. After G4 commits + pushes, hand off a verbatim brainstorm prompt for the phases/checklists feature (item #12). Only then G5 + G6.
