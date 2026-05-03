// I3 (M9 review): email-verify routes accessed without a session must
// redirect to the login surface with `email_verify_pending=1` and a
// `return=` query so the user understands they need to sign in with
// their CURRENT (old) email before completing the change. Previously
// the route silently bounced to /login (admin) or / (customer), which
// confused users who had typed their NEW email.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from '../../../server.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('email verify bounce surface (I3)', () => {
  let app;

  beforeAll(async () => {
    app = await build({ skipSafetyCheck: true });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /customer/profile/email/verify/:token without a session redirects to /login with the pending hint', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/customer/profile/email/verify/some-fake-token-value',
    });
    expect(r.statusCode).toBe(302);
    const loc = r.headers.location;
    expect(loc).toMatch(/^\/login\?/);
    expect(loc).toContain('email_verify_pending=1');
    expect(loc).toContain('return=');
    expect(decodeURIComponent(loc)).toContain('/customer/profile/email/verify/some-fake-token-value');
  });

  it('GET /admin/profile/email/verify/:token without a session redirects to /login with the pending hint', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/admin/profile/email/verify/another-fake-token',
    });
    expect(r.statusCode).toBe(302);
    const loc = r.headers.location;
    expect(loc).toMatch(/^\/login\?/);
    expect(loc).toContain('email_verify_pending=1');
    expect(decodeURIComponent(loc)).toContain('/admin/profile/email/verify/another-fake-token');
  });

  it('GET /login?email_verify_pending=1 renders the inline info banner', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/login?email_verify_pending=1',
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('CURRENT email address');
  });
});
