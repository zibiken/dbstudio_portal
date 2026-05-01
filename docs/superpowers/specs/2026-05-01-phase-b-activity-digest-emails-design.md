# Phase B — Activity-digest emails (design)

> **Status:** approved 2026-05-01 (operator). To be planned alongside Phase A (UI fixes) and Phase C (invoice OCR) in a single combined implementation plan.

## Why

The portal currently sends one email per event (`new-document-available`, `new-invoice`, `nda-ready`, `credential-request-created`, …). Operator wants customers and admins to be **notified about everything** that matters, but not spammed by per-event emails. Solution: a per-recipient debounced digest that coalesces events into a single email after 10 min of quiet, with auth/security mails still firing immediately.

## In scope

- A new digest pipeline that replaces four customer-facing per-event templates and adds a parallel admin-facing digest stream.
- A new `invoice_payments` ledger table plus admin "record payment" action (source of `invoice.payment_recorded` and `invoice.paid` digest events).
- Operational guardrails (60-min hard cap, empty-digest drop, dev hold env flag).

## Out of scope

- Recipient-controlled email preferences / unsubscribe.
- In-portal "notifications inbox" UI (the activity feed already serves this).
- Daily `invoice.overdue` synthesised events (deferred to a future phase).
- Push notifications, SMS, mobile.

---

## 1. Architecture overview

```
[ domain service writes audit_log row + digest item ]
                      │
                      ▼
        ┌─────────────────────────┐
        │  pending_digest_items   │  one row per event-recipient pair
        └─────────────────────────┘
                      │
                      ▼
        ┌─────────────────────────┐
        │  digest_schedules       │  one row per recipient, holds debounce timer
        └─────────────────────────┘
                      │
                      ▼
   [ digest worker — every 60s ]
                      │
                      ▼
   render template → enqueue into email_outbox (existing pipeline)
                      │
                      ▼
            [ MailerSend send ]
```

Two new tables, one new worker, one new email template per locale. Reuses `email_outbox`, `audit_log`, `renderTemplate`, MailerSend transport.

### Why "digest items" instead of "digest from audit_log"

We could read `audit_log` directly and project digest items at render time. Rejected because:
- audit_log has tight visibility rules (SAFE_METADATA_KEYS allow-list, `visible_to_customer`); duplicating those for the digest doubles the surface.
- Some events (e.g. `invoice.payment_recorded`) need post-processing (currency formatting, partial-vs-full classification) that we want to capture once at write time, not re-run on every digest worker tick.
- We need a per-recipient cursor (already-included items vs not). Adding `digest_status` to audit_log would mix display state into the immutable audit table.

A separate `pending_digest_items` table is cheap (≤ a few thousand rows live; rows hard-deleted after digest send) and decouples concerns.

---

## 2. Schema additions (migration 0010)

```sql
-- Per-recipient debounce timer.
CREATE TABLE digest_schedules (
  recipient_type text NOT NULL,          -- 'customer_user' | 'admin'
  recipient_id   uuid NOT NULL,
  due_at         timestamptz NOT NULL,   -- when the digest should fire
  oldest_item_at timestamptz NOT NULL,   -- for the 60-min hard cap
  PRIMARY KEY (recipient_type, recipient_id)
);

CREATE INDEX digest_schedules_due_at_idx ON digest_schedules (due_at);

-- Pending items waiting to be summarised.
CREATE TABLE pending_digest_items (
  id              uuid PRIMARY KEY,
  recipient_type  text NOT NULL,
  recipient_id    uuid NOT NULL,
  customer_id     uuid NULL,             -- for admin per-customer grouping; NULL for non-customer-scoped events
  bucket          text NOT NULL,         -- 'action_required' | 'fyi'
  event_type      text NOT NULL,         -- 'document.uploaded', 'invoice.payment_recorded', etc.
  title           text NOT NULL,         -- pre-rendered, locale-correct ("New invoice INV-2026-0042")
  detail          text NULL,             -- optional second line ("€1,210.00 due 2026-05-15")
  link_path       text NULL,             -- "/customer/invoices/<id>"
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_digest_items_recipient_idx
  ON pending_digest_items (recipient_type, recipient_id, created_at);

-- Coalescing key (admin sees "Acme Corp downloaded 4 documents", not 4 lines).
CREATE INDEX pending_digest_items_coalesce_idx
  ON pending_digest_items (recipient_type, recipient_id, event_type, customer_id);

-- Invoice payment ledger.
CREATE TABLE invoice_payments (
  id           uuid PRIMARY KEY,
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL CHECK (currency IN ('EUR')),
  paid_on      date NOT NULL,
  note         text NULL,
  recorded_by  uuid NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invoice_payments_invoice_idx ON invoice_payments (invoice_id, paid_on);
```

