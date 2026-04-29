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
