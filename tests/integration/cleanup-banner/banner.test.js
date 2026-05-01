import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { createDb } from '../../../config/db.js';
import {
  getCleanupBannerForCustomer,
  dismissCleanupBanner,
} from '../../../lib/cleanup-banner.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `banner_${Date.now()}`;

async function writeCredentialDeletedAudit(db, {
  customerId, provider, actorType = 'admin', visibleToCustomer = true, ts = null,
}) {
  await sql`
    INSERT INTO audit_log (id, ts, actor_type, actor_id, action, target_type, target_id, metadata, visible_to_customer)
    VALUES (
      ${uuidv7()}::uuid,
      COALESCE(${ts}::timestamptz, now()),
      ${actorType},
      NULL,
      'credential.deleted',
      'credential',
      ${uuidv7()}::uuid,
      ${JSON.stringify({ tag, customerId, provider, label: 'l' })}::jsonb,
      ${visibleToCustomer}
    )
  `.execute(db);
}

describe.skipIf(skip)('cleanup banner', () => {
  let db;
  let customerId;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
    customerId = uuidv7();
    await sql`
      INSERT INTO customers (id, razon_social, dek_ciphertext, dek_iv, dek_tag)
      VALUES (${customerId}::uuid, ${tag}, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea)
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await sql`DELETE FROM customers WHERE id = ${customerId}::uuid`.execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    // Clear test audit rows + reset dismissal stamp before each case.
    await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
    await sql`UPDATE customers SET last_cleanup_banner_dismissed_at = NULL WHERE id = ${customerId}::uuid`.execute(db);
  });

  it('returns the most recent admin credential.deleted within 7 days', async () => {
    await writeCredentialDeletedAudit(db, { customerId, provider: 'wp-engine' });
    const banner = await getCleanupBannerForCustomer(db, customerId);
    expect(banner).toBeTruthy();
    expect(banner.provider).toBe('wp-engine');
  });

  it('returns null when nothing matches', async () => {
    const banner = await getCleanupBannerForCustomer(db, customerId);
    expect(banner).toBeNull();
  });

  it('dismissCleanupBanner stamps the customer + suppresses the banner', async () => {
    await writeCredentialDeletedAudit(db, { customerId, provider: 'github' });
    expect(await getCleanupBannerForCustomer(db, customerId)).toBeTruthy();

    await dismissCleanupBanner(db, customerId);
    expect(await getCleanupBannerForCustomer(db, customerId)).toBeNull();
  });

  it('a fresh credential.deleted after dismissal re-shows the banner', async () => {
    await writeCredentialDeletedAudit(db, { customerId, provider: 'old' });
    await dismissCleanupBanner(db, customerId);
    expect(await getCleanupBannerForCustomer(db, customerId)).toBeNull();

    // Sleep a millisecond so ts > dismissed_at strictly. (now() is per-tx;
    // we explicitly stamp ts so this is deterministic.)
    await writeCredentialDeletedAudit(db, { customerId, provider: 'fresh', ts: new Date(Date.now() + 1000).toISOString() });
    const banner = await getCleanupBannerForCustomer(db, customerId);
    expect(banner?.provider).toBe('fresh');
  });

  it('ignores customer-actor self-deletes', async () => {
    await writeCredentialDeletedAudit(db, { customerId, provider: 'self', actorType: 'customer' });
    expect(await getCleanupBannerForCustomer(db, customerId)).toBeNull();
  });

  it('ignores audit rows older than 7 days', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeCredentialDeletedAudit(db, { customerId, provider: 'stale', ts: old });
    expect(await getCleanupBannerForCustomer(db, customerId)).toBeNull();
  });

  it('ignores rows with visible_to_customer=false', async () => {
    await writeCredentialDeletedAudit(db, { customerId, provider: 'hidden', visibleToCustomer: false });
    expect(await getCleanupBannerForCustomer(db, customerId)).toBeNull();
  });
});