Notes:
- `recipient_id` is intentionally not a FK — it points into either `customer_users(id)` or `admins(id)` depending on `recipient_type`, and we want the row to survive (and be cleaned up by the digest worker) even if the recipient is deleted.
- `digest_schedules` is keyed by `(recipient_type, recipient_id)`; the row is upserted on each new event for that recipient.
- `pending_digest_items` is the projection layer — title/detail are pre-localized at write time so we never need to look up customer/document/invoice rows at digest render time.
- `invoice_payments` enforces single-currency EUR (matches the existing invoices model). `amount_cents` integer avoids float rounding.

### Relation to existing invoice status

The `invoices` table already has a status column (per memory: "overdue computed in SQL"). Adding the ledger:
- `invoices.status` is *computed*: `paid` when `SUM(invoice_payments.amount_cents) >= invoices.total_cents`; `partially_paid` when sum > 0; else `open` (or `overdue` per existing time logic).
- No new column on `invoices`. The repo's `findById` and `listForCustomer` join the payments aggregate.

---

## 3. Event catalogue & buckets

| Event | Customer | Admin | Customer bucket | Admin bucket | Coalescing |
|---|---|---|---|---|---|
| `nda.created` | ✓ | — | Action required | — | one line per NDA |
| `nda.signed` | — | ✓ | — | FYI | one line per NDA |
| `document.uploaded` | ✓ | — | FYI | — | "Acme Corp: 3 new documents" if multiple |
| `document.downloaded` | — | ✓ | — | FYI | "Acme Corp downloaded 4 documents" — one line |
| `credential_request.created` | ✓ | — | Action required | — | one line per request |
| `credential_request.fulfilled` | — | ✓ | — | FYI | one line per request |
| `credential_request.not_applicable` | — | ✓ | — | FYI | one line per request |
| `credential.viewed` (admin views) | ✓ | — | FYI | — | "DB Studio viewed 2 credentials" — one line |
| `credential.created` by customer | — | ✓ | — | FYI | "Acme Corp added 2 credentials" — one line |
| `credential.updated` by customer | — | ✓ | — | FYI | one line per credential |
| `credential.deleted` by customer | — | ✓ | — | FYI | one line per credential |
| `invoice.uploaded` | ✓ | — | FYI | — | one line per invoice |
| `invoice.payment_recorded` | ✓ | ✓ | FYI | FYI | one line per payment |
| `invoice.paid` (computed: sum ≥ total) | ✓ | ✓ | FYI | FYI | one line per invoice |
| `project.created` | ✓ | — | FYI | — | one line per project |
| `project.status_changed` | ✓ | — | FYI | — | one line per change |
| `customer.suspended` / `reactivated` / `archived` | ✓ | — | FYI | — | one line per change |

**Not digestable** (always immediate): `auth.email_otp`, `customer_user.password_reset_requested`, `admin.password_reset_requested`, `customer_user.invitation_sent`, `customer_user.invite_expiring_soon`, `auth.new_device_login`, `email_change.verification`, `email_change.notification_old`, `2fa.reset_by_admin`, `admin.welcome`, `generic_admin_message`. These remain on the existing direct-enqueue path.

### Coalescing rule

At enqueue time, before inserting a new `pending_digest_items` row, check for an existing un-flushed item with `(recipient_type, recipient_id, event_type, customer_id)` matching, **AND** with a coalescing flag (e.g. event types marked "coalescing" in the catalogue table above). If one exists, update its `title`/`detail`/`metadata.count` instead of inserting a new row. Non-coalescing event types always insert a new row.

---

## 4. Per-recipient debounce mechanic

When a domain service emits a digestable event for recipient R:

1. **Insert/update** `pending_digest_items` (with coalescing per §3).
2. **Upsert** `digest_schedules` for R:
   - If row missing: insert with `due_at = now() + 10 min`, `oldest_item_at = now()`.
   - If row exists: `due_at = LEAST(now() + 10 min, oldest_item_at + 60 min)`. The `LEAST` enforces the **60-min hard cap** — even if events keep arriving, the timer cannot slide more than 60 min past the oldest item.
3. Both writes happen **inside the same transaction** as the audit_log write that the domain service is already doing. Atomicity guarantee: if the audit row commits, the digest item is queued.

The customer's own actions still produce items in the **admin** digest stream (admin sees what customer did), but **not** in the customer's own digest stream — this avoids the "self-recap" noise that B-Q3(b) was rejected for.

