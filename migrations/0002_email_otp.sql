-- 0002_email_otp.sql — store for active email-OTP codes.
--
-- Each request inserts one row carrying a SHA-256 hash of the 6-digit code
-- plus an absolute expires_at and an attempt counter. `consumed_at` is set
-- on successful verify (single-use) or when superseded by a fresh request.
--
-- Plain SHA-256 is sufficient here: codes are 10^6-keyspace, TTL is 5 min,
-- and the 3-attempt cap turns brute force into a practical non-issue. The
-- DB column never contains the plaintext code.

CREATE TABLE email_otp_codes (
  id          UUID PRIMARY KEY,
  user_type   TEXT NOT NULL CHECK (user_type IN ('admin','customer')),
  user_id     UUID NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_otp_active
  ON email_otp_codes (user_type, user_id, created_at DESC)
  WHERE consumed_at IS NULL;
