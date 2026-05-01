import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import * as svc from '../../../domain/customer-questions/service.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';
import { pruneTestPollution } from '../../helpers/test-pollution.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cq_svc_${Date.now()}`;

describe.skipIf(skip)('customer-questions service', () => {
  let db;
  let customerId;
  let adminId;
  let userAId;
  let userBId;
  const baseCtx = () => ({ audit: { tag }, ip: null, userAgentHash: null });

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    customerId = uuidv7();
    adminId = uuidv7();
    userAId = uuidv7();
    userBId = uuidv7();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (${customerId}::uuid, ${tag}, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea)
    `.execute(db);
    await sql`
      INSERT INTO admins (id, email, name)
      VALUES (${adminId}::uuid, ${tag + '+a@example.com'}, 'Q Service Admin')
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (${userAId}::uuid, ${customerId}::uuid, ${tag + '+ua@example.com'}, 'User A')
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (${userBId}::uuid, ${customerId}::uuid, ${tag + '+ub@example.com'}, 'User B')
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM customer_questions WHERE customer_id = ${customerId}::uuid`.execute(db);
    await pruneTestPollution(db, { recipientIds: [userAId, userBId, adminId] });
    await sql`DELETE FROM customer_users WHERE id IN (${userAId}::uuid, ${userBId}::uuid)`.execute(db);
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
    await sql`DELETE FROM customers WHERE id = ${customerId}::uuid`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  it('createQuestion writes audit visible_to_customer + customer-Action-required digest for each customer_user', async () => {
    const q = await svc.createQuestion(db, { customerId, createdByAdminId: adminId, question: 'What database engine do you prefer?' }, baseCtx());

    const a = await sql`
      SELECT visible_to_customer, metadata FROM audit_log
       WHERE action = 'question.created' AND target_id = ${q.id}::uuid
    `.execute(db);
    expect(a.rows.length).toBe(1);
    expect(a.rows[0].visible_to_customer).toBe(true);
    expect(a.rows[0].metadata).toMatchObject({ customerId });

    const dA = await sql`SELECT COUNT(*)::int AS n FROM pending_digest_items WHERE event_type = 'question.created' AND recipient_id = ${userAId}::uuid AND metadata->>'questionId' = ${q.id}`.execute(db);
    const dB = await sql`SELECT COUNT(*)::int AS n FROM pending_digest_items WHERE event_type = 'question.created' AND recipient_id = ${userBId}::uuid AND metadata->>'questionId' = ${q.id}`.execute(db);
    expect(dA.rows[0].n).toBe(1);
    expect(dB.rows[0].n).toBe(1);
  });

  it('answerQuestion succeeds once + emits one admin FYI digest event; second answer returns null', async () => {
    const q = await svc.createQuestion(db, { customerId, createdByAdminId: adminId, question: 'race?' }, baseCtx());

    const r1 = await svc.answerQuestion(db, { id: q.id, answeredByCustomerUserId: userAId, answerText: 'first' }, baseCtx());
    expect(r1?.status).toBe('answered');
    expect(r1.answer_text).toBe('first');

    const r2 = await svc.answerQuestion(db, { id: q.id, answeredByCustomerUserId: userBId, answerText: 'late' }, baseCtx());
    expect(r2).toBeNull();

    const audits = await sql`
      SELECT actor_id FROM audit_log
       WHERE action = 'question.answered' AND target_id = ${q.id}::uuid
    `.execute(db);
    expect(audits.rows.length).toBe(1);
    expect(audits.rows[0].actor_id).toBe(userAId);

    const adminDigest = await sql`SELECT COUNT(*)::int AS n FROM pending_digest_items WHERE event_type = 'question.answered' AND recipient_id = ${adminId}::uuid AND metadata->>'questionId' = ${q.id}`.execute(db);
    expect(adminDigest.rows[0].n).toBe(1);
  });

  it('skipQuestion sets status=skipped + answer_text NULL + emits admin FYI digest', async () => {
    const q = await svc.createQuestion(db, { customerId, createdByAdminId: adminId, question: 'dunno?' }, baseCtx());

    const r = await svc.skipQuestion(db, { id: q.id, answeredByCustomerUserId: userAId }, baseCtx());
    expect(r?.status).toBe('skipped');
    expect(r.answer_text).toBeNull();

    const audits = await sql`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'question.skipped' AND target_id = ${q.id}::uuid`.execute(db);
    expect(audits.rows[0].n).toBe(1);

    const adminDigest = await sql`SELECT COUNT(*)::int AS n FROM pending_digest_items WHERE event_type = 'question.skipped' AND recipient_id = ${adminId}::uuid AND metadata->>'questionId' = ${q.id}`.execute(db);
    expect(adminDigest.rows[0].n).toBe(1);
  });
});
