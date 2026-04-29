import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { writeAudit } from '../../../lib/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('writeAudit', () => {
  let db;
  const tag = `audit_test_${Date.now()}`;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      // Bypass the append-only trigger to keep production audit_log clean.
      await sql.raw(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify`).execute(db);
      await sql`DELETE FROM audit_log WHERE action LIKE ${tag + ':%'}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify`).execute(db);
      await db.destroy();
    }
  });

  it('inserts a row with all provided fields', async () => {
    await writeAudit(db, {
      actorType: 'admin',
      actorId: '00000000-0000-0000-0000-000000000001',
      action: `${tag}:full`,
      targetType: 'customer',
      targetId: '00000000-0000-0000-0000-000000000002',
      metadata: { foo: 'bar' },
      visibleToCustomer: true,
      ip: '198.51.100.7',
      userAgentHash: 'abc123',
    });

    const r = await sql`
      SELECT actor_type, actor_id, action, target_type, target_id, metadata,
             visible_to_customer, host(ip) AS ip, user_agent_hash
        FROM audit_log
       WHERE action = ${tag + ':full'}
    `.execute(db);

    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.actor_type).toBe('admin');
    expect(row.actor_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(row.action).toBe(`${tag}:full`);
    expect(row.target_type).toBe('customer');
    expect(row.target_id).toBe('00000000-0000-0000-0000-000000000002');
    expect(row.metadata).toEqual({ foo: 'bar' });
    expect(row.visible_to_customer).toBe(true);
    expect(row.ip).toBe('198.51.100.7');
    expect(row.user_agent_hash).toBe('abc123');
  });

  it('defaults metadata to {} and visibleToCustomer to false when omitted', async () => {
    await writeAudit(db, {
      actorType: 'system',
      action: `${tag}:minimal`,
    });

    const r = await sql`
      SELECT metadata, visible_to_customer, actor_id, target_id, ip, user_agent_hash
        FROM audit_log
       WHERE action = ${tag + ':minimal'}
    `.execute(db);

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].metadata).toEqual({});
    expect(r.rows[0].visible_to_customer).toBe(false);
    expect(r.rows[0].actor_id).toBeNull();
    expect(r.rows[0].target_id).toBeNull();
    expect(r.rows[0].ip).toBeNull();
    expect(r.rows[0].user_agent_hash).toBeNull();
  });

  it('produces an id that is a valid UUID and a ts at insert time', async () => {
    const before = Date.now();
    await writeAudit(db, { actorType: 'system', action: `${tag}:ids` });
    const r = await sql`
      SELECT id::text AS id, ts FROM audit_log WHERE action = ${tag + ':ids'}
    `.execute(db);
    expect(r.rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const tsMs = new Date(r.rows[0].ts).getTime();
    expect(tsMs).toBeGreaterThanOrEqual(before - 1000);
    expect(tsMs).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
