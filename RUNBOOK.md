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

### Email provider state

| Field | Value |
|---|---|
| Provider | MailerSend |
| Domain | `dbstudio.one` (SPF + DKIM verified, DMARC ≥ quarantine for `_dmarc.dbstudio.one`) |
| v1 sender | `portal@dbstudio.one` (display name "DB Studio Portal") |
| API key name | `portal-v1` (send-only scope) |
| API key last 4 | `GEME` |
| Gate closed | 2026-04-29, direct curl → HTTP 202, Message-Id `69f237c1240785931dfc7c72`, delivered to `bram@roxiplus.es`. Full pipeline (enqueue → worker → MailerSend → inbox) re-confirmed 2026-04-29 via `tests/integration/email/live-smoke.test.js`, Message-Id `69f25d23f31e51971bf18e55`. |

Operational notes:
- The dedicated `mail.portal.dbstudio.one` subdomain is deferred per spec §10. Once added, generate a new send-only key, paste, restart, repeat the live-send drill, then revoke `portal-v1` in the MailerSend dashboard.
- The `.env` value is wrapped in literal double-quotes (`MAILERSEND_API_KEY="mlsn..."`). systemd's `EnvironmentFile` and `dotenv` both strip the surrounding quotes at load, so the running service sees the bare token. Ad-hoc shell tests (`curl ... -H "Authorization: Bearer $KEY"`) must strip the quotes manually first, otherwise MailerSend returns 401 `Unauthenticated`.
- Rotation: see "Incident response" below — revoke in MailerSend, generate replacement, paste into `.env`, `sudo systemctl restart portal.service`, run the live-send drill, update the "API key last 4" cell here.

### Email outbox runner status

The worker runs inside `portal.service` on a 5-second tick (`setInterval` registered in `server.js`'s entrypoint branch — `build()` itself stays worker-free so tests don't accidentally start it). Implementation: `domain/email-outbox/repo.js` (`enqueue` / `claim` / `markSent` / `markFailed`) + `domain/email-outbox/worker.js` (`tickOnce` / `startWorker`). `claim` runs `SELECT ... FOR UPDATE SKIP LOCKED` inside the caller's transaction, flips `status='sending'` and increments `attempts` in the same UPDATE, and returns the claimed rows.

Retry policy:
- Retryable failure (`e.retryable === true`, i.e. MailerSend 429 / 5xx) → `status='queued'`, `send_after = now() + min(2 ** attempts * 60_000, 3_600_000) ms`, `last_error` populated. The next tick re-claims after `send_after`.
- Non-retryable failure (any other non-202) → `status='failed'` immediately.
- Cap: rows with `attempts >= 5` are never re-claimed (`attempts < 5` in the WHERE clause). The 5th retryable failure becomes `status='failed'` regardless of `e.retryable`.
- After a successful send the worker drops `locals.code` from the row (`UPDATE email_outbox SET locals = locals - 'code'`) so the OTP plaintext doesn't linger after delivery.

`idempotency_key` is **never** rewritten by the worker. M3's `noticeLoginDevice` keys by `adminId+fingerprint+YYYYMM` (commit `ada0a20`); that contract has to hold across retries.

### Integration tests — stopping portal.service

The outbox worker inside `portal.service` polls `email_outbox` every 5 s. Integration tests that insert rows into that table will race the live worker — the live worker claims the row, tries to send via MailerSend, burns a credit, and the test's own `tickOnce` finds the row already in `status='sending'/'sent'`. Tests fail non-deterministically and (worse) fake test data hits real recipients.

Always run integration tests through:

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh        # full suite
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/admins/   # one path
```

The wrapper:
1. Records whether `portal.service` was active.
2. Stops it for the duration of the run.
3. Loads `.env` into the environment vitest workers inherit (so `DATABASE_URL`, `PORTAL_BASE_URL`, etc. are present).
4. Runs `vitest run` as `portal-app` with `RUN_DB_TESTS=1`.
5. Restarts `portal.service` on exit (success or failure) and re-runs `smoke.sh`.

Unit tests (no DB, no service interaction) can still be run directly:

```bash
sudo -u portal-app PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin \
  /opt/dbstudio_portal/node_modules/.bin/vitest run tests/unit/
```

### Email outbox — live smoke

Run on the server when MailerSend keys, DNS, or the worker change. Operator must confirm inbox arrival by reading the message in `bram@roxiplus.es`.

```bash
cd /opt/dbstudio_portal
sudo -u portal-app bash -c '
  cd /opt/dbstudio_portal &&
  set -a; . /opt/dbstudio_portal/.env; set +a;
  PATH=/opt/dbstudio_portal/.node/bin:/usr/bin:/bin RUN_DB_TESTS=1 RUN_LIVE_EMAIL=1 \
    ./node_modules/.bin/vitest run tests/integration/email/live-smoke.test.js'
