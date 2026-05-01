# Phase F — Design

**Status:** approved 2026-05-01. Ready for implementation plan.
**Predecessor:** Phase E shipped at `76989ba`; current HEAD `7e907b2`.
**Migration ledger entry:** none added (no schema change).

---

## Goals

1. Reduce digest-email noise: fixed twice-daily cadence at 08:00 and 17:00 Atlantic/Canary, skip-if-empty at fire time.
2. Rework digest email content for readability: bucketed action / FYI counts in subject, per-customer grouping for admin recipients, human-friendly date stamps per item, natural-language verb rewrites, deep links honoured per item, light/dark-mode mail-client compatibility.
3. Bring `views/admin/credentials/show.ejs` (the admin reveal page) into the resource-type detail layout pattern used elsewhere.
4. Lock the detail-page layout pattern in writing as a checklist; introduce an advisory checker script.
5. Complete the customer-questions UI (admin list + admin detail + customer list pages, plus tab and sidebar entries). Data model and digest events shipped Phase D.
6. Add the customer-side view-with-decrypt UI (M9.X partial), built to the locked layout pattern, mirroring the admin reveal flow shipped in Phase E.

## Non-goals

- Admin credential-edit UI (separate phase).
- i18n localisation grind across the ~620 audit offenders (separate phase).
- Accessibility axe-core pass (separate phase).
- Per-recipient digest-time override (single server timezone Atlantic/Canary; YAGNI for v1).
- New digest events or new pending_digest_items columns (existing pipeline is sufficient).
- Hand translation of NL/ES email strings (the per-locale files exist as scaffolding; Phase F preserves them with EN copy mirrored).

---

## Section 1 — Digest cadence

### Behaviour

- Two daily fires per recipient: 08:00 and 17:00 Atlantic/Canary.
- At fire time, drain `pending_digest_items` for the recipient. If zero rows, drop the email and clear the schedule (existing path).
- Events arriving between fires sit in `pending_digest_items` and are surfaced at the next fire.
- Events arriving between 17:00 and 08:00 next-day are surfaced at the 08:00 fire.

### Code changes

- **`lib/digest-cadence.js`** (new) — pure helper exporting `nextDigestFire(now: Date): Date`. Computes the next 08:00 or 17:00 in `Atlantic/Canary` after `now`. Constants:
  - `DIGEST_FIRE_HOURS_LOCAL = [8, 17]`
  - `DIGEST_FIRE_TZ = 'Atlantic/Canary'`
- **`lib/digest.js`** — `recordForDigest` no longer accepts `windowMinutes` / `capMinutes` opts. Always upserts the schedule with `due_at = nextDigestFire(now)`.
- **`domain/digest/repo.js`** — `upsertSchedule(db, { recipientType, recipientId, dueAt })`. Drop `windowMinutes` / `capMinutes` params and the `LEAST(...)` cap clause. The `oldest_item_at` column stays in the table; on upsert it is set to `now()` for fresh inserts and left untouched on conflict (becomes the timestamp of the first pending item, useful as a debug field).
- **`domain/digest/worker.js`** — no logical change. Still `claimDue` + drain + enqueue or drop. Tick interval stays 60s.
- **`COALESCING_EVENTS`** — unchanged; collapses bursts within a half-day window into one digest line.

### Tests

- New `tests/unit/digest-cadence.test.js`: 07:59 Madrid → 08:00 today; 08:01 → 17:00 today; 17:01 → 08:00 tomorrow; DST spring-forward and fall-back boundaries.
- Update `tests/integration/digest/worker.test.js` and any other digest tests that asserted on 10/60-min behaviour: pin the new fire times via fake clock helper.
- New integration test: events recorded at 09:00 fire at 17:00; events recorded at 18:00 fire at 08:00 next day; two events recorded 6 hours apart for the same recipient produce ONE email at the next fire.

### Migration

None. Schema unchanged; only the contents written into `digest_schedules.due_at` change.

