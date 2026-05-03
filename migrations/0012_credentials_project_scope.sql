-- Phase G4: per-project credential scope.
--
-- A credential can be:
--   * company-wide (project_id IS NULL) — visible across the whole customer
--   * scoped to one project (project_id = <uuid>) — visible only on that
--     project's surface (and in the company-wide grouped list under the
--     project's heading).
--
-- Existing rows stay company-wide on this migration; nothing is migrated.
--
-- ON DELETE RESTRICT matches the projects ↔ representatives relationship
-- (0008_customer_representative). Deleting a project that still owns
-- credentials must be a deliberate operation; the service layer handles
-- the unscope/move flow.
--
-- Cross-customer integrity: if project_id is set, the project must belong
-- to the same customer as the credential. This is enforced in
-- domain/credentials/service.js (via a SELECT 1 check inside the
-- transaction) — Postgres does not support multi-column FOREIGN KEYs that
-- reference a non-PK pair, and a trigger here would duplicate logic that
-- already lives in the service layer.

ALTER TABLE credentials
  ADD COLUMN project_id UUID NULL REFERENCES projects(id) ON DELETE RESTRICT;

CREATE INDEX idx_credentials_customer_project
  ON credentials (customer_id, project_id);