### Worker

`domain/digest/worker.js`, ticks every 60 seconds (configurable; production default 60s, tests use 100ms via injected interval):

```
SELECT recipient_type, recipient_id
  FROM digest_schedules
 WHERE due_at <= now()
 LIMIT 50
   FOR UPDATE SKIP LOCKED;
```

For each claimed schedule row, in a single transaction:
1. Read all `pending_digest_items` for that recipient.
2. If zero items remain (all retracted before fire): delete the schedule row, do not enqueue. **Empty-digest drop.**
3. Otherwise: render the digest email (locale-correct, two sections), enqueue into `email_outbox` with `idempotencyKey = digest:<recipient_type>:<recipient_id>:<schedule_due_at_iso>`.
4. Delete the consumed `pending_digest_items` rows + the `digest_schedules` row.

`FOR UPDATE SKIP LOCKED` allows the existing single-process model (no clustering) to scale safely if we ever go multi-process. The locale is read from `customer_users.locale` or `admins.locale` at render time, so a locale change between event-emit and digest-fire takes effect.

---

## 5. Email template

New template `digest.ejs` (one per locale: `emails/en/digest.ejs`, `emails/nl/digest.ejs`, `emails/es/digest.ejs`) using the existing `_layout.ejs` for styling consistency with all other emails.

Subject lines (recipient-localized):
- Customer with action items: *"Action required from DB Studio (3 items)"* — `n` items in Action-Required.
- Customer with FYI only: *"What's new in your DB Studio Portal (5 items)"*.
- Admin: *"DB Studio Portal — activity update (2 customers, 7 items)"*.

Body structure:
1. Greeting (`Hello, {recipient.name}.`)
2. **Action required** section (if any items) — bulleted list, each line: `<title>` + optional `<detail>` muted, anchored to `link_path` (absolute URL: `https://portal.dbstudio.one<link_path>`).
3. **For your information** section.
4. Footer: "You're getting this because there was activity in your DB Studio Portal. Sign in to see the full timeline." + standard `_layout.ejs` footer.

Admin variant: same shell, but each section's items are grouped by customer (H3 per customer name, items beneath).

### Branding & copy

- Visual: identical to existing emails (same `_layout.ejs`, same fonts, same DB Studio header/footer).
- Brand name "DB Studio" never translated (per memory `feedback_brand_names.md` — applies to DB Studio variant of that rule).
- Locale-correct currency formatting for invoice amounts (Intl.NumberFormat in the helper; existing `euDateTime` for dates).

---

## 6. Domain integration: where the events come from

For each event in §3, the domain service that writes the audit row is extended with one call to a new helper:

```js
// lib/digest.js
export async function recordForDigest(tx, {
  recipientType,    // 'customer_user' | 'admin'
  recipientId,      // uuid
  customerId,       // uuid | null  (for admin per-customer grouping)
  bucket,           // 'action_required' | 'fyi'
  eventType,        // 'invoice.uploaded', etc.
  title,            // pre-rendered, locale-correct
  detail,           // optional
  linkPath,         // optional
  coalesceKey,      // optional — when set, updates existing matching row instead of inserting
  metadata,         // optional
}) { … }
```

**Recipient fan-out** is the caller's job: when `domain/documents/service.js` uploads a document for customer C, it queries `customer_users WHERE customer_id = C` and calls `recordForDigest` once per active user. Same pattern for admin fan-out (`SELECT id FROM admins WHERE active = TRUE`). Both fan-outs happen in the same DB transaction as the audit_log write.

**Locale resolution** happens at the title/detail rendering callsite — the service queries the recipient's `locale` and uses i18next or a small translation helper to produce the correct string before calling `recordForDigest`. This is why we store pre-rendered text in `pending_digest_items` rather than translating at digest render time.

### Domain services to be touched

- `domain/documents/service.js` — `document.uploaded` (customer), `document.downloaded` (admin)
- `domain/credential-requests/service.js` — `credential_request.{created,fulfilled,not_applicable}`
- `domain/credentials/service.js` — `credential.{viewed,created,updated,deleted}`
- `domain/invoices/service.js` — `invoice.{uploaded,payment_recorded,paid}`
- `domain/projects/service.js` — `project.{created,status_changed}`
- `domain/customers/service.js` — `customer.{suspended,reactivated,archived}`
- `domain/ndas/service.js` — `nda.{created,signed}`

Each call site is a 5–10 line addition next to the existing audit-write. **The four currently immediate templates (`new-document-available`, `new-invoice`, `nda-ready`, `credential-request-created`) stop being enqueued.** Their template files stay in the repo for now (no harm), but the call sites change to `recordForDigest` instead of `enqueueEmail`.

