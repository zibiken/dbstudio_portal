import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as invoicesService from '../../../domain/invoices/service.js';
import * as invoicesRepo from '../../../domain/invoices/repo.js';
import { insertDocument } from '../../../domain/documents/repo.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `inv_overdue_${Date.now()}`;

// `overdue` is a derived field computed in SQL on every read. It is
// NEVER stored on the row — verifying the column does not exist guards
// against a future migration accidentally adding it (the value would
// then go stale by the next sunrise).
describe.skipIf(skip)('invoices/repo overdue derivation', () => {
  let db;
  let kek;

  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  async function makeCustomer(suffix) {
    return await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, baseCtx());
  }

  async function makeInvoiceWith({ customerId, dueOn, invoiceNumber }) {
    const id = uuidv7();
    await insertDocument(db, {
      id, customerId, category: 'invoice',
      storagePath: `/var/lib/portal/storage/${customerId}/${id}.pdf`,
      originalFilename: `${id}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1, sha256: 'a'.repeat(64),
    });
    const r = await invoicesService.create(db, {
      customerId, documentId: id, invoiceNumber, amountCents: 1000,
      issuedOn: '2026-01-01', dueOn,
    }, baseCtx());
    return r.invoiceId;
  }

  async function cleanup() {
    await sql`DELETE FROM invoices WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  }

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.destroy();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it('is NOT a real column on the invoices table — the read-side computes it', async () => {
    const r = await sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name='invoices' AND column_name='overdue'
    `.execute(db);
    expect(r.rows.length).toBe(0);
  });

  it('today (CURRENT_DATE) is NOT overdue — strict-less-than semantics', async () => {
    const { customerId } = await makeCustomer('today');
    const today = await sql`SELECT CURRENT_DATE::text AS d`.execute(db);
    const todayStr = today.rows[0].d;

    const id = await makeInvoiceWith({ customerId, dueOn: todayStr, invoiceNumber: 'TODAY' });
    const row = await invoicesRepo.findInvoiceById(db, id);
    expect(row.overdue).toBe(false);
  });

  it('yesterday IS overdue when status=open', async () => {
    const { customerId } = await makeCustomer('yesterday');
    const r = await sql`SELECT (CURRENT_DATE - INTERVAL '1 day')::date::text AS d`.execute(db);
    const yesterdayStr = r.rows[0].d;
    const id = await makeInvoiceWith({ customerId, dueOn: yesterdayStr, invoiceNumber: 'Y' });
    const row = await invoicesRepo.findInvoiceById(db, id);
    expect(row.overdue).toBe(true);
  });

  it('paid invoice with past due is NOT overdue', async () => {
    const { customerId } = await makeCustomer('paidpast');
    const r = await sql`SELECT (CURRENT_DATE - INTERVAL '7 day')::date::text AS d`.execute(db);
    const id = await makeInvoiceWith({ customerId, dueOn: r.rows[0].d, invoiceNumber: 'P' });
    await sql`UPDATE invoices SET status='paid' WHERE id=${id}::uuid`.execute(db);
    const row = await invoicesRepo.findInvoiceById(db, id);
    expect(row.overdue).toBe(false);
  });

  it('void invoice with past due is NOT overdue', async () => {
    const { customerId } = await makeCustomer('voidpast');
    const r = await sql`SELECT (CURRENT_DATE - INTERVAL '7 day')::date::text AS d`.execute(db);
    const id = await makeInvoiceWith({ customerId, dueOn: r.rows[0].d, invoiceNumber: 'V' });
    await sql`UPDATE invoices SET status='void' WHERE id=${id}::uuid`.execute(db);
    const row = await invoicesRepo.findInvoiceById(db, id);
    expect(row.overdue).toBe(false);
  });

  it('listAll surfaces overdue and admins can filter by status', async () => {
    const { customerId } = await makeCustomer('list');
    const future = (await sql`SELECT (CURRENT_DATE + INTERVAL '14 day')::date::text AS d`.execute(db)).rows[0].d;
    const past = (await sql`SELECT (CURRENT_DATE - INTERVAL '14 day')::date::text AS d`.execute(db)).rows[0].d;

    await makeInvoiceWith({ customerId, dueOn: future, invoiceNumber: 'F1' });
    const past1 = await makeInvoiceWith({ customerId, dueOn: past, invoiceNumber: 'P1' });
    await invoicesService.setStatus(db, { invoiceId: past1, newStatus: 'paid' }, baseCtx());
    await makeInvoiceWith({ customerId, dueOn: past, invoiceNumber: 'P2' });

    const all = await invoicesService.listAll(db, { customerId });
    const byNum = Object.fromEntries(all.map((r) => [r.invoice_number, r]));
    expect(byNum.F1.overdue).toBe(false);
    expect(byNum.P1.overdue).toBe(false);
    expect(byNum.P2.overdue).toBe(true);

    const open = await invoicesService.listAll(db, { customerId, status: 'open' });
    expect(open.map((r) => r.invoice_number).sort()).toEqual(['F1', 'P2']);
  });
});
