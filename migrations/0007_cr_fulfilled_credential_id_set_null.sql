-- 0007_cr_fulfilled_credential_id_set_null.sql
--
-- Convert credential_requests.fulfilled_credential_id's foreign key from
-- the default NO ACTION to ON DELETE SET NULL.
--
-- Rationale: a customer or admin deleting a credential is supported per
-- the M7 trust contract (Task 7.2). When the credential being deleted was
-- originally fulfilled from a request, the request's history must be
-- preserved (status='fulfilled' is the truth — it WAS fulfilled at one
-- point) but the now-dangling FK pointer must clear. Without this change
-- the credentials.delete path errors out as soon as a request was ever
-- fulfilled.
--
-- The audit log carries the full deletion record; a NULL fulfilled_
-- credential_id paired with status='fulfilled' is correctly interpreted
-- as "fulfilled, then later deleted" by the read-side renderer.

ALTER TABLE credential_requests
  DROP CONSTRAINT credential_requests_fulfilled_credential_id_fkey;

ALTER TABLE credential_requests
  ADD CONSTRAINT credential_requests_fulfilled_credential_id_fkey
  FOREIGN KEY (fulfilled_credential_id)
  REFERENCES credentials(id)
  ON DELETE SET NULL;
