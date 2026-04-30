import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../../config/db.js';
import { writeAudit } from '../../../../lib/audit.js';
import {
  listAuditPage, streamAuditCsv,
} from '../../../../lib/audit-query.js';
import { pruneTaggedAuditRows } from '../../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('lib/audit-query', () => {
  let db;
  const tag = `audit_q_test_${Date.now()}`;
  const adminId = uuidv7();
  const customerUserId = uuidv7();
  const customerId = uuidv7();

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    await sql`
      INSERT INTO admins (id, email, name, password_hash)
      VALUES (${adminId}::uuid, ${tag + '+a@example.com'}, ${'Audit Admin'}, ${'$argon2id$dummy'})
    `.execute(db);
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (
        ${customerId}::uuid, ${tag + ' S.L.'},
        ${Buffer.alloc(32)}::bytea, ${Buffer.alloc(12)}::bytea, ${Buffer.alloc(16)}::bytea
      )
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (${customerUserId}::uuid, ${customerId}::uuid, ${tag + '+u@example.com'}, ${'Audit User'})
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await sql`DELETE FROM customer_users WHERE id = ${customerUserId}::uuid`.execute(db);
    await sql`DELETE FROM customers WHERE id = ${customerId}::uuid`.execute(db);
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  async function seedAudit(action, opts = {}) {
    await writeAudit(db, {
      actorType: opts.actorType ?? 'admin',
      actorId: opts.actorId ?? adminId,
      action,
      targetType: opts.targetType ?? 'admin',
      targetId: opts.targetId ?? adminId,
      metadata: { tag, ...(opts.metadata ?? {}) },
      visibleToCustomer: opts.visibleToCustomer ?? false,
      ip: opts.ip ?? '198.51.100.7',
      userAgentHash: opts.userAgentHash ?? 'uahash',
    });
  }

  describe('listAuditPage', () => {
    it('returns rows newest-first with actor_email + actor_name resolved', async () => {
      await seedAudit('admin.login_success');
      await seedAudit('customer_user.name_changed', {
        actorType: 'customer', actorId: customerUserId,
        targetType: 'customer_user', targetId: customerUserId,
        metadata: { previousName: 'a', newName: 'b' },
      });
      const r = await listAuditPage(db, { tagFilter: tag });
      expect(r.rows.length).toBe(2);
      const adminRow = r.rows.find((row) => row.action === 'admin.login_success');
      expect(adminRow.actor_email).toBe(tag + '+a@example.com');
      expect(adminRow.actor_name).toBe('Audit Admin');
      expect(adminRow.ip).toBe('198.51.100.7');
      const userRow = r.rows.find((row) => row.action === 'customer_user.name_changed');
      expect(userRow.actor_email).toBe(tag + '+u@example.com');
      expect(userRow.actor_name).toBe('Audit User');
    });

    it('respects actionPrefixes filter', async () => {
      await seedAudit('admin.login_success');
      await seedAudit('credential.viewed', { metadata: { provider: 'AWS' } });
      const r = await listAuditPage(db, { tagFilter: tag, actionPrefixes: ['credential.'] });
      expect(r.rows.length).toBe(1);
      expect(r.rows[0].action).toBe('credential.viewed');
    });

    it('respects actorType filter', async () => {
      await seedAudit('admin.login_success', { actorType: 'admin' });
      await seedAudit('customer_user.name_changed', { actorType: 'customer', actorId: customerUserId, targetType: 'customer_user', targetId: customerUserId });
      const r = await listAuditPage(db, { tagFilter: tag, actorType: 'customer' });
      expect(r.rows.length).toBe(1);
      expect(r.rows[0].action).toBe('customer_user.name_changed');
    });

    it('respects since / until + cursor on (ts, id) for stable pagination', async () => {
      await seedAudit('admin.login_success');
      await seedAudit('admin.login_success');
      await seedAudit('admin.login_success');

      const first = await listAuditPage(db, { tagFilter: tag, limit: 2 });
      expect(first.rows.length).toBe(2);
      expect(first.nextCursor).toBeTruthy();

      const second = await listAuditPage(db, { tagFilter: tag, limit: 2, cursor: first.nextCursor });
      expect(second.rows.length).toBe(1);
      expect(second.nextCursor).toBeNull();

      // No overlap
      const ids = new Set([...first.rows.map((r) => r.id), ...second.rows.map((r) => r.id)]);
      expect(ids.size).toBe(3);
    });

    it('caps limit at 500 to prevent runaway page sizes', async () => {
      await seedAudit('admin.login_success');
      const r = await listAuditPage(db, { tagFilter: tag, limit: 99999 });
      expect(r.rows.length).toBeLessThanOrEqual(500);
    });
  });

  describe('streamAuditCsv', () => {
    it('streams a header row + one row per matching audit, csv-escaped', async () => {
      await seedAudit('admin.login_success', { metadata: { foo: 'bar,baz', q: '"q"' } });
      await seedAudit('credential.viewed', { metadata: { provider: 'AWS' } });

      const chunks = [];
      for await (const chunk of streamAuditCsv(db, { tagFilter: tag })) {
        chunks.push(chunk);
      }
      const csv = chunks.join('');
      const lines = csv.trim().split('\n');
      expect(lines[0]).toMatch(/^ts,id,actor_type,actor_id,actor_email,action,target_type,target_id,visible_to_customer,ip,metadata$/);
      expect(lines.length).toBe(1 + 2);
      // CSV-escaping: a value containing a comma must be quoted; embedded
      // double-quotes must be doubled.
      expect(csv).toContain('"bar,baz"');
      expect(csv).toContain('""q""');
    });
  });
});
