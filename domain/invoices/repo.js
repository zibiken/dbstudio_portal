import { sql } from 'kysely';

// `overdue` is computed in SQL on every read so the value tracks the
// wall clock without any background job: an invoice is overdue iff it is
// still 'open' AND its due_on is strictly before today. The flag is
// derived, never stored on the row (spec §12 + plan Task 8.1).
const OVERDUE_EXPR = sql`(i.status = 'open' AND i.due_on < CURRENT_DATE)`;

export async function insertInvoice(db, {
  id,
  customerId,
  documentId,
  invoiceNumber,
  amountCents,
  currency,
  issuedOn,
  dueOn,
  notes = null,
}) {
  await sql`
    INSERT INTO invoices (
      id, customer_id, document_id, invoice_number,
      amount_cents, currency, issued_on, due_on, notes
    ) VALUES (
      ${id}::uuid, ${customerId}::uuid, ${documentId}::uuid, ${invoiceNumber},
      ${amountCents}::bigint, ${currency}, ${issuedOn}::date, ${dueOn}::date, ${notes}
    )
  `.execute(db);
}

export async function findInvoiceById(db, id) {
  const r = await sql`
    SELECT i.id, i.customer_id, i.document_id, i.invoice_number,
           i.amount_cents, i.currency, i.issued_on, i.due_on,
           i.status, i.notes, i.created_at,
           ${OVERDUE_EXPR} AS overdue
      FROM invoices i
     WHERE i.id = ${id}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

export async function findInvoiceByIdForUpdate(tx, id) {
  const r = await sql`
    SELECT id, customer_id, status
      FROM invoices
     WHERE id = ${id}::uuid
       FOR UPDATE
  `.execute(tx);
  return r.rows[0] ?? null;
}

export async function listInvoicesByCustomer(db, customerId) {
  const r = await sql`
    SELECT i.id, i.customer_id, i.document_id, i.invoice_number,
           i.amount_cents, i.currency, i.issued_on, i.due_on,
           i.status, i.notes, i.created_at,
           ${OVERDUE_EXPR} AS overdue
      FROM invoices i
     WHERE i.customer_id = ${customerId}::uuid
     ORDER BY i.issued_on DESC, i.created_at DESC
  `.execute(db);
  return r.rows;
}

export async function listInvoicesAll(db, { status = null, customerId = null } = {}) {
  const r = await sql`
    SELECT i.id, i.customer_id, i.document_id, i.invoice_number,
           i.amount_cents, i.currency, i.issued_on, i.due_on,
           i.status, i.notes, i.created_at,
           ${OVERDUE_EXPR} AS overdue
      FROM invoices i
     WHERE (${status}::text IS NULL OR i.status = ${status}::text)
       AND (${customerId}::uuid IS NULL OR i.customer_id = ${customerId}::uuid)
     ORDER BY i.issued_on DESC, i.created_at DESC
  `.execute(db);
  return r.rows;
}

export async function updateInvoiceStatus(db, id, newStatus) {
  const r = await sql`
    UPDATE invoices SET status = ${newStatus} WHERE id = ${id}::uuid
  `.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

// Patches an invoice's metadata. Pass null/undefined to leave a field
// unchanged. `status` is intentionally not patched here — status changes
// flow through `updateInvoiceStatus` so the audit trail reflects the
// transition explicitly.
export async function updateInvoiceMeta(db, id, {
  invoiceNumber = null,
  amountCents = null,
  currency = null,
  issuedOn = null,
  dueOn = null,
  notes = undefined,
} = {}) {
  // notes is treated specially: undefined = unchanged, null = clear.
  const setNotes = notes !== undefined;
  const r = await sql`
    UPDATE invoices
       SET invoice_number = COALESCE(${invoiceNumber}, invoice_number),
           amount_cents   = COALESCE(${amountCents}::bigint, amount_cents),
           currency       = COALESCE(${currency}, currency),
           issued_on      = COALESCE(${issuedOn}::date, issued_on),
           due_on         = COALESCE(${dueOn}::date, due_on),
           notes          = CASE WHEN ${setNotes}::boolean THEN ${notes} ELSE notes END
     WHERE id = ${id}::uuid
  `.execute(db);
  return Number(r.numAffectedRows ?? 0);
}