---

## 7. Invoice payment-status feature

New admin UI: on `/admin/invoices/:id` (admin invoice detail), three buttons appear when `status !== 'paid'`:

- **Record payment** — modal-form with fields: `amount` (EUR), `paid_on` (date, defaults to today), `note` (optional). On submit, inserts an `invoice_payments` row.
- **Mark fully paid** — shortcut: `amount = total - SUM(existing payments)`, `paid_on = today`. Single-click.
- **Edit payment / delete payment** — admin can edit or delete past payment rows from a "Payments" panel beneath the invoice details. Delete requires step-up auth (defence in depth, mirrors credential-edit pattern from M7).

Customer view: on `/customer/invoices/:id`, the new "Payments" panel shows the ledger read-only:
```
Paid: €1,210.00 of €1,500.00
  • €1,000.00 on 2026-04-15
  • €210.00   on 2026-04-29
Outstanding: €290.00
```

Status pill computed from sum: `open` (no payments) → `partially_paid` (sum > 0 and < total) → `paid` (sum ≥ total).

Each payment insert emits:
- `invoice.payment_recorded` to all customer_users (FYI bucket) and all admins (FYI).
- If `SUM >= total`, additionally emit `invoice.paid` (FYI customer, FYI admin).

Audit: every `invoice_payments` insert/edit/delete writes to `audit_log` via the existing `audit.write` pattern, with `visible_to_customer = TRUE` for inserts so the customer's activity feed shows the payment record.

---

## 8. Operational guardrails

- **60-min hard cap.** Enforced by the `LEAST(now() + 10 min, oldest_item_at + 60 min)` formula in §4 step 2.
- **Empty-digest drop.** Worker step 2 in §4.
- **No opt-out.** Digest is transactional; no preference UI in v1.
- **Dev hold env flag.** New env `PORTAL_EMAIL_DEV_HOLD=true` short-circuits `mailer.send` to log-only when true. Implemented inside `makeMailer` to cover *all* emails (digest + immediate auth). When false (production default), no behavioural change.

---

## 9. Acceptance

For Phase B to be considered "done":

- A test customer with three rapid actions (NDA-created, document-uploaded, credential-request-created) within 8 minutes receives **exactly one** digest email, ~10 minutes after the third action, with all three items in the correct buckets.
- An admin observing two different customers each performing actions in the same 10-min window receives **exactly one** digest email with per-customer subheadings.
- A customer with continuous activity for 65 minutes still receives a digest email by the 60-min hard cap.
- Auth flows (sign-in OTP, password reset, invitation) still produce immediate emails — no auth email is digested.
- Recording an invoice payment (admin → "Record payment" → submit) flips the invoice status pill correctly on both admin and customer surfaces, writes to `invoice_payments`, writes to `audit_log`, and produces the two digest events.
- Empty digests (all items retracted before fire) do not produce emails.
- All three locales (EN/NL/ES) render correctly.
- `PORTAL_EMAIL_DEV_HOLD=true` suppresses sends end-to-end.

## 10. Test plan

- Unit: per-recipient debounce timer math, including the `LEAST(...)` cap.
- Unit: coalescing logic (multiple `document.downloaded` from same customer → one row, count incremented).
- Integration: Vitest with the existing live-Postgres test harness — fan-out, schedule update, worker fire, email_outbox enqueue, idempotency key uniqueness.
- Integration: invoice payment ledger CRUD, status computation, edge cases (over-payment, zero-amount rejection).
- Manual smoke: a 3-event customer scenario observed end-to-end on operator dev.
- Live-smoke (`RUN_LIVE_EMAIL=true`): one digest send through MailerSend sandbox at the M-boundary.

## 11. Risk

Medium. The debounce-and-fire pipeline is new and stateful, so the failure modes are:
- **Worker stalled** → emails delayed, but eventually delivered when worker recovers (no data loss; pending items survive).
- **Worker double-fire** (worker crashes between item-delete and outbox-insert) → handled by `email_outbox.idempotency_key` already enforcing dedupe at the MailerSend layer; worst case is items resurrected for a second digest (we can mitigate later with a "last_fired_at" cursor).
- **Locale drift** between event-emit and digest-fire → cosmetic, low impact (rendered titles already in user's previous locale; new events in current locale).
- **Schema migration** → standard migration via existing runner; no data backfill.

Reverting this phase is one migration-down + one branch revert. The four currently immediate templates remain in the repo, so reverting just re-enables the per-event call sites.
