# Phase D — Design Spec

> **Status:** approved 2026-05-01. Implementation pending.
> **Predecessor handoff:** `docs/superpowers/2026-05-01-phase-d-handoff.md`.
> **Successor:** `docs/superpowers/plans/2026-05-01-phase-d-plan.md` (to be written by `superpowers:writing-plans`).

## Goal

Close the customer-trust gaps surfaced in the post-Phase-C audit:

1. Prevent customers from reaching feature surfaces before they have signed and we have recorded their NDA.
2. Give admins a structured way to ask short-answer questions and customers a structured way to answer (or decline) them.
3. Surface admin-driven credential cleanups to customers as a dismissible dashboard banner so the trust contract is visible.
4. Stop integration-test fixtures from leaking into the operator's real digest mail.

Phase E (digest copy/layout/grouping rework) is split off into its own future spec.

## Approved scope (operator-confirmed 2026-05-01)

1. **NDA gate.** Customer cannot reach `/customer/dashboard` or any feature surface until `customers.nda_signed_at` is set. Allowed while waiting: `/customer/profile`, `/customer/waiting`, transactional auth flows. APIs return `403 { error: 'nda_required' }`.
2. **Type C — short-answer questionnaire.** Company-level (no `project_id`). Plain text, not vault-encrypted. "Skip / I don't know" is first-class. Append-only after answer/skip.
3. **"Cleaned up" dashboard banner.** Reads existing `credential.deleted` audit rows; dismissal stamped on `customers.last_cleanup_banner_dismissed_at`.
4. **Test-pollution cleanup.** Extend `tests/helpers/audit.js` teardown to delete `pending_digest_items` and `digest_schedules` rows for tagged fixtures.

**Dropped from handoff scope:**
- **Per-project workspace.** With credentials and questions both company-level, the only project-scoped artifact is the NDA, which already shows on the dashboard NDA list. A separate per-project view would duplicate dashboard content. Skip.

## Architecture overview

All four work-items are independent at runtime; they share no code path. Migration `0011_phase_d.sql` bundles all schema changes (closely-related customer-trust workflow). Customer-visible copy ships in `en`, `es`, `nl`.

**Implementation order (test cleanup first to keep dev mail clean during the rest of Phase D):**

1. Test-pollution cleanup (tests/helpers).
2. Schema migration `0011_phase_d.sql`.
3. NDA gate (middleware + waiting page + `nda.unlocked` transactional email).
4. Type C questionnaire (admin create page, customer answer page, dashboard panel, 3 digest events).
5. Cleanup banner (dashboard component, dismiss endpoint).

## Schema (`migrations/0011_phase_d.sql`)

```sql
-- 0011_phase_d.sql

-- 1. NDA gate marker (set-once; first signed NDA upload wins).
ALTER TABLE customers
  ADD COLUMN nda_signed_at TIMESTAMPTZ NULL;

-- 2. Cleanup banner dismissal stamp (mutable; banner shows audit rows newer than this).
ALTER TABLE customers
  ADD COLUMN last_cleanup_banner_dismissed_at TIMESTAMPTZ NULL;

-- 3. Type C questionnaire (company-level, plain text, append-only after status change).
CREATE TABLE customer_questions (
  id                            UUID PRIMARY KEY,
  customer_id                   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_by_admin_id           UUID NOT NULL REFERENCES admins(id),
  answered_by_customer_user_id  UUID NULL REFERENCES customer_users(id),
  question                      TEXT NOT NULL,
  answer_text                   TEXT NULL,
  status                        TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'skipped')),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at                   TIMESTAMPTZ NULL
);

CREATE INDEX customer_questions_customer_id_status_idx
  ON customer_questions (customer_id, status);

CREATE INDEX customer_questions_created_at_idx
  ON customer_questions (created_at DESC);
```

**Schema notes:**
- `nda_signed_at`: setter checks `nda_signed_at IS NULL` before writing, so a second project NDA upload doesn't move the timestamp forward and doesn't re-fire the unlock email.
- `last_cleanup_banner_dismissed_at`: any dismissal moves it forward; NULL means never dismissed.
- `customer_questions`: plain text by design — these are not secrets. Indexes match the read patterns: list-by-customer-and-status (admin + customer dashboards) and recent-first listings.

