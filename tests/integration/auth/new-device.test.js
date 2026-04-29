import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../config/db.js';
import { computeDeviceFingerprint } from '../../../lib/auth/session.js';
import { noticeLoginDevice } from '../../../domain/admins/service.js';
import * as service from '../../../domain/admins/service.js';

const skip = !process.env.RUN_DB_TESTS;
const tag = `nd_test_${Date.now()}`;
const tagEmail = (s) => `${tag}+${s}@example.com`;

describe.skipIf(skip)('new-device detection', () => {
  let db;

  beforeAll(async () => {
    db = createDb({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
      await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
      await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_block_modify`).execute(db);
      await sql`DELETE FROM audit_log WHERE metadata->>'tag' = ${tag}`.execute(db);
      await sql.raw(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_block_modify`).execute(db);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM admins WHERE email LIKE ${tag + '%'})`.execute(db);
    await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
    await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
  });

  describe('computeDeviceFingerprint', () => {
    it('returns sha256 hex of "<UA>|<IP/24>"', () => {
      const fp = computeDeviceFingerprint('Mozilla/5.0', '198.51.100.42');
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });

    it('treats two IPs in the same /24 as the same fingerprint', () => {
      const a = computeDeviceFingerprint('Mozilla/5.0', '198.51.100.42');
      const b = computeDeviceFingerprint('Mozilla/5.0', '198.51.100.7');
      expect(a).toBe(b);
    });

    it('treats different /24s as different', () => {
      const a = computeDeviceFingerprint('Mozilla/5.0', '198.51.100.42');
      const b = computeDeviceFingerprint('Mozilla/5.0', '198.51.101.42');
      expect(a).not.toBe(b);
    });

    it('treats different UAs as different', () => {
      const a = computeDeviceFingerprint('Mozilla/5.0', '198.51.100.42');
      const b = computeDeviceFingerprint('curl/8.0',    '198.51.100.42');
      expect(a).not.toBe(b);
    });

    it('handles missing UA / missing IP without throwing', () => {
      expect(computeDeviceFingerprint(null, null)).toMatch(/^[0-9a-f]{64}$/);
      expect(computeDeviceFingerprint('', '')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('noticeLoginDevice', () => {
    async function makeAdmin(s) {
      const created = await service.create(db, { email: tagEmail(s), name: s }, { audit: { tag } });
      return created.id;
    }

    it('first login from a fingerprint queues a new_device_login email and writes the audit row', async () => {
      const adminId = await makeAdmin('first');
      const fp = computeDeviceFingerprint('Mozilla/5.0', '203.0.113.1');

      const r = await noticeLoginDevice(db, {
        adminId, fingerprint: fp, toAddress: tagEmail('first'),
      }, { audit: { tag }, ip: '203.0.113.1' });
      expect(r.isNew).toBe(true);

      const audits = await sql`
        SELECT action, metadata FROM audit_log
         WHERE target_id = ${adminId}::uuid AND action = 'admin.new_device_login'
      `.execute(db);
      expect(audits.rows).toHaveLength(1);
      expect(audits.rows[0].metadata).toMatchObject({ fingerprint: fp });

      const outbox = await sql`
        SELECT template, locals, idempotency_key FROM email_outbox
         WHERE to_address = ${tagEmail('first')}::citext AND template = 'new_device_login'
      `.execute(db);
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0].idempotency_key).toContain(fp);
    });

    it('second login from the same fingerprint within 30 days does not re-notify', async () => {
      const adminId = await makeAdmin('repeat');
      const fp = computeDeviceFingerprint('Mozilla/5.0', '203.0.113.5');

      // Seed a recent session row carrying that fingerprint to simulate prior login.
      await sql`
        INSERT INTO sessions (id, user_type, user_id, device_fingerprint, absolute_expires_at, last_seen_at)
        VALUES (${'seed_' + Date.now()}, 'admin', ${adminId}::uuid, ${fp}, now() + INTERVAL '12 hours', now() - INTERVAL '1 day')
      `.execute(db);

      const r = await noticeLoginDevice(db, {
        adminId, fingerprint: fp, toAddress: tagEmail('repeat'),
      }, { audit: { tag } });
      expect(r.isNew).toBe(false);

      const audits = await sql`
        SELECT 1 FROM audit_log
         WHERE target_id = ${adminId}::uuid AND action = 'admin.new_device_login'
      `.execute(db);
      expect(audits.rows).toHaveLength(0);

      const outbox = await sql`
        SELECT 1 FROM email_outbox
         WHERE to_address = ${tagEmail('repeat')}::citext AND template = 'new_device_login'
      `.execute(db);
      expect(outbox.rows).toHaveLength(0);
    });

    it('a fingerprint last seen more than 30 days ago is treated as new', async () => {
      const adminId = await makeAdmin('stale');
      const fp = computeDeviceFingerprint('Mozilla/5.0', '203.0.113.9');

      await sql`
        INSERT INTO sessions (id, user_type, user_id, device_fingerprint, absolute_expires_at, last_seen_at, created_at)
        VALUES (${'stale_' + Date.now()}, 'admin', ${adminId}::uuid, ${fp},
                now() + INTERVAL '12 hours', now() - INTERVAL '40 days', now() - INTERVAL '40 days')
      `.execute(db);

      const r = await noticeLoginDevice(db, {
        adminId, fingerprint: fp, toAddress: tagEmail('stale'),
      }, { audit: { tag } });
      expect(r.isNew).toBe(true);
    });

    it('excludes the session id of the login that just created it (so first login of a fresh device is "new")', async () => {
      const adminId = await makeAdmin('exclude');
      const fp = computeDeviceFingerprint('Mozilla/5.0', '203.0.113.42');

      // The just-created session for this login carries the same fingerprint
      // and last_seen_at = now(); without exclusion the lookup would falsely
      // match and report isNew:false.
      const justNow = 'just_' + Date.now();
      await sql`
        INSERT INTO sessions (id, user_type, user_id, device_fingerprint, absolute_expires_at)
        VALUES (${justNow}, 'admin', ${adminId}::uuid, ${fp}, now() + INTERVAL '12 hours')
      `.execute(db);

      const r = await noticeLoginDevice(db, {
        adminId, fingerprint: fp, toAddress: tagEmail('exclude'),
        excludeSessionId: justNow,
      }, { audit: { tag } });
      expect(r.isNew).toBe(true);
    });

    it('a stale outbox row from a prior month does not block today\'s notification', async () => {
      const adminId = await makeAdmin('rebuck');
      const fp = computeDeviceFingerprint('Mozilla/5.0', '203.0.113.99');

      // Seed a stale outbox row keyed by an older bucket. Today's bucket
      // differs, so a new row should still insert.
      const { v7: uuidv7 } = await import('uuid');
      await sql`
        INSERT INTO email_outbox (id, idempotency_key, to_address, template, locals)
        VALUES (
          ${uuidv7()}::uuid,
          ${`new_device_login:${adminId}:${fp}:200001`},
          ${tagEmail('rebuck')},
          'new_device_login',
          ${'{}'}::jsonb
        )
      `.execute(db);

      const r = await noticeLoginDevice(db, {
        adminId, fingerprint: fp, toAddress: tagEmail('rebuck'),
      }, { audit: { tag } });
      expect(r.isNew).toBe(true);

      const outbox = await sql`
        SELECT idempotency_key FROM email_outbox
         WHERE to_address = ${tagEmail('rebuck')}::citext AND template = 'new_device_login'
         ORDER BY created_at
      `.execute(db);
      expect(outbox.rows).toHaveLength(2);
      expect(outbox.rows[1].idempotency_key).not.toBe(outbox.rows[0].idempotency_key);
    });
  });
});
