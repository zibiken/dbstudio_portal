// Phase B invoice payment ledger service.
//
// Records (and edits/deletes) admin-entered payments against an invoice.
// Each insert produces an invoice.payment_recorded audit row + digest
// fan-out to active customer_users and admins. When the running total
// reaches the invoice's amount_cents, an additional invoice.paid digest
// event is emitted (the audit row remains the same single row).

import { sql } from 'kysely';
import * as repo from './repo.js';
import { writeAudit } from '../../lib/audit.js';
import { listActiveCustomerUsers, listActiveAdmins } from '../../lib/digest-fanout.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';

function formatEur(cents) {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

async function findInvoice(db, invoiceId) {
  const r = await sql`
    SELECT id::text AS id, customer_id::text AS customer_id, invoice_number, amount_cents
      FROM invoices WHERE id = ${invoiceId}::uuid
  `.execute(db);
  return r.rows[0] ?? null;
}

function baseAudit(ctx) {
  return {
    metadata: { ...(ctx?.audit ?? {}) },
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  };
}

export async function record(db, { adminId, invoiceId, amountCents, paidOn, note }, ctx = {}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('amount_cents must be a positive integer');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    throw new Error('paid_on must be in YYYY-MM-DD format');
  }

  return await db.transaction().execute(async (tx) => {
    const inv = await findInvoice(tx, invoiceId);
    if (!inv) throw new Error('invoice not found');
    const id = await repo.insert(tx, { invoiceId, amountCents, paidOn, note, recordedBy: adminId });

    const newSum = await repo.sumForInvoice(tx, invoiceId);
    const isFullyPaid = newSum >= inv.amount_cents;

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId:   adminId,
      action:    'invoice.payment_recorded',
      targetType: 'invoice',
      targetId:   invoiceId,
      metadata: {
        ...a.metadata,
        paymentId: id,
        amountCents,
        paidOn,
        isFullyPaid,
        customerId: inv.customer_id,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Fan-out: customer_users (FYI) + admins (FYI). When fully paid,
    // additionally emit the invoice.paid digest event to both surfaces.
    const users = await listActiveCustomerUsers(tx, inv.customer_id);
    const admins = await listActiveAdmins(tx);
    const amount = formatEur(amountCents);
    const cnameRow = await sql`SELECT razon_social FROM customers WHERE id = ${inv.customer_id}::uuid`.execute(tx);
    const customerName = cnameRow.rows[0]?.razon_social ?? '';

    for (const u of users) {
      const recVars = { invoiceNumber: inv.invoice_number, amount, paidOn };
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId:    inv.customer_id,
        bucket:        'fyi',
        eventType:     'invoice.payment_recorded',
        title:         titleFor('invoice.payment_recorded', u.locale, recVars),
        linkPath:      `/customer/invoices/${invoiceId}`,
        metadata:      { paymentId: id, invoiceId, amountCents, paidOn },
        vars:          recVars,
        locale:        u.locale,
      });
      if (isFullyPaid) {
        const paidVars = { recipient: 'customer', invoiceNumber: inv.invoice_number };
        await recordForDigest(tx, {
          recipientType: 'customer_user',
          recipientId:   u.id,
          customerId:    inv.customer_id,
          bucket:        'fyi',
          eventType:     'invoice.paid',
          title:         titleFor('invoice.paid', u.locale, paidVars),
          linkPath:      `/customer/invoices/${invoiceId}`,
          metadata:      { invoiceId },
          vars:          paidVars,
          locale:        u.locale,
        });
      }
    }
    for (const adm of admins) {
      const recVars = { invoiceNumber: inv.invoice_number, amount, paidOn };
      await recordForDigest(tx, {
        recipientType: 'admin',
        recipientId:   adm.id,
        customerId:    inv.customer_id,
        bucket:        'fyi',
        eventType:     'invoice.payment_recorded',
        title:         titleFor('invoice.payment_recorded', adm.locale, recVars),
        linkPath:      `/admin/invoices/${invoiceId}`,
        metadata:      { paymentId: id, invoiceId, amountCents, paidOn },
        vars:          recVars,
        locale:        adm.locale,
      });
      if (isFullyPaid) {
        const paidVars = { recipient: 'admin', customerName, invoiceNumber: inv.invoice_number };
        await recordForDigest(tx, {
          recipientType: 'admin',
          recipientId:   adm.id,
          customerId:    inv.customer_id,
          bucket:        'fyi',
          eventType:     'invoice.paid',
          title:         titleFor('invoice.paid', adm.locale, paidVars),
          linkPath:      `/admin/invoices/${invoiceId}`,
          metadata:      { invoiceId },
          vars:          paidVars,
          locale:        adm.locale,
        });
      }
    }

    return { paymentId: id, isFullyPaid, sumCents: newSum };
  });
}

export async function listForInvoice(db, invoiceId) {
  return await repo.listByInvoice(db, invoiceId);
}

export async function deletePayment(db, { adminId, paymentId, invoiceId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const existing = await repo.findById(tx, paymentId);
    if (!existing) throw new Error('payment not found');
    if (existing.invoice_id !== invoiceId) throw new Error('payment does not belong to invoice');
    await repo.deleteById(tx, { id: paymentId });
    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId:   adminId,
      action:    'invoice.payment_deleted',
      targetType: 'invoice',
      targetId:   invoiceId,
      metadata:  { ...a.metadata, paymentId, amountCents: existing.amount_cents, paidOn: existing.paid_on },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });
  });
}

export async function updatePayment(db, { adminId, paymentId, invoiceId, amountCents, paidOn, note }, ctx = {}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amount_cents must be positive integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new Error('paid_on must be YYYY-MM-DD');
  return await db.transaction().execute(async (tx) => {
    const existing = await repo.findById(tx, paymentId);
    if (!existing) throw new Error('payment not found');
    if (existing.invoice_id !== invoiceId) throw new Error('payment does not belong to invoice');
    await repo.update(tx, { id: paymentId, amountCents, paidOn, note });
    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId:   adminId,
      action:    'invoice.payment_updated',
      targetType: 'invoice',
      targetId:   invoiceId,
      metadata:  { ...a.metadata, paymentId, amountCents, paidOn, previousAmountCents: existing.amount_cents, previousPaidOn: existing.paid_on },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });
  });
}