## Routes & files

### New customer-facing routes

| Route | File | Purpose |
|---|---|---|
| `GET /customer/waiting` | `src/routes/customer/waiting.js` + `views/customer/waiting.ejs` | NDA-pending interstitial. Shows account info, support link, profile/logout footer. |
| `GET /customer/questions/:id` | `src/routes/customer/questions/show.js` + `views/customer/questions/show.ejs` | Single open question, textarea + submit + "Skip / I don't know". |
| `POST /customer/questions/:id/answer` | same router | Set `status='answered'`, `answer_text`, `answered_by_customer_user_id`, `answered_at`. Emits `question.answered` audit + admin FYI digest event. |
| `POST /customer/questions/:id/skip` | same router | Set `status='skipped'`, `answered_by_customer_user_id`, `answered_at`. Emits `question.skipped` audit + admin FYI digest. |
| `POST /customer/dashboard/cleanup-banner/dismiss` | `src/routes/customer/dashboard.js` (extension) | Stamp `customers.last_cleanup_banner_dismissed_at = now()`. Returns 204. |

### New admin-facing routes

| Route | File | Purpose |
|---|---|---|
| `GET /admin/customers/:cid/questions/new` | `src/routes/admin/customers/questions/new.js` + `views/admin/customers/questions/new.ejs` | Single textarea + submit. Mirrors `credential_requests` "new" page. |
| `POST /admin/customers/:cid/questions` | same router | Create row, emit `question.created` audit + customer Action-required digest event. |
| `GET /admin/customers/:cid` (extended) | existing | Add a "Questions" panel listing open + recently-resolved questions, with link to `/admin/customers/:cid/questions/new`. |

### New middleware

| File | Purpose |
|---|---|
| `src/middleware/nda-gate.js` | Strict allowlist. Pages 302 to `/customer/waiting`; APIs return `403 { error: 'nda_required' }`. Mounted on `/customer/*` and `/api/customer/*`. |

**Allowlist (NDA gate bypass):**
- Pages: `/customer/waiting`, `/customer/profile`, `/customer/profile/*`, `/auth/logout`, `/auth/email-change/*`, `/auth/password-reset/*`.
- APIs: `/api/customer/me`, `/api/customer/profile/*`, `/api/auth/*`.

### Modified existing files

| File | Change |
|---|---|
| `domain/ndas/service.js` (`attachUploadedDocument`) | On `kind === 'signed'`, inside existing tx: `UPDATE customers SET nda_signed_at = now() WHERE id = $1 AND nda_signed_at IS NULL`. After commit, if the row was updated (i.e. first signed NDA), enqueue `nda.unlocked` transactional email to every `customer_users` row of that customer. |
| `views/customer/dashboard.ejs` | Render cleanup banner (when applicable) at top + a "Questions" panel listing open questions with deep-links. |
| `lib/digest-strings.js` | Add titles for `question.created`, `question.answered`, `question.skipped` in `en`, `es`, `nl`. |
| `domain/digest/worker.js` | Add fan-out handlers for the three new event types. |
| `tests/helpers/audit.js` (cleanup) | Extend cleanup chain: also `DELETE FROM pending_digest_items WHERE recipient_id IN (<test customer ids> ∪ <test admin ids>)` and same for `digest_schedules`. |

### New email template

| File | Purpose |
|---|---|
| `emails/{en,es,nl}/nda-unlocked.ejs` + entry in email registry | Transactional "Your dashboard is now unlocked." Uses `renderBaseEmail()`. Deep-links to `/customer/dashboard`. |

## Waiting page content (`/customer/waiting`)

- Headline + paragraph: NDA preparation in progress; dashboard unlocks automatically once we record the signed NDA. We will email you.
- Account-confirmation panel: shows `razon_social` + account email so the customer can verify they're on the right account. Includes "Account created on `<localized-date>`" line.
- Support link: `mailto:hello@dbstudio.one`.
- Footer links: `/customer/profile` (change email/password) + logout.

