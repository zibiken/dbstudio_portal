import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { writeAudit } from '../../../lib/audit.js';
import { listActivityForCustomer } from '../../../lib/activity-feed.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('lib/activity-feed.listActivityForCustomer', () => {
  let db;
  const tag = `act_test_${Date.now()}`;
  const customerId = uuidv7();
  const customerUserId = uuidv7();
  const adminId = uuidv7();

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (
        ${customerId}::uuid, ${tag + ' S.L.'},
        ${Buffer.alloc(32)}::bytea, ${Buffer.alloc(12)}::bytea, ${Buffer.alloc(16)}::bytea
      )
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (
        ${customerUserId}::uuid, ${customerId}::uuid, ${tag + '+u@example.com'}, ${'Acting User'}
      )
    `.execute(db);
    await sql`
      INSERT INTO admins (id, email, name, password_hash)
      VALUES (
        ${adminId}::uuid, ${tag + '+a@example.com'}, ${'Acting Admin'}, ${'$argon2id$dummy'}
      )
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
      actorType: opts.actorType ?? 'customer',
      actorId: opts.actorId ?? customerUserId,
      action,
      targetType: opts.targetType ?? 'customer_user',
      targetId: opts.targetId ?? customerUserId,
      metadata: { tag, customerId, ...(opts.metadata ?? {}) },
      visibleToCustomer: opts.visibleToCustomer ?? true,
      ip: opts.ip ?? '198.51.100.7',
      userAgentHash: opts.userAgentHash ?? 'uahash',
    });
  }

  it('returns visible_to_customer rows scoped via metadata.customerId, newest-first', async () => {
    await seedAudit('customer_user.name_changed', { metadata: { previousName: 'Old', newName: 'New' } });
    await seedAudit('customer_user.password_changed');
    await seedAudit('credential.created', { actorType: 'customer', metadata: { provider: 'GitHub', label: 'CI bot' } });
    // Customer-targeted (no customer_user nesting) — uses target_type='customer' fallback
    await writeAudit(db, {
      actorType: 'admin', actorId: adminId,
      action: 'customer.suspended',
      targetType: 'customer', targetId: customerId,
      metadata: { tag, customerId },
      visibleToCustomer: true,
    });

    const rows = await listActivityForCustomer(db, customerId, {});
    expect(rows.length).toBe(4);
    // Newest first
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1].ts).getTime()).toBeGreaterThanOrEqual(new Date(rows[i].ts).getTime());
    }
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('customer_user.name_changed');
    expect(actions).toContain('customer.suspended');
    expect(actions).toContain('credential.created');
  });

  it('omits visible_to_customer=false rows even when metadata.customerId matches', async () => {
    await seedAudit('customer_user.password_change_failed', { visibleToCustomer: false });
    const rows = await listActivityForCustomer(db, customerId, {});
    expect(rows.find((r) => r.action === 'customer_user.password_change_failed')).toBeUndefined();
  });

  it('strips ip + user_agent_hash + audit-internal tag from rendered rows', async () => {
    await seedAudit('customer_user.name_changed', { metadata: { previousName: 'a', newName: 'b' } });
    const rows = await listActivityForCustomer(db, customerId, {});
    expect(rows[0].ip).toBeUndefined();
    expect(rows[0].user_agent_hash).toBeUndefined();
    expect(rows[0].metadata.tag).toBeUndefined();
  });

  it('resolves actor_display_name from admins.name / customer_users.name; admin email never leaks', async () => {
    await seedAudit('credential.viewed', {
      actorType: 'admin', actorId: adminId,
      metadata: { provider: 'AWS', label: 'prod-key' },
    });
    const rows = await listActivityForCustomer(db, customerId, {});
    const cred = rows.find((r) => r.action === 'credential.viewed');
    expect(cred.actor_display_name).toBe('Acting Admin');
    // The admin's email must not surface anywhere in the projection.
    expect(JSON.stringify(cred)).not.toContain(tag + '+a@example.com');
  });

  it('respects actionPrefix filter', async () => {
    await seedAudit('customer_user.name_changed', { metadata: { previousName: 'a', newName: 'b' } });
    await seedAudit('credential.created', { metadata: { provider: 'GitHub' } });
    await seedAudit('nda.signed_uploaded', { metadata: { ndaId: uuidv7() }, targetType: 'nda', targetId: uuidv7() });

    const credOnly = await listActivityForCustomer(db, customerId, { actionPrefixes: ['credential.'] });
    expect(credOnly.every((r) => r.action.startsWith('credential.'))).toBe(true);

    const ndaAndProfile = await listActivityForCustomer(db, customerId, {
      actionPrefixes: ['nda.', 'customer_user.'],
    });
    const acts = ndaAndProfile.map((r) => r.action);
    expect(acts.some((a) => a.startsWith('nda.'))).toBe(true);
    expect(acts.some((a) => a.startsWith('customer_user.'))).toBe(true);
    expect(acts.some((a) => a.startsWith('credential.'))).toBe(false);
  });

  it('respects since / until date filters (cursor on ts)', async () => {
    await seedAudit('customer_user.name_changed', { metadata: { previousName: 'a', newName: 'b' } });
    const after = new Date(Date.now() + 60_000); // 1 min in the future
    const rows = await listActivityForCustomer(db, customerId, { since: after.toISOString() });
    expect(rows.length).toBe(0);
  });

  it('respects limit (cap at 200, default 50)', async () => {
    for (let i = 0; i < 60; i++) {
      await seedAudit('customer_user.name_changed', { metadata: { previousName: `a${i}`, newName: `b${i}` } });
    }
    const def = await listActivityForCustomer(db, customerId, {});
    expect(def.length).toBe(50);
    const cap = await listActivityForCustomer(db, customerId, { limit: 9999 });
    expect(cap.length).toBe(60);
  });
});