```

Expected:
1. Vitest enqueues a `generic-admin-message` row to `bram@roxiplus.es`, runs one tick, and asserts `status='sent'`, `sent_at` populated, `last_error=NULL`, `attempts=1`. Test logs the MailerSend `providerId` from the `x-message-id` header.
2. Operator opens `bram@roxiplus.es`, confirms the message arrived, and verifies the headers show `dkim=pass` for `dbstudio.one` (later: `mail.portal.dbstudio.one` once the dedicated subdomain replaces v1's shared sender — see "Email provider state" above).

Failure modes worth knowing:
- 401 Unauthenticated → API key revoked or `.env` quoting bug (the value is wrapped in literal `"…"`; ad-hoc `curl -H "Authorization: Bearer $KEY"` tests must strip the quotes manually first — see "Email provider state").
- 422 with field errors → DKIM/SPF/DMARC misconfiguration on the verified domain. The MailerSend dashboard's "Domains" page is the authoritative diagnostic.
- Vitest hangs at "polling" → the worker process inside the test is stuck in `mailer.send`; check `journalctl -u portal.service` for parallel sends, and confirm the smoke test isn't racing with the live `portal.service` worker (the test creates its own `mailer` + `tickOnce` and is otherwise independent of the running service).

### Display formats — dates and times

Hardcoded across the entire portal (emails *and* server-rendered pages):

| Form | Format | Example |
|---|---|---|
| Date | `DD/MM/YYYY` | `06/05/2026` |
| Date + time | `DD/MM/YYYY HH:mm` (24h, no seconds) | `29/04/2026 13:32` |
| Timezone | Atlantic/Canary (DST-aware) | — |
| Locale | `es-ES` (only affects the day/month/year separators) | — |

All formatting goes through `lib/dates.js` (`euDate`, `euDateTime`). They are:

- Injected into every email template via `lib/email-templates.js` HELPERS.
- Injected into every EJS view via `lib/render.js` VIEW_GLOBALS.
- Independent of the host machine's TZ — they always render Atlantic/Canary wall-clock time.

If a new display surface needs dates, import from `lib/dates.js` rather than calling `Intl.DateTimeFormat` ad-hoc. The DD/MM/YYYY + 24h convention also matches `dbstudio.one`'s contact-form email (`/opt/dbstudio/src/lib/mail.ts`); keep them aligned.

---

## Recovery procedures

### KEK rotation

The master KEK at `/var/lib/portal/master.key` wraps every per-customer DEK. Rotating it means re-wrapping every `customers.dek_*` row with a fresh KEK. Procedure:

1. **Rehearse on a scratch DB before touching production.**
   - Restore the latest backup into a scratch Postgres database.
   - Generate a fake new KEK: `openssl rand -out /tmp/master.key.new 32 && chmod 0400 /tmp/master.key.new`.
   - Run `scripts/rotate-kek.js --dry-run --kek-old /var/lib/portal/master.key --kek-new /tmp/master.key.new --database-url "<scratch-db-url>"`. Output: list of customer rows that would be re-wrapped, no DB writes.
   - Run `scripts/rotate-kek.js --commit ...` against the scratch DB. Confirm one credential decrypts cleanly afterwards using the new KEK.

2. **Production rotation, scheduled-window only.**
   - Generate the new KEK: `sudo -u portal-app openssl rand -out /var/lib/portal/master.key.new 32 && sudo chmod 0400 /var/lib/portal/master.key.new && sudo chown portal-app:portal-app /var/lib/portal/master.key.new`.
   - Off-server backup the new KEK *before* the swap (operator workstation, encrypted password manager).
   - Dry-run: `sudo -u portal-app /opt/dbstudio_portal/.node/bin/node scripts/rotate-kek.js --dry-run --kek-old /var/lib/portal/master.key --kek-new /var/lib/portal/master.key.new`.
   - Commit: same command with `--commit`. The script reads each `customers.dek_*` row, unwraps with the old KEK, re-wraps with the new KEK, and writes back inside a transaction per row.

3. **Swap and restart.**
   - `sudo systemctl stop portal.service`.
   - `sudo mv /var/lib/portal/master.key /var/lib/portal/master.key.old && sudo mv /var/lib/portal/master.key.new /var/lib/portal/master.key`.
   - `sudo systemctl start portal.service`.
   - Verify: `sudo bash /opt/dbstudio_portal/scripts/smoke.sh` (safety-check passes, /health 200), and as a final smoke decrypt one customer credential via the admin UI to confirm the new KEK is live.

4. **24-hour soak.** If no decrypt failures appear in the journal in 24 hours, shred the old KEK: `sudo shred -u /var/lib/portal/master.key.old`. Document the rotation date and reason in the incident log below.

`scripts/rotate-kek.js` is written when first needed (M-after, not in M2). The procedure above defines the contract the script must satisfy.

### Admin password reset / lockout

Use this when an admin has lost their authenticator, forgotten their password, or been locked out by the rate limiter. The procedure issues a fresh single-use invite token; consuming it sets a new password and re-enrols 2FA from scratch (the previous TOTP secret is overwritten). Backup codes are also regenerated; old codes stop working.

Since M4, `service.requestPasswordReset` also enqueues an `admin-pw-reset` email via the outbox worker. The procedure below still prints the URL as a belt-and-braces fallback in case MailerSend is broken or the worker isn't running.

```bash
# 1. SSH to server.

