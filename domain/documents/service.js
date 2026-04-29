import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { writeAudit } from '../../lib/audit.js';
import {
  STORAGE_ROOT,
  storagePath,
  safeFilename,
  assertSize,
  assertCustomerQuota,
  mimeFromMagic,
  verifyDownloadToken,
} from '../../lib/files.js';
import { insertDocument, customerStorageBytes, findDocumentById } from './repo.js';

const ALLOWED_CATEGORIES = new Set([
  'nda-draft', 'nda-signed', 'nda-audit', 'invoice', 'generic',
]);
const MIME_SNIFF_BYTES = 4100; // file-type's recommended sample window

async function ensureCustomerDir(customerId) {
  const dir = `${STORAGE_ROOT}/${customerId}`;
  await fsp.mkdir(dir, { mode: 0o750, recursive: true });
  return dir;
}

async function unlinkSafe(path) {
  try { await fsp.unlink(path); } catch { /* already gone */ }
}

// Streams `source` to `destPath` while computing sha256, counting bytes,
// and capturing the first MIME_SNIFF_BYTES into a sample buffer.
//
// `truncated` is set to true when busboy's fileSizeLimit fired during the
// pipeline. Catching this is C1 from the M6 review: without the check,
// an oversize multipart upload silently truncates at exactly
// MAX_FILE_BYTES, the Transform observer hashes the truncated bytes,
// assertSize(MAX_FILE_BYTES) passes inclusively, magic bytes pass (the
// first 4 KiB of any oversize PDF look fine), and the tx commits a
// corrupt document with a sha256 of its truncated content. Customer
// downloads pass integrity (the row's sha256 was computed post-truncate),
// so M10's verification job never flags it. The detection has to happen
// at this stream layer; nothing else has visibility into busboy's flag.
async function streamToTemp(source, destPath) {
  const hash = createHash('sha256');
  let bytes = 0;
  let sniffChunks = [];
  let sniffBytes = 0;
  let limitFired = false;
  if (typeof source.on === 'function') {
    source.on('limit', () => { limitFired = true; });
  }

  const observer = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      if (sniffBytes < MIME_SNIFF_BYTES) {
        const need = MIME_SNIFF_BYTES - sniffBytes;
        const slice = chunk.length <= need ? chunk : chunk.subarray(0, need);
        sniffChunks.push(Buffer.from(slice));
        sniffBytes += slice.length;
      }
      cb(null, chunk);
    },
  });

  const out = createWriteStream(destPath, { mode: 0o640 });
  await pipeline(source, observer, out);

  return {
    sha256: hash.digest('hex'),
    sizeBytes: bytes,
    sniff: Buffer.concat(sniffChunks),
    truncated: limitFired || source?.truncated === true,
  };
}

async function lockActiveCustomer(tx, customerId) {
  const r = await sql`
    SELECT id, status FROM customers WHERE id = ${customerId}::uuid FOR UPDATE
  `.execute(tx);
  if (r.rows.length === 0) throw new Error(`customer ${customerId} not found`);
  if (r.rows[0].status !== 'active') {
    throw new Error(`cannot upload for customer in status '${r.rows[0].status}' — must be 'active'`);
  }
  return r.rows[0];
}

async function checkCustomerActive(db, customerId) {
  const r = await sql`SELECT status FROM customers WHERE id = ${customerId}::uuid`.execute(db);
  if (r.rows.length === 0) throw new Error(`customer ${customerId} not found`);
  if (r.rows[0].status !== 'active') {
    throw new Error(`cannot upload for customer in status '${r.rows[0].status}' — must be 'active'`);
  }
}

