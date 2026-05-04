// Integration test for the Levenshtein-1 typo cluster bucket on
// /reset. Validates that 5 different-but-similar emails from the same
// or different IPs cluster into a single rate-limit bucket and trigger
// the 429 lockout — closing the gap surfaced by the 2026-05-01
// brainzr.eu / brainzr.com incident in follow-ups.md.
//
// The cluster representative is computed as the lex-smallest email
// within Levenshtein-1 of the current attempt across recent reset
// buckets, so all 5 attempts in this test share the same
// `reset:cluster:*` bucket key.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `resetcluster_${Date.now()}`;

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

describe.skipIf(skip)('reset typo cluster bucket', () => {
  let app, db;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    const env = loadEnv();
    void env;
    app = await build({ skipSafetyCheck: true });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      // The cluster key is keyed off the lex-min email, which contains
      // the tag; the IP key is just 'reset:ip:127.0.0.1' and would
      // otherwise leak a 429-locked state into adjacent reset tests
      // that share the loopback IP. Clear every reset:* bucket the
      // suite could have touched, plus the tagged per-email rows.
      await sql`DELETE FROM rate_limit_buckets WHERE key LIKE 'reset:cluster:%'`.execute(db);
      await sql`DELETE FROM rate_limit_buckets WHERE key LIKE 'reset:ip:%'`.execute(db);
      await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'reset:email:%' + tag + '%'}`.execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    // Clear ALL reset buckets between tests — clusterKeyForResetEmail
    // looks at active rows globally, so leftover buckets from earlier
    // suites would skew the representative.
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE 'reset:%'`.execute(db);
  });

  async function postReset(email) {
    const jar = {};
    const get = await app.inject({ method: 'GET', url: '/reset' });
    mergeCookies(jar, get);
    const csrf = extractInputValue(get.body, '_csrf');
    const res = await app.inject({
      method: 'POST', url: '/reset',
      headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(email)}&_csrf=${encodeURIComponent(csrf)}`,
    });
    return res;
  }

  it('5 single-edit-distance typos against same address cluster into one bucket and trip 429', async () => {
    // Star pattern: 5 addresses each Lev-1 to the lex-min anchor
    // `${tag}aaaaa@x.com`. The anchor is lex-smallest among all 5 because
    // a < b/c/y. By inheritance, every attempt's clusterKeyForResetEmail
    // resolves to the anchor, so all 5 attempts land in the SAME
    // `reset:cluster:` bucket — and the 5th increment trips the lockout.
    const anchor = `${tag}aaaaa@x.com`;
    const emails = [
      anchor,
      `${tag}aaaab@x.com`, // sub last char of local-part
      `${tag}aaaac@x.com`, // sub last char of local-part
      `${tag}baaaaa@x.com`, // insertion at start of local-part
      `${tag}aaaaa@y.com`, // sub domain initial
    ];

    // First 4 attempts return 200 (neutral reset-sent page) and each
    // increments the cluster bucket. The 5th increment crosses
    // RESET_LIMIT and sets locked_until on the cluster row; the 6th
    // attempt's checkLockout sees the cluster locked and returns 429.
    for (let i = 0; i < 4; i++) {
      const r = await postReset(emails[i]);
      expect(r.statusCode, `attempt ${i + 1} should return 200, got ${r.statusCode} body=${r.body.slice(0, 200)}`).toBe(200);
    }
    const fifth = await postReset(emails[4]);
    expect(fifth.statusCode).toBe(200);

    // 6th attempt against any address in the cluster: 429.
    const sixth = await postReset(emails[0]);
    expect(sixth.statusCode).toBe(429);

    // Verify exactly one cluster row exists, keyed on the anchor (lex-min
    // representative), with count = 5 and a non-null locked_until.
    const row = await sql`
      SELECT key, count, locked_until FROM rate_limit_buckets
       WHERE key = ${'reset:cluster:' + anchor}
    `.execute(db);
    expect(row.rows).toHaveLength(1);
    expect(Number(row.rows[0].count)).toBe(5);
    expect(row.rows[0].locked_until).not.toBeNull();
  });

  it('Levenshtein-distance > 1 emails do NOT cluster (separate buckets, no shared lockout)', async () => {
    // Same prefix but distance >= 2 (different domains). These should
    // each get their own cluster bucket; 5 attempts across them should
    // NOT trip the cluster lockout.
    const emails = [
      `${tag}-far@alpha.com`,
      `${tag}-far@bravo.com`,
      `${tag}-far@charlie.com`,
      `${tag}-far@delta.com`,
      `${tag}-far@echo.com`,
    ];
    for (const e of emails) {
      const r = await postReset(e);
      expect(r.statusCode).toBe(200);
    }
    const sixth = await postReset(emails[0]);
    // The IP bucket DOES trip at this point because all 5 share the
    // same client IP (vitest's app.inject defaults). That's the
    // existing IP-bucket behaviour, not the new cluster bucket. We
    // assert the cluster row count separately.
    expect([200, 429]).toContain(sixth.statusCode);

    const clusterRows = await sql`
      SELECT key, count, locked_until FROM rate_limit_buckets
       WHERE key LIKE 'reset:cluster:%'
         AND key LIKE ${'%' + tag + '%'}
    `.execute(db);
    // Each non-similar email should have its own cluster row with
    // count <= 1 (singleton cluster). None should be locked.
    for (const r of clusterRows.rows) {
      expect(Number(r.count)).toBeLessThanOrEqual(1);
      expect(r.locked_until).toBeNull();
    }
    // Should be exactly 5 separate cluster rows.
    expect(clusterRows.rows.length).toBe(5);
  });
});
