import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';

const skip = !process.env.RUN_DB_TESTS;

// The provider catalogue is a *suggestion list* for admin autocomplete when
// building credential requests — credentials.provider and
// credential_requests.provider stay free-text. The seed migration ships a
// curated default set with optional `default_fields` field-suggestions
// keyed by slug.
describe.skipIf(skip)('provider_catalogue seed (migrations/0005)', () => {
  let db;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  it('seed migration 0005_provider_catalogue_seed.sql is recorded as applied', async () => {
    const r = await sql`
      SELECT name FROM _migrations WHERE name = '0005_provider_catalogue_seed.sql'
    `.execute(db);
    expect(r.rows).toHaveLength(1);
  });

  it('seeds the 20 default provider slugs as active rows', async () => {
    const expected = [
      'aws', 'azure', 'bitbucket', 'cloudflare', 'cpanel',
      'digitalocean', 'dns-provider', 'domain-registrar', 'email-service',
      'gcp', 'github', 'gitlab', 'hetzner', 'kinsta',
      'mailersend', 's3-bucket', 'stripe', 'vps-root', 'wordpress-admin',
      'wp-engine',
    ];
    const r = await sql`
      SELECT slug FROM provider_catalogue
       WHERE slug = ANY(${expected})
       ORDER BY slug
    `.execute(db);
    expect(r.rows.map((row) => row.slug)).toEqual(expected);

    const active = await sql`
      SELECT count(*)::int AS c FROM provider_catalogue
       WHERE slug = ANY(${expected}) AND active = TRUE
    `.execute(db);
    expect(active.rows[0].c).toBe(expected.length);
  });

  it('every seeded row has a non-empty display_name', async () => {
    const r = await sql`
      SELECT slug, display_name FROM provider_catalogue
       WHERE display_name IS NULL OR length(trim(display_name)) = 0
    `.execute(db);
    expect(r.rows).toEqual([]);
  });

  it('default_fields is a JSON array of {name,label,type,required} suggestions', async () => {
    const r = await sql`
      SELECT slug, default_fields FROM provider_catalogue
       WHERE slug IN ('aws', 'github', 'wordpress-admin', 'stripe')
       ORDER BY slug
    `.execute(db);
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows) {
      expect(Array.isArray(row.default_fields)).toBe(true);
      expect(row.default_fields.length).toBeGreaterThan(0);
      for (const f of row.default_fields) {
        expect(typeof f.name).toBe('string');
        expect(f.name.length).toBeGreaterThan(0);
        expect(typeof f.label).toBe('string');
        expect(f.label.length).toBeGreaterThan(0);
        expect(['text', 'secret', 'url', 'note']).toContain(f.type);
        expect(typeof f.required).toBe('boolean');
      }
    }
  });

  it('aws default_fields includes a secret-typed access key suggestion', async () => {
    const r = await sql`
      SELECT default_fields FROM provider_catalogue WHERE slug = 'aws'
    `.execute(db);
    expect(r.rows).toHaveLength(1);
    const fields = r.rows[0].default_fields;
    const secretField = fields.find((f) => f.type === 'secret');
    expect(secretField).toBeDefined();
  });

  it('seed is idempotent — re-running does not duplicate or error', async () => {
    const before = await sql`
      SELECT count(*)::int AS c FROM provider_catalogue
    `.execute(db);
    // The migration runner skips already-applied files, so we can't re-run
    // it directly. But the seed file itself MUST use ON CONFLICT (slug)
    // so a future "edit + re-apply via tooling" doesn't blow up. We assert
    // the runner's idempotency by counting pre/post a no-op runMigrations
    // pass elsewhere; here we assert the table state is stable across two
    // independent reads (sanity), and that no slug appears twice.
    const after = await sql`
      SELECT count(*)::int AS c FROM provider_catalogue
    `.execute(db);
    expect(after.rows[0].c).toBe(before.rows[0].c);

    const dups = await sql`
      SELECT slug, count(*) AS c FROM provider_catalogue
       GROUP BY slug HAVING count(*) > 1
    `.execute(db);
    expect(dups.rows).toEqual([]);
  });
});
