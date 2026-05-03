import { sql } from 'kysely';

export async function findPhaseById(db, id) {
  const r = await sql`SELECT * FROM project_phases WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function listPhasesByProject(db, projectId) {
  const r = await sql`
    SELECT * FROM project_phases
     WHERE project_id = ${projectId}::uuid
     ORDER BY display_order ASC
  `.execute(db);
  return r.rows;
}

export async function findPhaseByLabel(db, projectId, label) {
  const r = await sql`
    SELECT * FROM project_phases
     WHERE project_id = ${projectId}::uuid AND label = ${label}
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function findMaxDisplayOrder(db, projectId) {
  const r = await sql`
    SELECT COALESCE(MAX(display_order), 0)::int AS max
      FROM project_phases
     WHERE project_id = ${projectId}::uuid
  `.execute(db);
  return Number(r.rows[0]?.max ?? 0);
}

export async function findPhaseAtOrder(db, projectId, order) {
  const r = await sql`
    SELECT * FROM project_phases
     WHERE project_id = ${projectId}::uuid AND display_order = ${order}
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function insertPhase(db, { id, projectId, label, displayOrder, status, startedAt, completedAt }) {
  await sql`
    INSERT INTO project_phases (id, project_id, label, display_order, status, started_at, completed_at)
    VALUES (${id}::uuid, ${projectId}::uuid, ${label}, ${displayOrder}, ${status}, ${startedAt}, ${completedAt})
  `.execute(db);
}

export async function updatePhaseLabel(db, id, label) {
  await sql`
    UPDATE project_phases
       SET label = ${label}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setPhaseStatus(db, id, { status, startedAt, completedAt }) {
  await sql`
    UPDATE project_phases
       SET status = ${status},
           started_at = ${startedAt},
           completed_at = ${completedAt},
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function setPhaseDisplayOrder(db, id, displayOrder) {
  await sql`
    UPDATE project_phases
       SET display_order = ${displayOrder}, updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function deletePhase(db, id) {
  await sql`DELETE FROM project_phases WHERE id = ${id}::uuid`.execute(db);
}
