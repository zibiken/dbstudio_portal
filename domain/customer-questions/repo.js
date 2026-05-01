import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

// customer_questions repo. The status='open' guards in answer/skip enforce
// append-only semantics under concurrent customer_user requests: when two
// seats post to /customer/questions/:id/answer simultaneously the loser's
// UPDATE returns 0 rows and the route renders a "no longer open" notice.

export async function insert(executor, { customerId, createdByAdminId, question }) {
  const id = uuidv7();
  const r = await sql`
    INSERT INTO customer_questions (id, customer_id, created_by_admin_id, question)
    VALUES (${id}::uuid, ${customerId}::uuid, ${createdByAdminId}::uuid, ${question})
    RETURNING *
  `.execute(executor);
  return r.rows[0];
}

export async function findById(executor, id) {
  const r = await sql`
    SELECT * FROM customer_questions WHERE id = ${id}::uuid
  `.execute(executor);
  return r.rows[0] ?? null;
}

export async function listOpenForCustomer(executor, customerId) {
  const r = await sql`
    SELECT * FROM customer_questions
    WHERE customer_id = ${customerId}::uuid AND status = 'open'
    ORDER BY created_at DESC
  `.execute(executor);
  return r.rows;
}

export async function listAllForCustomer(executor, customerId, { limit = 50 } = {}) {
  const r = await sql`
    SELECT cq.id, cq.question, cq.answer_text, cq.status,
           cq.created_at, cq.answered_at,
           a.email AS created_by_email,
           cu.email AS answered_by_email
      FROM customer_questions cq
      LEFT JOIN admins a ON a.id = cq.created_by_admin_id
      LEFT JOIN customer_users cu ON cu.id = cq.answered_by_customer_user_id
     WHERE cq.customer_id = ${customerId}::uuid
     ORDER BY cq.created_at DESC
     LIMIT ${limit}
  `.execute(executor);
  return r.rows;
}

export async function answer(executor, { id, answeredByCustomerUserId, answerText }) {
  const r = await sql`
    UPDATE customer_questions
       SET status = 'answered',
           answer_text = ${answerText},
           answered_by_customer_user_id = ${answeredByCustomerUserId}::uuid,
           answered_at = now()
     WHERE id = ${id}::uuid AND status = 'open'
     RETURNING *
  `.execute(executor);
  return r.rows[0] ?? null;
}

export async function skip(executor, { id, answeredByCustomerUserId }) {
  const r = await sql`
    UPDATE customer_questions
       SET status = 'skipped',
           answered_by_customer_user_id = ${answeredByCustomerUserId}::uuid,
           answered_at = now()
     WHERE id = ${id}::uuid AND status = 'open'
     RETURNING *
  `.execute(executor);
  return r.rows[0] ?? null;
}
