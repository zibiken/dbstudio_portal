import { sql } from 'kysely';

export async function insertCredentialRequest(db, {
  id,
  customerId,
  requestedByAdminId,
  provider,
  fields,
}) {
  await sql`
    INSERT INTO credential_requests (
      id, customer_id, requested_by_admin_id, provider, fields, status
    ) VALUES (
      ${id}::uuid, ${customerId}::uuid, ${requestedByAdminId}::uuid,
      ${provider}, ${JSON.stringify(fields)}::jsonb, 'open'
    )
  `.execute(db);
}

export async function findCredentialRequestById(db, id) {
  const r = await sql`SELECT * FROM credential_requests WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

// Selects + locks the row by id. Used wherever a state transition needs
// FOR UPDATE serialisation against concurrent fulfilment / cancel /
// not-applicable attempts.
export async function lockCredentialRequestById(db, id) {
  const r = await sql`
    SELECT * FROM credential_requests WHERE id = ${id}::uuid FOR UPDATE
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function setStatusFulfilled(db, id, fulfilledCredentialId) {
  const r = await sql`
    UPDATE credential_requests
       SET status = 'fulfilled',
           fulfilled_credential_id = ${fulfilledCredentialId}::uuid,
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

export async function setStatusNotApplicable(db, id, reason) {
  const r = await sql`
    UPDATE credential_requests
       SET status = 'not_applicable',
           not_applicable_reason = ${reason},
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

export async function setStatusCancelled(db, id) {
  const r = await sql`
    UPDATE credential_requests
       SET status = 'cancelled',
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

export async function listForCustomer(db, customerId) {
  const r = await sql`
    SELECT id, customer_id, requested_by_admin_id, provider, fields, status,
           not_applicable_reason, fulfilled_credential_id, created_at, updated_at
      FROM credential_requests
     WHERE customer_id = ${customerId}::uuid
     ORDER BY created_at DESC
  `.execute(db);
  return r.rows;
}

export async function listOpenForCustomer(db, customerId) {
  const r = await sql`
    SELECT id, provider, fields, created_at
      FROM credential_requests
     WHERE customer_id = ${customerId}::uuid
       AND status = 'open'
     ORDER BY created_at DESC
  `.execute(db);
  return r.rows;
}
