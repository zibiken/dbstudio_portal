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
const tag = `inv_status_${Date.now()}`;

describe.skipIf(skip)('invoices/service status transitions', () => {
  let db;
  let kek;

  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.21',
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

  async function makeInvoice(customerId, invoiceNumber) {
    const id = uuidv7();
    await insertDocument(db, {
      id,
      customerId,
      category: 'invoice',
      storagePath: `/var/lib/portal/storage/${customerId}/${id}.pdf`,
      originalFilename: `inv-${id.slice(0, 8)}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      sha256: 'a'.repeat(64),
    });
    const r = await invoicesService.create(db, {
      customerId,
      documentId: id,
      invoiceNumber,
      amountCents: 1000,
      issuedOn: '2026-04-01',
      dueOn: '2026-05-15',
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

  it('open → paid transitions and writes a visible_to_customer audit', async () => {
    const { customerId } = await makeCustomer('paid');
    const invoiceId = await makeInvoice(customerId, 'INV-PAY');

    const r = await invoicesService.setStatus(db, {
      adminId: null, invoiceId, newStatus: 'paid',
    }, baseCtx());
    expect(r).toMatchObject({ previousStatus: 'open', newStatus: 'paid', changed: true });

    const row = await invoicesRepo.findInvoiceById(db, invoiceId);
    expect(row.status).toBe('paid');
    expect(row.overdue).toBe(false);

    const audit = await sql`
      SELECT metadata, visible_to_customer FROM audit_log
       WHERE action='invoice.status_changed' AND target_id=${invoiceId}::uuid
    `.execute(db);
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].visible_to_customer).toBe(true);
    expect(audit.rows[0].metadata).toMatchObject({
      customerId, previousStatus: 'open', newStatus: 'paid',
    });
  });

  it('open → void transitions', async () => {
    const { customerId } = await makeCustomer('void');
    const invoiceId = await makeInvoice(customerId, 'INV-VOID');

    const r = await invoicesService.setStatus(db, {
      adminId: null, invoiceId, newStatus: 'void',
    }, baseCtx());
    expect(r.newStatus).toBe('void');
    const row = await invoicesRepo.findInvoiceById(db, invoiceId);
    expect(row.status).toBe('void');
    expect(row.overdue).toBe(false);
  });

  it('paid → void is refused; route through open', async () => {
    const { customerId } = await makeCustomer('paid-to-void');
    const invoiceId = await makeInvoice(customerId, 'INV-PAY-VOID');
    await invoicesService.setStatus(db, { invoiceId, newStatus: 'paid' }, baseCtx());

    await expect(invoicesService.setStatus(db, {
      invoiceId, newStatus: 'void',
    }, baseCtx())).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION', from: 'paid', to: 'void' });

    // Reopen, then void.
    await invoicesService.setStatus(db, { invoiceId, newStatus: 'open' }, baseCtx());
    await invoicesService.setStatus(db, { invoiceId, newStatus: 'void' }, baseCtx());
    const row = await invoicesRepo.findInvoiceById(db, invoiceId);
    expect(row.status).toBe('void');

    const transitions = await sql`
      SELECT (metadata->>'previousStatus') AS prev, (metadata->>'newStatus') AS next
        FROM audit_log
       WHERE action='invoice.status_changed' AND target_id=${invoiceId}::uuid
       ORDER BY ts ASC
    `.execute(db);
    expect(transitions.rows.map((r) => `${r.prev}->${r.next}`)).toEqual([
      'open->paid', 'paid->open', 'open->void',
    ]);
  });

  it('rejects invalid status values', async () => {
    const { customerId } = await makeCustomer('bad');
    const invoiceId = await makeInvoice(customerId, 'INV-BAD');
    await expect(invoicesService.setStatus(db, {
      invoiceId, newStatus: 'sent',
    }, baseCtx())).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('throws InvoiceNotFoundError on unknown id', async () => {
    await expect(invoicesService.setStatus(db, {
      invoiceId: uuidv7(), newStatus: 'paid',
    }, baseCtx())).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('no-op on same status: no audit row, changed=false', async () => {
    const { customerId } = await makeCustomer('noop');
    const invoiceId = await makeInvoice(customerId, 'INV-NOOP');

    const r = await invoicesService.setStatus(db, {
      invoiceId, newStatus: 'open',
    }, baseCtx());
    expect(r.changed).toBe(false);

    const audit = await sql`
      SELECT 1 FROM audit_log
       WHERE action='invoice.status_changed' AND target_id=${invoiceId}::uuid
    `.execute(db);
    expect(audit.rows.length).toBe(0);
  });
});
