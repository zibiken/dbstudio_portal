-- 0003_admin_invite.sql — extend admins so they can have a pending welcome
-- or password-reset invite token (mirrors customer_users.invite_token_*).
--
-- Drops NOT NULL on password_hash because an admin row exists between
-- creation (via scripts/create-admin.js) and the operator's first password
-- set via the welcome flow.

ALTER TABLE admins ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE admins ADD COLUMN invite_token_hash  TEXT;
ALTER TABLE admins ADD COLUMN invite_expires_at  TIMESTAMPTZ;
ALTER TABLE admins ADD COLUMN invite_consumed_at TIMESTAMPTZ;
