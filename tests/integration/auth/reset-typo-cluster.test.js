// Integration test for the Levenshtein-1 typo cluster bucket on
// /reset. Validates that 5 different-but-similar emails cluster into a
// single rate-limit bucket and trigger the 429 lockout — closing the
// gap surfaced by the 2026-05-01 brainzr.eu / brainzr.com incident in
// follow-ups.md. Also validates the cluster-aging fix: when an early
// attempt's reset:email row's reset_at expires while the cluster bucket
// is still locked, a fresh attempt against a Lev-1 typo must STILL
// resolve to the active cluster representative (not invent a new one).
//
// Test isolation: requests are tagged with a deterministic test-only
// IP via x-forwarded-for (RFC 5737 TEST-NET-2 198.51.100.1). The
// portal's trustProxy includes 127.0.0.1, so the bucket key becomes
// 'reset:ip:198.51.100.1' — distinct from any production traffic IP.
// Cleanup deletes only that exact IP key plus tagged email/cluster
// rows; we never touch other users' rate_limit_buckets state.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { build } from '../../../server.js';
import { createDb } from '../../../config/db.js';
import { loadEnv } from '../../../config/env.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `resetcluster_${Date.now()}`;
// RFC 5737 TEST-NET-2 — never globally routed; safe for test isolation.
const TEST_IP = '198.51.100.1';
const TEST_IP_KEY = `reset:ip:${TEST_IP}`;

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

  async function clearTaggedBuckets() {
    // Scoped cleanup: only this suite's tagged email/cluster rows and
    // the test-only IP key. Never touches non-tagged production state
    // (e.g., a real user's locked email bucket from a real reset).
    await sql`DELETE FROM rate_limit_buckets WHERE key = ${TEST_IP_KEY}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'reset:email:%' + tag + '%'}`.execute(db);
    await sql`DELETE FROM rate_limit_buckets WHERE key LIKE ${'reset:cluster:%' + tag + '%'}`.execute(db);
  }

  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await clearTaggedBuckets();
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await clearTaggedBuckets();
  });

  async function postReset(email) {
    const jar = {};
    const get = await app.inject({
      method: 'GET', url: '/reset',
      headers: { 'x-forwarded-for': TEST_IP },
    });
    mergeCookies(jar, get);
    const csrf = extractInputValue(get.body, '_csrf');
    const res = await app.inject({
      method: 'POST', url: '/reset',
      headers: {
        cookie: cookieHeader(jar),
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': TEST_IP,
      },
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
    // same x-forwarded-for IP. That's the existing IP-bucket behaviour,
    // not the new cluster bucket. We assert the cluster row count
    // separately.
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

  it('cluster-aging bypass is closed: an aged-out reset:email candidate still keeps the cluster rep discoverable via the live cluster bucket', async () => {
    // Threat: attempts 1-5 build a cluster around an anchor and lock it.
    // The lockout window (30 min) is longer than the per-email reset
    // window (15 min). After the 15-min mark, every reset:email row's
    // reset_at has aged out, so a 6th attempt's clusterKeyForResetEmail
    // would — under the original implementation — find no email
    // candidates and invent a fresh representative, sidestepping the
    // still-locked cluster bucket. The fix: clusterKeyForResetEmail also
    // looks at active reset:cluster:* rows.
    const anchor = `${tag}aged-aaaaa@x.com`;
    const sibling = `${tag}aged-aaaab@x.com`; // Lev-1 to anchor
    const newTypo = `${tag}aged-aaaac@x.com`; // Lev-1 to anchor

    // Seed: anchor's email bucket aged out (reset_at in the past), but
    // the cluster bucket is still locked. This simulates the 16-30 min
    // window of a typo loop.
    await sql`
      INSERT INTO rate_limit_buckets (key, count, reset_at, locked_until)
      VALUES (
        ${'reset:email:' + anchor}, 5,
        now() - interval '20 minutes',
        NULL
      )
    `.execute(db);
    await sql`
      INSERT INTO rate_limit_buckets (key, count, reset_at, locked_until)
      VALUES (
        ${'reset:cluster:' + anchor}, 5,
        now() - interval '20 minutes',
        now() + interval '10 minutes'
      )
    `.execute(db);
    await sql`
      INSERT INTO rate_limit_buckets (key, count, reset_at, locked_until)
      VALUES (
        ${'reset:email:' + sibling}, 1,
        now() - interval '20 minutes',
        NULL
      )
    `.execute(db);

    // 6th attempt: typo'd to a NEW Lev-1 neighbour of the anchor.
    // Without the fix, this returns 200 (cluster bypass — fresh rep,
    // fresh bucket). With the fix, the live cluster bucket is found,
    // its rep is the anchor, and the request returns 429.
    const res = await postReset(newTypo);
    expect(res.statusCode, `cluster-aging bypass should be blocked; got ${res.statusCode}`).toBe(429);

    // Sanity: no NEW cluster row was created with newTypo as the rep.
    const newRow = await sql`
      SELECT key FROM rate_limit_buckets
       WHERE key = ${'reset:cluster:' + newTypo}
    `.execute(db);
    expect(newRow.rows).toHaveLength(0);
  });
});
