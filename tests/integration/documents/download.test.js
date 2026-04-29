import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'kysely';
import { Readable } from 'node:stream';
import * as fsp from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import * as documentsService from '../../../domain/documents/service.js';
import { STORAGE_ROOT } from '../../../lib/files.js';
import { sign, signFileUrl } from '../../../lib/crypto/tokens.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `dl_test_${Date.now()}`;

function pdfBuffer(payload = 'test') {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from(`${payload}\n`),
    Buffer.from('%%EOF\n'),
  ]);
}
function streamOf(buf) { return Readable.from([buf]); }

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

describe.skipIf(skip)('documents download', () => {
  let app;
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
    return r;
  }

  async function uploadAdminDoc(customerId, payload = 'pl') {
    const buf = pdfBuffer(payload);
    const r = await documentsService.uploadForCustomer(db, {
      customerId,
      category: 'generic',
      originalFilename: 'doc.pdf',
      stream: streamOf(buf),
    }, baseCtx());
    return { ...r, buffer: buf };
  }

  async function loginAdminFully(suffix, password = 'admin-pw-928374-strong') {
    const created = await adminsService.create(db, {
      email: `${tag}+adm-${suffix}@example.com`, name: `Admin ${suffix}`,
    }, { actorType: 'system', audit: { tag } });
    const enrolSecret = deriveEnrolSecret(created.inviteToken, env.SESSION_SIGNING_SECRET);
    await adminsService.consumeInvite(db, {
      token: created.inviteToken, newPassword: password,
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
      payload: `email=${encodeURIComponent(`${tag}+adm-${suffix}@example.com`)}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(lCsrf)}`,
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

  // Drives a customer from invite straight to a stepped-up session by
  // calling completeCustomerWelcome directly and seating its returned sid
  // as the session cookie. Far simpler than driving the multi-step UI.
  async function loginCustomerFully(customerId, primaryUserEmail, inviteToken) {
    // Re-use service.completeCustomerWelcome which mints the session in tx.
    const totpSecret = 'JBSWY3DPEHPK3PXP'; // base32 placeholder
    const r = await customersService.completeCustomerWelcome(db, {
      token: inviteToken,
      newPassword: 'customer-pw-928374-strong',
      totpSecret,
      kek,
      sessionIp: '198.51.100.7',
      sessionDeviceFingerprint: null,
    }, { hibpHasBeenPwned: vi.fn(async () => false), audit: { tag } });

    // Seat the sid as the session cookie. @fastify/cookie was registered
    // with the SESSION_SIGNING_SECRET in build(), so app.signCookie()
    // produces the same signed string the server would set with
    // setSessionCookie().
    const signed = app.signCookie(r.sid);
    return { jar: { sid: signed }, customerUserId: r.customerUserId };
  }

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    kek = randomBytes(32);
    app = await build({ skipSafetyCheck: true, kek });
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await sql`DELETE FROM download_token_consumptions WHERE document_id IN (
      SELECT id FROM documents WHERE customer_id IN (
        SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
      )
    )`.execute(db);
    for (const cid of createdCustomerIds) {
      await fsp.rm(`${STORAGE_ROOT}/${cid}`, { recursive: true, force: true });
    }
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (
      SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}
      UNION SELECT id FROM admins WHERE email LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    for (const cid of createdCustomerIds) {
      await fsp.rm(`${STORAGE_ROOT}/${cid}`, { recursive: true, force: true });
    }
    createdCustomerIds = [];
    await sql`DELETE FROM download_token_consumptions WHERE expires_at < now() + interval '1 day'`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (
      SELECT id FROM customer_users WHERE email LIKE ${tag + '%'}
      UNION SELECT id FROM admins WHERE email LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql.raw('ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify').execute(db);
    await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
    await sql.raw('ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify').execute(db);
  });

  describe('GET /files/:token', () => {
    it('streams the file bytes on a fresh, valid token', async () => {
      const cust = await makeCustomer('files-fresh');
      const doc = await uploadAdminDoc(cust.customerId);
      const token = signFileUrl({ fileId: doc.documentId }, env.FILE_URL_SIGNING_SECRET);

      const r = await app.inject({ method: 'GET', url: `/files/${token}` });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('application/pdf');
      expect(Buffer.from(r.rawPayload).equals(doc.buffer)).toBe(true);
    });

    it('rejects a replay (second GET on the same token) with 410 Gone', async () => {
      const cust = await makeCustomer('files-replay');
      const doc = await uploadAdminDoc(cust.customerId);
      const token = signFileUrl({ fileId: doc.documentId }, env.FILE_URL_SIGNING_SECRET);

      const r1 = await app.inject({ method: 'GET', url: `/files/${token}` });
      expect(r1.statusCode).toBe(200);
      const r2 = await app.inject({ method: 'GET', url: `/files/${token}` });
      expect(r2.statusCode).toBe(410);
    });

    it('rejects a tampered MAC with 400', async () => {
      const cust = await makeCustomer('files-tamper');
      const doc = await uploadAdminDoc(cust.customerId);
      const token = signFileUrl({ fileId: doc.documentId }, env.FILE_URL_SIGNING_SECRET);
      const bad = token.slice(0, -2) + 'xx';

      const r = await app.inject({ method: 'GET', url: `/files/${bad}` });
      expect(r.statusCode).toBe(400);
    });

    it('rejects an expired token with 410', async () => {
      const cust = await makeCustomer('files-expired');
      const doc = await uploadAdminDoc(cust.customerId);
      // Hand-roll an expired token using the underlying sign() so the
      // 60s TTL guard inside signFileUrl is bypassed for the fixture.
      const stale = sign({ fileId: doc.documentId, kind: 'file' },
        env.FILE_URL_SIGNING_SECRET, { expSeconds: -1 });

      const r = await app.inject({ method: 'GET', url: `/files/${stale}` });
      expect(r.statusCode).toBe(410);
    });

    it('rejects a malformed token with 400', async () => {
      const r = await app.inject({ method: 'GET', url: '/files/this-is-not-a-token' });
      expect(r.statusCode).toBe(400);
    });

    it('rejects a token signed with a different secret with 400', async () => {
      const cust = await makeCustomer('files-wrongsec');
      const doc = await uploadAdminDoc(cust.customerId);
      const wrong = signFileUrl({ fileId: doc.documentId }, 'b'.repeat(64));

      const r = await app.inject({ method: 'GET', url: `/files/${wrong}` });
      expect(r.statusCode).toBe(400);
    });

    it('returns 500 + audits file_integrity_failure when the on-disk sha256 mismatches the row', async () => {
      const cust = await makeCustomer('files-corrupt');
      const doc = await uploadAdminDoc(cust.customerId);
      // Mutate one byte in the on-disk file. The documents.sha256 was
      // computed at upload, so bytes-on-disk no longer match.
      const orig = await fsp.readFile(doc.storagePath);
      const corrupt = Buffer.from(orig);
      corrupt[corrupt.length - 1] ^= 0xff;
      await fsp.writeFile(doc.storagePath, corrupt);

      const token = signFileUrl({ fileId: doc.documentId }, env.FILE_URL_SIGNING_SECRET);
      const r = await app.inject({ method: 'GET', url: `/files/${token}` });
      expect(r.statusCode).toBe(500);

      const audit = await sql`
        SELECT action, target_type, target_id
          FROM audit_log
         WHERE action = 'document.file_integrity_failure'
           AND target_id = ${doc.documentId}::uuid
      `.execute(db);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].target_type).toBe('document');
    });

    it('returns 410 when the token references a deleted document', async () => {
      const cust = await makeCustomer('files-deleted');
      const doc = await uploadAdminDoc(cust.customerId);
      const token = signFileUrl({ fileId: doc.documentId }, env.FILE_URL_SIGNING_SECRET);

      // Delete the document row. The download_token_consumptions FK
      // CASCADEs, so any prior consumption records vanish too.
      await sql`DELETE FROM documents WHERE id = ${doc.documentId}::uuid`.execute(db);
      const r = await app.inject({ method: 'GET', url: `/files/${token}` });
      expect(r.statusCode).toBe(410);
    });
  });

  describe('GET /admin/documents/:id/download', () => {
    it('redirects an authenticated admin to /files/<token>', async () => {
      const cust = await makeCustomer('admdl-happy');
      const doc = await uploadAdminDoc(cust.customerId);
      const jar = await loginAdminFully('admdl-happy');

      const r = await app.inject({
        method: 'GET',
        url: `/admin/documents/${doc.documentId}/download`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toMatch(/^\/files\/[A-Za-z0-9_.-]+$/);

      // Follow the redirect: the token issued must be valid and yield the
      // file bytes.
      const token = r.headers.location.slice('/files/'.length);
      const f = await app.inject({ method: 'GET', url: `/files/${token}` });
      expect(f.statusCode).toBe(200);
      expect(Buffer.from(f.rawPayload).equals(doc.buffer)).toBe(true);
    });

    it('redirects unauthenticated requests to /login', async () => {
      const cust = await makeCustomer('admdl-unauth');
      const doc = await uploadAdminDoc(cust.customerId);

      const r = await app.inject({
        method: 'GET',
        url: `/admin/documents/${doc.documentId}/download`,
      });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('/login');
    });

    it('returns 404 for an unknown document id', async () => {
      const jar = await loginAdminFully('admdl-ghost');
      const ghostId = uuidv7();

      const r = await app.inject({
        method: 'GET',
        url: `/admin/documents/${ghostId}/download`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(r.statusCode).toBe(404);
    });
  });

  describe('GET /customer/documents/:id/download', () => {
    it('redirects the document owner to /files/<token>', async () => {
      const cust = await makeCustomer('cdl-happy');
      const doc = await uploadAdminDoc(cust.customerId);
      const { jar } = await loginCustomerFully(cust.customerId, `${tag}+cdl-happy@example.com`, cust.inviteToken);

      const r = await app.inject({
        method: 'GET',
        url: `/customer/documents/${doc.documentId}/download`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toMatch(/^\/files\/[A-Za-z0-9_.-]+$/);
    });

    it('returns 403 when a customer tries to download another customer\'s doc', async () => {
      const owner = await makeCustomer('cdl-owner');
      const intruder = await makeCustomer('cdl-intruder');
      const ownerDoc = await uploadAdminDoc(owner.customerId);
      const { jar } = await loginCustomerFully(intruder.customerId, `${tag}+cdl-intruder@example.com`, intruder.inviteToken);

      const r = await app.inject({
        method: 'GET',
        url: `/customer/documents/${ownerDoc.documentId}/download`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(r.statusCode).toBe(403);
    });

    it('redirects unauthenticated customer requests to /', async () => {
      const cust = await makeCustomer('cdl-unauth');
      const doc = await uploadAdminDoc(cust.customerId);
      const r = await app.inject({
        method: 'GET',
        url: `/customer/documents/${doc.documentId}/download`,
      });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('/');
    });

    it('returns 404 for an unknown document id', async () => {
      const cust = await makeCustomer('cdl-ghost');
      const { jar } = await loginCustomerFully(cust.customerId, `${tag}+cdl-ghost@example.com`, cust.inviteToken);
      const ghostId = uuidv7();

      const r = await app.inject({
        method: 'GET',
        url: `/customer/documents/${ghostId}/download`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(r.statusCode).toBe(404);
    });
  });
});
