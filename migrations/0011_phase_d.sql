-- 0011_phase_d.sql
--
-- Phase D customer-trust workflow:
--   - NDA gate (customers.nda_signed_at): set-once stamp marking the
--     moment a customer's first signed NDA was uploaded; gate middleware
--     redirects feature surfaces to /customer/waiting until set.
--   - Cleanup banner dismissal (customers.last_cleanup_banner_dismissed_at):
--     mutable timestamp; banner shows audit rows newer than this.
--   - Type C short-answer questionnaire (customer_questions): plain text
--     by design (these aren't secrets); append-only after status change
--     (enforced at app layer via WHERE status='open' guard).

ALTER TABLE customers
  ADD COLUMN nda_signed_at TIMESTAMPTZ NULL;

ALTER TABLE customers
  ADD COLUMN last_cleanup_banner_dismissed_at TIMESTAMPTZ NULL;

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
