import { sql } from 'kysely';

export async function insertCredential(db, {
  id,
  customerId,
  provider,
  label,
  payloadCiphertext,
  payloadIv,
  payloadTag,
  createdBy,
  projectId = null,
}) {
  const projectIdSql = projectId === null ? sql`NULL` : sql`${projectId}::uuid`;
  await sql`
    INSERT INTO credentials (
      id, customer_id, project_id, provider, label,
      payload_ciphertext, payload_iv, payload_tag,
      created_by
    ) VALUES (
      ${id}::uuid, ${customerId}::uuid, ${projectIdSql},
      ${provider}, ${label},
      ${payloadCiphertext}, ${payloadIv}, ${payloadTag},
      ${createdBy}
    )
  `.execute(db);
}

export async function findCredentialById(db, id) {
  const r = await sql`SELECT * FROM credentials WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function deleteCredentialById(db, id) {
  const r = await sql`DELETE FROM credentials WHERE id = ${id}::uuid`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

export async function markCredentialNeedsUpdate(db, id) {
  const r = await sql`
    UPDATE credentials SET needs_update = TRUE, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

// Patches a credential row. `label` and the `payload_*` triple are optional;
// pass null/undefined to leave them unchanged. Whenever the payload changes,
// needs_update is force-cleared (the new payload IS the resolution).
//
// project_id has its own "no change" sentinel: pass `projectIdProvided=false`
// (the default) to leave it untouched. To set it, pass `projectIdProvided=true`
// and `projectId` = null (company-wide) or a UUID string (project-scoped).
// This split matters because `null` is a meaningful target value here, so
// COALESCE-style "treat null as no-op" doesn't work.
export async function updateCredential(db, id, {
  label = null,
  payloadCiphertext = null,
  payloadIv = null,
  payloadTag = null,
  projectId = null,
  projectIdProvided = false,
} = {}) {
  const payloadChanged = payloadCiphertext !== null;
  const projectIdSql = projectIdProvided
    ? (projectId === null ? sql`NULL` : sql`${projectId}::uuid`)
    : sql`project_id`;
  const r = await sql`
    UPDATE credentials
       SET label = COALESCE(${label}, label),
           payload_ciphertext = COALESCE(${payloadCiphertext}, payload_ciphertext),
           payload_iv = COALESCE(${payloadIv}, payload_iv),
           payload_tag = COALESCE(${payloadTag}, payload_tag),
           project_id = ${projectIdSql},
           needs_update = CASE WHEN ${payloadChanged}::boolean THEN FALSE ELSE needs_update END,
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

export async function listCredentialsByCustomer(db, customerId) {
  const r = await sql`
    SELECT id, customer_id, project_id, provider, label, needs_update, created_by, created_at, updated_at
      FROM credentials
     WHERE customer_id = ${customerId}::uuid
     ORDER BY created_at DESC
  `.execute(db);
  return r.rows;
}

export async function listCredentialsByProject(db, customerId, projectId) {
  const r = await sql`
    SELECT id, customer_id, project_id, provider, label, needs_update, created_by, created_at, updated_at
      FROM credentials
     WHERE customer_id = ${customerId}::uuid
       AND project_id  = ${projectId}::uuid
     ORDER BY created_at DESC
  `.execute(db);
  return r.rows;
}
