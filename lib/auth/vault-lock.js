import { sql } from 'kysely';

// 5-min sliding idle window for the credential vault. Plan Task 7.3:
// "vault-lock is a session-scoped flag separate from step-up: idle 5
// minutes since last credential interaction → flag cleared → next view
// requires fresh step-up."
//
// Decoupled from step-up because step-up is hard-capped at 5 min from
// 2FA — the vault flag is sliding, refreshed by each successful credential
// view, so an admin reviewing a long list of credentials doesn't have to
// re-2FA every 5 min, but a single-step-up + idle session DOES re-lock
// after 5 min of credential idleness.
export const VAULT_LOCK_IDLE_MS = 5 * 60_000;

export async function isVaultUnlocked(db, sessionId) {
  const r = await sql`
    SELECT 1 FROM sessions
     WHERE id = ${sessionId}
       AND vault_unlocked_at IS NOT NULL
       AND vault_unlocked_at > now() - (${VAULT_LOCK_IDLE_MS}::bigint || ' milliseconds')::interval
  `.execute(db);
  return r.rows.length > 0;
}

export async function unlockVault(db, sessionId) {
  await sql`
    UPDATE sessions SET vault_unlocked_at = now() WHERE id = ${sessionId}
  `.execute(db);
}
