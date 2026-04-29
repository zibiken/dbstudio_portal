import { describe, it, expect } from 'vitest';
import { runSafetyCheck } from '../../lib/safety-check.js';

function fsStub(map) {
  return {
    statSync(p) {
      if (!(p in map)) {
        const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e;
      }
      const m = map[p];
      return { mode: m.mode, uid: m.uid, gid: m.gid, isFile: () => true, isDirectory: () => true };
    }
  };
}

const baseMap = {
  '/var/lib/portal/master.key': { mode: 0o100400, uid: 1001, gid: 1001 },
  '/opt/dbstudio_portal/.env':  { mode: 0o100400, uid: 1001, gid: 1001 },
  '/var/lib/portal/storage':    { mode: 0o040750, uid: 1001, gid: 1001 },
  '/run/portal-pdf.sock':       { mode: 0o140660, uid: 1002, gid: 1001 }
};

const baseEnv = {
  MASTER_KEY_PATH: '/var/lib/portal/master.key',
  SESSION_SIGNING_SECRET: 'a'.repeat(64),
  FILE_URL_SIGNING_SECRET: 'b'.repeat(64),
  PDF_SERVICE_SOCKET: '/run/portal-pdf.sock'
};

const baseDb = {
  fetchCurrent: async () => ({ current_database: 'portal_db', current_user: 'portal_user' })
};

const userOk = () => ({ username: 'portal-app', uid: 1001, gid: 1001 });

describe('runSafetyCheck', () => {
  it('passes when all invariants hold', async () => {
    const r = await runSafetyCheck({ fs: fsStub(baseMap), userInfo: userOk, db: baseDb, env: baseEnv });
    expect(r).toEqual({ ok: true });
  });

  it('fails when running as root', async () => {
    await expect(runSafetyCheck({
      fs: fsStub(baseMap),
      userInfo: () => ({ username: 'root', uid: 0, gid: 0 }),
      db: baseDb, env: baseEnv
    })).rejects.toThrow(/portal-app/);
  });

  it('fails when master.key is mode 0440', async () => {
    const m = { ...baseMap, '/var/lib/portal/master.key': { mode: 0o100440, uid: 1001, gid: 1001 } };
    await expect(runSafetyCheck({ fs: fsStub(m), userInfo: userOk, db: baseDb, env: baseEnv }))
      .rejects.toThrow(/master\.key.*mode/);
  });

  it('fails when master.key not owned by portal-app', async () => {
    const m = { ...baseMap, '/var/lib/portal/master.key': { mode: 0o100400, uid: 999, gid: 999 } };
    await expect(runSafetyCheck({ fs: fsStub(m), userInfo: userOk, db: baseDb, env: baseEnv }))
      .rejects.toThrow(/master\.key.*owned/);
  });

  it('fails when .env mode looser than 0400', async () => {
    const m = { ...baseMap, '/opt/dbstudio_portal/.env': { mode: 0o100440, uid: 1001, gid: 1001 } };
    await expect(runSafetyCheck({ fs: fsStub(m), userInfo: userOk, db: baseDb, env: baseEnv }))
      .rejects.toThrow(/\.env.*mode/);
  });

  it('fails when storage dir mode > 0750', async () => {
    const m = { ...baseMap, '/var/lib/portal/storage': { mode: 0o040755, uid: 1001, gid: 1001 } };
    await expect(runSafetyCheck({ fs: fsStub(m), userInfo: userOk, db: baseDb, env: baseEnv }))
      .rejects.toThrow(/storage.*mode/);
  });

  it('fails when SESSION_SIGNING_SECRET shorter than 32 bytes', async () => {
    await expect(runSafetyCheck({
      fs: fsStub(baseMap), userInfo: userOk, db: baseDb,
      env: { ...baseEnv, SESSION_SIGNING_SECRET: 'short' }
    })).rejects.toThrow(/SESSION_SIGNING_SECRET/);
  });

  it('fails when FILE_URL_SIGNING_SECRET shorter than 32 bytes', async () => {
    await expect(runSafetyCheck({
      fs: fsStub(baseMap), userInfo: userOk, db: baseDb,
      env: { ...baseEnv, FILE_URL_SIGNING_SECRET: 'short' }
    })).rejects.toThrow(/FILE_URL_SIGNING_SECRET/);
  });

  it('fails when pg current_user is not portal_user', async () => {
    const badDb = { fetchCurrent: async () => ({ current_database: 'portal_db', current_user: 'postgres' }) };
    await expect(runSafetyCheck({
      fs: fsStub(baseMap), userInfo: userOk, db: badDb, env: baseEnv
    })).rejects.toThrow(/portal_user/);
  });

  it('fails when pg current_database is not portal_db', async () => {
    const badDb = { fetchCurrent: async () => ({ current_database: 'wrong_db', current_user: 'portal_user' }) };
    await expect(runSafetyCheck({
      fs: fsStub(baseMap), userInfo: userOk, db: badDb, env: baseEnv
    })).rejects.toThrow(/portal_db/);
  });

  it('fails when portal-pdf.sock mode is not 0660', async () => {
    const m = { ...baseMap, '/run/portal-pdf.sock': { mode: 0o140600, uid: 1002, gid: 1001 } };
    await expect(runSafetyCheck({ fs: fsStub(m), userInfo: userOk, db: baseDb, env: baseEnv }))
      .rejects.toThrow(/portal-pdf\.sock/);
  });

  it('fails when master.key missing entirely', async () => {
    const { '/var/lib/portal/master.key': _, ...rest } = baseMap;
    await expect(runSafetyCheck({ fs: fsStub(rest), userInfo: userOk, db: baseDb, env: baseEnv }))
      .rejects.toThrow();
  });
});
