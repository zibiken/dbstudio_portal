import { describe, it, expect } from 'vitest';
import { build } from '../../../server.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('GET /admin', () => {
  it('is a registered route — unauthenticated request returns 302 (redirect to login), not 404', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin' });
      expect(res.statusCode).not.toBe(404);
      expect([302, 401, 403]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });
});
