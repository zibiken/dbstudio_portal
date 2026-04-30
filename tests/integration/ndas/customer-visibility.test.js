import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as projectsRepo from '../../../domain/projects/repo.js';
import * as ndasService from '../../../domain/ndas/service.js';
import { listNdasForCustomer } from '../../../domain/ndas/repo.js';
import { insertDocument } from '../../../domain/documents/repo.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `nda_cust_${Date.now()}`;

describe.skipIf(skip)('ndas customer visibility', () => {
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
      nif: 'B', domicilio: 'Adeje',
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, baseCtx());
    await customersService.updateCustomer(db, {
      customerId: r.customerId,
      fields: { representanteNombre: 'X', representanteDni: 'Y', representanteCargo: 'Z' },
    }, baseCtx());
    return r;
  }

  async function makeProject(customerId, name = 'p') {
    const id = uuidv7();
    await projectsRepo.insertProject(db, {
      id, customerId, name, objetoProyecto: 'D',
    });
    return id;
  }

  async function seedDoc({ customerId, projectId, category }) {
    const id = uuidv7();
    await insertDocument(db, {
      id, customerId, projectId, category,
      storagePath: `/var/lib/portal/storage/${customerId}/${id}.pdf`,
      originalFilename: `${category}.pdf`, mimeType: 'application/pdf',
      sizeBytes: 1, sha256: 'd'.repeat(64), uploadedByAdminId: adminId,
    });
    return id;
  }

  async function seedNda({ customerId, projectId, signedDocId = null, auditDocId = null }) {
    const draftDocId = await seedDoc({ customerId, projectId, category: 'nda-draft' });
    const ndaId = uuidv7();
    await sql`
      INSERT INTO ndas (id, customer_id, project_id, draft_document_id,
                        signed_document_id, audit_document_id,
                        template_version_sha, generated_by_admin_id)
      VALUES (${ndaId}::uuid, ${customerId}::uuid, ${projectId}::uuid,
              ${draftDocId}::uuid,
              ${signedDocId}::uuid, ${auditDocId}::uuid,
              ${'a'.repeat(64)}, ${adminId}::uuid)
    `.execute(db);
    return { ndaId, draftDocId };
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
      VALUES (${adminId}::uuid, ${tag + '@admin.local'}, 'NDA cust admin')
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

  it('listNdasForCustomer returns only NDAs with a signed_document_id', async () => {
    const { customerId } = await makeCustomer('mix');
    const projectId = await makeProject(customerId, 'mixed');

    // Draft only — must be invisible.
    await seedNda({ customerId, projectId });

    // Signed but no audit-trail — must appear, audit_document_id null.
    const signedDoc = await seedDoc({ customerId, projectId, category: 'nda-signed' });
    const { ndaId: visibleId } = await seedNda({
      customerId, projectId, signedDocId: signedDoc,
    });

    // Signed AND audit-trail — must appear with both populated.
    const signedDoc2 = await seedDoc({ customerId, projectId, category: 'nda-signed' });
    const auditDoc2 = await seedDoc({ customerId, projectId, category: 'nda-audit' });
    const { ndaId: fullId } = await seedNda({
      customerId, projectId, signedDocId: signedDoc2, auditDocId: auditDoc2,
    });

    const rows = await listNdasForCustomer(db, customerId);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([visibleId, fullId].sort());
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[visibleId].signed_document_id).toBe(signedDoc);
    expect(byId[visibleId].audit_document_id).toBeNull();
    expect(byId[fullId].audit_document_id).toBe(auditDoc2);

    // No raw drafts ever appear in the customer slice.
    const draftIds = rows.map((r) => r.signed_document_id).filter((x) => x === null);
    expect(draftIds.length).toBe(0);
  });

  it('returns rows newest-first by generated_at', async () => {
    const { customerId } = await makeCustomer('order');
    const projectId = await makeProject(customerId);

    const sd1 = await seedDoc({ customerId, projectId, category: 'nda-signed' });
    const a = await seedNda({ customerId, projectId, signedDocId: sd1 });
    await sql`UPDATE ndas SET generated_at = now() - interval '2 days' WHERE id = ${a.ndaId}::uuid`.execute(db);

    const sd2 = await seedDoc({ customerId, projectId, category: 'nda-signed' });
    const b = await seedNda({ customerId, projectId, signedDocId: sd2 });

    const rows = await listNdasForCustomer(db, customerId);
    expect(rows.map((r) => r.id)).toEqual([b.ndaId, a.ndaId]);
  });

  it('exposes only the public template_version_sha, project_name, and document slot ids — no admin-only columns', async () => {
    const { customerId } = await makeCustomer('shape');
    const projectId = await makeProject(customerId, 'visible');
    const sd = await seedDoc({ customerId, projectId, category: 'nda-signed' });
    await seedNda({ customerId, projectId, signedDocId: sd });

    const rows = await listNdasForCustomer(db, customerId);
    expect(rows.length).toBe(1);
    const keys = Object.keys(rows[0]).sort();
    // generated_by_admin_id and draft_document_id MUST NOT appear in the
    // customer-facing projection — they're admin-only metadata.
    expect(keys).not.toContain('generated_by_admin_id');
    expect(keys).not.toContain('draft_document_id');
    expect(keys).toContain('id');
    expect(keys).toContain('project_id');
    expect(keys).toContain('project_name');
    expect(keys).toContain('signed_document_id');
    expect(keys).toContain('audit_document_id');
    expect(keys).toContain('template_version_sha');
    expect(keys).toContain('generated_at');
    expect(rows[0].project_name).toBe('visible');
  });
});
