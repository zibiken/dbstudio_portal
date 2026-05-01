import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import * as repo from '../../../domain/customer-questions/repo.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `cq_repo_${Date.now()}`;

describe.skipIf(skip)('customer-questions repo', () => {
  let db;
  let customerId;
  let adminId;
  let customerUserId;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    customerId = uuidv7();
    adminId = uuidv7();
    customerUserId = uuidv7();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (${customerId}::uuid, ${tag}, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea)
    `.execute(db);
    await sql`
      INSERT INTO admins (id, email, name)
      VALUES (${adminId}::uuid, ${tag + '+a@example.com'}, 'Repo Admin')
    `.execute(db);
    await sql`
      INSERT INTO customer_users (id, customer_id, email, name)
      VALUES (${customerUserId}::uuid, ${customerId}::uuid, ${tag + '+u@example.com'}, 'Repo User')
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM customer_questions WHERE customer_id = ${customerId}::uuid`.execute(db);
    await sql`DELETE FROM customer_users WHERE id = ${customerUserId}::uuid`.execute(db);
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
    await sql`DELETE FROM customers WHERE id = ${customerId}::uuid`.execute(db);
    await db.destroy();
  });

  it('insert returns the new row with status=open', async () => {
    const row = await repo.insert(db, { customerId, createdByAdminId: adminId, question: 'What is X?' });
    expect(row.id).toBeTruthy();
    expect(row.status).toBe('open');
    expect(row.question).toBe('What is X?');
    expect(row.answer_text).toBeNull();
    expect(row.answered_at).toBeNull();
  });

  it('findById returns the row', async () => {
    const row = await repo.insert(db, { customerId, createdByAdminId: adminId, question: 'find?' });
    const found = await repo.findById(db, row.id);
    expect(found.question).toBe('find?');
  });

  it('listOpenForCustomer returns only open rows, newest first', async () => {
    const r1 = await repo.insert(db, { customerId, createdByAdminId: adminId, question: 'open Q1' });
    const r2 = await repo.insert(db, { customerId, createdByAdminId: adminId, question: 'closed Q' });
    await sql`UPDATE customer_questions SET status='answered', answer_text='hi', answered_at=now() WHERE id = ${r2.id}::uuid`.execute(db);
    const rows = await repo.listOpenForCustomer(db, customerId);
    const ids = rows.map(x => x.id);
    expect(ids).toContain(r1.id);
    expect(ids).not.toContain(r2.id);
    expect(rows.every(x => x.status === 'open')).toBe(true);
  });

  it('answer transitions only when status=open; second call returns null', async () => {
    const row = await repo.insert(db, { customerId, createdByAdminId: adminId, question: 'race Q' });
    const first = await repo.answer(db, { id: row.id, answeredByCustomerUserId: customerUserId, answerText: 'A' });
    expect(first?.status).toBe('answered');
    expect(first.answer_text).toBe('A');
    const second = await repo.answer(db, { id: row.id, answeredByCustomerUserId: customerUserId, answerText: 'B' });
    expect(second).toBeNull();
  });

  it('skip transitions only when status=open; sets answer_text NULL; second call returns null', async () => {
    const row = await repo.insert(db, { customerId, createdByAdminId: adminId, question: 'skip Q' });
    const first = await repo.skip(db, { id: row.id, answeredByCustomerUserId: customerUserId });
    expect(first?.status).toBe('skipped');
    expect(first.answer_text).toBeNull();
    const second = await repo.skip(db, { id: row.id, answeredByCustomerUserId: customerUserId });
    expect(second).toBeNull();
  });

  it('listAllForCustomer joins admin email + answerer email', async () => {
    const r = await repo.insert(db, { customerId, createdByAdminId: adminId, question: 'joined Q' });
    await repo.answer(db, { id: r.id, answeredByCustomerUserId: customerUserId, answerText: 'thanks' });
    const rows = await repo.listAllForCustomer(db, customerId);
    const found = rows.find(x => x.id === r.id);
    expect(found.created_by_email).toBe(tag + '+a@example.com');
    expect(found.answered_by_email).toBe(tag + '+u@example.com');
  });
});
