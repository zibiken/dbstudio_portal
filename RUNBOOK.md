# Portal Operations Runbook

Operational procedures for `portal.dbstudio.one`. Read alongside `SAFETY.md`.

---

## Initial bootstrap (one-time)

Performed 2026-04-29.

### M0-A — Linux + Postgres + Node

```bash
# Linux users
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/portal --create-home portal-app
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/portal-pdf --create-home portal-pdf
sudo usermod -a -G portal-app portal-pdf

# Runtime data dirs
sudo install -d -o portal-app -g portal-app -m 0750 \
    /var/lib/portal /var/lib/portal/storage /var/lib/portal/fonts \
    /var/lib/portal/templates /var/lib/portal/backups /var/log/portal

# Postgres role + DB (password generated via openssl rand -base64 32, saved to /root/.portal_db_pw mode 0400)
sudo -u postgres psql <<SQL
CREATE ROLE portal_user WITH LOGIN PASSWORD '<generated>';
CREATE DATABASE portal_db OWNER portal_user;
\c portal_db
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
REVOKE ALL ON DATABASE dbfootball_prod    FROM portal_user;
REVOKE ALL ON DATABASE dbfootball_staging FROM portal_user;
REVOKE ALL ON DATABASE postgres           FROM portal_user;
SQL

# Project-local Node 20.19.6
sudo -u root curl -fsSL https://nodejs.org/dist/v20.19.6/node-v20.19.6-linux-x64.tar.xz \
  | sudo tar -xJ -C /opt/dbstudio_portal
sudo mv /opt/dbstudio_portal/node-v20.19.6-linux-x64 /opt/dbstudio_portal/.node

# Repo perms (root:portal-app, group write on root for npm install only)
sudo chown -R root:portal-app /opt/dbstudio_portal
sudo find /opt/dbstudio_portal -path /opt/dbstudio_portal/.git -prune -o -type d -exec chmod 0750 {} +
sudo find /opt/dbstudio_portal -path /opt/dbstudio_portal/.git -prune -o -type f -exec chmod 0640 {} +
sudo chmod g+w /opt/dbstudio_portal
sudo install -d -o portal-app -g portal-app -m 0750 /opt/dbstudio_portal/node_modules
```

Verification (saved 2026-04-29):
- `id portal-app` → uid=996(portal-app) gid=987(portal-app)
- `id portal-pdf` → uid=995(portal-pdf) gid=986(portal-pdf) groups=986(portal-pdf),987(portal-app)
- `\du portal_user` → role created, no special attributes
- `\l` → portal_db owned by portal_user, no grants on dbfootball_prod / dbfootball_staging / postgres
- `psql -h 127.0.0.1 -U portal_user -d portal_db` → connects successfully (scram-sha-256)
- `/opt/dbstudio_portal/.node/bin/node --version` → v20.19.6

### M0-B — bootstrap-secrets.sh

```bash
sudo bash /opt/dbstudio_portal/scripts/bootstrap-secrets.sh
```

Outputs:
- `/var/lib/portal/master.key` — 32-byte KEK, mode 0400, owned portal-app:portal-app. **Off-server backup pending operator action.**
- `/opt/dbstudio_portal/.env` — DATABASE_URL populated from `/root/.portal_db_pw`; SESSION_SIGNING_SECRET + FILE_URL_SIGNING_SECRET each 64 random bytes base64-encoded; mode 0400, portal-app.
- `/opt/dbstudio_portal/.git/hooks/pre-commit` → symlink to `scripts/precommit-secrets-check.sh`.

KEK fingerprint (first 16 hex chars of sha256, for tamper detection): record in operator's password manager, not here.

### Postgres role audit (initial)

```
List of databases
- dbfootball_prod    | dbfootball_prod_user    | (no portal_user grants)
- dbfootball_staging | dbfootball_staging_user | (no portal_user grants)
- portal_db          | portal_user             | owner
- postgres           | postgres                | (no portal_user grants)
```

Confirmed 2026-04-29. Re-run quarterly via `sudo -u postgres psql -c '\du portal_user' && sudo -u postgres psql -c '\l'`.

### Pre-commit hook rejection drill

