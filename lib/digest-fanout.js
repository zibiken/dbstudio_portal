// Phase B: helpers for enumerating digest recipients.
//
// 'Active' for customer users = their parent customer's status is 'active'.
// (customer_users itself has no status column; archive/suspend lives on
// customers.status per the original v1 schema.)
//
// Admins have no status column — every admin row is considered active.

import { sql } from 'kysely';

export async function listActiveCustomerUsers(db, customerId) {
  const r = await sql`
    SELECT cu.id::text AS id, cu.name, cu.email, cu.locale
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.customer_id = ${customerId}::uuid
       AND c.status = 'active'
  `.execute(db);
  return r.rows;
}

export async function listActiveAdmins(db) {
  const r = await sql`
    SELECT id::text AS id, name, email, locale FROM admins
  `.execute(db);
  return r.rows;
}
