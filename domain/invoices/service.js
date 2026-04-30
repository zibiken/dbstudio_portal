import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { enqueue as enqueueEmail } from '../email-outbox/repo.js';
import * as repo from './repo.js';

// Invoice domain (M8 Task 8.1).
//
// Money model: amounts persist as integer cents (BIGINT) under the
// `currency` column, freeing the service layer from float drift. The
// `overdue` flag is computed in SQL on every read (`status='open' AND
// due_on < CURRENT_DATE`), never stored — see repo.js OVERDUE_EXPR.

export class InvoiceNotFoundError extends Error {
  constructor(id) {
    super(`invoice ${id} not found`);
    this.name = 'InvoiceNotFoundError';
    this.code = 'INVOICE_NOT_FOUND';
    this.status = 404;
  }
}

export class CrossCustomerError extends Error {
  constructor() {
    super('cross-customer access refused');
    this.name = 'CrossCustomerError';
    this.code = 'CROSS_CUSTOMER';
    this.status = 403;
  }
}

export class InvalidStatusError extends Error {
  constructor(status) {
    super(`invalid invoice status '${status}'`);
    this.name = 'InvalidStatusError';
    this.code = 'INVALID_STATUS';
    this.status = 400;
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(from, to) {
    super(`invalid invoice status transition: ${from} -> ${to}`);
    this.name = 'InvalidStatusTransitionError';
    this.code = 'INVALID_STATUS_TRANSITION';
    this.status = 400;
    this.from = from;
    this.to = to;
  }
}

const ALLOWED_STATUSES = new Set(['open', 'paid', 'void']);

// Status transitions (v1):
//   open  -> paid    (admin marks paid)
//   open  -> void    (admin voids)
//   paid  -> open    (admin reopens — refunds, reissue scenarios)
//   void  -> open    (admin un-voids — typo recovery)
// `paid` and `void` are NOT terminal; an admin may reopen either back to
// 'open'. Direct paid<->void hops are refused (route them through 'open'
// so the audit shows two distinct decisions).
const ALLOWED_TRANSITIONS = new Map([
  ['open', new Set(['paid', 'void'])],
  ['paid', new Set(['open'])],
  ['void', new Set(['open'])],
]);

function requirePortalBaseUrl(ctx, callerName) {
  const url = ctx?.portalBaseUrl;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(`${callerName} requires ctx.portalBaseUrl (non-empty string)`);
  }
  return url.replace(/\/+$/, '');
}

function baseAudit(ctx) {
  return {
    metadata: { ...(ctx?.audit ?? {}) },
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  };
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  return value.trim();
}

