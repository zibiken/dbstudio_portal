// Phase B invoice payment ledger storage layer.
//
// Append-mostly: insert is the dominant op; admin can edit/delete past
// rows for corrections (audit trail captures every change). The
// invoice's "paid status" is derived from SUM(amount_cents) at read
// time — we do not store status on the invoice or the row.

import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

export async function insert(tx, { invoiceId, amountCents, paidOn, note, recordedBy }) {
  const id = uuidv7();
  await sql`
    INSERT INTO invoice_payments (id, invoice_id, amount_cents, currency, paid_on, note, recorded_by)
    VALUES (${id}::uuid, ${invoiceId}::uuid, ${amountCents}, 'EUR', ${paidOn}, ${note ?? null}, ${recordedBy}::uuid)
  `.execute(tx);
  return id;
}

export async function listByInvoice(db, invoiceId) {
  const r = await sql`
    SELECT id::text AS id, amount_cents, currency, paid_on, note, recorded_by::text AS recorded_by, created_at
      FROM invoice_payments
     WHERE invoice_id = ${invoiceId}::uuid
     ORDER BY paid_on ASC, created_at ASC
  `.execute(db);
  return r.rows;
}

export async function findById(db, paymentId) {
  const r = await sql`
    SELECT id::text AS id, invoice_id::text AS invoice_id, amount_cents, currency, paid_on, note, recorded_by::text AS recorded_by, created_at
      FROM invoice_payments
     WHERE id = ${paymentId}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function sumForInvoice(db, invoiceId) {
  const r = await sql`
    SELECT COALESCE(SUM(amount_cents), 0)::int AS total
      FROM invoice_payments
     WHERE invoice_id = ${invoiceId}::uuid
  `.execute(db);
  return r.rows[0].total;
}

export async function deleteById(tx, { id }) {
  await sql`DELETE FROM invoice_payments WHERE id = ${id}::uuid`.execute(tx);
}

export async function update(tx, { id, amountCents, paidOn, note }) {
  await sql`
    UPDATE invoice_payments
       SET amount_cents = ${amountCents},
           paid_on      = ${paidOn},
           note         = ${note ?? null}
     WHERE id = ${id}::uuid
  `.execute(tx);
}
