-- M5 (M9 review) — audit_log metadata->>'customerId' expression index.
--
-- The customer activity feed (lib/activity-feed.js: listActivityForCustomer)
-- OR-joins `metadata->>'customerId' = X` against `target_type='customer' AND
-- target_id=X`. Without an expression index on the JSONB path, every
-- customer-activity page-load scans the full audit_log once it grows
-- past a few thousand rows.
--
-- Partial index on `visible_to_customer = TRUE` matches the only column
-- the customer feed reads, keeping the index small (admin-only rows
-- never ride the index pages).

CREATE INDEX IF NOT EXISTS idx_audit_metadata_customer
  ON audit_log ((metadata->>'customerId'))
  WHERE visible_to_customer;
