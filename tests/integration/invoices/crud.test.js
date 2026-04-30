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
const tag = `inv_crud_${Date.now()}`;

describe.skipIf(skip)('invoices/service crud', () => {
  let db;
  let kek;

  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.20',
    userAgentHash: 'uahash',
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

  async function makeInvoiceDocument(customerId) {
    const id = uuidv7();
    await insertDocument(db, {
      id,
      customerId,
      category: 'invoice',
      storagePath: `/var/lib/portal/storage/${customerId}/${id}.pdf`,
      originalFilename: `invoice-${id.slice(0, 8)}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 12345,
      sha256: 'a'.repeat(64),
    });
    return id;
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

  describe('create', () => {
    it('persists row, audits visible_to_customer, enqueues new-invoice email', async () => {
      const { customerId, primaryUserId } = await makeCustomer('happy');
      const documentId = await makeInvoiceDocument(customerId);

      const r = await invoicesService.create(db, {
        adminId: null,
        customerId,
        documentId,
        invoiceNumber: 'INV-2026-001',
        amountCents: 123456,
        currency: 'EUR',
        issuedOn: '2026-04-01',
        dueOn: '2026-05-15',
        notes: 'first draft',
      }, baseCtx());

      expect(r.invoiceId).toMatch(/^[0-9a-f-]{36}$/);

      const row = await invoicesRepo.findInvoiceById(db, r.invoiceId);
      expect(row).not.toBeNull();
      expect(row.customer_id).toBe(customerId);
      expect(row.document_id).toBe(documentId);
      expect(row.invoice_number).toBe('INV-2026-001');
      expect(Number(row.amount_cents)).toBe(123456);
      expect(row.currency).toBe('EUR');
      expect(row.status).toBe('open');
      expect(row.notes).toBe('first draft');
      // due_on is in the future relative to today (2026-04-30), so not overdue.
      expect(row.overdue).toBe(false);

      const audit = await sql`
        SELECT actor_type, actor_id::text AS actor_id, action,
               target_type, target_id::text AS target_id,
               metadata, visible_to_customer
          FROM audit_log
         WHERE action = 'invoice.created'
           AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].actor_type).toBe('admin');
      expect(audit.rows[0].target_type).toBe('invoice');
      expect(audit.rows[0].target_id).toBe(r.invoiceId);
      expect(audit.rows[0].visible_to_customer).toBe(true);
      expect(audit.rows[0].metadata.customerId).toBe(customerId);
      expect(audit.rows[0].metadata.invoiceNumber).toBe('INV-2026-001');
      expect(Number(audit.rows[0].metadata.amountCents)).toBe(123456);
      expect(audit.rows[0].metadata.currency).toBe('EUR');

      const outbox = await sql`
        SELECT to_address, template, idempotency_key, locals
          FROM email_outbox
         WHERE to_address LIKE ${tag + '%'}
           AND template = 'new-invoice'
      `.execute(db);
      expect(outbox.rows.length).toBe(1);
      expect(outbox.rows[0].idempotency_key).toBe(`invoice_created:${r.invoiceId}`);
      expect(outbox.rows[0].locals.invoiceNumber).toBe('INV-2026-001');
      expect(outbox.rows[0].locals.invoiceUrl).toMatch(`/customer/invoices/${r.invoiceId}`);
    });

    it('refuses when the customer is not active', async () => {
      const { customerId } = await makeCustomer('suspended');
      const documentId = await makeInvoiceDocument(customerId);
      await sql`UPDATE customers SET status='suspended' WHERE id=${customerId}::uuid`.execute(db);

      await expect(invoicesService.create(db, {
        customerId,
        documentId,
        invoiceNumber: 'INV-X',
        amountCents: 1000,
        issuedOn: '2026-04-01',
        dueOn: '2026-05-15',
      }, baseCtx())).rejects.toThrow(/status 'suspended'/);

      const after = await sql`SELECT 1 FROM invoices WHERE customer_id = ${customerId}::uuid`.execute(db);
      expect(after.rows.length).toBe(0);
    });

    it('refuses cross-customer document', async () => {
      const a = await makeCustomer('a');
      const b = await makeCustomer('b');
      const docOfA = await makeInvoiceDocument(a.customerId);

      await expect(invoicesService.create(db, {
        customerId: b.customerId,
        documentId: docOfA,
        invoiceNumber: 'INV-X',
        amountCents: 1000,
        issuedOn: '2026-04-01',
        dueOn: '2026-05-15',
      }, baseCtx())).rejects.toMatchObject({ code: 'CROSS_CUSTOMER' });

      const after = await sql`SELECT 1 FROM invoices WHERE customer_id = ${b.customerId}::uuid`.execute(db);
      expect(after.rows.length).toBe(0);
    });

    it('refuses a document that is not category=invoice', async () => {
      const { customerId } = await makeCustomer('wrongcat');
      const id = uuidv7();
      await insertDocument(db, {
        id,
        customerId,
        category: 'generic',
        storagePath: `/var/lib/portal/storage/${customerId}/${id}.pdf`,
        originalFilename: 'wrong.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        sha256: 'b'.repeat(64),
      });

      await expect(invoicesService.create(db, {
        customerId,
        documentId: id,
        invoiceNumber: 'INV-X',
        amountCents: 1000,
        issuedOn: '2026-04-01',
        dueOn: '2026-05-15',
      }, baseCtx())).rejects.toThrow(/category 'generic'.*expected 'invoice'/);
    });

    it('rejects malformed dates and bad amounts before touching the DB', async () => {
      const { customerId } = await makeCustomer('valid');
      const documentId = await makeInvoiceDocument(customerId);

      await expect(invoicesService.create(db, {
        customerId, documentId, invoiceNumber: 'X',
        amountCents: -1, issuedOn: '2026-04-01', dueOn: '2026-05-01',
      }, baseCtx())).rejects.toThrow(/amountCents/);

      await expect(invoicesService.create(db, {
        customerId, documentId, invoiceNumber: 'X',
        amountCents: 100, issuedOn: '2026/04/01', dueOn: '2026-05-01',
      }, baseCtx())).rejects.toThrow(/issuedOn/);

      await expect(invoicesService.create(db, {
        customerId, documentId, invoiceNumber: '   ',
        amountCents: 100, issuedOn: '2026-04-01', dueOn: '2026-05-01',
      }, baseCtx())).rejects.toThrow(/invoiceNumber/);

      await expect(invoicesService.create(db, {
        customerId, documentId, invoiceNumber: 'X',
        amountCents: 100, currency: 'eur',
        issuedOn: '2026-04-01', dueOn: '2026-05-01',
      }, baseCtx())).rejects.toThrow(/currency/);
    });
  });

  describe('listForCustomer', () => {
    it('returns invoices for that customer with overdue computed', async () => {
      const { customerId } = await makeCustomer('list');
      const doc1 = await makeInvoiceDocument(customerId);
      const doc2 = await makeInvoiceDocument(customerId);
      const doc3 = await makeInvoiceDocument(customerId);

      // Open + due in past = overdue.
      await invoicesService.create(db, {
        customerId, documentId: doc1, invoiceNumber: 'A',
        amountCents: 100, issuedOn: '2026-01-01', dueOn: '2026-02-01',
      }, baseCtx());
      // Open + due in future = not overdue.
      await invoicesService.create(db, {
        customerId, documentId: doc2, invoiceNumber: 'B',
        amountCents: 200, issuedOn: '2026-04-01', dueOn: '2026-05-30',
      }, baseCtx());
      // Paid + due in past = NOT overdue (paid trumps).
      const c = await invoicesService.create(db, {
        customerId, documentId: doc3, invoiceNumber: 'C',
        amountCents: 300, issuedOn: '2026-01-01', dueOn: '2026-02-01',
      }, baseCtx());
      await sql`UPDATE invoices SET status='paid' WHERE id=${c.invoiceId}::uuid`.execute(db);

      const rows = await invoicesService.listForCustomer(db, customerId);
      expect(rows.length).toBe(3);
      const byNum = Object.fromEntries(rows.map((r) => [r.invoice_number, r]));
      expect(byNum.A.overdue).toBe(true);
      expect(byNum.B.overdue).toBe(false);
      expect(byNum.C.overdue).toBe(false);
    });
  });
});