Confirmed 2026-04-29: staging an env line of the form `MAILERSEND_API_KEY=` followed by a `mlsn.`-prefixed token triggers exit 1 with "REJECTED 1 staged change(s)". The hook itself is what now blocked an attempt to record the literal example here, which is the correct behaviour. Re-run the drill with `bash scripts/precommit-secrets-check.sh /tmp/<file-with-fake-secret>` if you ever need to re-verify.

---

## Routine operations

### Deploy

```bash
cd /opt/dbstudio_portal
sudo -u root git pull --ff-only origin main
sudo -u portal-app env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm ci --omit=dev
sudo -u portal-app env PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin /opt/dbstudio_portal/.node/bin/npm run build
sudo systemctl restart portal-pdf.service
sleep 2
sudo systemctl restart portal.service
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

Rollback: `git reset --hard <sha>` then re-run the same sequence.

### Service control

```bash
# Status
systemctl is-active portal.service portal-pdf.service
sudo journalctl -u portal.service -f
sudo journalctl -u portal-pdf.service -f

# Order matters on cold start: portal-pdf first (creates the socket), portal second.
sudo systemctl restart portal-pdf.service
sudo systemctl restart portal.service

# Stop everything
sudo systemctl stop portal.service portal-pdf.service
```

### Smoke test

```bash
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

5 checks: both services active, /health green, socket mode 0660 portal-pdf:portal-app, safety-check passes.

### M1 hardening deltas (vs spec §7)

The spec aspired to `MemoryDenyWriteExecute=true` + `SystemCallFilter=@system-service` on portal.service. Both crash Node 20 V8 (status=31/SYS / SIGBUS). Both omitted. The other hardening (ProtectSystem=strict, ProtectHome, PrivateTmp, NoNewPrivileges, RestrictAddressFamilies, ProtectKernel*, RestrictNamespaces, LockPersonality, RestrictRealtime) is intact. Future work: capture syscall list via `auditd` and write a custom narrow `SystemCallFilter=` allowlist.

The spec said the IPC socket lived at `/run/portal-pdf.sock`. The portal-pdf user can't write directly to `/run/`. Implementation uses `RuntimeDirectory=portal-pdf` so systemd creates `/run/portal-pdf/` owned by portal-pdf:portal-app, and the actual socket lives at `/run/portal-pdf/portal.sock`. `pdf-service.js` does an explicit `chmodSync(SOCK, 0o660)` after listen because Node creates Unix sockets with mode 0777 & ~umask which leaves 0770 even with `UMask=0007` in the unit. Safety-check (invariant 7) verifies the final 0660.

### Email outbox runner status

(Filled at M4.)

---

## Recovery procedures

### KEK rotation

(Filled at M2 — see plan task 2.8.)

### Admin password reset / lockout

(Filled at M3.)

### Backup restore drill

(Filled at M10.)

### Incident response — secret leaked into git history

If a secret reaches a commit (despite SAFETY.md and the pre-commit hook):

1. **Rotate the affected secret immediately.**
   - DB password: `ALTER ROLE portal_user PASSWORD '<new>';` then `sudoedit /opt/dbstudio_portal/.env` to update `DATABASE_URL`.
   - SESSION/FILE_URL signing secrets: `sudo bash scripts/bootstrap-secrets.sh --rotate-signing` then restart `portal.service`. Existing sessions invalidated; existing signed file URLs invalidated.
   - MAILERSEND_API_KEY: revoke in MailerSend dashboard, generate new, paste into `.env`, restart.
   - Master KEK: full KEK rotation procedure above (in M2 once written).
2. **Force-push the cleaned history.** Use `git filter-repo` or BFG. This is the **only** legitimate force-push on `main`. Coordinate with anyone who pulled.
3. **Document the incident here** with date, what leaked, when rotated, who was notified.

---

## Audit checklists

### Post-deploy smoke

(Filled at M1, expanded at M10.)

### Quarterly Postgres role audit

```bash
sudo -u postgres psql -c '\du portal_user'
sudo -u postgres psql -c '\l'
# Expect: portal_user owns portal_db, no grants on any other database.
```
