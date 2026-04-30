import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import { renderNda, NDA_PLACEHOLDERS } from '../../lib/nda.js';
import { renderPdf as defaultRenderPdf } from '../../lib/pdf-client.js';
import { euDate } from '../../lib/dates.js';
import { STORAGE_ROOT, assertCustomerQuota } from '../../lib/files.js';
import { customerStorageBytes, insertDocument } from '../documents/repo.js';
import * as repo from './repo.js';

// Spec §2.10 + plan Task 8.4. Turns a (customer, project) pair into a
// rendered NDA draft PDF. Pipeline:
//   load customer + project       — domain rows
//   build vars (FECHA_FIRMA today, LUGAR_FIRMA fixed = 'Adeje')
//   renderNda(template, vars)     — Mustache + sha256 (lib/nda.js)
//   pdf-client.renderPdf(html)    — IPC → portal-pdf.service
//   write PDF, document row, ndas row, audit  — one tx
//
// Drafts are ADMIN-ONLY: per operator scope clarification (2026-04-30)
// the customer never sees a draft and never receives a notification —
// they sign through the operator's secure signing platform and only
// access the signed copy + audit-trail (Task 8.5/8.6) here. The audit
// trail therefore writes visible_to_customer=FALSE for every step of the
// draft lifecycle. The download path additionally refuses any
// category='nda-draft' download from the customer surface (defence in
// depth on top of the audit invisibility).

const TEMPLATE_PATH = '/var/lib/portal/templates/nda.html';
const FIXED_LUGAR_FIRMA = 'Adeje';

export class NdaTemplateMissingError extends Error {
  constructor(path) {
    super(`NDA template not found at ${path}; run scripts/bootstrap-templates.sh on the server`);
    this.name = 'NdaTemplateMissingError';
    this.code = 'NDA_TEMPLATE_MISSING';
    this.status = 500;
  }
}

export class NdaProjectMissingError extends Error {
  constructor(id) {
    super(`project ${id} not found`);
    this.name = 'NdaProjectMissingError';
    this.code = 'NDA_PROJECT_NOT_FOUND';
    this.status = 404;
  }
}

export class NdaCustomerMissingFieldError extends Error {
  constructor(missing) {
    super(`customer is missing required NDA fields: ${missing.join(', ')}`);
    this.name = 'NdaCustomerMissingFieldError';
    this.code = 'NDA_CUSTOMER_MISSING_FIELDS';
    this.status = 422;
    this.missing = missing;
  }
}

export class NdaOverflowError extends Error {
  constructor({ field, length }) {
    super(`NDA exceeds one A4 page; offending field '${field ?? 'unknown'}' length ${length ?? 0}`);
    this.name = 'NdaOverflowError';
    this.code = 'NDA_OVERFLOW';
    this.status = 422;
    this.field = field ?? null;
    this.length = length ?? 0;
  }
}

export class NdaPdfServiceError extends Error {
  constructor(cause) {
    super(`portal-pdf.service unavailable: ${cause}`);
    this.name = 'NdaPdfServiceError';
    this.code = 'NDA_PDF_SERVICE';
    this.status = 502;
  }
}

