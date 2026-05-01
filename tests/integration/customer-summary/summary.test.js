import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import * as customersService from '../../../domain/customers/service.js';
import * as adminsService from '../../../domain/admins/service.js';
import { getCustomerDashboardSummary } from '../../../lib/customer-summary.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('lib/customer-summary — getCustomerDashboardSummary', () => {
  let db;
  let kek;
  let adminId;
  const tag = `summary_test_${Date.now()}`;
  const tagEmail = (s) => `${tag}+${s}@example.com`;
  const baseCtx = () => ({
    ip: '198.51.100.7',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    kek = randomBytes(32);
    // The admin id is referenced as uploaded_by_admin_id and
    // requested_by_admin_id on documents / credential_requests rows.
    const a = await adminsService.create(
      db,
      { email: tagEmail('admin'), name: 'Summary Admin' },
      { actorType: 'system', audit: { tag }, portalBaseUrl: 'https://portal.example.test/' },
    );
    adminId = a.id;
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM credential_requests WHERE requested_by_admin_id = ${adminId}::uuid`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM ndas WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id = ${adminId}::uuid`.execute(db);
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM credential_requests WHERE requested_by_admin_id = ${adminId}::uuid`.execute(db);
    await sql`DELETE FROM credentials WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM ndas WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
  });

  async function makeCustomer(suffix) {
    const r = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      nif: 'B' + Math.floor(Math.random() * 9e7 + 1e7),
      domicilio: 'Calle ' + suffix,
      primaryUser: { name: suffix, email: tagEmail(suffix) },
    }, baseCtx());
    return r.customerId;
  }

  async function insertProject(customerId, { name = 'Proj', objeto = 'Lorem ipsum…', status = 'active' } = {}) {
    const id = uuidv7();
    await sql`
      INSERT INTO projects (id, customer_id, name, objeto_proyecto, status)
      VALUES (${id}::uuid, ${customerId}::uuid, ${name}, ${objeto}, ${status})
    `.execute(db);
    return id;
  }

  async function insertDocument(customerId, { category = 'generic', filename = 'file.pdf', uploadedAt = null } = {}) {
    const id = uuidv7();
    await sql`
      INSERT INTO documents (id, customer_id, category, storage_path, original_filename,
                             mime_type, size_bytes, sha256, uploaded_by_admin_id, uploaded_at)
      VALUES (${id}::uuid, ${customerId}::uuid, ${category}, ${'/tmp/' + id}, ${filename},
              'application/pdf', 123, ${'a'.repeat(64)}, ${adminId}::uuid,
              ${uploadedAt ?? new Date()})
    `.execute(db);
    return id;
  }

  async function insertCredential(customerId, { needsUpdate = false } = {}) {
    const id = uuidv7();
    await sql`
      INSERT INTO credentials (id, customer_id, provider, label,
                               payload_ciphertext, payload_iv, payload_tag,
                               needs_update, created_by)
      VALUES (${id}::uuid, ${customerId}::uuid, 'AWS', 'Production',
              ${Buffer.from('x')}, ${Buffer.from('iv0000000000')}, ${Buffer.from('tag0123456789ab')},
              ${needsUpdate}, 'admin')
    `.execute(db);
    return id;
  }

  async function insertCredentialRequest(customerId, { status = 'open' } = {}) {
    const id = uuidv7();
    await sql`
      INSERT INTO credential_requests (id, customer_id, requested_by_admin_id, provider, fields, status)
      VALUES (${id}::uuid, ${customerId}::uuid, ${adminId}::uuid, 'AWS',
              ${JSON.stringify([{ name: 'access_key', label: 'Access key', type: 'secret', required: true }])}::jsonb,
              ${status})
    `.execute(db);
    return id;
  }

  async function insertInvoice(customerId, { status = 'open', invoiceNumber = null } = {}) {
    // Invoices require a document FK — seed a backing invoice doc first.
    const docId = await insertDocument(customerId, { category: 'invoice', filename: 'inv.pdf' });
    const id = uuidv7();
    const number = invoiceNumber ?? ('INV-' + id.slice(0, 8));
    await sql`
      INSERT INTO invoices (id, customer_id, document_id, invoice_number,
                            amount_cents, currency, issued_on, due_on, status)
      VALUES (${id}::uuid, ${customerId}::uuid, ${docId}::uuid, ${number},
              10000, 'EUR', CURRENT_DATE - 1, CURRENT_DATE + 14, ${status})
    `.execute(db);
    return id;
  }

  async function insertNda(customerId, { signed = false } = {}) {
    // NDA requires a project + draft document FK.
    const projectId = await insertProject(customerId);
    const draftId = await insertDocument(customerId, { category: 'nda-draft' });
    const signedId = signed ? await insertDocument(customerId, { category: 'nda-signed' }) : null;
    const id = uuidv7();
    await sql`
      INSERT INTO ndas (id, customer_id, project_id, draft_document_id, signed_document_id,
                       template_version_sha, generated_by_admin_id)
      VALUES (${id}::uuid, ${customerId}::uuid, ${projectId}::uuid, ${draftId}::uuid,
              ${signedId ? sql`${signedId}::uuid` : sql`NULL`},
              ${'b'.repeat(64)}, ${adminId}::uuid)
    `.execute(db);
    return id;
  }

  it('returns six section keys with count/latestAt/unreadCount each', async () => {
    const customerId = await makeCustomer('shape');
    const r = await getCustomerDashboardSummary(db, { customerId });
    expect(Object.keys(r).sort()).toEqual([
      'credentialRequests', 'credentials', 'documents', 'invoices', 'ndas', 'projects',
    ]);
    for (const key of Object.keys(r)) {
      expect(r[key]).toHaveProperty('count');
      expect(r[key]).toHaveProperty('latestAt');
      expect(r[key]).toHaveProperty('unreadCount');
      expect(typeof r[key].count).toBe('number');
      expect(typeof r[key].unreadCount).toBe('number');
    }
  });

  it('reports zero counts and null latestAt for an empty customer', async () => {
    const customerId = await makeCustomer('empty');
    const r = await getCustomerDashboardSummary(db, { customerId });
    for (const key of Object.keys(r)) {
      expect(r[key].count).toBe(0);
      expect(r[key].latestAt).toBeNull();
      expect(r[key].unreadCount).toBe(0);
    }
  });

  it('counts each section against the seeded rows', async () => {
    const customerId = await makeCustomer('busy');
    await insertProject(customerId);
    await insertProject(customerId, { name: 'Proj 2' });
    await insertDocument(customerId, { category: 'generic' });
    await insertCredential(customerId, { needsUpdate: false });
    await insertCredential(customerId, { needsUpdate: true });
    await insertCredentialRequest(customerId, { status: 'open' });
    await insertCredentialRequest(customerId, { status: 'fulfilled' });
    await insertInvoice(customerId, { status: 'open' });
    await insertInvoice(customerId, { status: 'paid' });
    await insertNda(customerId, { signed: false });
    await insertNda(customerId, { signed: true });

    const r = await getCustomerDashboardSummary(db, { customerId });
    expect(r.projects.count).toBe(4); // 2 standalone + 2 created via insertNda
    expect(r.documents.count).toBe(1); // generic only — nda-draft / nda-signed / invoice excluded
    expect(r.credentials.count).toBe(2);
    expect(r.credentialRequests.count).toBe(2);
    expect(r.invoices.count).toBe(2);
    expect(r.ndas.count).toBe(2);
    expect(r.documents.latestAt).not.toBeNull();
  });

  it('unreadCount semantics: NDAs awaiting signature, credentials flagged needs_update, requests open, invoices open', async () => {
    const customerId = await makeCustomer('unread');
    await insertCredential(customerId, { needsUpdate: false });
    await insertCredential(customerId, { needsUpdate: true });
    await insertCredential(customerId, { needsUpdate: true });
    await insertCredentialRequest(customerId, { status: 'open' });
    await insertCredentialRequest(customerId, { status: 'fulfilled' });
    await insertCredentialRequest(customerId, { status: 'cancelled' });
    await insertInvoice(customerId, { status: 'open' });
    await insertInvoice(customerId, { status: 'open' });
    await insertInvoice(customerId, { status: 'paid' });
    await insertNda(customerId, { signed: false });
    await insertNda(customerId, { signed: false });
    await insertNda(customerId, { signed: true });

    const r = await getCustomerDashboardSummary(db, { customerId });
    expect(r.credentials.unreadCount).toBe(2);
    expect(r.credentialRequests.unreadCount).toBe(1);
    expect(r.invoices.unreadCount).toBe(2);
    expect(r.ndas.unreadCount).toBe(2);
    // documents + projects don't have a meaningful unread surface yet.
    expect(r.documents.unreadCount).toBe(0);
    expect(r.projects.unreadCount).toBe(0);
  });

  it('isolates customers — one customer cannot see another customer\'s rows', async () => {
    const aId = await makeCustomer('iso-a');
    const bId = await makeCustomer('iso-b');
    await insertDocument(aId, { category: 'generic' });
    await insertNda(aId, { signed: false });
    await insertCredential(aId);

    const ra = await getCustomerDashboardSummary(db, { customerId: aId });
    const rb = await getCustomerDashboardSummary(db, { customerId: bId });
    expect(ra.documents.count).toBe(1);
    expect(ra.ndas.count).toBe(1);
    expect(ra.credentials.count).toBe(1);
    // B's view: zero across the board even though A has rows.
    for (const key of Object.keys(rb)) {
      expect(rb[key].count).toBe(0);
    }
  });

  it('latestAt reflects the most recent row in each section', async () => {
    const customerId = await makeCustomer('latest');
    const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const recent = new Date();
    await insertDocument(customerId, { category: 'generic', uploadedAt: old });
    await insertDocument(customerId, { category: 'generic', uploadedAt: recent });

    const r = await getCustomerDashboardSummary(db, { customerId });
    expect(r.documents.count).toBe(2);
    const latestMs = new Date(r.documents.latestAt).getTime();
    expect(Math.abs(latestMs - recent.getTime())).toBeLessThan(1000);
  });

  it('throws if customerId is missing', async () => {
    await expect(getCustomerDashboardSummary(db, {})).rejects.toThrow(/customerId/);
    await expect(getCustomerDashboardSummary(db, { customerId: '' })).rejects.toThrow(/customerId/);
  });
});
