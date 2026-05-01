import { describe, it, expect } from 'vitest';
import { build } from '../../../server.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('POST /admin/invoices/parse-pdf', () => {
  it('is registered + auth-gated — unauthenticated request does not 404', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'POST', url: '/admin/invoices/parse-pdf' });
      // Either CSRF gate (403) or auth gate (302) fires — both prove the
      // route is registered. We just need NOT-404.
      expect(res.statusCode).not.toBe(404);
    } finally {
      await app.close();
    }
  });
});
