import { sql } from 'kysely';

export async function insertDocument(db, {
  id,
  customerId,
  projectId = null,
  parentId = null,
  category,
  storagePath,
  originalFilename,
  mimeType,
  sizeBytes,
  sha256,
  uploadedByAdminId = null,
}) {
  await sql`
    INSERT INTO documents (
      id, customer_id, project_id, parent_id, category,
      storage_path, original_filename, mime_type, size_bytes, sha256,
      uploaded_by_admin_id
    ) VALUES (
      ${id}::uuid, ${customerId}::uuid, ${projectId}, ${parentId}, ${category},
      ${storagePath}, ${originalFilename}, ${mimeType}, ${sizeBytes}, ${sha256},
      ${uploadedByAdminId}
    )
  `.execute(db);
}

export async function findDocumentById(db, id) {
  const r = await sql`SELECT * FROM documents WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function customerStorageBytes(db, customerId) {
  const r = await sql`
    SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
      FROM documents
     WHERE customer_id = ${customerId}::uuid
  `.execute(db);
  return Number(r.rows[0].total);
}

// Returns the full version chain a document belongs to, in chronological
// order from root (no parent_id) to the most recent leaf. Walks the
// parent_id pointers — chains are typically short (3-10 entries) so the
// iterative SELECTs are cheaper than a recursive CTE round-trip.
export async function listVersionChain(db, documentId) {
  let cur = await findDocumentById(db, documentId);
  if (!cur) return [];
  // Walk up to root.
  while (cur.parent_id) {
    const parent = await findDocumentById(db, cur.parent_id);
    if (!parent) break;
    cur = parent;
  }
  const chain = [cur];
  // Walk down via parent_id pointers from each child.
  for (;;) {
    const r = await sql`
      SELECT * FROM documents
       WHERE parent_id = ${chain[chain.length - 1].id}::uuid
       ORDER BY uploaded_at ASC
       LIMIT 1
    `.execute(db);
    if (r.rows.length === 0) break;
    chain.push(r.rows[0]);
  }
  return chain;
}

export async function listDocumentsByCustomer(db, customerId, { projectId = null } = {}) {
  if (projectId) {
    const r = await sql`
      SELECT id, project_id, parent_id, category, original_filename,
             mime_type, size_bytes, sha256, uploaded_at
        FROM documents
       WHERE customer_id = ${customerId}::uuid
         AND project_id = ${projectId}::uuid
       ORDER BY uploaded_at DESC
    `.execute(db);
    return r.rows;
  }
  const r = await sql`
    SELECT id, project_id, parent_id, category, original_filename,
           mime_type, size_bytes, sha256, uploaded_at
      FROM documents
     WHERE customer_id = ${customerId}::uuid
     ORDER BY uploaded_at DESC
  `.execute(db);
  return r.rows;
}
