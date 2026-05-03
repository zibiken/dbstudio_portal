import { sql } from 'kysely';

export async function findItemById(db, id) {
  const r = await sql`SELECT * FROM phase_checklist_items WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function listItemsByPhase(db, phaseId) {
  const r = await sql`
    SELECT * FROM phase_checklist_items
     WHERE phase_id = ${phaseId}::uuid
     ORDER BY display_order ASC
  `.execute(db);
  return r.rows;
}

export async function findMaxItemDisplayOrder(db, phaseId) {
  const r = await sql`
    SELECT COALESCE(MAX(display_order), 0)::int AS max
      FROM phase_checklist_items
     WHERE phase_id = ${phaseId}::uuid
  `.execute(db);
  return Number(r.rows[0]?.max ?? 0);
}

export async function insertItem(db, { id, phaseId, label, displayOrder, visibleToCustomer }) {
  await sql`
    INSERT INTO phase_checklist_items (id, phase_id, label, display_order, visible_to_customer)
    VALUES (${id}::uuid, ${phaseId}::uuid, ${label}, ${displayOrder}, ${visibleToCustomer})
  `.execute(db);
}

export async function updateItemLabel(db, id, label) {
  await sql`
    UPDATE phase_checklist_items
       SET label = ${label}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setItemVisibility(db, id, visibleToCustomer) {
  await sql`
    UPDATE phase_checklist_items
       SET visible_to_customer = ${visibleToCustomer}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setItemDone(db, id, { doneAt, doneByAdminId }) {
  await sql`
    UPDATE phase_checklist_items
       SET done_at = ${doneAt},
           done_by_admin_id = ${doneByAdminId},
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setItemDisplayOrder(db, id, displayOrder) {
  await sql`
    UPDATE phase_checklist_items
       SET display_order = ${displayOrder}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function deleteItem(db, id) {
  await sql`DELETE FROM phase_checklist_items WHERE id = ${id}::uuid`.execute(db);
}
