import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { Readable } from 'node:stream';
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as customersService from '../../../domain/customers/service.js';
import * as documentsService from '../../../domain/documents/service.js';
import {
  findDocumentById,
  listVersionChain,
} from '../../../domain/documents/repo.js';
import { STORAGE_ROOT } from '../../../lib/files.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `ver_test_${Date.now()}`;

function pdfBuffer(payload = 't') {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from(`${payload}\n`),
    Buffer.from('%%EOF\n'),
  ]);
}
function streamOf(b) { return Readable.from([b]); }

describe.skipIf(skip)('documents versions', () => {
  let db;
  let kek;
  let createdCustomerIds = [];

  const baseCtx = () => ({
    actorType: 'admin',
    actorId: null,
    ip: '198.51.100.7',
    userAgentHash: 'uahash',
    portalBaseUrl: 'https://portal.example.test/',
    audit: { tag },
    kek,
  });

  async function makeCustomer(suffix) {
    const r = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, baseCtx());
    createdCustomerIds.push(r.customerId);
    return r.customerId;
  }
  async function uploadDoc(customerId, { category = 'generic', parentId = null, payload = 'v' } = {}) {
    return await documentsService.uploadForCustomer(db, {
      customerId, category, parentId,
      originalFilename: 'doc.pdf',
      stream: streamOf(pdfBuffer(payload)),
    }, baseCtx());
  }

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    for (const cid of createdCustomerIds) {
      await fsp.rm(`${STORAGE_ROOT}/${cid}`, { recursive: true, force: true });
    }
    await sql`DELETE FROM download_token_consumptions WHERE document_id IN (
      SELECT id FROM documents WHERE customer_id IN (
        SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
      )
    )`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  beforeEach(async () => {
    for (const cid of createdCustomerIds) {
      await fsp.rm(`${STORAGE_ROOT}/${cid}`, { recursive: true, force: true });
    }
    createdCustomerIds = [];
    await sql`DELETE FROM download_token_consumptions WHERE document_id IN (
      SELECT id FROM documents WHERE customer_id IN (
        SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
      )
    )`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
  });

  it('a version-2 upload links via parent_id and inherits the parent category', async () => {
    const customerId = await makeCustomer('v2');
    const v1 = await uploadDoc(customerId, { category: 'invoice', payload: 'v1' });
    const v2 = await uploadDoc(customerId, {
      // Caller passes a DIFFERENT category — service must inherit the
      // parent's 'invoice' regardless. The contract is "the version chain
      // is one document evolving over time"; switching categories mid-chain
      // would be a footgun.
      category: 'generic',
      parentId: v1.documentId,
      payload: 'v2',
    });

    const v2row = await findDocumentById(db, v2.documentId);
    expect(v2row.parent_id).toBe(v1.documentId);
    expect(v2row.category).toBe('invoice');
  });

  it('a 3-deep chain walks via listVersionChain', async () => {
    const customerId = await makeCustomer('chain');
    const v1 = await uploadDoc(customerId, { category: 'nda-draft', payload: 'a' });
    const v2 = await uploadDoc(customerId, { parentId: v1.documentId, payload: 'b' });
    const v3 = await uploadDoc(customerId, { parentId: v2.documentId, payload: 'c' });

    const chain = await listVersionChain(db, v3.documentId);
    expect(chain.map(r => r.id)).toEqual([v1.documentId, v2.documentId, v3.documentId]);
    for (const r of chain) expect(r.category).toBe('nda-draft');
  });

  it('rejects a parent_id that does not exist', async () => {
    const customerId = await makeCustomer('parent-ghost');
    const ghostParent = uuidv7();
    await expect(uploadDoc(customerId, { parentId: ghostParent }))
      .rejects.toThrow(/parent/i);
  });

  it('rejects a parent_id owned by a different customer (cross-customer trap)', async () => {
    const a = await makeCustomer('parent-a');
    const b = await makeCustomer('parent-b');
    const aDoc = await uploadDoc(a, { payload: 'a-original' });

    await expect(uploadDoc(b, { parentId: aDoc.documentId }))
      .rejects.toThrow(/parent|customer/i);

    // Belt-and-braces: no document was created on customer B's side.
    const c = await sql`
      SELECT count(*)::int AS c FROM documents WHERE customer_id = ${b}::uuid
    `.execute(db);
    expect(c.rows[0].c).toBe(0);
  });

  it('listVersionChain on a single document returns just that document', async () => {
    const customerId = await makeCustomer('one');
    const v1 = await uploadDoc(customerId, { payload: 'lone' });
    const chain = await listVersionChain(db, v1.documentId);
    expect(chain).toHaveLength(1);
    expect(chain[0].id).toBe(v1.documentId);
  });
});