---

## Section 2 — Digest email content rework

### Subject line

Computed at enqueue time by `domain/digest/worker.js` from bucket counts:

- Both buckets present: `"3 to action, 8 updates · DB Studio Portal"`
- Action only: `"3 to action · DB Studio Portal"`
- FYI only: `"8 updates · DB Studio Portal"`
- Singular: `"1 to action"` not `"1 to actions"`. Zero-count segments are omitted.

The worker passes `actionCount` and `fyiCount` to `enqueueEmail({ subjectLocals })`. Subject moves from EJS front-matter to a per-locale `subject(locals)` function in `lib/digest-strings.js`.

### Body structure — admin digest (multi-customer grouping)

```
Hello <recipientName>,

ACTION REQUIRED (3)
  Acme Corp — 1 item
    Today  — Acme uploaded a new credential to their vault   [link]
  Solbizz Canarias — 2 items
    Today  — Solbizz marked wp-engine as not applicable      [link]
    Yesterday — Solbizz answered "What hosting do you use?"  [link]

UPDATES (8)
  Acme Corp — 4 items
    Today  — DB Studio reviewed 3 of Acme's credentials      [link]
    ...
  Solbizz Canarias — 3 items
    ...
  Other — 1 item
    Today  — System maintenance window scheduled              [link]

Sign in to your dashboard
```

The "Other" group renders only if at least one item has no `customerId`. When the digest contains items from a single customer, the per-customer sub-heading is omitted (flat list under each bucket).

### Body structure — customer digest (single-customer, flat)

```
Hello <recipientName>,

ACTION REQUIRED (1)
  Today  — DB Studio asked you a question                    [link]

UPDATES (3)
  Today     — DB Studio uploaded a new document              [link]
  Yesterday — Your invoice INV-001 was marked paid           [link]
  2 days ago — DB Studio reviewed 2 of your credentials      [link]

Sign in to your dashboard
```

### Date stamps

`lib/digest-dates.js` (new) exports `humanDate(ts: Date, locale: string, tz='Atlantic/Canary'): string` that returns:

- `"Today"` if same calendar day in `tz`
- `"Yesterday"` if previous calendar day
- weekday name (`"Monday"`, etc.) for last 6 days, locale-formatted
- `"dd MMM"` for older within current year
- `"dd MMM yyyy"` past year boundary

Locale-aware via `Intl.DateTimeFormat`. Source is each digest item's `created_at`.

### Verb rewrites — `lib/digest-strings.js`

- `credential.created` (1): `"<co> uploaded a new credential to their vault"`
- `credential.created` (N): `"<co> uploaded N new credentials to their vault"`
- `credential.viewed` (1): `"DB Studio reviewed a credential of <co>'s"`
- `credential.viewed` (N): `"DB Studio reviewed N of <co>'s credentials"`
- `credential.deleted`: `"<co> deleted a credential from their vault"`
- `document.uploaded` (admin): `"<co> uploaded a new document"`
- `document.uploaded` (customer): `"DB Studio uploaded a new document"`
- `document.downloaded` (admin): `"DB Studio reviewed <co>'s <docname>"`
- `nda.signed_uploaded`: `"<co>'s signed NDA is on file"`
- `invoice.paid` (admin): `"<co> fully paid invoice <invno>"`
- `invoice.paid` (customer): `"Your invoice <invno> was marked paid"`
- `invoice.created` (admin): `"<co> received invoice <invno>"`
- `invoice.created` (customer): `"DB Studio sent you invoice <invno>"`
- `question.created` (customer): `"DB Studio asked you a question"`
- `question.answered` (admin): `"<co> answered '<truncated 60 char question>'"`
- `question.skipped` (admin): `"<co> skipped '<truncated 60 char question>'"`
- `credential_request.fulfilled`: `"<co> filled in <provider> credentials"`
- `credential_request.not_applicable`: `"<co> marked <provider> as not applicable"`
- All visible internal IDs (`cred_autolock_…`, `cr_workflow_…`) are removed from titles.
- The slug-count assertion in `tests/unit/email/templates.test.js` is bumped if the slug set changes shape.

