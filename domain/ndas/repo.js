import { sql } from 'kysely';

export async function insertNda(db, {
  id,
  customerId,
  projectId,
  draftDocumentId,
  templateVersionSha,
  generatedByAdminId,
}) {
  await sql`
    INSERT INTO ndas (id, customer_id, project_id, draft_document_id,
                      template_version_sha, generated_by_admin_id)
    VALUES (
      ${id}::uuid, ${customerId}::uuid, ${projectId}::uuid,
      ${draftDocumentId}::uuid, ${templateVersionSha}, ${generatedByAdminId}::uuid
    )
  `.execute(db);
}

export async function findNdaById(db, id) {
  const r = await sql`SELECT * FROM ndas WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

// Joins onto documents three times (draft / signed / audit-trail) so the
// admin detail view can render every download link in one query. Returns
// nulls for the unattached signed/audit slots so the caller can show
// upload affordances vs. download links per the row state.
export async function findNdaWithDocs(db, id) {
  const r = await sql`
    SELECT n.*,
           dd.original_filename AS draft_filename,
           dd.size_bytes        AS draft_size_bytes,
           ds.original_filename AS signed_filename,
           ds.size_bytes        AS signed_size_bytes,
           da.original_filename AS audit_filename,
           da.size_bytes        AS audit_size_bytes
      FROM ndas n
      LEFT JOIN documents dd ON dd.id = n.draft_document_id
      LEFT JOIN documents ds ON ds.id = n.signed_document_id
      LEFT JOIN documents da ON da.id = n.audit_document_id
     WHERE n.id = ${id}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

// Admin per-customer list. Returns ALL NDAs (drafts and signed) so the
// admin can track the full lifecycle — generate, send for signature,
// upload signed copy, optionally upload audit-trail.
export async function listNdasForAdmin(db, customerId) {
  const r = await sql`
    SELECT n.id, n.customer_id, n.project_id, n.template_version_sha,
           n.draft_document_id, n.signed_document_id, n.audit_document_id,
           n.generated_at,
           p.name AS project_name
      FROM ndas n
      JOIN projects p ON p.id = n.project_id
     WHERE n.customer_id = ${customerId}::uuid
     ORDER BY n.generated_at DESC
  `.execute(db);
  return r.rows;
}

// Customer-side list: ONLY surfaces NDAs once a signed copy has been
// uploaded. Drafts are admin-internal and the customer must NEVER see
// they exist (operator scope clarification 2026-04-30).
export async function listNdasForCustomer(db, customerId) {
  const r = await sql`
    SELECT n.id, n.project_id, n.template_version_sha,
           n.signed_document_id, n.audit_document_id, n.generated_at,
           p.name AS project_name
      FROM ndas n
      JOIN projects p ON p.id = n.project_id
     WHERE n.customer_id = ${customerId}::uuid
       AND n.signed_document_id IS NOT NULL
     ORDER BY n.generated_at DESC
  `.execute(db);
  return r.rows;
}

export async function attachSignedDocuments(db, id, {
  signedDocumentId = null,
  auditDocumentId = null,
} = {}) {
  // Pass null/undefined to leave a slot unchanged. COALESCE against the
  // existing column value lets a re-upload of just the audit-trail PDF
  // (the common pattern: signed first, audit-trail later) avoid touching
  // the signed_document_id column.
  const r = await sql`
    UPDATE ndas
       SET signed_document_id = COALESCE(${signedDocumentId}::uuid, signed_document_id),
           audit_document_id  = COALESCE(${auditDocumentId}::uuid, audit_document_id)
     WHERE id = ${id}::uuid
  `.execute(db);
  return Number(r.numAffectedRows ?? 0);
}
