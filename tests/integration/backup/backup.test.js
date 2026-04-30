import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Gated double: RUN_BACKUP_TESTS=1 to opt in, AND age must be installed.
// Until M10 gate 10-A lands the age binary on the box, the test self-skips.
const skipReason =
  !process.env.RUN_BACKUP_TESTS ? 'RUN_BACKUP_TESTS not set' :
  !process.env.DATABASE_URL    ? 'DATABASE_URL not set' :
  !hasBinary('age')            ? 'age binary not installed (M10 gate 10-A)' :
  !hasBinary('rclone')         ? 'rclone binary not installed' :
  null;

function hasBinary(name) {
  try { execSync(`command -v ${name}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

describe.skipIf(skipReason)('scripts/backup.sh', () => {
  const root = '/opt/dbstudio_portal';
  let workdir;
  let backupDir;
  let remoteDir;
  let recipientsFile;
  let agePrivate;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'portal-backup-'));
    backupDir = join(workdir, 'backups');
    remoteDir = join(workdir, 'remote/portal/');
    recipientsFile = join(workdir, '.age-recipients');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(remoteDir, { recursive: true });

    // Throwaway age keypair generated for this test only — never persisted.
    const r = spawnSync('age-keygen', { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`age-keygen failed: ${r.stderr}`);
    agePrivate = r.stdout;
    const pub = (agePrivate.match(/^# public key: (age1\S+)/m) || [])[1];
    if (!pub) throw new Error('could not parse age public key from age-keygen stdout');
    writeFileSync(recipientsFile, pub + '\n');
  });

  afterAll(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it('produces age-encrypted db + storage artefacts and pushes them to the rclone target', () => {
    const env = {
      ...process.env,
      BACKUP_DIR: backupDir,
      BACKUP_RCLONE_REMOTE: remoteDir,        // local path — rclone treats no-colon as local
      AGE_RECIPIENTS_FILE: recipientsFile,
      // Use a writable temp PORTAL_DATA_DIR so `tar -C $DATA_DIR storage` succeeds
      // even if the test runner can't read /var/lib/portal/storage.
      PORTAL_DATA_DIR: workdir,
    };
    mkdirSync(join(workdir, 'storage'), { recursive: true });
    writeFileSync(join(workdir, 'storage', 'sentinel.txt'), 'storage-snapshot-marker');

    const run = spawnSync('bash', [join(root, 'scripts/backup.sh')], { env, encoding: 'utf8' });
    if (run.status !== 0) {
      throw new Error(`backup.sh exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    }

    // Local: encrypted artefacts retained, plaintexts shredded
    const localFiles = readdirSync(backupDir).sort();
    const dbAge = localFiles.find((f) => /^db-.*\.dump\.age$/.test(f));
    const stAge = localFiles.find((f) => /^storage-.*\.tar\.age$/.test(f));
    expect(dbAge, `local backup dir contents: ${localFiles.join(', ')}`).toBeTruthy();
    expect(stAge).toBeTruthy();
    expect(localFiles.find((f) => /^db-.*\.dump$/.test(f))).toBeUndefined(); // plaintext shredded
    expect(localFiles.find((f) => /^storage-.*\.tar$/.test(f))).toBeUndefined();

    // Remote: same artefacts under the timestamped subdir
    const remoteEntries = readdirSync(remoteDir);
    expect(remoteEntries.length, `remote: ${remoteEntries.join(', ')}`).toBe(1);
    const tsDir = join(remoteDir, remoteEntries[0]);
    const remoteFiles = readdirSync(tsDir).sort();
    expect(remoteFiles.find((f) => /^db-.*\.dump\.age$/.test(f))).toBeTruthy();
    expect(remoteFiles.find((f) => /^storage-.*\.tar\.age$/.test(f))).toBeTruthy();

    // Decrypt the db dump with the throwaway private key, confirm it's a valid
    // pg_dump custom-format archive (PGDMP magic header).
    const keyPath = join(workdir, 'private.age.key');
    writeFileSync(keyPath, agePrivate, { mode: 0o600 });
    const decrypted = join(workdir, 'db.dump');
    const dec = spawnSync('age', ['--decrypt', '-i', keyPath, '-o', decrypted, join(backupDir, dbAge)], { encoding: 'utf8' });
    expect(dec.status, `age decrypt failed: ${dec.stderr}`).toBe(0);
    expect(existsSync(decrypted)).toBe(true);
    const head = readFileSync(decrypted).subarray(0, 5).toString('utf8');
    expect(head).toBe('PGDMP');

    // Sanity-check the storage tar carries our sentinel
    const stDecrypted = join(workdir, 'storage.tar');
    const dec2 = spawnSync('age', ['--decrypt', '-i', keyPath, '-o', stDecrypted, join(backupDir, stAge)], { encoding: 'utf8' });
    expect(dec2.status, `age decrypt (storage) failed: ${dec2.stderr}`).toBe(0);
    const list = spawnSync('tar', ['-tf', stDecrypted], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/storage\/sentinel\.txt/);
  }, 60_000);
});
