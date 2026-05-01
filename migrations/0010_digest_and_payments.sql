-- Phase B (2026-05-01): per-recipient debounce digest pipeline + invoice payment ledger.

-- Per-recipient debounce timer.
CREATE TABLE digest_schedules (
  recipient_type text NOT NULL CHECK (recipient_type IN ('customer_user', 'admin')),
  recipient_id   uuid NOT NULL,
  due_at         timestamptz NOT NULL,
  oldest_item_at timestamptz NOT NULL,
  PRIMARY KEY (recipient_type, recipient_id)
);
CREATE INDEX digest_schedules_due_at_idx ON digest_schedules (due_at);

-- Pending items waiting to be summarised.
CREATE TABLE pending_digest_items (
  id              uuid PRIMARY KEY,
  recipient_type  text NOT NULL CHECK (recipient_type IN ('customer_user', 'admin')),
  recipient_id    uuid NOT NULL,
  customer_id     uuid NULL,
  bucket          text NOT NULL CHECK (bucket IN ('action_required', 'fyi')),
  event_type      text NOT NULL,
  title           text NOT NULL,
  detail          text NULL,
  link_path       text NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_digest_items_recipient_idx
  ON pending_digest_items (recipient_type, recipient_id, created_at);
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

-- Per-recipient locale (used by digest fan-out + future per-event mails).
ALTER TABLE customer_users ADD COLUMN locale CHAR(2) NOT NULL DEFAULT 'en';
ALTER TABLE admins         ADD COLUMN locale CHAR(2) NOT NULL DEFAULT 'en';