No simulated progress bar; unlock is admin-driven and the system has no truthful intermediate states to surface.

## Cleaned-up banner: behavior

**Read query** (uses real `audit_log` schema — `action`, `ts`, `metadata->>'customerId'`):

```sql
SELECT id, ts, metadata
FROM audit_log
WHERE action = 'credential.deleted'
  AND actor_type = 'admin'
  AND visible_to_customer = true
  AND metadata->>'customerId' = $1::text
  AND ts > now() - interval '7 days'
  AND ts > COALESCE(
    (SELECT last_cleanup_banner_dismissed_at FROM customers WHERE id = $1),
    '-infinity'::timestamptz
  )
ORDER BY ts DESC
LIMIT 1;
```

The `metadata->>'provider'` value supplies the provider name for the banner copy. The `idx_audit_customer_visible` partial index on `(target_id, ts DESC) WHERE visible_to_customer` doesn't help here (we filter by `metadata->>'customerId'`, not `target_id`); add `CREATE INDEX audit_log_credential_deleted_customer_idx ON audit_log ((metadata->>'customerId')) WHERE action = 'credential.deleted' AND visible_to_customer` to the migration if profiling shows the query is slow. Defer the index until then — `audit_log` is small.

**Multi-cleanup behavior:** show only the newest. Older cleanups in the 7-day window are hidden behind the same dismissal. (Audit log retains full history; banner is a trust signal, not a feed.)

**Placement:** top of `/customer/dashboard`, full-width, info-style (neutral/blue), small "×" dismiss on the right.

**Copy:** *"DB Studio cleaned up your `<provider>` credential on `<localized-date>`."* — provider in `<code>` styling, date in customer's locale.

**Dismiss:** `POST /customer/dashboard/cleanup-banner/dismiss` → `UPDATE customers SET last_cleanup_banner_dismissed_at = now() WHERE id=$1` → 204 → client refreshes.

## Type C questionnaire: behavior

### Admin creation flow

`/admin/customers/:cid/questions/new` is a dedicated page (mirrors `credential_requests` new page pattern). Single textarea, submit button. POST creates the row, emits `question.created` audit, enqueues digest event for every `customer_users` of that customer (Action-required channel).

### Customer answer flow

Customer sees the question on `/customer/dashboard` "Questions" panel. Click → `/customer/questions/:id` (textarea + "Submit answer" + "Skip / I don't know").

**Answer:** `UPDATE customer_questions SET status='answered', answer_text=$1, answered_by_customer_user_id=$session_user, answered_at=now() WHERE id=$id AND status='open'`. The `AND status='open'` enforces immutability under concurrent answers — if a different seat beat us to it, the update is a no-op and the page renders "this question is no longer open."

**Skip:** same with `status='skipped'`, `answer_text` left NULL.

Both paths emit audit + admin FYI digest event.

### Audit / digest events

Three new digest event types in this phase:

| Event | To | Channel |
|---|---|---|
| `question.created` | Customer (all `customer_users`) | Action-required |
| `question.answered` | Admin | FYI |
| `question.skipped` | Admin | FYI |

No new event for `nda_signed_at` being set; that moment is already audited by the existing `nda.signed_attached` event. The customer-facing notification is the new transactional `nda.unlocked` email (not a digest event).

No new event for cleanup-banner dismissal; silent.

## Edge cases

### NDA gate

- Customer is mid-session when admin uploads NDA → next request unblocks; nothing live-pushed.
- Customer logged-out tab clicks an old link → standard auth flow, then gate.
- Admin uploads a *second* (project-2) signed NDA → `WHERE nda_signed_at IS NULL` clause makes the SET a no-op; no email, no events.
- Email-change confirmation link sent before NDA upload still works (allowlisted route).

### Type C questionnaire

- Two `customer_users` from same company answer simultaneously → one wins via `WHERE status='open'`; loser sees "this question is no longer open." Only one digest event emitted.
- `customer_user_A` tries `GET /customer/questions/<question_belongs_to_B>` → 404 (row-scope on `customer_id` in query).

