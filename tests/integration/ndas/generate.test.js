import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as projectsRepo from '../../../domain/projects/repo.js';
import * as ndasService from '../../../domain/ndas/service.js';
import { findNdaById } from '../../../domain/ndas/repo.js';
import { findDocumentById } from '../../../domain/documents/repo.js';
import { STORAGE_ROOT } from '../../../lib/files.js';
import { v7 as uuidv7 } from 'uuid';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `nda_gen_${Date.now()}`;

const MIN_PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('1 0 obj <<>> endobj\n'),
  Buffer.from('%%EOF\n'),
]);
const MIN_PDF_SHA = createHash('sha256').update(MIN_PDF_BYTES).digest('hex');

function fakeOkClient() {
  return async () => ({ ok: true, pdf: MIN_PDF_BYTES, sha256: MIN_PDF_SHA });
}
function fakeOverflowClient() {
  return async () => ({ ok: false, error: 'overflow', field: 'domicilio', length: 1024 });
}
function fakeCrashClient() {
  return async () => { throw new Error('ECONNREFUSED'); };
}
function fakeShaMismatchClient() {
  return async () => ({ ok: true, pdf: MIN_PDF_BYTES, sha256: 'f'.repeat(64) });
}

describe.skipIf(skip)('ndas/service generateDraft', () => {
  let db;
  let kek;
  let adminId;
  let createdCustomerIds = [];

  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.30',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
    pdfSocketPath: '/run/portal-pdf/portal.sock',
  });

  async function makeCustomer(suffix, overrides = {}) {
    const r = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      nif: 'B12345678',
      domicilio: 'Calle Mayor 1, 38670 Adeje, Tenerife',
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, baseCtx());
    createdCustomerIds.push(r.customerId);
    // Populate the rep fields (M8 added them; service.create doesn't take
    // them yet — set via repo or service.updateCustomer).
    await customersService.updateCustomer(db, {
      customerId: r.customerId,
      fields: {
        representanteNombre: 'María Pérez Gómez',
        representanteDni: '12345678X',
        representanteCargo: 'Administradora Única',
        ...overrides,
      },
    }, baseCtx());
    return r;
  }

  async function makeProject(customerId, suffix) {
    const id = uuidv7();
    await projectsRepo.insertProject(db, {
      id, customerId,
      name: `${suffix}-project`,
      objetoProyecto: `Diseño y desarrollo de plataforma ${suffix}`,
    });
    return id;
  }

  async function rmCustomerDir(customerId) {
    await fsp.rm(`${STORAGE_ROOT}/${customerId}`, { recursive: true, force: true });
  }

  async function cleanup() {
    await sql`DELETE FROM ndas WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (
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
    if (!fs.existsSync('/var/lib/portal/templates/nda.html')) {
      throw new Error('Run scripts/bootstrap-templates.sh once (with SKIP_FONT_CHECK=1) before integration tests.');
    }
    adminId = uuidv7();
    await sql`
      INSERT INTO admins (id, email, name)
      VALUES (${adminId}::uuid, ${tag + '@admin.local'}, 'NDA test admin')
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    for (const cid of createdCustomerIds) await rmCustomerDir(cid);
    await cleanup();
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    for (const cid of createdCustomerIds) await rmCustomerDir(cid);
    createdCustomerIds = [];
    await cleanup();
  });

  it('happy path (mocked PDF): writes documents + ndas rows, audits visible_to_customer=false', async () => {
    const { customerId } = await makeCustomer('happy');
    const projectId = await makeProject(customerId, 'happy');
    // adminId hoisted to suite scope (real admin row from beforeAll)

    const r = await ndasService.generateDraft(db,
      { adminId, projectId },
      { ...baseCtx(), renderPdf: fakeOkClient() },
    );
    expect(r.ndaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.draftDocumentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.templateVersionSha).toMatch(/^[0-9a-f]{64}$/);
    expect(r.sizeBytes).toBe(MIN_PDF_BYTES.length);

    const ndaRow = await findNdaById(db, r.ndaId);
    expect(ndaRow.customer_id).toBe(customerId);
    expect(ndaRow.project_id).toBe(projectId);
    expect(ndaRow.draft_document_id).toBe(r.draftDocumentId);
    expect(ndaRow.template_version_sha).toBe(r.templateVersionSha);
    expect(ndaRow.signed_document_id).toBeNull();
    expect(ndaRow.audit_document_id).toBeNull();

    const docRow = await findDocumentById(db, r.draftDocumentId);
    expect(docRow.category).toBe('nda-draft');
    expect(docRow.mime_type).toBe('application/pdf');
    expect(Number(docRow.size_bytes)).toBe(MIN_PDF_BYTES.length);
    expect(docRow.sha256).toBe(MIN_PDF_SHA);

    // PDF bytes on disk match the document row.
    const onDisk = await fsp.readFile(docRow.storage_path);
    expect(onDisk.equals(MIN_PDF_BYTES)).toBe(true);

    // Both audit rows are admin-only (operator scope: drafts must not
    // appear in the customer's activity feed).
    const audits = await sql`
      SELECT action, visible_to_customer FROM audit_log
       WHERE metadata->>'tag' = ${tag} AND action LIKE 'nda.%' OR (metadata->>'tag' = ${tag} AND action='document.uploaded')
    `.execute(db);
    const byAction = Object.fromEntries(audits.rows.map((r) => [r.action, r]));
    expect(byAction['document.uploaded'].visible_to_customer).toBe(false);
    expect(byAction['nda.draft_generated'].visible_to_customer).toBe(false);
  });

  it('two generations on the same template + same vars produce the SAME template_version_sha (auditability §11)', async () => {
    const { customerId } = await makeCustomer('audit');
    const projectId = await makeProject(customerId, 'audit');
    // adminId hoisted to suite scope (real admin row from beforeAll)

    const a = await ndasService.generateDraft(db,
      { adminId, projectId }, { ...baseCtx(), renderPdf: fakeOkClient() });
    const b = await ndasService.generateDraft(db,
      { adminId, projectId }, { ...baseCtx(), renderPdf: fakeOkClient() });
    expect(a.templateVersionSha).toBe(b.templateVersionSha);
  });

  it('a one-character template-file edit flips the sha (the auditability invariant)', async () => {
    const { customerId } = await makeCustomer('edit');
    const projectId = await makeProject(customerId, 'edit');
    // adminId hoisted to suite scope (real admin row from beforeAll)

    const a = await ndasService.generateDraft(db,
      { adminId, projectId }, { ...baseCtx(), renderPdf: fakeOkClient() });

    const tplPath = '/var/lib/portal/templates/nda.html';
    const original = await fsp.readFile(tplPath, 'utf8');
    const tweaked = original.replace('Acuerdo', 'Acuerdo.');
    if (tweaked === original) throw new Error('test: could not tweak template');
    await fsp.writeFile(tplPath, tweaked);
    try {
      const b = await ndasService.generateDraft(db,
        { adminId, projectId }, { ...baseCtx(), renderPdf: fakeOkClient() });
      expect(b.templateVersionSha).not.toBe(a.templateVersionSha);
    } finally {
      await fsp.writeFile(tplPath, original);
    }
  });

  it('refuses when the customer is missing rep fields, no rows written', async () => {
    const r = await customersService.create(db, {
      razonSocial: `${tag} bare S.L.`,
      nif: 'B999',
      domicilio: 'Adeje',
      primaryUser: { name: 'User', email: `${tag}+bare@example.com` },
    }, baseCtx());
    createdCustomerIds.push(r.customerId);
    const projectId = await makeProject(r.customerId, 'bare');
    // adminId hoisted to suite scope (real admin row from beforeAll)

    await expect(ndasService.generateDraft(db,
      { adminId, projectId },
      { ...baseCtx(), renderPdf: fakeOkClient() },
    )).rejects.toMatchObject({
      code: 'NDA_CUSTOMER_MISSING_FIELDS',
    });

    const c = await sql`SELECT count(*)::int AS c FROM ndas WHERE customer_id = ${r.customerId}::uuid`.execute(db);
    expect(c.rows[0].c).toBe(0);
  });

  it('overflow → no rows, structured error, audit nda.draft_overflow visible_to_customer=false', async () => {
    const { customerId } = await makeCustomer('over');
    const projectId = await makeProject(customerId, 'over');
    // adminId hoisted to suite scope (real admin row from beforeAll)

    await expect(ndasService.generateDraft(db,
      { adminId, projectId },
      { ...baseCtx(), renderPdf: fakeOverflowClient() },
    )).rejects.toMatchObject({
      code: 'NDA_OVERFLOW',
      field: 'domicilio',
      length: 1024,
    });

    const dc = await sql`SELECT count(*)::int AS c FROM documents WHERE customer_id = ${customerId}::uuid`.execute(db);
    expect(dc.rows[0].c).toBe(0);
    const nc = await sql`SELECT count(*)::int AS c FROM ndas WHERE customer_id = ${customerId}::uuid`.execute(db);
    expect(nc.rows[0].c).toBe(0);

    const audit = await sql`
      SELECT visible_to_customer, metadata FROM audit_log
       WHERE action='nda.draft_overflow' AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].visible_to_customer).toBe(false);
    expect(audit.rows[0].metadata.field).toBe('domicilio');
  });

  it('IPC failure → audits nda.draft_failed (forensic), throws NdaPdfServiceError, no rows', async () => {
    const { customerId } = await makeCustomer('crash');
    const projectId = await makeProject(customerId, 'crash');
    // adminId hoisted to suite scope (real admin row from beforeAll)

    await expect(ndasService.generateDraft(db,
      { adminId, projectId },
      { ...baseCtx(), renderPdf: fakeCrashClient() },
    )).rejects.toMatchObject({ code: 'NDA_PDF_SERVICE' });

    const audit = await sql`
      SELECT visible_to_customer, metadata FROM audit_log
       WHERE action='nda.draft_failed' AND metadata->>'tag' = ${tag}
    `.execute(db);
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].visible_to_customer).toBe(false);
    expect(String(audit.rows[0].metadata.cause)).toMatch(/ECONNREFUSED/);
  });

  it('sha mismatch from portal-pdf → NdaPdfServiceError, no rows', async () => {
    const { customerId } = await makeCustomer('shamismatch');
    const projectId = await makeProject(customerId, 'shamismatch');
    // adminId hoisted to suite scope (real admin row from beforeAll)

    await expect(ndasService.generateDraft(db,
      { adminId, projectId },
      { ...baseCtx(), renderPdf: fakeShaMismatchClient() },
    )).rejects.toMatchObject({ code: 'NDA_PDF_SERVICE' });

    const c = await sql`SELECT count(*)::int AS c FROM ndas WHERE customer_id = ${customerId}::uuid`.execute(db);
    expect(c.rows[0].c).toBe(0);
  });

  it('refuses when the project does not exist', async () => {
    // adminId hoisted to suite scope (real admin row from beforeAll)
    await expect(ndasService.generateDraft(db,
      { adminId, projectId: uuidv7() },
      { ...baseCtx(), renderPdf: fakeOkClient() },
    )).rejects.toMatchObject({ code: 'NDA_PROJECT_NOT_FOUND' });
  });

  it('refuses when the customer is suspended', async () => {
    const { customerId } = await makeCustomer('suspended');
    const projectId = await makeProject(customerId, 'suspended');
    await sql`UPDATE customers SET status='suspended' WHERE id=${customerId}::uuid`.execute(db);
    // adminId hoisted to suite scope (real admin row from beforeAll)

    await expect(ndasService.generateDraft(db,
      { adminId, projectId },
      { ...baseCtx(), renderPdf: fakeOkClient() },
    )).rejects.toThrow(/status 'suspended'/);
  });
});

// End-to-end test that hits the REAL portal-pdf.service over the live
// socket. Skipped unless RUN_PDF_E2E=1 is set, because the run-tests.sh
// wrapper leaves portal-pdf.service running but the test takes ~3-5s
// (Puppeteer cold start). Provides the contract test the spec calls for
// (§6 testing strategy: "Contract test for PDF IPC: pinned request/
// response schema; if either side drifts, test fails.").
describe.skipIf(skip || !process.env.RUN_PDF_E2E)('ndas/service generateDraft (real portal-pdf IPC)', () => {
  let db;
  let kek;
  let e2eAdminId;
  let createdCustomerIds = [];

  const baseCtx = () => ({
    actorType: 'admin', actorId: null,
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag: `${tag}_e2e` }, kek,
    pdfSocketPath: '/run/portal-pdf/portal.sock',
  });

  beforeAll(async () => {
    const env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    e2eAdminId = uuidv7();
    await sql`
      INSERT INTO admins (id, email, name)
      VALUES (${e2eAdminId}::uuid, ${tag + '_e2e@admin.local'}, 'NDA e2e admin')
    `.execute(db);
  });
  afterAll(async () => {
    if (!db) return;
    for (const cid of createdCustomerIds) {
      await fsp.rm(`${STORAGE_ROOT}/${cid}`, { recursive: true, force: true });
    }
    await sql`DELETE FROM ndas WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '_e2e%'})`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '_e2e%'})`.execute(db);
    await sql`DELETE FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '_e2e%'})`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '_e2e%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '_e2e%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag + '_e2e'}`);
    await sql`DELETE FROM admins WHERE id = ${e2eAdminId}::uuid`.execute(db);
    await db.destroy();
  });

  it('produces a real PDF that opens, has a non-zero byte count, and matches its sha on disk', async () => {
    const c = await customersService.create(db, {
      razonSocial: `${tag}_e2e Acme S.L.`,
      nif: 'B12345678',
      domicilio: 'Calle Mayor 1, 38670 Adeje, Tenerife',
      primaryUser: { name: 'User', email: `${tag}_e2e@example.com` },
    }, baseCtx());
    createdCustomerIds.push(c.customerId);
    await customersService.updateCustomer(db, {
      customerId: c.customerId,
      fields: {
        representanteNombre: 'María Pérez Gómez',
        representanteDni: '12345678X',
        representanteCargo: 'Administradora Única',
      },
    }, baseCtx());
    const id = uuidv7();
    await projectsRepo.insertProject(db, {
      id, customerId: c.customerId, name: 'e2e', objetoProyecto: 'Diseño',
    });

    const r = await ndasService.generateDraft(db,
      { adminId: e2eAdminId, projectId: id },
      baseCtx(),
    );
    expect(r.sizeBytes).toBeGreaterThan(1024);
    const doc = await findDocumentById(db, r.draftDocumentId);
    const onDisk = await fsp.readFile(doc.storage_path);
    const sha = createHash('sha256').update(onDisk).digest('hex');
    expect(sha).toBe(doc.sha256);
    // The first bytes of any well-formed PDF.
    expect(onDisk.slice(0, 4).toString()).toBe('%PDF');
  }, 30_000);
});
