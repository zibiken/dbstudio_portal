-- 0006_session_vault_unlocked_at.sql
--
-- Adds the vault-lock timer column to sessions (Task 7.3 — credential
-- vault auto-lock). Distinct from step_up_at: step_up_at is set by 2FA
-- only; vault_unlocked_at is set by 2FA AND refreshed by every successful
-- credential view, giving the credential vault a sliding 5-min idle
-- window separate from the hard step-up window.
--
-- NULL for existing rows is the correct default — pre-migration sessions
-- have never been "vault-unlocked" and must re-step-up to view credentials.

ALTER TABLE sessions
  ADD COLUMN vault_unlocked_at TIMESTAMPTZ;