### Per-customer grouping (admin only)

The worker passes:

```
groupedItems = {
  byCustomer: Map<razonSocial, { action: Item[], fyi: Item[] }>,
  system:     { action: Item[], fyi: Item[] }
}
```

Customer-name lookup happens at fire time: one query per drain mapping `customerId → razon_social` from `customers`. Items with no `customerId` go into `system`. The "Other" group renders only when `system.action.length || system.fyi.length`. Customer digests render flat.

### Deep links

- Each `pending_digest_items.link_path` is honoured directly as the per-line link target.
- Items without `link_path`: fallback to `/admin/customers/<customerId>/activity` (admin) or `/customer/activity` (customer).
- The footer "Sign in to your dashboard" link stays at `/admin/` or `/customer/dashboard`.

### Light/dark-mode mail-client compatibility

- Audit current `digest.ejs` against Gmail web, Apple Mail, Outlook web (light + dark prefs); document failure modes.
- Redesign palette: white background, ink-900 text, ~6:1 contrast, brand colour for links only.
- `prefers-color-scheme: dark` media query in `<style>` for clients that honour it (Apple Mail, Gmail iOS).
- Per-line layout: `<table>`-based row with `<td>` cells (date, body, link). No CSS grid (Outlook), no flexbox.
- Inline critical styles per cell. Brand colour as CSS variable, swapped per-mode.

### Locale scaffolding

The repo already has `emails/{en,nl,es}/digest.ejs` and `recipient.locale` plumbing. Phase F preserves the scaffolding without doing translation work: EN strings are the canonical version, and the same EN copy is mirrored into NL/ES files. Real translation lives in the deferred i18n phase.

### Tests

- Snapshot tests per locale × admin/customer × bucket-mix in `tests/integration/email/digest.test.js`. Fixtures with 0 / 1 / N items per bucket and per customer.
- Render assertions: subject contains correct counts; group sub-headings present when ≥2 customers; absent when 1 customer; dates correctly humanised against a fake `now`.

---

## Section 3 — Reveal credentials page consistency

### `views/admin/credentials/show.ejs` rewrites

- **Header:**
  - `eyebrow: 'ADMIN · CUSTOMERS'`
  - `title: 'Credential'`
  - `subtitle: customer.razon_social + ' · ' + credential.provider`
  - `actions:` rendered status pills — `created by admin` / `added by customer` (origin) plus `needs update` if applicable.