export async function uploadForCustomer(db, {
  customerId,
  projectId = null,
  parentId = null,
  category,
  originalFilename,
  declaredMime = null,
  stream,
}, ctx = {}) {
  // If a parent_id is provided, the new doc INHERITS the parent's
  // category — versioning is one document evolving over time, switching
  // categories mid-chain would be a footgun. Cross-customer parents
  // are rejected here (defence-in-depth on top of the FK constraint
  // which only verifies the parent exists, not who owns it).
  let resolvedCategory = category;
  if (parentId) {
    const parent = await findDocumentById(db, parentId);
    if (!parent) throw new Error(`upload: parent document ${parentId} not found`);
    if (parent.customer_id !== customerId) {
      throw new Error('upload: parent document belongs to a different customer');
    }
    resolvedCategory = parent.category;
  }
  if (!ALLOWED_CATEGORIES.has(resolvedCategory)) {
    throw new Error(`upload: invalid category '${resolvedCategory}'`);
  }
  // Pre-flight check: catches archived/suspended/missing before we touch
  // the disk. The transactional re-check below is the load-bearing gate.
  await checkCustomerActive(db, customerId);

  const cleanName = safeFilename(originalFilename);
  const documentId = uuidv7();
  const customerDir = await ensureCustomerDir(customerId);
  const tempPath = `${customerDir}/.tmp-${documentId}`;

  let streamed;
  try {
    streamed = await streamToTemp(stream, tempPath);
  } catch (err) {
    await unlinkSafe(tempPath);
    throw err;
  }

  let finalPath;
  try {
    if (streamed.truncated) {
      // busboy's transport-layer cap fired mid-pipeline. Reject before any
      // row or rename — see streamToTemp's comment on why post-tx detection
      // is too late.
      throw new Error('upload: file exceeded 50 MiB cap (multipart truncation)');
    }
    assertSize(streamed.sizeBytes);

    const sniffed = await mimeFromMagic(streamed.sniff);
    if (!sniffed) {
      throw new Error('upload: could not determine file type from magic bytes');
    }
    if (declaredMime && declaredMime !== sniffed.mime) {
      throw new Error(
        `upload: declared mime '${declaredMime}' does not match magic-byte mime '${sniffed.mime}'`,
      );
    }

    const currentBytes = await customerStorageBytes(db, customerId);
    assertCustomerQuota(currentBytes, streamed.sizeBytes);

    finalPath = storagePath(customerId, documentId, sniffed.ext);
    await fsp.rename(tempPath, finalPath);

    try {
      await db.transaction().execute(async (tx) => {
        // Re-verify under FOR UPDATE: the customer may have been suspended
        // between the pre-flight check and now. Also re-check quota inside
        // the lock to serialise concurrent uploads against the cap.
        await lockActiveCustomer(tx, customerId);
        const lockedBytes = await customerStorageBytes(tx, customerId);
        assertCustomerQuota(lockedBytes, streamed.sizeBytes);

        await insertDocument(tx, {
          id: documentId,
          customerId,
          projectId,
          parentId,
          category: resolvedCategory,
          storagePath: finalPath,
          originalFilename: cleanName,
          mimeType: sniffed.mime,
          sizeBytes: streamed.sizeBytes,
          sha256: streamed.sha256,
          uploadedByAdminId: ctx?.actorType === 'admin' ? ctx?.actorId ?? null : null,
        });

        await writeAudit(tx, {
          actorType: ctx?.actorType ?? 'system',
          actorId: ctx?.actorId ?? null,
          action: 'document.uploaded',
          targetType: 'document',
          targetId: documentId,
          metadata: {
            customerId,
            projectId,
            parentId,
            category: resolvedCategory,
            sizeBytes: streamed.sizeBytes,
            mimeType: sniffed.mime,
            ...(ctx?.audit ?? {}),
          },
          visibleToCustomer: true,
          ip: ctx?.ip ?? null,
          userAgentHash: ctx?.userAgentHash ?? null,
        });
      });
    } catch (err) {
      // Tx failed after the file was renamed into place. Best-effort
      // cleanup so we don't leave an orphan blob on disk.
      await unlinkSafe(finalPath);
      throw err;
    }

    return {
      documentId,
      sizeBytes: streamed.sizeBytes,
      mimeType: sniffed.mime,
      sha256: streamed.sha256,
      storagePath: finalPath,
    };
  } catch (err) {
    await unlinkSafe(tempPath);
    throw err;
  }
}

