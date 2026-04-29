import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from '../../../server.js';

const skip = !process.env.RUN_DB_TESTS;

describe.skipIf(skip)('GET /health', () => {
  let app;
  beforeAll(async () => { app = await build({ skipSafetyCheck: true }); });
  afterAll(async () => { await app.close(); });

  it('returns 200 with {ok:true}', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });
});
