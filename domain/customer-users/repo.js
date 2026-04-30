import { sql } from 'kysely';

export async function findCustomerUserById(db, id) {
  const r = await sql`
    SELECT cu.id::text AS id,
           cu.customer_id::text AS customer_id,
           cu.email,
           cu.name,
           cu.password_hash,
           cu.totp_secret_enc,
           cu.totp_iv,
           cu.totp_tag,
           cu.email_otp_enabled,
           cu.webauthn_creds,
           cu.backup_codes,
           cu.language,
           c.razon_social,
           c.dek_ciphertext,
           c.dek_iv,
           c.dek_tag,
           c.status AS customer_status
      FROM customer_users cu
      JOIN customers c ON c.id = cu.customer_id
     WHERE cu.id = ${id}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function findCustomerUserByEmail(db, email) {
  const r = await sql`
    SELECT cu.id::text AS id,
           cu.customer_id::text AS customer_id,
           cu.email,
           cu.name
      FROM customer_users cu
     WHERE cu.email = ${email}
  `.execute(db);
  return r.rows[0] ?? null;
}
