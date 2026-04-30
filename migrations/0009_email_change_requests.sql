-- M9 Task 9.1.2 — email-change requests (verify + revert).
--
-- One row tracks one in-flight email-change request from request through
-- verify (swap) and through the post-swap revert window. Both admins and
-- customer_users use the same table — user_type discriminates.
--
-- Lifecycle:
--   1. requestEmailChange — INSERT row with verify_token_hash,
--      verify_expires_at (24h). The new address is not yet attached to
--      the user; the verification email lands at the new address.
--   2. verifyEmailChange — clicking the verify link consumes the token,
--      swaps the user's email, sets verified_at, mints a revert_token_hash
--      with revert_expires_at (7d) used in the notification email sent to
--      the OLD address. Active sessions stay alive (the user is mid-flow).
--   3. revertEmailChange — clicking the revert link in the OLD-address
--      notification swaps the email back, sets reverted_at, and revokes
--      every active session for the affected user (the change was
--      hostile by definition; the user-on-file expels everyone).
--
-- A user may have only ONE in-flight request at a time. When a fresh
-- request comes in, the prior unverified row is cancelled (cancelled_at
-- set, tokens nulled). When a revert lands, the underlying email is
-- restored and revert_token_hash is nulled so the link is single-use.
--
-- The partial unique index enforces "one in-flight per user" without
-- blocking an unbounded archive of resolved requests.

CREATE TABLE email_change_requests (
  id                UUID PRIMARY KEY,
  user_type         TEXT NOT NULL CHECK (user_type IN ('admin','customer_user')),
  user_id           UUID NOT NULL,
  old_email         CITEXT NOT NULL,
  new_email         CITEXT NOT NULL,
  verify_token_hash TEXT UNIQUE,
  verify_expires_at TIMESTAMPTZ NOT NULL,
  verified_at       TIMESTAMPTZ,
  revert_token_hash TEXT UNIQUE,
  revert_expires_at TIMESTAMPTZ,
  reverted_at       TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_change_requests_one_inflight_per_user
  ON email_change_requests (user_type, user_id)
  WHERE verified_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX email_change_requests_user_idx
  ON email_change_requests (user_type, user_id, created_at DESC);