function requireDateString(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be an ISO date string YYYY-MM-DD`);
  }
  return value;
}

function requireAmountCents(value) {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error('amountCents must be a non-negative integer');
  }
  return n;
}

function requireCurrency(value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new Error("currency must be a 3-letter uppercase ISO code (e.g. 'EUR')");
  }
  return value;
}

async function loadActiveCustomerForUpdate(tx, customerId) {
  const r = await sql`
    SELECT id, status FROM customers WHERE id = ${customerId}::uuid FOR UPDATE
  `.execute(tx);
  if (r.rows.length === 0) throw new Error(`customer ${customerId} not found`);
  if (r.rows[0].status !== 'active') {
    throw new Error(
      `cannot create invoice for customer in status '${r.rows[0].status}' — must be 'active'`,
    );
  }
  return r.rows[0];
}

async function loadInvoiceDocument(tx, documentId) {
  const r = await sql`
    SELECT id, customer_id, category
      FROM documents WHERE id = ${documentId}::uuid
  `.execute(tx);
  if (r.rows.length === 0) {
    throw new Error(`document ${documentId} not found`);
  }
  return r.rows[0];
}

async function loadPrimaryUserForCustomer(tx, customerId) {
  // The first customer_user provisioned for a customer is the recipient
  // of system notifications (M5 keeps this row 1:1 in v1; multi-user
  // customers ship post-launch).
  const r = await sql`
    SELECT id, email, name
      FROM customer_users
     WHERE customer_id = ${customerId}::uuid
     ORDER BY created_at ASC
     LIMIT 1
  `.execute(tx);
  return r.rows[0] ?? null;
}

function formatAmount(amountCents, currency) {
  const major = Number(amountCents) / 100;
  // Spec §2.11 says we format via Intl. Locale-en here is adequate for
  // the v1 ship (operator timezone-bound to Atlantic/Canary, language=en
  // for now). Customer-specific locale is honoured at render-time in the
  // email template; the persisted `amount` string is a sensible default.
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(major);
}

export async function create(db, {
  adminId = null,
  customerId,
  documentId,
  invoiceNumber,
  amountCents,
  currency = 'EUR',
  issuedOn,
  dueOn,
  notes = null,
}, ctx = {}) {
  const baseUrl = requirePortalBaseUrl(ctx, 'invoices.create');
  const number = requireString(invoiceNumber, 'invoiceNumber');
  const amt = requireAmountCents(amountCents);
  const cur = requireCurrency(currency);
  const issued = requireDateString(issuedOn, 'issuedOn');
  const due = requireDateString(dueOn, 'dueOn');
  const trimmedNotes = notes == null ? null : String(notes);

  return await db.transaction().execute(async (tx) => {
    await loadActiveCustomerForUpdate(tx, customerId);

    const doc = await loadInvoiceDocument(tx, documentId);
    if (doc.customer_id !== customerId) throw new CrossCustomerError();
    if (doc.category !== 'invoice') {
      throw new Error(
        `document ${documentId} has category '${doc.category}', expected 'invoice'`,
      );
    }

    const id = uuidv7();
    await repo.insertInvoice(tx, {
      id,
      customerId,
      documentId,
      invoiceNumber: number,
      amountCents: amt,
      currency: cur,
      issuedOn: issued,
      dueOn: due,
      notes: trimmedNotes,
    });

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'invoice.created',
      targetType: 'invoice',
      targetId: id,
      metadata: {
        ...a.metadata,
        customerId,
        documentId,
        invoiceNumber: number,
        amountCents: amt,
        currency: cur,
        issuedOn: issued,
        dueOn: due,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    const recipient = await loadPrimaryUserForCustomer(tx, customerId);
    if (recipient) {
      await enqueueEmail(tx, {
        idempotencyKey: `invoice_created:${id}`,
        toAddress: recipient.email,
        template: 'new-invoice',
        locals: {
          recipientName: recipient.name,
          invoiceNumber: number,
          amount: formatAmount(amt, cur),
          dueDate: due,
          invoiceUrl: `${baseUrl}/customer/invoices/${id}`,
        },
      });
    }

    return { invoiceId: id };
  });
}

export async function setStatus(db, { adminId, invoiceId, newStatus }, ctx = {}) {
  if (!ALLOWED_STATUSES.has(newStatus)) throw new InvalidStatusError(newStatus);

  return await db.transaction().execute(async (tx) => {
    const inv = await repo.findInvoiceByIdForUpdate(tx, invoiceId);
    if (!inv) throw new InvoiceNotFoundError(invoiceId);

    const previousStatus = inv.status;
    if (previousStatus === newStatus) {
      // No-op, no audit, no transition (v1 keeps the audit log clean of
      // accidental form double-submits).
      return { invoiceId, previousStatus, newStatus, changed: false };
    }
    const allowed = ALLOWED_TRANSITIONS.get(previousStatus) ?? new Set();
    if (!allowed.has(newStatus)) {
      throw new InvalidStatusTransitionError(previousStatus, newStatus);
    }

    await repo.updateInvoiceStatus(tx, invoiceId, newStatus);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'invoice.status_changed',
      targetType: 'invoice',
      targetId: invoiceId,
      metadata: {
        ...a.metadata,
        customerId: inv.customer_id,
        previousStatus,
        newStatus,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { invoiceId, previousStatus, newStatus, changed: true };
  });
}

export async function update(db, { adminId, invoiceId, fields }, ctx = {}) {
  const patch = {};
  if (fields?.invoiceNumber !== undefined) patch.invoiceNumber = requireString(fields.invoiceNumber, 'invoiceNumber');
  if (fields?.amountCents !== undefined) patch.amountCents = requireAmountCents(fields.amountCents);
  if (fields?.currency !== undefined) patch.currency = requireCurrency(fields.currency);
  if (fields?.issuedOn !== undefined) patch.issuedOn = requireDateString(fields.issuedOn, 'issuedOn');
  if (fields?.dueOn !== undefined) patch.dueOn = requireDateString(fields.dueOn, 'dueOn');
  if (fields?.notes !== undefined) patch.notes = fields.notes == null ? null : String(fields.notes);

  if (Object.keys(patch).length === 0) {
    throw new Error('update: at least one field must be provided');
  }

  return await db.transaction().execute(async (tx) => {
    const inv = await repo.findInvoiceByIdForUpdate(tx, invoiceId);
    if (!inv) throw new InvoiceNotFoundError(invoiceId);

    await repo.updateInvoiceMeta(tx, invoiceId, patch);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'invoice.updated',
      targetType: 'invoice',
      targetId: invoiceId,
      metadata: {
        ...a.metadata,
        customerId: inv.customer_id,
        fieldsChanged: Object.keys(patch),
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { invoiceId };
  });
}

export async function listForCustomer(db, customerId) {
  return await repo.listInvoicesByCustomer(db, customerId);
}

export async function listAll(db, opts = {}) {
  return await repo.listInvoicesAll(db, opts);
}

export async function findById(db, id) {
  return await repo.findInvoiceById(db, id);
}
