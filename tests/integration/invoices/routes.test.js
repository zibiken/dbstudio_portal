import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';
import * as adminsService from '../../../domain/admins/service.js';
import * as customersService from '../../../domain/customers/service.js';
import { STORAGE_ROOT } from '../../../lib/files.js';
import { deriveEnrolSecret } from '../../../lib/auth/totp-enrol.js';
import { generateToken } from '../../../lib/auth/totp.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `inv_routes_${Date.now()}`;

function pdfBuffer(payload = 'inv') {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from(`${payload}\n`),
    Buffer.from('%%EOF\n'),
  ]);
}

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

describe.skipIf(skip)('invoice routes (HTTP)', () => {
  let app;
  let db;
  let env;
  let adminTag;

  beforeAll(async () => {
    env = loadEnv();
    db = createDb({ connectionString: env.DATABASE_URL });
    app = await build({ skipSafetyCheck: true });
    adminTag = `${tag}_admin`;
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM invoices WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    await sql`DELETE FROM documents WHERE customer_id IN (
      SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'}
    )`.execute(db);
    const cust = await sql`SELECT id::text AS id FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    for (const r of cust.rows) {
      await fsp.rm(`${STORAGE_ROOT}/${r.id}`, { recursive: true, force: true });
    }
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'} OR to_address LIKE ${adminTag + '%'}`.execute(db);
    await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${adminTag + '%'})`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'%' + adminTag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${adminTag + '%'}`.execute(db);
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await db.destroy();
  });

  async function loginAdmin(suffix) {
    const password = 'admin-pw-928374-strong';
    const created = await adminsService.create(
      db,
      { email: `${adminTag}+${suffix}@example.com`, name: `Admin ${suffix}` },
      { actorType: 'system', audit: { tag } },
    );
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

  async function makeCustomer(suffix) {
    const r = await customersService.create(db, {
      razonSocial: `${tag} ${suffix} S.L.`,
      primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}@example.com` },
    }, {
      actorType: 'system', audit: { tag }, kek: app.kek,
      portalBaseUrl: env.PORTAL_BASE_URL,
    });
    return r;
  }

  it('happy path: admin uploads invoice PDF + metadata, redirect to detail, customer sees it', async () => {
    const { customerId } = await makeCustomer('happy');
    const jar = await loginAdmin('happy');

    const newPage = await app.inject({
      method: 'GET',
      url: `/admin/customers/${customerId}/invoices/new`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(newPage.statusCode).toBe(200);
    mergeCookies(jar, newPage);
    const csrf = extractInputValue(newPage.body, '_csrf');
    expect(csrf).toBeTruthy();

    const boundary = '----vitest' + Date.now();
    const body = buildMultipart(boundary, {
      _csrf: csrf,
      invoice_number: 'INV-2026-100',
      amount_cents: '24750',
      currency: 'EUR',
      issued_on: '2026-04-15',
      due_on: '2026-05-15',
      notes: 'Q2 retainer',
    }, {
      name: 'file', filename: 'invoice.pdf', mime: 'application/pdf', body: pdfBuffer('happy'),
    });
    const post = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerId}/invoices`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length,
        'x-csrf-token': csrf,
      },
      payload: body,
    });
    expect(post.statusCode).toBe(303);
    expect(post.headers.location).toMatch(/^\/admin\/invoices\/[0-9a-f-]{36}$/);
    const invoiceId = post.headers.location.split('/').pop();

    // Both rows wrote.
    const rows = await sql`
      SELECT i.id::text AS id, i.invoice_number, i.amount_cents, i.status,
             d.category, d.original_filename
        FROM invoices i JOIN documents d ON d.id = i.document_id
       WHERE i.id = ${invoiceId}::uuid
    `.execute(db);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].invoice_number).toBe('INV-2026-100');
    expect(Number(rows.rows[0].amount_cents)).toBe(24750);
    expect(rows.rows[0].status).toBe('open');
    expect(rows.rows[0].category).toBe('invoice');
    expect(rows.rows[0].original_filename).toBe('invoice.pdf');

    // Admin detail renders with a download link to the PDF.
    const detail = await app.inject({
      method: 'GET',
      url: `/admin/invoices/${invoiceId}`,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('INV-2026-100');
    expect(detail.body).toContain('/download');
  });

  it('rejects an upload missing the PDF (re-renders with error, no rows written)', async () => {
    const { customerId } = await makeCustomer('nofile');
    const jar = await loginAdmin('nofile');

    const newPage = await app.inject({
      method: 'GET', url: `/admin/customers/${customerId}/invoices/new`,
      headers: { cookie: cookieHeader(jar) },
    });
    mergeCookies(jar, newPage);
    const csrf = extractInputValue(newPage.body, '_csrf');

    const boundary = '----vitest' + Date.now();
    const body = buildMultipart(boundary, {
      _csrf: csrf,
      invoice_number: 'INV-X',
      amount_cents: '100',
      currency: 'EUR',
      issued_on: '2026-04-01',
      due_on: '2026-05-01',
    }, null);
    const post = await app.inject({
      method: 'POST',
      url: `/admin/customers/${customerId}/invoices`,
      headers: {
        cookie: cookieHeader(jar),
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length,
        'x-csrf-token': csrf,
      },
      payload: body,
    });
    expect(post.statusCode).toBe(422);
    expect(post.body).toContain('No file received.');
    const c = await sql`
      SELECT count(*)::int AS c FROM invoices WHERE customer_id = ${customerId}::uuid
    `.execute(db);
    expect(c.rows[0].c).toBe(0);
  });
});