# 2. Until scripts/admin-reset.js exists in M9, mint the invite directly.
#    Generate token + sha256, write the hash to admins. service.requestPasswordReset
#    enqueues an admin-pw-reset email; the script also prints the URL
#    as a fallback so the operator can hand it out-of-band if the email
#    never arrives.
sudo -u portal-app /opt/dbstudio_portal/.node/bin/node <<'NODE'
import { createDb } from '/opt/dbstudio_portal/config/db.js';
import { loadEnv } from '/opt/dbstudio_portal/config/env.js';
import { findByEmail } from '/opt/dbstudio_portal/domain/admins/repo.js';
import * as service from '/opt/dbstudio_portal/domain/admins/service.js';

const email = 'ADMIN_EMAIL_HERE';
const env = loadEnv();
const db = createDb({ connectionString: env.DATABASE_URL });
try {
  const admin = await findByEmail(db, email);
  if (!admin) { console.error('no such admin'); process.exit(1); }
  const r = await service.requestPasswordReset(db, { email },
    { actorType: 'system', audit: { reason: 'operator_reset' } });
  if (!r.inviteToken) { console.error('reset failed (no token)'); process.exit(1); }
  console.log(`${env.PORTAL_BASE_URL.replace(/\/+$/, '')}/reset/${r.inviteToken}`);
} finally { await db.destroy(); }
NODE
```

3. Hand the printed `https://portal.dbstudio.one/reset/<token>` URL to the locked-out admin out of band (Signal, in-person — never the same channel as the original credential).

4. The admin opens the URL within 7 days, sets a new password, scans the new TOTP QR code, enters the six-digit code, and saves the freshly generated 8 backup codes. The session is recorded against the new device fingerprint; the next login from a different network will trigger the new-device email per Task 3.11.

5. If the rate limiter has the admin in lockout (5 failed logins in 15 min → 30-min lockout), clear it explicitly only after step 4 — the reset itself does not bypass the lockout:

```bash
sudo -u postgres psql portal_db -c \
  "DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%:ADMIN_EMAIL_HERE';"
```

6. Audit-log the operator action by tailing the journal for the resulting `admin.password_reset_requested` and (after the admin completes the flow) `admin.password_set_via_invite` rows:

```bash
sudo -u postgres psql portal_db -c \
  "SELECT ts, action, actor_type, metadata FROM audit_log
    WHERE target_id = (SELECT id FROM admins WHERE email = 'ADMIN_EMAIL_HERE')
    ORDER BY ts DESC LIMIT 10;"
```

### Backup restore drill

(Filled at M10.)

### Incident response — secret leaked into git history

If a secret reaches a commit (despite SAFETY.md and the pre-commit hook):

1. **Rotate the affected secret immediately.**
   - DB password: `ALTER ROLE portal_user PASSWORD '<new>';` then `sudoedit /opt/dbstudio_portal/.env` to update `DATABASE_URL`.
   - SESSION/FILE_URL signing secrets: `sudo bash scripts/bootstrap-secrets.sh --rotate-signing` then restart `portal.service`. Existing sessions invalidated; existing signed file URLs invalidated. **Also invalidates every in-flight admin invite and password-reset token** because the welcome-flow TOTP enrol secret is derived from the SESSION_SIGNING_SECRET (`lib/auth/totp-enrol.js`); admins who scanned the QR but did not finish enrolment will silently fail TOTP verify. After rotation, re-issue any open invites via `service.requestPasswordReset`.
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
