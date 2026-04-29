// Startup invariant verifier. Mirrors SAFETY.md §"Isolation invariants".
// All file/db/userInfo dependencies are injected so unit tests can exercise the failure modes
// without touching the real system.

export async function runSafetyCheck({ fs, userInfo, db, env }) {
  // 1. process user
  const u = userInfo();
  if (u.username !== 'portal-app') {
    throw new Error(`safety: process user is ${u.username}, expected portal-app`);
  }

  // 2. pg role + db
  const pg = await db.fetchCurrent();
  if (pg.current_user !== 'portal_user') {
    throw new Error(`safety: pg current_user is ${pg.current_user}, expected portal_user`);
  }
  if (pg.current_database !== 'portal_db') {
    throw new Error(`safety: pg current_database is ${pg.current_database}, expected portal_db`);
  }

  // 3. master.key — mode 0400, owned portal-app
  const k = fs.statSync(env.MASTER_KEY_PATH);
  if ((k.mode & 0o777) !== 0o400) {
    throw new Error(`safety: master.key mode is ${(k.mode & 0o777).toString(8)}, expected 0400`);
  }
  if (k.uid !== u.uid) {
    throw new Error(`safety: master.key not owned by portal-app (uid=${k.uid})`);
  }

  // 4. .env — mode 0400
  const e = fs.statSync('/opt/dbstudio_portal/.env');
  if ((e.mode & 0o777) !== 0o400) {
    throw new Error(`safety: .env mode is ${(e.mode & 0o777).toString(8)}, expected 0400`);
  }

  // 5. storage dir — mode <=0750, owned portal-app, no world bits
  const s = fs.statSync('/var/lib/portal/storage');
  const sMode = s.mode & 0o777;
  if (sMode > 0o750 || (sMode & 0o007) !== 0) {
    throw new Error(`safety: storage mode is ${sMode.toString(8)}, expected <=0750 with no world bits`);
  }

  // 6. signing secrets >= 32 bytes
  if (env.SESSION_SIGNING_SECRET.length < 32) {
    throw new Error('safety: SESSION_SIGNING_SECRET is shorter than 32 bytes');
  }
  if (env.FILE_URL_SIGNING_SECRET.length < 32) {
    throw new Error('safety: FILE_URL_SIGNING_SECRET is shorter than 32 bytes');
  }

  // 7. portal-pdf socket — mode 0660
  const sock = fs.statSync(env.PDF_SERVICE_SOCKET);
  if ((sock.mode & 0o777) !== 0o660) {
    throw new Error(`safety: portal-pdf.sock mode is ${(sock.mode & 0o777).toString(8)}, expected 0660`);
  }

  return { ok: true };
}
