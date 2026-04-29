import { sql } from 'kysely';

const CUSTOMER_COLUMN_MAP = {
  razonSocial: 'razon_social',
  nif: 'nif',
  domicilio: 'domicilio',
  status: 'status',
  dekCiphertext: 'dek_ciphertext',
  dekIv: 'dek_iv',
  dekTag: 'dek_tag',
};

export async function insertCustomer(db, {
  id,
  razonSocial,
  nif = null,
  domicilio = null,
  dekCiphertext,
  dekIv,
  dekTag,
}) {
  await sql`
    INSERT INTO customers (id, razon_social, nif, domicilio, dek_ciphertext, dek_iv, dek_tag)
    VALUES (
      ${id}::uuid,
      ${razonSocial},
      ${nif},
      ${domicilio},
      ${dekCiphertext},
      ${dekIv},
      ${dekTag}
    )
  `.execute(db);
}

export async function insertCustomerUser(db, {
  id,
  customerId,
  email,
  name,
  passwordHash = null,
  inviteTokenHash = null,
  inviteExpiresAt = null,
}) {
  await sql`
    INSERT INTO customer_users (id, customer_id, email, name, password_hash, invite_token_hash, invite_expires_at)
    VALUES (
      ${id}::uuid,
      ${customerId}::uuid,
      ${email},
      ${name},
      ${passwordHash},
      ${inviteTokenHash},
      ${inviteExpiresAt}
    )
  `.execute(db);
}

export async function findCustomerById(db, id) {
  const r = await sql`SELECT * FROM customers WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function findCustomerUserByEmail(db, email) {
  const r = await sql`SELECT * FROM customer_users WHERE email = ${email}::citext`.execute(db);
  return r.rows[0] ?? null;
}

export async function updateCustomerStatus(db, id, status) {
  await sql`
    UPDATE customers
       SET status = ${status},
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function listCustomers(db, { q = '', limit = 25, offset = 0 } = {}) {
  // Search is a case-insensitive substring match on razon_social OR nif.
  // Returns { rows, total } so the caller can render a pagination control.
  const term = typeof q === 'string' ? q.trim() : '';
  const filter = term ? `%${term}%` : null;
  const where = filter
    ? sql`WHERE razon_social ILIKE ${filter} OR nif ILIKE ${filter}`
    : sql``;

  const totalRow = await sql`
    SELECT count(*)::int AS total FROM customers ${where}
  `.execute(db);

  const rowsRes = await sql`
    SELECT id, razon_social, nif, domicilio, status, created_at, updated_at
      FROM customers
      ${where}
     ORDER BY created_at DESC
     LIMIT ${limit} OFFSET ${offset}
  `.execute(db);

  return { rows: rowsRes.rows, total: totalRow.rows[0].total };
}

export async function listCustomerUsersByCustomer(db, customerId) {
  const r = await sql`
    SELECT id, email, name, invite_consumed_at, invite_expires_at, created_at
      FROM customer_users
     WHERE customer_id = ${customerId}::uuid
     ORDER BY created_at ASC
  `.execute(db);
  return r.rows;
}

export async function updateCustomer(db, id, fields) {
  const setParts = Object.entries(fields)
    .filter(([_k, v]) => v !== undefined)
    .map(([k, v]) => {
      const col = CUSTOMER_COLUMN_MAP[k];
      if (!col) throw new Error(`updateCustomer: unknown field '${k}'`);
      return sql`${sql.ref(col)} = ${v}`;
    });
  if (setParts.length === 0) return;
  await sql`
    UPDATE customers
       SET ${sql.join(setParts, sql`, `)},
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}
