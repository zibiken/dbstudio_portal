import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TX_TIMEOUT_MS = 60_000;

export function createDb({
  connectionString,
  max = 10,
  statementTimeoutMs = STATEMENT_TIMEOUT_MS,
  idleInTxTimeoutMs = IDLE_IN_TX_TIMEOUT_MS,
}) {
  const pool = new pg.Pool({ connectionString, max });
  // Per-connection guards so a hung statement (e.g. an outbox worker tick
  // wedged on a network call inside its transaction) cannot indefinitely
  // hold a pool slot or row lock.
  pool.on('connect', (client) => {
    // One concatenated statement so we don't fire two .query() calls
    // back-to-back on a freshly-opened client (pg deprecates that).
    // Both values are integers we control, so template-literal interpolation
    // is safe here.
    client
      .query(
        `SET statement_timeout = ${Number(statementTimeoutMs)}; ` +
        `SET idle_in_transaction_session_timeout = ${Number(idleInTxTimeoutMs)}`,
      )
      .catch(() => {});
  });
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}
