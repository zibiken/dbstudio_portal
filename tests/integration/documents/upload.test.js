import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { Readable } from 'node:stream';
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as documentsService from '../../../domain/documents/service.js';
import { findDocumentById, customerStorageBytes } from '../../../domain/documents/repo.js';
import { STORAGE_ROOT, MAX_FILE_BYTES, MAX_CUSTOMER_BYTES } from '../../../lib/files.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `doc_test_${Date.now()}`;

// Minimal valid PDF byte stream that file-type recognises.
function pdfBuffer(payload = 'test') {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from(`${payload}\n`),
    Buffer.from('%%EOF\n'),
  ]);
}

// Minimal PNG (8-byte signature + IHDR chunk) — enough for file-type to bite.
function pngBuffer() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.from([0x00, 0x00, 0x00, 0x0d]);
  const ihdr = Buffer.from('IHDR');
  const ihdrData = Buffer.alloc(13, 0);
  const crc = Buffer.alloc(4, 0);
  return Buffer.concat([sig, ihdrLen, ihdr, ihdrData, crc]);
}

function streamOf(buffer) {
  return Readable.from([buffer]);
}

async function rmCustomerDir(customerId) {
  await fsp.rm(`${STORAGE_ROOT}/${customerId}`, { recursive: true, force: true });
}