### Cleanup banner

- Multiple cleanups in 7-day window → newest only; dismissal hides older too.
- Customer dismisses, admin runs another cleanup the same day → newer `created_at > last_cleanup_banner_dismissed_at` → banner reappears with the new event.
- Customer never dismisses → banner naturally falls off after 7 days.

### Test-pollution cleanup

- If `pending_digest_items.recipient_id` / `digest_schedules.recipient_id` are FK-constrained with `ON DELETE CASCADE` to customers/admins, the explicit `DELETE` becomes a no-op (correct, harmless). Verify in schema before implementing; if it's already CASCADE the issue is elsewhere — investigate before assuming the explicit delete is sufficient.

## Testing

### Migration test

Apply `0011_phase_d.sql` to a fresh test DB; assert columns and table exist with expected types and constraints. One assertion per added artifact (matches existing migration test pattern).

### NDA gate (`tests/integration/nda-gate.test.js`)

- Customer with `nda_signed_at = NULL` → `GET /customer/dashboard` → 302 `/customer/waiting`.
- Same customer → `GET /customer/profile` → 200.
- Same customer → `GET /api/customer/credentials` → `403 { error: 'nda_required' }`.
- Email-change confirmation route works while gated.
- Password-reset flow works while gated.
- After admin uploads signed NDA: same customer → `GET /customer/dashboard` → 200; `nda.unlocked` email enqueued to all `customer_users` of that customer.
- Second project's signed NDA upload: `nda_signed_at` unchanged; no second `nda.unlocked` email fired.

### Type C (`tests/integration/customer-questions.test.js`)

- Admin creates question → row inserted with `status='open'`, audit `question.created` written, customer digest event enqueued.
- Customer answers → `status='answered'`, `answered_at` stamped, `answered_by_customer_user_id` set, admin FYI digest event enqueued.
- Customer skips → `status='skipped'`, `answer_text` NULL, admin FYI digest event enqueued.
- Race condition: two customer_users hit `/answer` simultaneously → one wins, other gets "no longer open"; one digest event total.
- Cross-customer access: 404.

### Cleanup banner (`tests/integration/cleanup-banner.test.js`)

- `credential.deleted` audit (admin actor, `visible_to_customer=true`) within 7 days, `last_cleanup_banner_dismissed_at` NULL → banner renders with provider + date.
- Customer POSTs dismiss → 204; subsequent dashboard render has no banner.
- New `credential.deleted` post-dismissal → banner reappears.
- Older than 7 days → no banner.
- `visible_to_customer=false` → no banner.
- `actor_type='customer'` → no banner.

### Test-pollution cleanup (`tests/integration/test-helpers-cleanup.test.js`)

- Fixture creates customer + admin, generates a digest event, runs teardown.
- Assert `pending_digest_items WHERE recipient_id IN (...)` returns 0 rows post-teardown.
- Assert `digest_schedules WHERE recipient_id IN (...)` returns 0 rows post-teardown.
- After full integration suite run: 0 leftover digest rows from any tagged fixture.

### Email template tests

`nda.unlocked` template renders without errors in `en`, `es`, `nl`; subject line + key copy strings present.

### Smoke checklist after merge

- `sudo bash scripts/run-tests.sh` → all pass (target: 610 + ~25 new ≈ 635 passing).
- Manual: log in as fresh customer with no signed NDA → `/customer/dashboard` redirects to `/customer/waiting`, `/customer/profile` reachable, footer logout works.
- Manual: admin creates a question → switch to customer session → answer it → switch back → admin sees the answer panel.
- Manual: admin runs `credentials.delete` from admin UI → customer dashboard shows banner; customer dismisses → banner gone.
- Confirm `PORTAL_EMAIL_DEV_HOLD=true` is still respected during dev verification.

## Out of scope (future Phase E)

- Digest copy/layout/grouping rework: subject line content, per-customer admin grouping, natural-language verb rewrites, timestamps per item, drop-internal-IDs, light/dark mail-client compatibility. Tracked in handoff doc; will get its own spec.
