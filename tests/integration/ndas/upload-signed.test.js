import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as projectsRepo from '../../../domain/projects/repo.js';
import * as ndasService from '../../../domain/ndas/service.js';
import { findNdaById } from '../../../domain/ndas/repo.js';
import { insertDocument } from '../../../domain/documents/repo.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `nda_signed_${Date.now()}`;

describe.skipIf(skip)('ndas/service attachUploadedDocument', () => {
  let db;
  let kek;
  let adminId;
  const baseCtx = () => ({
    actorType: 'admin', actorId: null,
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag }, kek,
  });

  async function makeCustomer(suffix) {
    const r = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      nif: 'B12345678',
      domicilio: 'Adeje',
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, baseCtx());
    await customersService.updateCustomer(db, {
      customerId: r.customerId,
      fields: {
        representanteNombre: 'María Pérez',
        representanteDni: '12345678X',
        representanteCargo: 'Administradora',
      },
    }, baseCtx());
    return r;
  }

  async function makeProject(customerId) {
    const id = uuidv7();
    await projectsRepo.insertProject(db, {
      id, customerId, name: 'p', objetoProyecto: 'Diseño',
    });
    return id;
  }

  async function seedDraftNda({ customerId, projectId }) {
    const draftDocId = uuidv7();
    await insertDocument(db, {
      id: draftDocId, customerId, projectId,
      category: 'nda-draft',
      storagePath: `/var/lib/portal/storage/${customerId}/${draftDocId}.pdf`,
      originalFilename: 'draft.pdf', mimeType: 'application/pdf',
      sizeBytes: 1, sha256: 'a'.repeat(64), uploadedByAdminId: adminId,
    });
    const ndaId = uuidv7();
    await sql`
      INSERT INTO ndas (id, customer_id, project_id, draft_document_id,
                        template_version_sha, generated_by_admin_id)
      VALUES (${ndaId}::uuid, ${customerId}::uuid, ${projectId}::uuid,
              ${draftDocId}::uuid, ${'b'.repeat(64)}, ${adminId}::uuid)
    `.execute(db);
    return ndaId;
  }

  async function seedDoc({ customerId, projectId, category }) {
    const id = uuidv7();
    await insertDocument(db, {
      id, customerId, projectId, category,
      storagePath: `/var/lib/portal/storage/${customerId}/${id}.pdf`,
      originalFilename: `${category}.pdf`, mimeType: 'application/pdf',
      sizeBytes: 1, sha256: 'c'.repeat(64), uploadedByAdminId: adminId,
    });
    return id;
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
    adminId = uuidv7();
    await sql`
      INSERT INTO admins (id, email, name)
      VALUES (${adminId}::uuid, ${tag + '@admin.local'}, 'NDA upload-signed admin')
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await sql`DELETE FROM admins WHERE id = ${adminId}::uuid`.execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it('attaches a signed nda-signed document, audits visible_to_customer=true', async () => {
    const { customerId } = await makeCustomer('s1');
    const projectId = await makeProject(customerId);
    const ndaId = await seedDraftNda({ customerId, projectId });
    const docId = await seedDoc({ customerId, projectId, category: 'nda-signed' });

    const r = await ndasService.attachUploadedDocument(db, {
      adminId, ndaId, documentId: docId, kind: 'signed',
    }, baseCtx());
    expect(r).toMatchObject({ ndaId, slot: 'signed_document_id', documentId: docId });

    const row = await findNdaById(db, ndaId);
    expect(row.signed_document_id).toBe(docId);
    expect(row.audit_document_id).toBeNull();

    const audit = await sql`
      SELECT visible_to_customer, metadata FROM audit_log
       WHERE action='nda.signed_uploaded' AND target_id=${ndaId}::uuid
    `.execute(db);
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].visible_to_customer).toBe(true);
    expect(audit.rows[0].metadata).toMatchObject({
      customerId, projectId, documentId: docId, slot: 'signed_document_id',
    });
  });

  it('attaches an audit-trail to an already-signed NDA', async () => {
    const { customerId } = await makeCustomer('a1');
    const projectId = await makeProject(customerId);
    const ndaId = await seedDraftNda({ customerId, projectId });

    const signedDoc = await seedDoc({ customerId, projectId, category: 'nda-signed' });
    await ndasService.attachUploadedDocument(db, {
      adminId, ndaId, documentId: signedDoc, kind: 'signed',
    }, baseCtx());

    const auditDoc = await seedDoc({ customerId, projectId, category: 'nda-audit' });
    await ndasService.attachUploadedDocument(db, {
      adminId, ndaId, documentId: auditDoc, kind: 'audit',
    }, baseCtx());

    const row = await findNdaById(db, ndaId);
    expect(row.signed_document_id).toBe(signedDoc);
    expect(row.audit_document_id).toBe(auditDoc);

    const aud = await sql`
      SELECT action FROM audit_log
       WHERE target_id=${ndaId}::uuid AND action LIKE 'nda.%'
       ORDER BY ts ASC
    `.execute(db);
    expect(aud.rows.map((r) => r.action)).toEqual([
      'nda.signed_uploaded', 'nda.audit_trail_uploaded',
    ]);
  });

  it('refuses to overwrite an already-attached signed slot', async () => {
    const { customerId } = await makeCustomer('busy');
    const projectId = await makeProject(customerId);
    const ndaId = await seedDraftNda({ customerId, projectId });
    const a = await seedDoc({ customerId, projectId, category: 'nda-signed' });
    await ndasService.attachUploadedDocument(db, {
      adminId, ndaId, documentId: a, kind: 'signed',
    }, baseCtx());

    const b = await seedDoc({ customerId, projectId, category: 'nda-signed' });
    await expect(ndasService.attachUploadedDocument(db, {
      adminId, ndaId, documentId: b, kind: 'signed',
    }, baseCtx())).rejects.toMatchObject({ code: 'NDA_SLOT_FILLED', slot: 'signed' });

    const row = await findNdaById(db, ndaId);
    expect(row.signed_document_id).toBe(a);
  });

  it('refuses a document from a different customer', async () => {
    const a = await makeCustomer('xa');
    const b = await makeCustomer('xb');
    const aProject = await makeProject(a.customerId);
    const ndaId = await seedDraftNda({ customerId: a.customerId, projectId: aProject });

    const wrongDoc = await seedDoc({
      customerId: b.customerId,
      projectId: await makeProject(b.customerId),
      category: 'nda-signed',
    });

    await expect(ndasService.attachUploadedDocument(db, {
      adminId, ndaId, documentId: wrongDoc, kind: 'signed',
    }, baseCtx())).rejects.toMatchObject({ code: 'NDA_CROSS_CUSTOMER' });
  });

  it('refuses a document with the wrong category', async () => {
    const { customerId } = await makeCustomer('cat');
    const projectId = await makeProject(customerId);
    const ndaId = await seedDraftNda({ customerId, projectId });
    const wrongCat = await seedDoc({ customerId, projectId, category: 'invoice' });

    await expect(ndasService.attachUploadedDocument(db, {
      adminId, ndaId, documentId: wrongCat, kind: 'signed',
    }, baseCtx())).rejects.toMatchObject({
      code: 'NDA_CATEGORY_MISMATCH',
      expected: 'nda-signed',
      actual: 'invoice',
    });
  });

  it('throws NdaNotFoundError on unknown NDA', async () => {
    await expect(ndasService.attachUploadedDocument(db, {
      adminId, ndaId: uuidv7(), documentId: uuidv7(), kind: 'signed',
    }, baseCtx())).rejects.toMatchObject({ code: 'NDA_NOT_FOUND' });
  });

  it('throws on unknown kind', async () => {
    const { customerId } = await makeCustomer('badkind');
    const projectId = await makeProject(customerId);
    const ndaId = await seedDraftNda({ customerId, projectId });
    await expect(ndasService.attachUploadedDocument(db, {
      adminId, ndaId, documentId: uuidv7(), kind: 'whatever',
    }, baseCtx())).rejects.toThrow(/unknown kind/);
  });
});