async function readTemplate() {
  try {
    return await fsp.readFile(TEMPLATE_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new NdaTemplateMissingError(TEMPLATE_PATH);
    throw err;
  }
}

async function loadCustomer(db, customerId) {
  const r = await sql`SELECT * FROM customers WHERE id = ${customerId}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

async function loadProject(db, projectId) {
  const r = await sql`SELECT * FROM projects WHERE id = ${projectId}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

function buildVars(customer, project) {
  const required = [
    ['representante_nombre', customer.representante_nombre],
    ['representante_dni', customer.representante_dni],
    ['representante_cargo', customer.representante_cargo],
    ['nif', customer.nif],
    ['domicilio', customer.domicilio],
    ['objeto_proyecto', project.objeto_proyecto],
  ];
  const missing = required
    .filter(([_k, v]) => typeof v !== 'string' || v.trim() === '')
    .map(([k]) => k);
  if (missing.length > 0) throw new NdaCustomerMissingFieldError(missing);

  return {
    CLIENTE_RAZON_SOCIAL: customer.razon_social,
    CLIENTE_CIF: customer.nif,
    CLIENTE_DOMICILIO: customer.domicilio,
    CLIENTE_REPRESENTANTE_NOMBRE: customer.representante_nombre,
    CLIENTE_REPRESENTANTE_DNI: customer.representante_dni,
    CLIENTE_REPRESENTANTE_CARGO: customer.representante_cargo,
    OBJETO_PROYECTO: project.objeto_proyecto,
    FECHA_FIRMA: euDate(new Date()),
    LUGAR_FIRMA: FIXED_LUGAR_FIRMA,
  };
}

async function ensureCustomerDir(customerId) {
  const dir = `${STORAGE_ROOT}/${customerId}`;
  await fsp.mkdir(dir, { mode: 0o750, recursive: true });
  return dir;
}

async function unlinkSafe(path) {
  try { await fsp.unlink(path); } catch { /* already gone */ }
}

function baseAudit(ctx) {
  return {
    metadata: { ...(ctx?.audit ?? {}) },
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  };
}

export async function generateDraft(db, { adminId, projectId }, ctx = {}) {
  if (typeof adminId !== 'string' || adminId.trim() === '') {
    throw new Error('generateDraft: adminId required');
  }
  const socketPath = ctx?.pdfSocketPath;
  if (typeof socketPath !== 'string' || socketPath === '') {
    throw new Error('generateDraft: ctx.pdfSocketPath required');
  }
  const renderPdf = ctx?.renderPdf ?? defaultRenderPdf;

  const project = await loadProject(db, projectId);
  if (!project) throw new NdaProjectMissingError(projectId);
  const customer = await loadCustomer(db, project.customer_id);
  if (!customer) throw new Error(`customer ${project.customer_id} not found (project FK orphan)`);
  if (customer.status !== 'active') {
    throw new Error(`cannot generate NDA for customer in status '${customer.status}' — must be 'active'`);
  }

  const template = await readTemplate();
  const vars = buildVars(customer, project);
  const { html, sha256: templateVersionSha } = renderNda({ template, vars });

  let pdfResult;
  try {
    pdfResult = await renderPdf({
      socketPath,
      html,
      options: { format: 'A4', margin: 0 },
    });
  } catch (cause) {
    // IPC failure — socket missing, timeout, malformed JSON. Forensic
    // audit lives on the admin (operator-side) stream so the customer
    // never sees a failed-NDA event leak through the activity feed.
    const a = baseAudit(ctx);
    try {
      await writeAudit(db, {
        actorType: 'admin',
        actorId: adminId,
        action: 'nda.draft_failed',
        targetType: 'project',
        targetId: projectId,
        metadata: {
          ...a.metadata,
          customerId: customer.id,
          cause: String(cause?.message ?? cause),
        },
        visibleToCustomer: false,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });
    } catch { /* audit best-effort; throw the underlying error unconditionally */ }
    throw new NdaPdfServiceError(cause?.message ?? cause);
  }

  if (!pdfResult.ok) {
    if (pdfResult.error === 'overflow') {
      const a = baseAudit(ctx);
      await writeAudit(db, {
        actorType: 'admin',
        actorId: adminId,
        action: 'nda.draft_overflow',
        targetType: 'project',
        targetId: projectId,
        metadata: {
          ...a.metadata,
          customerId: customer.id,
          field: pdfResult.field ?? null,
          length: pdfResult.length ?? 0,
        },
        visibleToCustomer: false,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });
      throw new NdaOverflowError({ field: pdfResult.field, length: pdfResult.length });
    }
    // crash / unknown error
    throw new NdaPdfServiceError(pdfResult.message ?? pdfResult.error ?? 'unknown pdf-service error');
  }

  // Verify the sha that portal-pdf.service computed against ours — both
  // sides hash the exact PDF bytes. Mismatch is a contract violation
  // (a tampered IPC response or a binary-corruption-in-flight). We fail
  // closed and audit forensically.
  const localSha = createHash('sha256').update(pdfResult.pdf).digest('hex');
  if (pdfResult.sha256 && pdfResult.sha256 !== localSha) {
    const a = baseAudit(ctx);
    try {
      await writeAudit(db, {
        actorType: 'admin',
        actorId: adminId,
        action: 'nda.draft_failed',
        targetType: 'project',
        targetId: projectId,
        metadata: {
          ...a.metadata,
          customerId: customer.id,
          cause: 'sha256 mismatch between portal-pdf.service and local recompute',
        },
        visibleToCustomer: false,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });
    } catch { /* best-effort */ }
    throw new NdaPdfServiceError('sha256 mismatch');
  }

  // Disk + DB phase. Mirrors documentsService.uploadForCustomer's
  // pre-flight + locked recheck, but inlined here so the document.uploaded
  // audit can be written with visible_to_customer=FALSE — drafts must
  // not leak to the customer activity feed. We also write the bytes to
  // disk BEFORE opening the tx (matches M6 ordering: rename a tempfile
  // into place, then commit; if the tx fails, unlink the orphan).
  const documentId = uuidv7();
  const customerDir = await ensureCustomerDir(customer.id);
  const finalPath = `${customerDir}/${documentId}.pdf`;
  const tempPath = `${customerDir}/.tmp-${documentId}`;

  await fsp.writeFile(tempPath, pdfResult.pdf, { mode: 0o640 });
  try {
    await fsp.rename(tempPath, finalPath);
  } catch (err) {
    await unlinkSafe(tempPath);
    throw err;
  }

  const sizeBytes = pdfResult.pdf.length;
  const ndaId = uuidv7();

  try {
    await db.transaction().execute(async (tx) => {
      // Re-verify under FOR UPDATE: the customer may have been suspended
      // between the pre-check and now.
      const lock = await sql`
        SELECT id, status FROM customers
         WHERE id = ${customer.id}::uuid FOR UPDATE
      `.execute(tx);
      if (lock.rows.length === 0 || lock.rows[0].status !== 'active') {
        throw new Error('customer no longer active');
      }
      const lockedBytes = await customerStorageBytes(tx, customer.id);
      assertCustomerQuota(lockedBytes, sizeBytes);

      await insertDocument(tx, {
        id: documentId,
        customerId: customer.id,
        projectId: project.id,
        category: 'nda-draft',
        storagePath: finalPath,
        originalFilename: `nda-draft-${ndaId.slice(0, 8)}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes,
        sha256: localSha,
        uploadedByAdminId: adminId,
      });

      await repo.insertNda(tx, {
        id: ndaId,
        customerId: customer.id,
        projectId: project.id,
        draftDocumentId: documentId,
        templateVersionSha,
        generatedByAdminId: adminId,
      });

      const a = baseAudit(ctx);
      // Draft is admin-only — visible_to_customer=FALSE on every step.
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'document.uploaded',
        targetType: 'document',
        targetId: documentId,
        metadata: {
          ...a.metadata,
          customerId: customer.id,
          projectId: project.id,
          category: 'nda-draft',
          sizeBytes,
          mimeType: 'application/pdf',
        },
        visibleToCustomer: false,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'nda.draft_generated',
        targetType: 'nda',
        targetId: ndaId,
        metadata: {
          ...a.metadata,
          customerId: customer.id,
          projectId: project.id,
          draftDocumentId: documentId,
          templateVersionSha,
        },
        visibleToCustomer: false,
        ip: a.ip,
        userAgentHash: a.userAgentHash,
      });
    });
  } catch (err) {
    await unlinkSafe(finalPath);
    throw err;
  }

  return {
    ndaId,
    draftDocumentId: documentId,
    templateVersionSha,
    sizeBytes,
  };
}

// Re-exported so route layer doesn't need to know about lib/nda.js.
export { NDA_PLACEHOLDERS };
export const findNdaById = repo.findNdaById;
export const findNdaWithDocs = repo.findNdaWithDocs;
export const listNdasForAdmin = repo.listNdasForAdmin;
export const listNdasForCustomer = repo.listNdasForCustomer;

// M8 Task 8.5 — signed NDA + audit-trail upload, linked back to the
// draft via the ndas row.
//
// The upload itself goes through documentsService.uploadForCustomer
// (M6 pipeline: streams + magic-byte sniff + sha + atomic rename + the
// document.uploaded audit visible_to_customer=true). We then run a
// short follow-up tx that:
//   - asserts the NDA exists and the slot we're filling is empty
//   - asserts the new document belongs to the same customer + has the
//     expected category (defence in depth on top of the FK)
//   - sets ndas.{signed,audit}_document_id
//   - writes the milestone audit visible_to_customer=true so the
//     customer activity feed shows "signed NDA available".
//
// If the route-level upload commits but this follow-up fails, the
// document remains on disk + in the documents table as the right
// category but unattached. The admin sees it via the documents list
// and can retry the attach manually. Acceptable v1 trade-off — the
// alternative (inlining all of uploadForCustomer here so it shares one
// tx) duplicates the M6 streaming pipeline for marginal benefit.

export class NdaNotFoundError extends Error {
  constructor(id) {
    super(`nda ${id} not found`);
    this.name = 'NdaNotFoundError';
    this.code = 'NDA_NOT_FOUND';
    this.status = 404;
  }
}
export class NdaSlotAlreadyFilledError extends Error {
  constructor(slot) {
    super(`nda ${slot} already attached`);
    this.name = 'NdaSlotAlreadyFilledError';
    this.code = 'NDA_SLOT_FILLED';
    this.status = 409;
    this.slot = slot;
  }
}
export class NdaCrossCustomerError extends Error {
  constructor() {
    super('document does not belong to this NDA\'s customer');
    this.name = 'NdaCrossCustomerError';
    this.code = 'NDA_CROSS_CUSTOMER';
    this.status = 403;
  }
}
export class NdaCategoryMismatchError extends Error {
  constructor(expected, actual) {
    super(`document has category '${actual}', expected '${expected}'`);
    this.name = 'NdaCategoryMismatchError';
    this.code = 'NDA_CATEGORY_MISMATCH';
    this.status = 422;
    this.expected = expected;
    this.actual = actual;
  }
}

async function loadNdaForAttach(tx, ndaId) {
  const r = await sql`
    SELECT id, customer_id, project_id, draft_document_id,
           signed_document_id, audit_document_id, template_version_sha
      FROM ndas WHERE id = ${ndaId}::uuid FOR UPDATE
  `.execute(tx);
  if (r.rows.length === 0) throw new NdaNotFoundError(ndaId);
  return r.rows[0];
}

async function loadDocumentForAttach(tx, documentId) {
  const r = await sql`
    SELECT id, customer_id, category
      FROM documents WHERE id = ${documentId}::uuid
  `.execute(tx);
  if (r.rows.length === 0) {
    throw new Error(`document ${documentId} not found (post-upload disappearance)`);
  }
  return r.rows[0];
}

// kind ∈ {'signed', 'audit'}.
const KIND_TO_CATEGORY = { signed: 'nda-signed', audit: 'nda-audit' };
const KIND_TO_AUDIT_ACTION = {
  signed: 'nda.signed_uploaded',
  audit: 'nda.audit_trail_uploaded',
};
const KIND_TO_SLOT_COL = {
  signed: 'signed_document_id',
  audit: 'audit_document_id',
};

export async function attachUploadedDocument(db, {
  adminId, ndaId, documentId, kind,
}, ctx = {}) {
  if (!Object.prototype.hasOwnProperty.call(KIND_TO_CATEGORY, kind)) {
    throw new Error(`attachUploadedDocument: unknown kind '${kind}'`);
  }
  return await db.transaction().execute(async (tx) => {
    const nda = await loadNdaForAttach(tx, ndaId);
    if (kind === 'signed' && nda.signed_document_id) {
      throw new NdaSlotAlreadyFilledError('signed');
    }
    if (kind === 'audit' && nda.audit_document_id) {
      throw new NdaSlotAlreadyFilledError('audit');
    }
    const doc = await loadDocumentForAttach(tx, documentId);
    if (doc.customer_id !== nda.customer_id) throw new NdaCrossCustomerError();
    if (doc.category !== KIND_TO_CATEGORY[kind]) {
      throw new NdaCategoryMismatchError(KIND_TO_CATEGORY[kind], doc.category);
    }

    if (kind === 'signed') {
      await sql`UPDATE ndas SET signed_document_id = ${documentId}::uuid WHERE id = ${ndaId}::uuid`.execute(tx);
    } else {
      await sql`UPDATE ndas SET audit_document_id = ${documentId}::uuid WHERE id = ${ndaId}::uuid`.execute(tx);
    }

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: KIND_TO_AUDIT_ACTION[kind],
      targetType: 'nda',
      targetId: ndaId,
      metadata: {
        ...a.metadata,
        customerId: nda.customer_id,
        projectId: nda.project_id,
        documentId,
        slot: KIND_TO_SLOT_COL[kind],
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { ndaId, slot: KIND_TO_SLOT_COL[kind], documentId };
  });
}