- **Metadata card** — first row becomes `Label` (the credential's instance label, which used to be the page title). Other rows unchanged: Provider, Created by, Created, Updated, Needs update.
- **Reveal/decrypt card** — unchanged.
- **Form-actions back-link** — unchanged: `← Back to credentials`.

### Tests

- Update existing integration tests asserting on the page title to expect `Credential` plus `<customer> · <provider>` subtitle.

---

## Section 4 — Detail page pattern (locked Phase F+)

This pattern is binding for every page edited or created in Phase F and is the default for future phases.

```
┌──────────────────────────────────────────────────────────┐
│ EYEBROW (caps)                                           │
│ Resource-Type Title                  [actions / pills]   │
│ <context> · <secondary>                                  │
└──────────────────────────────────────────────────────────┘
[ subtabs (admin: _admin-customer-tabs ; customer: sidebar — no sub-tabs this phase) ]
[ optional _alert (info / warn / error) ]

┌─ card ─────────────────────────────────────────────┐
│ card__title                                        │
│ <kv list, paragraphs, or form>                     │
└────────────────────────────────────────────────────┘
[ more cards… ]

[ form-actions: primary _button + ghost _button ]
[ form-actions: ← Back to <plural resource> ]
```

### Rules

1. **`_page-header` always.** Eyebrow is caps section name (e.g. `ADMIN · CUSTOMERS`, `CUSTOMER · CREDENTIALS`). Title is the resource type, never an instance label. Subtitle is `<primary context> · <secondary context>` when both exist; one or the other otherwise.
2. **Status / state pills go in `actions` slot**, never inline in the title. Multiple pills space-separated.
3. **Sub-tabs immediately under the header** when the page belongs to a tabbed section. Admin uses `_admin-customer-tabs`; customer side uses sidebar entries (no sub-tabs introduced this phase).
4. **`_alert` only between header/tabs and content.** Never between cards. Variants: info, warn, error.
5. **`card` is the primary content container.** One `card__title` per card. Use `kv` lists for metadata, `form-stack` for forms, `_table` for collections. Never raw `<div>` blocks for what could be a card.
6. **`_table` for collections, `_empty-state` for zero rows.** Empty-state always names a primary CTA.
7. **`form-actions` for buttons.** Primary = `_button` variant `primary`. Cancel/secondary = `secondary`. Back-to-list = `ghost`.
8. **Back-link at the bottom**, in its own `form-actions`. Format: `← Back to <plural resource>`.
9. **No bespoke margins or paddings.** Use `card`, `form-actions`, `kv` spacing; if a custom gap is needed, it's a sign a component is missing.
10. **Eyebrow text rules:** all caps, ` · ` separator, max 3 segments. NEVER include the instance name (the customer name). The instance goes in subtitle.

### Pages this phase audits/conforms

- `views/admin/credentials/show.ejs` — Section 3.
- `views/admin/customer-questions/new.ejs` — fix eyebrow (currently `'ADMIN · ' + customer.razon_social`, violates rule 10). Should be `ADMIN · CUSTOMERS`, subtitle `<customer> · New question`. Add `_admin-customer-tabs` with `active: 'customer-questions'`.
- `views/customer/questions/show.ejs` — fix eyebrow (currently `'A question from DB Studio'`). Should be `CUSTOMER · QUESTIONS`, title `Question`, subtitle question prompt truncated 60 chars. The marketing line "Help us with one short question" moves into a card lead.
- All new pages introduced in Section 5.

### Mechanism

- **`scripts/check-detail-pattern.js`** (new) — greps every `views/admin/**` and `views/customer/**` `.ejs` for `_page-header(` and asserts:
  - eyebrow matches `^[A-Z][A-Z0-9 ·]+$` (uppercase, ` · ` separators)
  - title is a string literal, not a template literal of an instance field (heuristic; warns, doesn't error)
- Runs as a non-blocking advisory check inside `scripts/run-tests.sh` for v1. Warnings printed; exit zero. Promotion to blocking is a future phase decision.

---

## Section 5 — New pages

### 5a — Customer-questions UI completion

**Admin side — new pages and tab:**

1. **`views/admin/customer-questions/list.ejs`** — list of questions per customer.
   - Header: eyebrow `ADMIN · CUSTOMERS`, title `Questions`, subtitle `<customer.razon_social>`.
   - Sub-tabs: `_admin-customer-tabs` with active key `customer-questions`.
   - Table columns: Question (truncated 80 chars, links to detail), Status pill, Created, Answered/Skipped at, Answered by.
   - Empty state: "No questions yet for <customer>." CTA: `+ Ask a question`.
   - Header actions: `+ Ask a question` button when rows exist.

2. **`views/admin/customer-questions/detail.ejs`** — single question + answer view.
   - Header: eyebrow `ADMIN · CUSTOMERS`, title `Question`, subtitle `<customer> · <status>`. Status pill in actions slot.
   - Card "Question" — full question text, created at, created-by admin name.
   - Card "Answer" — branches on status:
     - `answered`: answer text + answered at + answered-by customer user.
     - `skipped`: "Customer clicked Skip / I don't know — no answer."
     - `open`: "Awaiting customer response." with note about customer's last login.
   - Form-actions: ← Back to questions.
   - No edit/cancel actions (questions are immutable per Phase D spec).

3. **`_admin-customer-tabs.ejs`** — add `{ key: 'customer-questions', label: 'Questions', href: '/admin/customers/' + customerId + '/questions' }` between `credential-requests` and `invoices`.

4. **`views/admin/customer-questions/new.ejs`** — header rewrite per rule 10:
   - eyebrow `ADMIN · CUSTOMERS`
   - title `Ask a question`
   - subtitle `<customer.razon_social>`
   - Add `_admin-customer-tabs` with `active: 'customer-questions'`.

**New admin routes:**

- `GET /admin/customers/:cid/questions` → list
- `GET /admin/customers/:cid/questions/:qid` → detail
- Existing `GET .../questions/new` and `POST .../questions` stay; the POST redirect changes from `/admin/customers/:cid` to `/admin/customers/:cid/questions`.

**Customer side — new page:**

5. **`views/customer/questions/list.ejs`** — customer's own question list.
   - Header: eyebrow `CUSTOMER · QUESTIONS`, title `Questions`.
   - Two sections: "Open — needs your answer" and "Answered / skipped" with status pill.
   - Each open question links to `/customer/questions/<id>`.
   - Empty state: "No questions from DB Studio yet." or "You're all caught up." when none open.

6. **`views/customer/questions/show.ejs`** — header rewrite per rule 10:
   - eyebrow `CUSTOMER · QUESTIONS` (was `A question from DB Studio`)
   - title `Question` (was `Help us with one short question`)
   - subtitle: question preview truncated 60 chars.
   - Marketing line "Help us with one short question" moves into a card lead.

7. **`_sidebar-customer.ejs`** — add `Questions` entry linking to `/customer/questions`. Show a count badge if there are `status='open'` questions for this customer.

**New customer route:**

- `GET /customer/questions` → list

**Tests:**

- Integration: admin list returns rows for the customer's questions.
- Integration: admin detail shows answer text / skipped message / awaiting message per status branch.
- Integration: customer list returns only own customer's questions; cross-customer 404.
- Integration: customer list page badge count = open question count.
- Tab presence: admin customer-page-tabs include "Questions" with correct href.

### 5b — Customer-side view-with-decrypt UI (M9.X partial)

Mirrors the admin reveal flow shipped in Phase E.

8. **`views/customer/credentials/show.ejs`** (new — today only `list.ejs` and `new.ejs` exist).
   - Header: eyebrow `CUSTOMER · CREDENTIALS`, title `Credential`, subtitle `<credential.provider>`.
   - Card "Metadata" — Label, Provider, Created, Updated, Needs update.
   - Card "Reveal secret" — POST form to `/customer/credentials/:id/reveal`. After reveal, "Decrypted secret" card with `kv` payload + Hide button (mirrors admin show.ejs).
   - Form-actions: ← Back to credentials.

9. **`domain/credentials/service.view`** — add `actor_type='customer'` branch that writes audit with the customer user's id and `visible_to_customer=true`. Customer audit row goes into the customer activity feed. Same Phase B `credential.viewed` digest fan-out, but now to admins only (the actor is the customer; they don't notify themselves).

10. **Customer routes:**
    - `GET /customer/credentials/:id` → show.ejs (handles re-2FA / vault unlock; renders payload only after `isVaultUnlocked(sid)` and step-up).
    - `POST /customer/credentials/:id/reveal` → does unlock+decrypt, redirects to GET with `?mode=revealed`.
    - `views/customer/credentials/list.ejs` — make label a link to `/customer/credentials/:id`. Update copy to honestly describe the new view path.

11. **`views/customer/step-up.ejs`** (new) — same shape as `views/admin/step-up.ejs` with `CUSTOMER · STEP-UP` eyebrow. Reused by the customer reveal flow.

**Tests:**

- Integration: customer view path requires NDA signed + 2FA stepped up; happy path decrypts payload and writes audit.
- Integration: customer can view own credentials only; cross-customer 404.
- Integration: customer view writes `credential.viewed` digest event to admins (and NOT to themselves).
- Integration: customer step-up failure rate-limits and bucket-isolates from login bucket (mirror Phase E test for admin).

**No new migrations.** All schema already exists.

---

## Section 6 — Test, build, verification

### Test buckets to extend

- `tests/unit/digest-cadence.test.js` (new) — `nextDigestFire` cases including DST.
- `tests/unit/digest-strings.test.js` — verb-rewrite assertions per event type, singular/plural, admin/customer recipient.
- `tests/unit/digest-dates.test.js` (new) — `humanDate` cases per locale.
- `tests/integration/digest/worker.test.js` — replace 10/60-min assertions with twice-daily fire-time assertions; cover skip-if-empty at fire time; cover events-from-N-customers grouping.
- `tests/integration/email/digest.test.js` — snapshot per locale × admin/customer × bucket-mix; subject string assertions.
- `tests/integration/email/templates.test.js` — bump slug count if `digest-strings.js` changes shape.
- `tests/integration/credentials/admin-show.test.js` — header strings post-rewrite.
- `tests/integration/customer-questions/admin-list.test.js` (new), `admin-detail.test.js` (new), `customer-list.test.js` (new).
- `tests/integration/credentials/customer-show.test.js` (new) — view-with-decrypt happy path + 2FA gate + cross-customer isolation + audit + admin-only digest fan-out.
- `tests/integration/credentials/customer-step-up.test.js` (new) — bucket isolation + lockout.

### Build steps after EJS / CSS / string edits

- `node scripts/build.js` after every `.ejs` or `app.src.css` edit (regenerates `_compiled.js` and `app.css`).
- `chmod 644` after every Write/Edit, since the test runner runs as `portal-app` and root-written files land at 640.

### Acceptance gates (run before phase ship)

1. `sudo bash scripts/run-tests.sh` — full suite green (current baseline 657 passing / 3 skipped).
2. `node scripts/clean-stale-test-rows.js` — 0 stale rows.
3. `node scripts/check-detail-pattern.js` — runs clean (advisory; warnings allowed for v1, no errors).
4. Manual verification: send a test digest to a known mailbox via dev-hold replay; eyeball Gmail web + Apple Mail to confirm light-mode rendering and groups/dates render as designed.
5. `sudo bash scripts/smoke.sh` — portal + DB healthy.

### Rollout plan

- Single deploy after the full Phase F bundle. No feature-flag — the cadence change and the layout changes ship together. Operator can revert by reverting the Phase F merge commit if anything's wrong.
- First post-deploy 08:00 fire is the natural smoke test; if it skips correctly on quiet days and renders correctly on busy days, ship is green.

### Migration ledger

None added. Ledger ends at `0011_phase_d`.

---

## Open questions resolved during brainstorm

- **Cadence shape** — fixed twice-daily, skip-if-empty (chosen over bigger debounce or hybrid).
- **Fire times** — 08:00 and 17:00 Atlantic/Canary, single server timezone (no per-recipient override).
- **Schedule table** — keep `digest_schedules`, repurpose `due_at` (chosen over dropping the table).
- **Reveal page layout** — full resource-type pattern (chosen over partial alignment).
- **Open follow-ups folded into Phase F** — customer-side view-with-decrypt, customer-questions UI completion. Admin credential-edit, i18n grind, accessibility pass stay separate.
- **NL/ES translation** — out of scope; mirror EN copy. Real translation lives in deferred i18n phase.

## Out-of-scope items confirmed for later phases

- Admin credential-edit UI.
- i18n localisation grind (~620 strings).
- Accessibility pass (axe-core + skip-link + heading-order).
- Per-recipient digest-time override.
- M3 / M5 / M6 / M9 / M10 review-deferred items per `follow-ups.md`.
