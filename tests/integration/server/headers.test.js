import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from '../../../server.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('security headers', () => {
  let app;
  beforeAll(async () => { app = await build({ skipSafetyCheck: true }); });
  afterAll(async () => { await app.close(); });

  it('sets HSTS, CSP with nonce, X-Frame-Options DENY on /', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(r.headers['content-security-policy']).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('rejects http when X-Forwarded-Proto:http in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const r = await app.inject({ method: 'GET', url: '/', headers: { 'x-forwarded-proto': 'http' } });
    expect(r.statusCode).toBe(400);
    process.env.NODE_ENV = prev;
  });
});
