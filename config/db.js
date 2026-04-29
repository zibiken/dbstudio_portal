import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

export function createDb({ connectionString, max = 10 }) {
  const pool = new pg.Pool({ connectionString, max });
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}