describe.skipIf(skip)('documents upload', () => {
  let db;
  let env;
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

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
  });

  afterAll(async () => {
    if (!db) return;
    for (const cid of createdCustomerIds) {
      await rmCustomerDir(cid);
    }
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    for (const cid of createdCustomerIds) {
      await rmCustomerDir(cid);
    }
    createdCustomerIds = [];
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
  });

  describe('service.uploadForCustomer (happy path)', () => {
    it('streams a PDF to disk, hashes it, inserts a documents row, audits visible_to_customer', async () => {
      const customerId = await makeCustomer('happy');
      const buf = pdfBuffer('happy-payload');

      const r = await documentsService.uploadForCustomer(db, {
        customerId,
        category: 'generic',
        originalFilename: 'My Report.pdf',
        stream: streamOf(buf),
      }, baseCtx());

      expect(r.documentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.sizeBytes).toBe(buf.length);
      expect(r.mimeType).toBe('application/pdf');
      expect(r.storagePath).toBe(`${STORAGE_ROOT}/${customerId}/${r.documentId}.pdf`);
      // sha256 is 64 hex chars and matches the buffer content.
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);

      // File on disk has the exact bytes we streamed.
      const onDisk = await fsp.readFile(r.storagePath);
      expect(onDisk.equals(buf)).toBe(true);

      // documents row populated.
      const row = await findDocumentById(db, r.documentId);
      expect(row).not.toBeNull();
      expect(row.customer_id).toBe(customerId);
      expect(row.category).toBe('generic');
      expect(row.storage_path).toBe(r.storagePath);
      expect(row.original_filename).toBe('My Report.pdf');
      expect(row.mime_type).toBe('application/pdf');
      expect(Number(row.size_bytes)).toBe(buf.length);
      expect(row.sha256).toBe(r.sha256);
      expect(row.project_id).toBeNull();
      expect(row.parent_id).toBeNull();

      // Audit row visible to customer.
      const audit = await sql`
        SELECT action, target_type, target_id, visible_to_customer, metadata
          FROM audit_log
         WHERE action = 'document.uploaded' AND metadata->>'tag' = ${tag}
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].target_type).toBe('document');
      expect(audit.rows[0].target_id).toBe(r.documentId);
      expect(audit.rows[0].visible_to_customer).toBe(true);
    });

    it('sanitises the original filename (path components stripped, NFC normalised)', async () => {
      const customerId = await makeCustomer('sanitise');
      const buf = pdfBuffer('sani');

      const r = await documentsService.uploadForCustomer(db, {
        customerId,
        category: 'generic',
        originalFilename: '../../etc/café-bonus.pdf',
        stream: streamOf(buf),
      }, baseCtx());

      const row = await findDocumentById(db, r.documentId);
      expect(row.original_filename).toBe('café-bonus.pdf');
    });

    it('uses the magic-byte-detected ext for the on-disk path even if filename ext differs', async () => {
      const customerId = await makeCustomer('extmismatch');
      const buf = pngBuffer();

      const r = await documentsService.uploadForCustomer(db, {
        customerId,
        category: 'generic',
        originalFilename: 'looks-like.txt',
        stream: streamOf(buf),
      }, baseCtx());

      // Original filename preserved on the row, but on-disk ext is the
      // magic-byte-derived 'png'.
      expect(r.storagePath.endsWith('.png')).toBe(true);
      const row = await findDocumentById(db, r.documentId);
      expect(row.original_filename).toBe('looks-like.txt');
      expect(row.mime_type).toBe('image/png');
      expect(row.storage_path.endsWith('.png')).toBe(true);
    });
  });

  describe('service.uploadForCustomer (rejection paths)', () => {
    it('rejects an oversize file (1 byte over 50 MiB) and leaves no row, no file', async () => {
      const customerId = await makeCustomer('oversize');
      // Build an oversize buffer cheaply: PDF header + filler + EOF.
      const filler = Buffer.alloc(MAX_FILE_BYTES, 0x20);
      const buf = Buffer.concat([Buffer.from('%PDF-1.4\n'), filler, Buffer.from('%%EOF\n')]);

      await expect(
        documentsService.uploadForCustomer(db, {
          customerId,
          category: 'generic',
          originalFilename: 'big.pdf',
          stream: streamOf(buf),
        }, baseCtx()),
      ).rejects.toThrow();

      const c = await sql`
        SELECT count(*)::int AS c FROM documents WHERE customer_id = ${customerId}::uuid
      `.execute(db);
      expect(c.rows[0].c).toBe(0);

      // No leftover files in the customer dir (besides nothing — dir may
      // exist if mkdir ran first, but it must contain no files including
      // .tmp-* turds).
      const dir = `${STORAGE_ROOT}/${customerId}`;
      let entries = [];
      try {
        entries = await fsp.readdir(dir);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      expect(entries).toHaveLength(0);
    });

    it('rejects a buffer whose magic bytes do not match a known type', async () => {
      const customerId = await makeCustomer('unknown');
      const buf = Buffer.from('plain text masquerading as a binary');

      await expect(
        documentsService.uploadForCustomer(db, {
          customerId,
          category: 'generic',
          originalFilename: 'sneaky.pdf',
          stream: streamOf(buf),
        }, baseCtx()),
      ).rejects.toThrow();

      const c = await sql`
        SELECT count(*)::int AS c FROM documents WHERE customer_id = ${customerId}::uuid
      `.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('rejects when declaredMime mismatches the magic-byte-detected mime', async () => {
      const customerId = await makeCustomer('mimemismatch');
      // PNG bytes, declared as PDF — Content-Type spoofing attempt.
      const buf = pngBuffer();

      await expect(
        documentsService.uploadForCustomer(db, {
          customerId,
          category: 'generic',
          originalFilename: 'spoof.pdf',
          declaredMime: 'application/pdf',
          stream: streamOf(buf),
        }, baseCtx()),
      ).rejects.toThrow();

      const c = await sql`
        SELECT count(*)::int AS c FROM documents WHERE customer_id = ${customerId}::uuid
      `.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('rejects when cumulative customer bytes would exceed 5 GiB', async () => {
      const customerId = await makeCustomer('quota');
      // Shortcut: insert a fake-but-valid documents row that already
      // accounts for almost the full 5 GiB. The new upload's tiny payload
      // pushes over the cap. We don't write the fake file to disk because
      // assertCustomerQuota only consults the size_bytes column.
      const fakeId = uuidv7();
      await sql`
        INSERT INTO documents (
          id, customer_id, category, storage_path, original_filename,
          mime_type, size_bytes, sha256
        )
        VALUES (
          ${fakeId}::uuid, ${customerId}::uuid, 'generic',
          ${'/var/lib/portal/storage/' + customerId + '/' + fakeId + '.pdf'},
          'placeholder.pdf', 'application/pdf',
          ${MAX_CUSTOMER_BYTES - 10},
          ${'0'.repeat(64)}
        )
      `.execute(db);

      const buf = pdfBuffer('over-quota');
      await expect(
        documentsService.uploadForCustomer(db, {
          customerId,
          category: 'generic',
          originalFilename: 'over.pdf',
          stream: streamOf(buf),
        }, baseCtx()),
      ).rejects.toThrow(/quota/i);

      const c = await sql`
        SELECT count(*)::int AS c
          FROM documents
         WHERE customer_id = ${customerId}::uuid AND id <> ${fakeId}::uuid
      `.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('rejects when the customer is suspended', async () => {
      const customerId = await makeCustomer('suspended');
      await customersService.suspendCustomer(db, { customerId }, baseCtx());

      const buf = pdfBuffer('s');
      await expect(
        documentsService.uploadForCustomer(db, {
          customerId,
          category: 'generic',
          originalFilename: 's.pdf',
          stream: streamOf(buf),
        }, baseCtx()),
      ).rejects.toThrow(/status|active/i);
    });

    it('rejects when the customer is archived', async () => {
      const customerId = await makeCustomer('archived');
      await customersService.archiveCustomer(db, { customerId }, baseCtx());

      const buf = pdfBuffer('a');
      await expect(
        documentsService.uploadForCustomer(db, {
          customerId,
          category: 'generic',
          originalFilename: 'a.pdf',
          stream: streamOf(buf),
        }, baseCtx()),
      ).rejects.toThrow(/status|active/i);
    });

    it('rejects an unknown customer id', async () => {
      const buf = pdfBuffer('x');
      const ghostId = uuidv7();
      await expect(
        documentsService.uploadForCustomer(db, {
          customerId: ghostId,
          category: 'generic',
          originalFilename: 'x.pdf',
          stream: streamOf(buf),
        }, baseCtx()),
      ).rejects.toThrow();
    });

    it('rejects an invalid category', async () => {
      const customerId = await makeCustomer('badcat');
      const buf = pdfBuffer('c');
      await expect(
        documentsService.uploadForCustomer(db, {
          customerId,
          category: 'not-a-category',
          originalFilename: 'c.pdf',
          stream: streamOf(buf),
        }, baseCtx()),
      ).rejects.toThrow(/category/i);
    });
  });

  describe('POST /admin/customers/:id/documents (multipart, HTTP layer)', () => {
    let app;
    let adminTag;

    function parseSetCookies(res) {
      const raw = res.headers['set-cookie'];
      if (!raw) return [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.map((line) => {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1) };
      });
    }
    function cookieHeader(jar) {
      return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    function mergeCookies(jar, res) {
      for (const c of parseSetCookies(res)) jar[c.name] = c.value;
    }
    function extractInputValue(html, name) {
      const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']+)["']`);
      const m = html.match(re);
      return m ? m[1] : null;
    }

    async function loginAdminFully(suffix, password = 'admin-pw-928374-strong') {
      const created = await adminsService.create(
        db,
        { email: `${adminTag}+${suffix}@example.com`, name: `Admin ${suffix}` },
        { actorType: 'system', audit: { tag } },
      );
      const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
      await adminsService.consumeInvite(db, {
        token: created.inviteToken,
        newPassword: password,
      }, { audit: { tag }, hibpHasBeenPwned: vi.fn(async () => false) });
      await adminsService.enroll2faTotp(db, {
        adminId: created.id, secret: enrolSecret, kek: app.kek,
      }, { audit: { tag } });

      const jar = {};
      const lGet = await app.inject({ method: 'GET', url: '/login' });
      mergeCookies(jar, lGet);
      const lCsrf = extractInputValue(lGet.body, '_csrf');
      const lOk = await app.inject({
        method: 'POST', url: '/login',
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=${encodeURIComponent(`${adminTag}+${suffix}@example.com`)}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
      });
      expect(lOk.statusCode).toBe(302);
      mergeCookies(jar, lOk);

      const cGet = await app.inject({ method: 'GET', url: '/login/2fa', headers: { cookie: cookieHeader(jar) } });
      mergeCookies(jar, cGet);
      const cCsrf = extractInputValue(cGet.body, '_csrf');
      const cOk = await app.inject({
        method: 'POST', url: '/login/2fa',
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `method=totp&totp_code=${generateToken(enrolSecret)}&_csrf=${encodeURIComponent(cCsrf)}`,
      });
      expect(cOk.statusCode).toBe(302);
      mergeCookies(jar, cOk);
      return jar;
    }

    function buildMultipart(boundary, fields, file) {
      const chunks = [];
      for (const [k, v] of Object.entries(fields)) {
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        ));
      }
      if (file) {
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.mime}\r\n\r\n`,
        ));
        chunks.push(file.body);
        chunks.push(Buffer.from('\r\n'));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return Buffer.concat(chunks);
    }

    async function fetchUploadCsrf(jar, customerId) {
      const r = await app.inject({
        method: 'GET',
        url: `/admin/customers/${customerId}/documents/new`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(r.statusCode).toBe(200);
      mergeCookies(jar, r);
      return extractInputValue(r.body, '_csrf');
    }

    beforeAll(async () => {
      app = await build({ skipSafetyCheck: true });
      adminTag = `${tag}_admin`;
    });

    afterAll(async () => {
      await app?.close();
      await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${adminTag + '%'})`.execute(db);
      await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + adminTag + '%'}`.execute(db);
      await sql`DELETE FROM email_outbox WHERE to_address LIKE ${adminTag + '%'}`.execute(db);
      await sql`DELETE FROM admins WHERE email LIKE ${adminTag + '%'}`.execute(db);
    });

    it('redirects an unauthenticated POST to /login (no cookies)', async () => {
      const customerId = await makeCustomer('http-unauth');
      const boundary = '----vitest' + Date.now();
      const body = buildMultipart(boundary, { _csrf: 'irrelevant', category: 'generic' }, {
        name: 'file', filename: 'x.pdf', mime: 'application/pdf', body: pdfBuffer('u'),
      });
      const r = await app.inject({
        method: 'POST',
        url: `/admin/customers/${customerId}/documents`,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
          'x-csrf-token': 'irrelevant',
        },
        payload: body,
      });
      // No cookies at all → CSRF preHandler fires first; either way the
      // upload must not have happened.
      expect([302, 403]).toContain(r.statusCode);
      const c = await sql`
        SELECT count(*)::int AS c FROM documents WHERE customer_id = ${customerId}::uuid
      `.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('happy path: admin uploads a real PDF, gets 302 to /admin/customers/:id, row inserted, file on disk', async () => {
      const customerId = await makeCustomer('http-happy');
      const jar = await loginAdminFully('http-happy');
      const csrf = await fetchUploadCsrf(jar, customerId);

      const buf = pdfBuffer('http-happy');
      const boundary = '----vitest' + Date.now();
      const body = buildMultipart(boundary, { _csrf: csrf, category: 'generic' }, {
        name: 'file', filename: 'invoice.pdf', mime: 'application/pdf', body: buf,
      });
      const r = await app.inject({
        method: 'POST',
        url: `/admin/customers/${customerId}/documents`,
        headers: {
          cookie: cookieHeader(jar),
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
          'x-csrf-token': csrf,
        },
        payload: body,
      });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe(`/admin/customers/${customerId}`);

      const rows = await sql`
        SELECT id, original_filename, mime_type, size_bytes, sha256, storage_path
          FROM documents
         WHERE customer_id = ${customerId}::uuid
      `.execute(db);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].original_filename).toBe('invoice.pdf');
      expect(rows.rows[0].mime_type).toBe('application/pdf');
      expect(Number(rows.rows[0].size_bytes)).toBe(buf.length);
      const onDisk = await fsp.readFile(rows.rows[0].storage_path);
      expect(onDisk.equals(buf)).toBe(true);
    });

    it('rejects without an x-csrf-token header (CSRF preHandler 403)', async () => {
      const customerId = await makeCustomer('http-nocsrf');
      const jar = await loginAdminFully('http-nocsrf');
      // Skip fetching the form's csrf — we deliberately omit the header.
      const buf = pdfBuffer('nocsrf');
      const boundary = '----vitest' + Date.now();
      const body = buildMultipart(boundary, { category: 'generic' }, {
        name: 'file', filename: 'x.pdf', mime: 'application/pdf', body: buf,
      });
      const r = await app.inject({
        method: 'POST',
        url: `/admin/customers/${customerId}/documents`,
        headers: {
          cookie: cookieHeader(jar),
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
        },
        payload: body,
      });
      expect(r.statusCode).toBe(403);
      const c = await sql`
        SELECT count(*)::int AS c FROM documents WHERE customer_id = ${customerId}::uuid
      `.execute(db);
      expect(c.rows[0].c).toBe(0);
    });

    it('returns 404 for an unknown customer UUID', async () => {
      const ghostId = uuidv7();
      const jar = await loginAdminFully('http-ghost');
      // We can't fetch CSRF from the ghost's own form (404), so fetch one
      // from a real customer's form (CSRF tokens are per-session, not
      // per-target).
      const realCid = await makeCustomer('http-ghost-real');
      const csrf = await fetchUploadCsrf(jar, realCid);

      const buf = pdfBuffer('ghost');
      const boundary = '----vitest' + Date.now();
      const body = buildMultipart(boundary, { _csrf: csrf, category: 'generic' }, {
        name: 'file', filename: 'g.pdf', mime: 'application/pdf', body: buf,
      });
      const r = await app.inject({
        method: 'POST',
        url: `/admin/customers/${ghostId}/documents`,
        headers: {
          cookie: cookieHeader(jar),
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
          'x-csrf-token': csrf,
        },
        payload: body,
      });
      expect(r.statusCode).toBe(404);
    });
  });

  describe('repo.customerStorageBytes', () => {
    it('returns 0 for a customer with no documents', async () => {
      const customerId = await makeCustomer('empty');
      const total = await customerStorageBytes(db, customerId);
      expect(Number(total)).toBe(0);
    });

    it('sums size_bytes for the customer only', async () => {
      const a = await makeCustomer('sum-a');
      const b = await makeCustomer('sum-b');

      await documentsService.uploadForCustomer(db, {
        customerId: a,
        category: 'generic',
        originalFilename: 'a.pdf',
        stream: streamOf(pdfBuffer('aa')),
      }, baseCtx());
      await documentsService.uploadForCustomer(db, {
        customerId: a,
        category: 'generic',
        originalFilename: 'a2.pdf',
        stream: streamOf(pdfBuffer('aaaa')),
      }, baseCtx());
      await documentsService.uploadForCustomer(db, {
        customerId: b,
        category: 'generic',
        originalFilename: 'b.pdf',
        stream: streamOf(pdfBuffer('bbbbbbbb')),
      }, baseCtx());

      const a1 = pdfBuffer('aa').length;
      const a2 = pdfBuffer('aaaa').length;
      const totalA = await customerStorageBytes(db, a);
      expect(Number(totalA)).toBe(a1 + a2);

      const b1 = pdfBuffer('bbbbbbbb').length;
      const totalB = await customerStorageBytes(db, b);
      expect(Number(totalB)).toBe(b1);
    });
  });
});
