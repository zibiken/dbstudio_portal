import { sql } from 'kysely';

export async function insertProject(db, { id, customerId, name, objetoProyecto }) {
  await sql`
    INSERT INTO projects (id, customer_id, name, objeto_proyecto)
    VALUES (${id}::uuid, ${customerId}::uuid, ${name}, ${objetoProyecto})
  `.execute(db);
}

export async function findProjectById(db, id) {
  const r = await sql`SELECT * FROM projects WHERE id = ${id}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

export async function listProjectsByCustomer(db, customerId) {
  const r = await sql`
    SELECT id, customer_id, name, objeto_proyecto, status, created_at, updated_at
      FROM projects
     WHERE customer_id = ${customerId}::uuid
     ORDER BY created_at DESC
  `.execute(db);
  return r.rows;
}

export async function updateProjectFields(db, id, { name, objetoProyecto }) {
  await sql`
    UPDATE projects
       SET name = COALESCE(${name ?? null}, name),
           objeto_proyecto = COALESCE(${objetoProyecto ?? null}, objeto_proyecto),
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}

export async function updateProjectStatus(db, id, status) {
  await sql`
    UPDATE projects
       SET status = ${status},
           updated_at = now()
     WHERE id = ${id}::uuid
  `.execute(db);
}
