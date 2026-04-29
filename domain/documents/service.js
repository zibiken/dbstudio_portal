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
} from '../../lib/files.js';
import { insertDocument, customerStorageBytes } from './repo.js';

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
async function streamToTemp(source, destPath) {
  const hash = createHash('sha256');
  let bytes = 0;
  let sniffChunks = [];
  let sniffBytes = 0;

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
  if (!ALLOWED_CATEGORIES.has(category)) {
    throw new Error(`upload: invalid category '${category}'`);
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
          category,
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
            category,
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