// Custom error classes so the route layer can map to HTTP status codes
// without leaking implementation details into callers.
export class TokenInvalidError extends Error {
  constructor(message) { super(message); this.name = 'TokenInvalidError'; this.status = 400; }
}
export class TokenExpiredError extends Error {
  constructor(message) { super(message); this.name = 'TokenExpiredError'; this.status = 410; }
}
export class TokenAlreadyConsumedError extends Error {
  constructor(message) { super(message); this.name = 'TokenAlreadyConsumedError'; this.status = 410; }
}
export class DocumentNotFoundError extends Error {
  constructor(message) { super(message); this.name = 'DocumentNotFoundError'; this.status = 410; }
}
export class IntegrityFailureError extends Error {
  constructor(message) { super(message); this.name = 'IntegrityFailureError'; this.status = 500; }
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Verifies a signed download token and atomically consumes it. Replays
// throw TokenAlreadyConsumedError; expired tokens throw TokenExpiredError;
// tokens that reference a no-longer-existing document throw
// DocumentNotFoundError (FK violation on INSERT). On success returns the
// documents row.
export async function consumeDownloadToken(db, { token, secret }) {
  let payload;
  try {
    payload = verifyDownloadToken(token, secret);
  } catch (err) {
    if (/expired/i.test(err.message)) throw new TokenExpiredError('token expired');
    throw new TokenInvalidError('invalid token');
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(payload.exp * 1000);

  try {
    await sql`
      INSERT INTO download_token_consumptions (token_hash, document_id, expires_at)
      VALUES (${tokenHash}, ${payload.fileId}::uuid, ${expiresAt})
    `.execute(db);
  } catch (err) {
    if (err.code === '23505') throw new TokenAlreadyConsumedError('token already consumed');
    if (err.code === '23503') throw new DocumentNotFoundError('document not found');
    throw err;
  }

  const doc = await findDocumentById(db, payload.fileId);
  if (!doc) throw new DocumentNotFoundError('document not found');
  return doc;
}

// Reads the document's bytes from disk, verifies the on-disk sha256 still
// matches the row, and returns the buffer. On mismatch writes a
// document.file_integrity_failure audit row and throws
// IntegrityFailureError so the caller can return 500.
//
// Buffer-then-send (rather than stream-with-late-hash) keeps the
// integrity verification BEFORE any byte goes to the client — at the
// cost of holding up to MAX_FILE_BYTES (50 MiB) in RAM per download.
// Acceptable v1 trade-off; spec §2.7 demands "if mismatch, abort with
// 500 + audit", which is incompatible with response bytes already
// flushed.
export async function readVerifiedDocumentBytes(db, doc, ctx = {}) {
  const buf = await fsp.readFile(doc.storage_path);
  const actual = sha256Hex(buf);
  if (actual !== doc.sha256) {
    // Audit-write may itself fail (DB unreachable, statement timeout,
    // append-only trigger reactivated mid-incident). The IntegrityFailureError
    // MUST throw regardless — corrupt bytes must NEVER reach the client even
    // if we can't record the forensic trail. The caller route catches
    // IntegrityFailureError and returns 500. The audit failure is logged via
    // ctx.log if provided so an operator can correlate; if no logger is wired
    // we still don't leak (the throw happens unconditionally).
    try {
      await writeAudit(db, {
        actorType: ctx?.actorType ?? 'system',
        actorId: ctx?.actorId ?? null,
        action: 'document.file_integrity_failure',
        targetType: 'document',
        targetId: doc.id,
        metadata: {
          customerId: doc.customer_id,
          expectedSha256: doc.sha256,
          actualSha256: actual,
          ...(ctx?.audit ?? {}),
        },
        visibleToCustomer: false,
        ip: ctx?.ip ?? null,
        userAgentHash: ctx?.userAgentHash ?? null,
      });
    } catch (auditErr) {
      if (typeof ctx?.log?.error === 'function') {
        ctx.log.error({ err: auditErr, docId: doc.id },
          'document.file_integrity_failure audit write failed; throwing 500 anyway');
      }
    }
    throw new IntegrityFailureError('on-disk sha256 does not match the documents row');
  }
  return buf;
}
