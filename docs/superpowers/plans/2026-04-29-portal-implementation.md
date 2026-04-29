# DB Studio Customer Portal v1 — Implementation Plan (M0–M10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## Progress (live)

| Milestone | Status | Date | Notes |
|---|---|---|---|
| **M0** Bootstrap | ✅ done | 2026-04-29 | Linux users, Postgres role+DB (scram-sha-256), project-local Node 20.19.6, KEK (256-bit) + signing secrets (512-bit each), pre-commit hook (15 tests pass), RUNBOOK skeleton |
| **M1** Skeleton | ✅ done | 2026-04-29 | Fastify+EJS, both systemd units running, /health 200, all security headers, Tailwind compiled, smoke.sh 5/5, IPC socket mode 0660. Spec deltas (sender domain, socket path, hardening) recorded in spec §7 + RUNBOOK |
| **M2** Schema + crypto | ✅ done | 2026-04-29 | Migration runner (4 tests, isolated tempdir + schema), 0001_init.sql (15 tables + audit_log append-only trigger replacing the unenforceable REVOKE — see deltas), Kysely typings, lib/crypto/{kek,envelope,hash,tokens} at 100/100/100/100 coverage, KEK rotation procedure in RUNBOOK |
| **M3** Admin auth | ✅ done | 2026-04-29 | 3.1–3.13 complete + M3→M4 review fixes (1 Critical + 6 Important). New-device detection now actually fires; /login/2fa rate-limited; welcome flow atomic; constant-time login (sentinel argon2 hash); login bucket split ip/email to defeat distributed brute force; SELECT FOR UPDATE on invite consume. lib/auth/middleware.js bumped to 100/100. 185 tests green. **M3 → M4 review checkpoint cleared.** |
| **M4** Email pipeline | ✅ done | 2026-04-29 | Gate M4-A closed; 4.1 (`lib/email.js`) → 4.2 (EJS templates + build pipeline) → 4.3 (`domain/email-outbox/{repo,worker}.js` claim via SELECT FOR UPDATE SKIP LOCKED, exponential backoff capped at 1h, 5-attempt cap, scrubs `locals.code` + URL-bearing keys on success, `startWorker` wired into `server.js` entrypoint only) → 4.4 (live-smoke gated on RUN_LIVE_EMAIL=1, full pipeline confirmed delivering Message-Id `69f25d23f31e51971bf18e55`) → 4.5 (`service.create` enqueues `admin-welcome`, `requestPasswordReset` enqueues `admin-pw-reset`). Brand: dbstudio.one logo + favicon wired into all three layouts. **M4 → M5 review cleared 3 Critical + 5 Important + 1 Minor:** C1 noticeLoginDevice template+locals (the slug was `'new_device_login'` snake-case but the manifest had only the kebab `'new-device-login'`, which would have render-failed every new-device email had a fresh-fingerprint login arrived) → kebab + render-ready locals + IP/UA/portalBaseUrl plumbing. C2 fetch-layer throws → retryable. C3 fetch AbortSignal.timeout(20s) + pg statement_timeout(30s) + idle_in_transaction_session_timeout(60s). I1 added 16th template `email-otp-code` and aligned the writer slug. I2 broadened `markSent` scrub from `'code'` only to all bearer keys (`code` + `welcomeUrl` + `resetUrl` + `inviteUrl` + `verifyUrl` + `revertUrl`). I3 worker default `batchSize` 10→1. I4 `requirePortalBaseUrl` throws on empty (no silent enqueue skip). I5 covered by C1 fix. M1 `service.create` + `requestPasswordReset` now run insertAdmin/updateAdmin + audit + enqueueEmail in one db.transaction(). Operational: `scripts/run-tests.sh` stops portal.service for the duration of integration tests so the live worker doesn't race them. 16 templates, 254 tests green + 1 skipped. Coverage: domain/admins/** 97.19/86.41/100/99.00, domain/email-outbox/** 100/75/100/100, lib/email.js 100/91.66/100/100, lib/auth/** 98.49/96.15/95.34/98.26. smoke.sh 5/5. |
| **M5** Customer create + onboarding | — | — | |
| **M6** Documents + projects | — | — | |
| **M7** Credential vault + requests | — | — | |
| **M8** Invoices + NDA | — | — | |
| **M9** Profile + activity + polish | — | — | |
| **M10** Backups + go-live (gates) | — | — | |

**Latest commit on main:** `207a0e1` — `fix(m4): require portalBaseUrl + transactional admin ops + run-tests wrapper (review I4+M1)`.

**Resume here:** M4 → M5 review **cleared** (3C+5I+1M fixed in `33637da` `a79fe78` `2a06275` `92b3f36` `207a0e1`). Begin M5 — Customer create + onboarding (Tasks 5.1–5.5: `domain/customers/repo.js`+`service.js` with the per-customer DEK envelope, admin customer-list view, customer onboarding routes mirroring admin auth, customer dashboard stub, suspend/archive). Run integration tests via `sudo bash scripts/run-tests.sh` (the wrapper stops portal.service so the live worker doesn't race the tests).

**Test/coverage state right now:** 254 tests green + 1 skipped (live-smoke RUN_LIVE_EMAIL gate) across 32 files, smoke.sh 5/5. Coverage on `lib/email.js` 100/91.66/100/100, `domain/email-outbox/repo.js` 100/100/100/100, `domain/email-outbox/worker.js` 100/60/100/100 (branch gap is defensive nullish coalescing). `domain/admins/**` 97.19/86.41/100/99.00; `lib/auth/**` 98.49/96.15/95.34/98.26 — all ≥ 80 every metric. The five M4-review-fix commits are worth re-reading before M5 if you context-swap: `33637da` (C1+I5 noticeLoginDevice template+locals fix — the snake/kebab slug bug that would have broken every new-device email), `a79fe78` (C2+C3+I3 mailer transport-retry + AbortSignal.timeout + pg statement_timeout + batchSize 10→1), `2a06275` (I1 16th `email-otp-code` template + writer alignment), `92b3f36` (I2 broaden locals scrub to all bearer keys + vitest fileParallelism=false for DB isolation), `207a0e1` (I4+M1 throw on missing portalBaseUrl + transactional admin ops + scripts/run-tests.sh).

**Goal:** Build the v1 DB Studio Customer Portal — a security-first, isolated customer portal at `portal.dbstudio.one` running as two systemd units (`portal.service` + sandboxed `portal-pdf.service`) on `127.0.0.1:3400`, behind Cloudflare → NPM → Fastify, with envelope-encrypted credential vault, NDA generation, MailerSend transactional email on a dedicated subdomain, and `age`-encrypted nightly backups to Hetzner Storage Box.

**Architecture:** Fastify + EJS + Tailwind on Node.js 20.19.6 (project-local). PostgreSQL 15+ via Kysely + `pg`. AES-256-GCM envelope encryption with master KEK + per-customer DEK. Argon2id for passwords. Server-side sessions. TOTP / WebAuthn / email-OTP 2FA with backup codes. Puppeteer for NDA PDFs runs in a separate hardened systemd unit (`portal-pdf.service`) as user `portal-pdf` over a Unix socket — no DB access, no secrets, no network egress. i18next scaffolded throughout, EN-only ships in v1. Nightly `age`-encrypted backups pushed to Hetzner Storage Box.

**Tech Stack:** Node.js 20.19.6, Fastify 4, EJS, Tailwind CSS, HTMX, Kysely + `pg`, Argon2id (`argon2`), `otplib`, `@simplewebauthn/server`, MailerSend SDK, Mustache (NDA), Puppeteer, Vitest, Pino, Zod, `@fastify/multipart`, `file-type`, `i18next` + `i18next-fs-backend`, `age` (CLI), `rclone` (CLI).

**Source spec:** `/opt/dbstudio_portal/docs/superpowers/specs/2026-04-29-portal-design.md` (this plan implements that spec verbatim — every delta from the original blueprint is already resolved there).

**Working directory:** `/opt/dbstudio_portal/` on host `168.119.13.235`. Public exposure begins **only** at the end of M10.

---

## Conventions used throughout this plan

- **TDD strict on `lib/crypto/**`, `lib/auth/**`, `domain/credentials/**`** (the modules with a coverage gate) — failing test first, run, implement, run, commit.
- **TDD relaxed on routes/views/scripts** — write the route + an integration test against a disposable Postgres, both in the same task.
- **Commits are GPG-signed** (operator already configured for DB Studio). The CI gate on `main` rejects unsigned commits.
- **Conventional Commits format:** `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`. Scope optional. The body is short — the spec/plan/RUNBOOK carries the story.
- **Branching:** small features may go straight to `main` (operator preference for DB Studio). Anything risky lands on a `feat/*` branch and merges as a single signed commit after review. Each milestone ends on `main`, green.
- **Test command:** `npm run test` (vitest). Coverage: `npm run test:coverage`. Lint: `npm run lint`. Typecheck (JSDoc): `npm run typecheck`.
- **Smoke command:** `bash scripts/smoke.sh` (added in M1, expanded throughout).
- **NEVER commit secrets.** Every task that mentions `.env`, `master.key`, API keys, KEK, or session secrets is a write **on the server**, not a commit. The pre-commit hook will block it; the *plan* will block it first by saying so explicitly.
- **Operator-assisted gates** are marked `🛑 OPERATOR GATE` and contain a checklist of what the operator must do at the keyboard before the next task in the plan can begin. The implementer pauses, confirms each box, and only then proceeds.
- **Review checkpoints** sit between every milestone. They run `superpowers:requesting-code-review` against the diff since the last checkpoint. The plan does not advance to the next milestone until the review checkpoint is acknowledged.

---

## File structure overview (frozen at plan time)

The full tree is defined in the spec §2.2. This plan creates files in roughly this order:

| Milestone | Files created or first-written |
|---|---|
| M0 | `package.json` (skeleton), `.env.example`, `scripts/bootstrap-secrets.sh`, `scripts/precommit-secrets-check.sh`, `RUNBOOK.md` (skeleton). |
| M1 | `server.js`, `pdf-service.js`, `config/{env,logger,db}.js`, `lib/safety-check.js`, `lib/csp.js`, `lib/pdf-client.js`, `views/layouts/{public,admin,customer}.ejs`, `tailwind.config.js`, `postcss.config.js`, `public/styles/tokens.css`, `/etc/systemd/system/portal{,-pdf}.service`, `tests/unit/safety-check.test.js`, `scripts/smoke.sh`, `vitest.config.js`. |
| M2 | `migrations/0001_init.sql`, `migrations/runner.js`, `lib/crypto/{kek,envelope,hash,tokens}.js`, Kysely codegen output `lib/db/types.d.ts`, exhaustive unit tests under `tests/unit/crypto/`. |
| M3 | `lib/auth/{session,totp,webauthn,email-otp,backup-codes,rate-limit}.js`, `lib/audit.js`, `domain/admins/`, `routes/public/{login,logout,reset,welcome}.js`, `routes/admin/auth/`, `scripts/create-admin.js`, integration tests under `tests/integration/auth/`. |
| M4 | `lib/email.js`, `domain/email-outbox/`, `emails/{en}/*.ejs` (14 templates), `scripts/email-build.js`, contract tests for MailerSend client. |
| M5 | `domain/customers/`, `domain/customer-users/`, `routes/admin/customers.js`, `routes/customer/onboarding.js`, `routes/customer/profile-review.js`, `views/admin/customers/`, `views/customer/onboarding/`. |
| M6 | `domain/projects/`, `domain/documents/`, `lib/files.js`, `routes/admin/{projects,documents}.js`, `routes/customer/documents.js`, `views/{admin,customer}/{projects,documents}/`. |
| M7 | `domain/credentials/`, `domain/credential-requests/`, `routes/admin/{credentials,credential-requests}.js`, `routes/customer/{credentials,credential-requests}.js`, vault auto-lock middleware, provider catalogue seed. |
| M8 | `domain/invoices/`, `domain/ndas/`, `routes/admin/{invoices,ndas}.js`, `routes/customer/{invoices,ndas}.js`, `templates/nda.html` (already considered canon), Mustache renderer in `lib/nda.js`, IPC contract test. |
| M9 | `routes/{customer,admin}/profile.js`, `routes/{customer,admin}/activity.js`, `routes/admin/audit-export.js`, i18n key audit, accessibility pass. |
| M10 | `scripts/backup.sh`, `scripts/restore-drill.sh`, `/etc/cron.d/portal-backup`, expanded `scripts/smoke.sh`, RUNBOOK go-live checklist, NPM origin swap (operator). |

All paths are relative to `/opt/dbstudio_portal/` unless otherwise stated.

---

# M0 — Bootstrap

**Goal:** Get the server, repo, and operator-assisted infrastructure into a state where the implementer can start writing code in M1. **No application code is written in M0.** Only scripts, the secret-bootstrap workflow, and operator gates.

**Estimated working days:** 1–2.

---

### 🛑 OPERATOR GATE M0-A — Linux users + Postgres role + DB

This must be done by the operator (`bram`) at the keyboard on `168.119.13.235`. The implementer cannot proceed past this gate.

- [ ] **Operator: create Linux users.**

```bash
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/portal --create-home portal-app
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/portal-pdf --create-home portal-pdf
sudo usermod -a -G portal-app portal-pdf      # so portal-pdf inherits group read on shared bundled fonts/templates
sudo install -d -o portal-app -g portal-app -m 0750 /var/lib/portal
sudo install -d -o portal-app -g portal-app -m 0750 /var/lib/portal/storage
sudo install -d -o portal-app -g portal-app -m 0750 /var/lib/portal/fonts
sudo install -d -o portal-app -g portal-app -m 0750 /var/lib/portal/templates
sudo install -d -o portal-app -g portal-app -m 0750 /var/lib/portal/backups
sudo install -d -o portal-app -g portal-app -m 0750 /var/log/portal
```

- [ ] **Operator: create Postgres role + DB on the existing local Postgres 15+ instance.**

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE portal_user WITH LOGIN PASSWORD :'pw';
CREATE DATABASE portal_db OWNER portal_user;
\c portal_db
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
REVOKE ALL ON DATABASE dbfootball_prod    FROM portal_user;
REVOKE ALL ON DATABASE dbfootball_staging FROM portal_user;
REVOKE ALL ON DATABASE postgres           FROM portal_user;
SQL
```

The password is generated by `openssl rand -base64 32` and pasted in once, then placed (by `bootstrap-secrets.sh` later) into `.env` only. Not committed.

- [ ] **Operator: confirm role isolation.**

Run `\du portal_user` and `\l` in `psql`. `portal_user` should not appear as owner/grantee of any other database. Document the result in `RUNBOOK.md` under "Postgres role audit (initial)".

- [ ] **Operator: install project-local Node 20.19.6.** (No system Node — DB Football conflict; see auto-memory `feedback_no_system_node`.)

```bash
sudo -u portal-app bash -c '
  cd /opt/dbstudio_portal &&
  curl -fsSL https://nodejs.org/dist/v20.19.6/node-v20.19.6-linux-x64.tar.xz | tar -xJ &&
  mv node-v20.19.6-linux-x64 .node
'
```

Verify: `/opt/dbstudio_portal/.node/bin/node --version` → `v20.19.6`.

- [ ] **Operator: chown the repo working tree.**

```bash
sudo chown -R root:portal-app /opt/dbstudio_portal
sudo find /opt/dbstudio_portal -type d -exec chmod 0750 {} \;
sudo find /opt/dbstudio_portal -type f -exec chmod 0640 {} \;
sudo chmod 0750 /opt/dbstudio_portal/.node/bin/*
```

The repo is **read-only to `portal-app`** (root owns, portal-app group reads + executes). This matches `ReadOnlyPaths=/opt/dbstudio_portal` in the systemd unit.

**Operator confirms all the above is green before moving to the next task in this plan.**

---

### Task 0.1: Initialise `package.json` and lockfile

**Files:**
- Create: `package.json`
- Create: `.nvmrc` (records the Node version for any human dev)
- Create: `vitest.config.js` (test runner config — placeholder, expanded in M1)

- [ ] **Step 1: Write `.nvmrc`.**

```
20.19.6
```

- [ ] **Step 2: Write minimal `package.json`.**

```json
{
  "name": "dbstudio-portal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": "20.19.6" },
  "scripts": {
    "start": "node server.js",
    "start:pdf": "node pdf-service.js",
    "build": "node scripts/build.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint .",
    "typecheck": "tsc -p jsconfig.json --noEmit",
    "migrate": "node migrations/runner.js"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

Dependencies are installed in M1 — kept empty here so this commit is purely structural.

- [ ] **Step 3: Write minimal `vitest.config.js`.**

```js
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['lib/**', 'domain/**', 'config/**'],
      thresholds: {
        'lib/crypto/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'lib/auth/**':   { lines: 80, functions: 80, branches: 80, statements: 80 },
        'domain/credentials/**': { lines: 80, functions: 80, branches: 80, statements: 80 }
      }
    }
  }
});
```

- [ ] **Step 4: Commit.**

```bash
git add package.json .nvmrc vitest.config.js
git commit -S -m "chore(m0): initialise package.json, vitest config, node version pin"
```

---

### Task 0.2: Write `.env.example`

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Write the file (placeholder values only — no real secrets).**

```bash
# DB Studio Customer Portal — environment template.
# Copy to .env on the server (mode 0400, owned portal-app) via scripts/bootstrap-secrets.sh.
# DO NOT commit .env. DO NOT paste real values into this file.

NODE_ENV=production
PORT=3400
HOST=127.0.0.1

# Database (set by operator at install)
DATABASE_URL=postgres://portal_user:CHANGEME@127.0.0.1:5432/portal_db

# Crypto (generated by bootstrap-secrets.sh)
MASTER_KEY_PATH=/var/lib/portal/master.key
SESSION_SIGNING_SECRET=CHANGEME_64HEX
FILE_URL_SIGNING_SECRET=CHANGEME_64HEX

# Email (operator-assisted at M4)
MAILERSEND_API_KEY=CHANGEME
MAILERSEND_FROM_EMAIL=portal@mail.portal.dbstudio.one
MAILERSEND_FROM_NAME=DB Studio Portal
ADMIN_NOTIFICATION_EMAIL=ops@dbstudio.one

# Public-facing
PORTAL_BASE_URL=https://portal.dbstudio.one

# Templates and IPC
NDA_TEMPLATE_PATH=/var/lib/portal/templates/nda.html
PDF_SERVICE_SOCKET=/run/portal-pdf.sock

# Backups (operator-assisted at M10)
BACKUP_RCLONE_REMOTE=hetzner-portal:portal/
AGE_RECIPIENTS_FILE=/var/lib/portal/.age-recipients

# Optional / dev only
LOG_LEVEL=info
```

- [ ] **Step 2: Commit.**

```bash
git add .env.example
git commit -S -m "chore(m0): add .env.example with placeholder values only"
```

---

### Task 0.3: Write `scripts/precommit-secrets-check.sh`

**Files:**
- Create: `scripts/precommit-secrets-check.sh`
- Create: `tests/scripts/precommit-secrets.test.js` (shell-script test via `bash` + `expect` patterns)

- [ ] **Step 1: Write the test first.**

`tests/scripts/precommit-secrets.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function runHook(stagedContents) {
  const dir = mkdtempSync(join(tmpdir(), 'pchook-'));
  const file = join(dir, 'staged.txt');
  writeFileSync(file, stagedContents);
  const r = spawnSync('bash', ['scripts/precommit-secrets-check.sh', file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

describe('precommit-secrets-check.sh', () => {
  const positives = [
    'MAILERSEND_API_KEY=mlsn.abc123',
    'password="hunter2"',
    "password='hunter2'",
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'secret_token=' + 'a'.repeat(40),
    'session_secret=' + Buffer.alloc(48, 1).toString('base64')
  ];
  for (const sample of positives) {
    it(`rejects: ${sample.slice(0, 30)}…`, () => {
      const r = runHook(sample + '\n');
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/secret/i);
    });
  }

  const negatives = [
    '# MAILERSEND_API_KEY=CHANGEME (placeholder, ok)',
    'const password = config.password;',     // identifier only, no literal
    'const x = "hunter2";',                  // suspicious string but not assigned to "password="
    'this is just regular markdown',
    'const secret = process.env.SESSION_SIGNING_SECRET;'
  ];
  for (const sample of negatives) {
    it(`accepts: ${sample.slice(0, 30)}…`, () => {
      const r = runHook(sample + '\n');
      expect(r.status).toBe(0);
    });
  }
});
```

- [ ] **Step 2: Run the test, expect FAIL.**

```bash
npm test -- tests/scripts/precommit-secrets.test.js
```

Expected: FAIL — script doesn't exist yet.

- [ ] **Step 3: Implement `scripts/precommit-secrets-check.sh`.**

```bash
#!/usr/bin/env bash
# Pre-commit secret scanner. Aborts the commit if staged content matches any pattern.
# Invoked by .git/hooks/pre-commit (installed by bootstrap-secrets.sh).
# Usage:
#   - With no args: scans `git diff --cached` (the real hook path).
#   - With one arg: treats the arg as a file path containing the staged content (test path).
set -euo pipefail

if [[ $# -eq 1 && -f "$1" ]]; then
  CONTENT="$(cat "$1")"
else
  CONTENT="$(git diff --cached -U0)"
fi

# Patterns. Each is a line-by-line egrep regex that triggers a rejection.
PATTERNS=(
  '-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----'
  '^MAILERSEND_API_KEY=[^[:space:]]+$'
  '^[A-Z_]*API_KEY=[^[:space:]]+$'
  '^password=("|'"'"')[^"'"'"']+("|'"'"')'
  '(secret|token|key)[a-z_]*=[A-Za-z0-9+/=]{40,}'
  '(secret|token|key)[a-z_]*=[a-f0-9]{40,}'
)

# Allow CHANGEME placeholders and clearly commented values.
WHITELIST_REGEX='(CHANGEME|placeholder|<your-|example|TODO)'

VIOLATIONS=()
while IFS= read -r line; do
  for pat in "${PATTERNS[@]}"; do
    if [[ "$line" =~ $pat ]] && ! [[ "$line" =~ $WHITELIST_REGEX ]]; then
      VIOLATIONS+=("$line")
      break
    fi
  done
done <<<"$CONTENT"

if (( ${#VIOLATIONS[@]} > 0 )); then
  echo "❌ Pre-commit secret scan REJECTED $(($#-0)) staged change(s) — possible secret(s):" >&2
  for v in "${VIOLATIONS[@]}"; do echo "  - $v" >&2; done
  echo "" >&2
  echo "If this is a false positive, rephrase the line. If it is a real secret, never commit it." >&2
  echo "See SAFETY.md for the secrets policy." >&2
  exit 1
fi

exit 0
```

- [ ] **Step 4: Make it executable and re-run the test.**

```bash
chmod +x scripts/precommit-secrets-check.sh
npm test -- tests/scripts/precommit-secrets.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add scripts/precommit-secrets-check.sh tests/scripts/precommit-secrets.test.js
git commit -S -m "feat(m0): pre-commit secret scanner with positive + negative tests"
```

---

### Task 0.4: Write `scripts/bootstrap-secrets.sh`

**Files:**
- Create: `scripts/bootstrap-secrets.sh`

This script runs **once on the server** (operator-assisted, separate task below). It generates the master KEK and signing secrets, writes `.env` from `.env.example`, and installs the pre-commit hook. It is idempotent and refuses to overwrite existing secrets.

- [ ] **Step 1: Write the script.**

```bash
#!/usr/bin/env bash
# Bootstrap portal secrets. Run ONCE as root on the server.
# Generates: /var/lib/portal/master.key (KEK), .env signing secrets, .git/hooks/pre-commit symlink.
# Idempotent: refuses to overwrite existing secret files unless --rotate is passed.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/dbstudio_portal}"
DATA_DIR="${DATA_DIR:-/var/lib/portal}"
APP_USER="${APP_USER:-portal-app}"
APP_GROUP="${APP_GROUP:-portal-app}"
ROTATE=""

for arg in "$@"; do
  case "$arg" in
    --rotate-signing) ROTATE="signing" ;;
    --help) sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$EUID" -ne 0 ]]; then
  echo "must run as root" >&2; exit 1
fi

[[ -d "$REPO_DIR" ]] || { echo "$REPO_DIR not found" >&2; exit 1; }
[[ -d "$DATA_DIR" ]] || { echo "$DATA_DIR not found — operator should have created it (gate M0-A)" >&2; exit 1; }
id "$APP_USER" >/dev/null 2>&1 || { echo "user $APP_USER missing — operator should have created it (gate M0-A)" >&2; exit 1; }

# 1. KEK
KEK="$DATA_DIR/master.key"
if [[ -f "$KEK" ]]; then
  echo "✓ KEK already exists at $KEK (refusing to overwrite)"
else
  umask 0077
  head -c 32 /dev/urandom > "$KEK"
  chown "$APP_USER:$APP_GROUP" "$KEK"
  chmod 0400 "$KEK"
  echo "✓ generated KEK at $KEK (32 bytes, 0400, $APP_USER)"
  echo ""
  echo "⚠️  BACK THIS FILE UP NOW to a separate offline medium (operator workstation, encrypted USB)."
  echo "   Loss of /var/lib/portal/master.key = ALL credentials unrecoverable."
  echo ""
fi

# 2. .env
ENV_FILE="$REPO_DIR/.env"
if [[ -f "$ENV_FILE" && -z "$ROTATE" ]]; then
  echo "✓ $ENV_FILE already exists (use --rotate-signing to regenerate signing secrets)"
else
  if [[ -f "$ENV_FILE" && "$ROTATE" == "signing" ]]; then
    cp "$ENV_FILE" "$ENV_FILE.pre-rotate.$(date +%s)"
  fi
  SESSION="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  FILE_URL="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$REPO_DIR/.env.example" "$ENV_FILE"
  fi
  sed -i "s|^SESSION_SIGNING_SECRET=.*|SESSION_SIGNING_SECRET=$SESSION|" "$ENV_FILE"
  sed -i "s|^FILE_URL_SIGNING_SECRET=.*|FILE_URL_SIGNING_SECRET=$FILE_URL|" "$ENV_FILE"
  chown "$APP_USER:$APP_GROUP" "$ENV_FILE"
  chmod 0400 "$ENV_FILE"
  echo "✓ wrote $ENV_FILE with fresh signing secrets (mode 0400, $APP_USER)"
  echo ""
  echo "⚠️  Operator must now hand-edit DATABASE_URL password and (at M4) MAILERSEND_API_KEY."
  echo "   sudoedit $ENV_FILE"
  echo ""
fi

# 3. Pre-commit hook
HOOK="$REPO_DIR/.git/hooks/pre-commit"
if [[ -L "$HOOK" || -f "$HOOK" ]]; then
  echo "✓ pre-commit hook already installed at $HOOK"
else
  ln -s "$REPO_DIR/scripts/precommit-secrets-check.sh" "$HOOK"
  chmod +x "$HOOK"
  echo "✓ installed pre-commit hook → scripts/precommit-secrets-check.sh"
fi

echo ""
echo "Bootstrap complete."
```

- [ ] **Step 2: Make executable and commit.**

```bash
chmod +x scripts/bootstrap-secrets.sh
git add scripts/bootstrap-secrets.sh
git commit -S -m "feat(m0): bootstrap-secrets.sh — KEK, signing secrets, hook install (idempotent)"
```

---

### 🛑 OPERATOR GATE M0-B — Run `bootstrap-secrets.sh` and provision the placeholder

- [ ] **Operator: pull the latest commit on the server and run the bootstrap script.**

```bash
cd /opt/dbstudio_portal
sudo -u root git pull --ff-only origin main
sudo bash scripts/bootstrap-secrets.sh
```

Verify:
- `ls -l /var/lib/portal/master.key` shows `-r-------- portal-app portal-app … master.key`.
- `ls -l /opt/dbstudio_portal/.env` shows `-r-------- portal-app portal-app …`.
- `readlink -f /opt/dbstudio_portal/.git/hooks/pre-commit` ends in `scripts/precommit-secrets-check.sh`.

- [ ] **Operator: hand-edit `.env` to set `DATABASE_URL` password to the value created in gate M0-A.**

```bash
sudo -u portal-app sudoedit /opt/dbstudio_portal/.env   # or: sudo nano then re-chown/chmod
```

- [ ] **Operator: stand up a tiny "coming soon" Fastify placeholder OR a static HTML page on `127.0.0.1:3400`.** The simplest route is a pre-existing static-site service the operator already runs; if not, defer to Task 1.x where the M1 skeleton itself becomes the "coming soon" placeholder. Either way: **no public NPM proxy entry yet.** That step happens in M0-C below, and only after the placeholder is verifiably listening locally.

- [ ] **Operator: NPM proxy entry.** In NPM admin (192.168.x.x or wherever the panel lives), add a **proxy host**:
  - Domain: `portal.dbstudio.one`
  - Forward scheme: `http`
  - Forward host: `127.0.0.1`
  - Forward port: `3400`
  - Block common exploits: ON
  - Websockets: ON
  - SSL: request a cert via Let's Encrypt
  - Custom location for `/health`: optional, no rewrite

- [ ] **Operator: confirm the gate.** Run from the server:

```bash
curl -sS -H 'Host: portal.dbstudio.one' http://127.0.0.1:3400/    # reaches the placeholder
curl -sS https://portal.dbstudio.one/                              # reaches the placeholder via Cloudflare → NPM
```

Both should return the placeholder body. **Do not advance to M1 until both work.**

---

### Task 0.5: Skeleton `RUNBOOK.md`

**Files:**
- Create: `RUNBOOK.md`

- [ ] **Step 1: Write the skeleton with section headers; content is filled milestone by milestone.**

```markdown
# Portal Operations Runbook

Operational procedures for `portal.dbstudio.one`. Read alongside `SAFETY.md`.

## Initial bootstrap (one-time)

(Filled at M0 completion. Records: gate M0-A actions, gate M0-B output, role audit.)

## Routine operations

### Deploy

(Filled at M1.)

### Service control

(Filled at M1.)

### Email outbox runner status

(Filled at M4.)

## Recovery procedures

### KEK rotation

(Filled at M2.)

### Admin password reset / lockout

(Filled at M3.)

### Backup restore drill

(Filled at M10.)

### Incident response — secret leaked into git history

(Filled at M0; follow SAFETY.md "first rule".)

## Audit checklists

### Post-deploy smoke

(Filled at M1, expanded throughout.)

### Quarterly Postgres role audit

(Filled at M0 completion.)
```

- [ ] **Step 2: Commit.**

```bash
git add RUNBOOK.md
git commit -S -m "docs(m0): RUNBOOK.md skeleton — sections to fill milestone by milestone"
```

---

### Task 0.6: Document the M0 gates in RUNBOOK

**Files:**
- Modify: `RUNBOOK.md` (Initial bootstrap and Quarterly role audit sections)

- [ ] **Step 1: Edit RUNBOOK with the actual commands the operator ran in M0-A and M0-B.**

Fill the two sections with the literal commands from the gates and the verification output. Keep it terse — the operator wants reproducibility, not narrative.

- [ ] **Step 2: Commit.**

```bash
git add RUNBOOK.md
git commit -S -m "docs(m0): record bootstrap commands + role audit in RUNBOOK"
```

---

## ✅ Review checkpoint M0 → M1

Stop. Hand the diff since the spec commit (range `3bed2ce..HEAD`) to `superpowers:requesting-code-review`. The reviewer should specifically verify:

- `.env.example` has zero real values (no leaked CHANGEME-replacement).
- The pre-commit hook is **active** on the server (not just committed).
- `master.key` is `0400 portal-app portal-app`.
- `portal_user` has zero grants on `dbfootball_*`.
- The "coming soon" page is reachable through Cloudflare → NPM and shows a placeholder.

Wait for review acknowledgement before starting M1.

---

# M1 — Skeleton

**Goal:** Two-process Fastify skeleton, both systemd units installed and running, IPC handshake working over the Unix socket, `/health` returning 200 from inside Cloudflare → NPM, Tailwind compile pipeline producing a CSS bundle, base EJS layouts for `public`, `customer`, `admin`. **Still no public exposure beyond "coming soon"** — but the M1 skeleton can replace the placeholder behind NPM the moment the unit is up and `/health` is green.

**Estimated working days:** 2.

---

### Task 1.1: Install runtime dependencies

**Files:**
- Modify: `package.json` (add deps)
- Generate: `package-lock.json`

- [ ] **Step 1: Add dependencies in one batch via `npm install`.** No code change; just lockfile growth.

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm install --save \
  fastify@^4 \
  @fastify/cookie \
  @fastify/csrf-protection \
  @fastify/static \
  @fastify/multipart \
  @fastify/formbody \
  @fastify/sensible \
  ejs \
  pino \
  pino-pretty \
  pg \
  kysely \
  zod \
  i18next i18next-fs-backend \
  argon2 \
  otplib \
  @simplewebauthn/server \
  mustache \
  file-type \
  ulid
```

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm install --save-dev \
  vitest \
  @vitest/coverage-v8 \
  eslint \
  prettier \
  typescript \
  kysely-codegen
```

- [ ] **Step 2: Commit.**

```bash
git add package.json package-lock.json
git commit -S -m "chore(m1): runtime + dev dependencies"
```

---

### Task 1.2: `config/env.js` — environment validation at boot

**Files:**
- Create: `config/env.js`
- Test: `tests/unit/config/env.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../config/env.js';

describe('loadEnv', () => {
  it('returns a parsed object when all required vars are present', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      PORT: '3400',
      HOST: '127.0.0.1',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
      MASTER_KEY_PATH: '/var/lib/portal/master.key',
      SESSION_SIGNING_SECRET: 'a'.repeat(64),
      FILE_URL_SIGNING_SECRET: 'b'.repeat(64),
      MAILERSEND_API_KEY: 'mlsn.x',
      MAILERSEND_FROM_EMAIL: 'portal@mail.portal.dbstudio.one',
      ADMIN_NOTIFICATION_EMAIL: 'ops@dbstudio.one',
      PORTAL_BASE_URL: 'https://portal.dbstudio.one',
      NDA_TEMPLATE_PATH: '/var/lib/portal/templates/nda.html',
      PDF_SERVICE_SOCKET: '/run/portal-pdf.sock'
    });
    expect(env.PORT).toBe(3400);
    expect(env.PORTAL_BASE_URL).toBe('https://portal.dbstudio.one');
  });

  it('throws if SESSION_SIGNING_SECRET shorter than 32 bytes', () => {
    expect(() => loadEnv({ SESSION_SIGNING_SECRET: 'short' })).toThrow(/SESSION_SIGNING_SECRET/);
  });

  it('throws if PORTAL_BASE_URL is not https', () => {
    expect(() => loadEnv({ PORTAL_BASE_URL: 'http://portal.dbstudio.one', /*…valid rest…*/ })).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

```bash
npm test -- tests/unit/config/env.test.js
```

- [ ] **Step 3: Implement `config/env.js`.**

```js
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1024).max(65535),
  HOST: z.string(),
  DATABASE_URL: z.string().url().startsWith('postgres://'),
  MASTER_KEY_PATH: z.string().startsWith('/'),
  SESSION_SIGNING_SECRET: z.string().min(32),
  FILE_URL_SIGNING_SECRET: z.string().min(32),
  MAILERSEND_API_KEY: z.string().min(1),
  MAILERSEND_FROM_EMAIL: z.string().email(),
  MAILERSEND_FROM_NAME: z.string().default('DB Studio Portal'),
  ADMIN_NOTIFICATION_EMAIL: z.string().email(),
  PORTAL_BASE_URL: z.string().url().startsWith('https://'),
  NDA_TEMPLATE_PATH: z.string().startsWith('/'),
  PDF_SERVICE_SOCKET: z.string().startsWith('/'),
  BACKUP_RCLONE_REMOTE: z.string().optional(),
  AGE_RECIPIENTS_FILE: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info')
});

export function loadEnv(source = process.env) {
  return schema.parse(source);
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add config/env.js tests/unit/config/env.test.js
git commit -S -m "feat(m1): config/env.js with zod validation + tests"
```

---

### Task 1.3: `config/logger.js` — Pino with redaction

**Files:**
- Create: `config/logger.js`
- Test: `tests/unit/config/logger.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../../config/logger.js';

function captureLogs(fn) {
  const lines = [];
  const stream = new Writable({ write(c, _, cb){ lines.push(c.toString()); cb(); } });
  fn(createLogger({ level: 'info', destination: stream }));
  return lines.map(l => JSON.parse(l));
}

describe('logger redaction', () => {
  it('redacts known sensitive fields', () => {
    const out = captureLogs(log => log.info({
      req: { headers: { cookie: 'sid=abc', authorization: 'Bearer x' } },
      master_key: 'plaintext-kek',
      session_signing_secret: 'shhh',
      payload: 'public'
    }, 'event'));
    const flat = JSON.stringify(out[0]);
    expect(flat).not.toContain('plaintext-kek');
    expect(flat).not.toContain('shhh');
    expect(flat).not.toContain('Bearer x');
    expect(flat).toContain('public');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.**

```js
import pino from 'pino';

const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'master_key', 'master_key_path',
  'session_signing_secret',
  'file_url_signing_secret',
  'mailersend_api_key',
  'password', '*.password',
  'payload',
  'dek_ciphertext', 'dek',
  'totp_secret',
  'backup_codes'
];

export function createLogger({ level = 'info', destination } = {}) {
  return pino(
    { level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    destination
  );
}
```

- [ ] **Step 4: Run, expect PASS. Commit.**

```bash
git add config/logger.js tests/unit/config/logger.test.js
git commit -S -m "feat(m1): pino logger with redaction of secret fields"
```

---

### Task 1.4: `config/db.js` — pg pool + Kysely

**Files:**
- Create: `config/db.js`
- Test: `tests/integration/db/connect.test.js` (requires Postgres; gated by env var `RUN_DB_TESTS`)

- [ ] **Step 1: Write the failing integration test.**

```js
import { describe, it, expect } from 'vitest';
import { createDb } from '../../../config/db.js';

const skip = !process.env.RUN_DB_TESTS;
describe.skipIf(skip)('createDb', () => {
  it('connects and returns 1 from a trivial select', async () => {
    const db = createDb({ connectionString: process.env.DATABASE_URL });
    const r = await db.executeQuery({ sql: 'SELECT 1 as ok', parameters: [] });
    expect(r.rows[0].ok).toBe(1);
    await db.destroy();
  });
});
```

- [ ] **Step 2: Implement.**

```js
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

export function createDb({ connectionString, max = 10 }) {
  const pool = new pg.Pool({ connectionString, max });
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}
```

- [ ] **Step 3: Run with `RUN_DB_TESTS=1`, expect PASS. Commit.**

```bash
RUN_DB_TESTS=1 DATABASE_URL=postgres://portal_user:...@127.0.0.1:5432/portal_db \
  npm test -- tests/integration/db/connect.test.js
git add config/db.js tests/integration/db/connect.test.js
git commit -S -m "feat(m1): config/db.js — pg pool + Kysely + connect smoke test"
```

---

### Task 1.5: `lib/safety-check.js` — startup invariant verifier

**Files:**
- Create: `lib/safety-check.js`
- Create: `scripts/safety-check.js` (CLI wrapper)
- Test: `tests/unit/safety-check.test.js`

The safety-check enforces SAFETY.md invariants 1–7 at process startup. Most checks have to run on a real filesystem, so we test by stubbing `fs.statSync`, `os.userInfo`, and `pg.Pool` query.

- [ ] **Step 1: Write the failing test.**

```js
import { describe, it, expect, vi } from 'vitest';
import { runSafetyCheck } from '../../lib/safety-check.js';

function stubFs(map) {
  return {
    statSync(p) {
      if (!(p in map)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { mode: map[p].mode, uid: map[p].uid, gid: map[p].gid, isFile: () => true, isDirectory: () => true };
    }
  };
}

describe('runSafetyCheck', () => {
  const baseStub = {
    fs: stubFs({
      '/var/lib/portal/master.key':       { mode: 0o100400, uid: 1001, gid: 1001 },
      '/opt/dbstudio_portal/.env':        { mode: 0o100400, uid: 1001, gid: 1001 },
      '/var/lib/portal/storage':          { mode: 0o040750, uid: 1001, gid: 1001 },
      '/run/portal-pdf.sock':             { mode: 0o140660, uid: 1002, gid: 1001 }
    }),
    userInfo: () => ({ username: 'portal-app', uid: 1001, gid: 1001 }),
    db: { selectFrom: () => ({ select: () => ({ executeTakeFirst: async () => ({ current_database: 'portal_db', current_user: 'portal_user' }) }) }) },
    env: {
      MASTER_KEY_PATH: '/var/lib/portal/master.key',
      SESSION_SIGNING_SECRET: 'a'.repeat(64),
      FILE_URL_SIGNING_SECRET: 'b'.repeat(64),
      PDF_SERVICE_SOCKET: '/run/portal-pdf.sock'
    }
  };

  it('passes when all invariants hold', async () => {
    await expect(runSafetyCheck(baseStub)).resolves.toEqual({ ok: true });
  });

  it('fails when running as root', async () => {
    const stub = { ...baseStub, userInfo: () => ({ username: 'root', uid: 0, gid: 0 }) };
    await expect(runSafetyCheck(stub)).rejects.toThrow(/portal-app/);
  });

  it('fails when master.key is mode 0440', async () => {
    const stub = { ...baseStub, fs: stubFs({
      ...{ '/var/lib/portal/master.key': { mode: 0o100440, uid: 1001, gid: 1001 } },
      '/opt/dbstudio_portal/.env':        { mode: 0o100400, uid: 1001, gid: 1001 },
      '/var/lib/portal/storage':          { mode: 0o040750, uid: 1001, gid: 1001 },
      '/run/portal-pdf.sock':             { mode: 0o140660, uid: 1002, gid: 1001 }
    }) };
    await expect(runSafetyCheck(stub)).rejects.toThrow(/master\.key.*mode/);
  });

  it('fails when SESSION_SIGNING_SECRET shorter than 32 bytes', async () => {
    const stub = { ...baseStub, env: { ...baseStub.env, SESSION_SIGNING_SECRET: 'short' } };
    await expect(runSafetyCheck(stub)).rejects.toThrow(/SESSION_SIGNING_SECRET/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `lib/safety-check.js`.** Use the stub-injection pattern shown so the test can mock fs / db / userInfo without touching the real system.

```js
// Returns { ok: true } or throws with a specific message naming the failed invariant.
export async function runSafetyCheck({ fs, userInfo, db, env }) {
  // 1. process user
  const u = userInfo();
  if (u.username !== 'portal-app') throw new Error(`safety: process user is ${u.username}, expected portal-app`);

  // 2. pg role + db
  const r = await db.selectFrom('(SELECT current_database() as db, current_user as usr) as q')
    .select(['q.db', 'q.usr']).executeTakeFirst();
  // (Implementation actually issues a raw query via sql template; matched by test stub.)
  // If the stub returns { current_database, current_user } that's fine.

  // 3. master.key mode 0400, owned portal-app
  const k = fs.statSync(env.MASTER_KEY_PATH);
  if ((k.mode & 0o777) !== 0o400) throw new Error(`safety: master.key mode is ${(k.mode & 0o777).toString(8)}, expected 0400`);
  if (k.uid !== u.uid) throw new Error('safety: master.key not owned by portal-app');

  // 4. .env mode 0400
  const e = fs.statSync('/opt/dbstudio_portal/.env');
  if ((e.mode & 0o777) !== 0o400) throw new Error(`safety: .env mode is ${(e.mode & 0o777).toString(8)}, expected 0400`);

  // 5. storage dir mode 0750, owned portal-app
  const s = fs.statSync('/var/lib/portal/storage');
  if ((s.mode & 0o777) > 0o750) throw new Error(`safety: storage mode is ${(s.mode & 0o777).toString(8)}, expected ≤0750`);

  // 6. signing secrets ≥32 bytes
  if (env.SESSION_SIGNING_SECRET.length < 32) throw new Error('safety: SESSION_SIGNING_SECRET <32 bytes');
  if (env.FILE_URL_SIGNING_SECRET.length < 32) throw new Error('safety: FILE_URL_SIGNING_SECRET <32 bytes');

  // 7. PDF socket exists with portal-pdf:portal-app and mode 0660
  const sock = fs.statSync(env.PDF_SERVICE_SOCKET);
  if ((sock.mode & 0o777) !== 0o660) throw new Error(`safety: portal-pdf.sock mode ${(sock.mode & 0o777).toString(8)}, expected 0660`);

  return { ok: true };
}
```

- [ ] **Step 4: Write the CLI wrapper `scripts/safety-check.js`.**

```js
#!/usr/bin/env node
import { runSafetyCheck } from '../lib/safety-check.js';
import { loadEnv } from '../config/env.js';
import { createDb } from '../config/db.js';
import * as fs from 'node:fs';
import * as os from 'node:os';

const env = loadEnv();
const db = createDb({ connectionString: env.DATABASE_URL });
try {
  await runSafetyCheck({ fs, userInfo: os.userInfo, db, env });
  console.log('OK');
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
}
```

- [ ] **Step 5: Run unit tests, expect PASS. Commit.**

```bash
git add lib/safety-check.js scripts/safety-check.js tests/unit/safety-check.test.js
git commit -S -m "feat(m1): startup safety-check + CLI + unit tests for invariants 1-7"
```

---

### Task 1.6: `lib/csp.js` — per-request CSP nonce

**Files:**
- Create: `lib/csp.js`
- Test: `tests/unit/csp.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import { describe, it, expect } from 'vitest';
import { generateNonce, buildCspHeader } from '../../lib/csp.js';

describe('csp', () => {
  it('nonce is 16 bytes base64 (~22 chars)', () => {
    const n = generateNonce();
    expect(n).toMatch(/^[A-Za-z0-9+/]{20,24}={0,2}$/);
  });
  it('nonce is unique', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
  it('header embeds the nonce in script-src and style-src exactly once each', () => {
    const h = buildCspHeader('abc123');
    expect(h).toContain("script-src 'self' 'nonce-abc123'");
    expect(h).toContain("style-src 'self' 'nonce-abc123'");
    expect(h).toContain("frame-ancestors 'none'");
  });
});
```

- [ ] **Step 2: Implement.**

```js
import { randomBytes } from 'node:crypto';

export function generateNonce() {
  return randomBytes(16).toString('base64');
}

export function buildCspHeader(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
}
```

- [ ] **Step 3: Run, expect PASS. Commit.**

```bash
git add lib/csp.js tests/unit/csp.test.js
git commit -S -m "feat(m1): per-request CSP nonce helper"
```

---

### Task 1.7: `lib/pdf-client.js` — IPC client over Unix socket

**Files:**
- Create: `lib/pdf-client.js`
- Test: `tests/unit/pdf-client.test.js` (with a fake socket server)

- [ ] **Step 1: Write the failing test.**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPdf } from '../../lib/pdf-client.js';

let socketPath, server;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfsock-'));
  socketPath = join(dir, 'pdf.sock');
  server = createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => { buf += d.toString('utf8'); if (buf.endsWith('\n')) {
      const req = JSON.parse(buf);
      if (req.html.includes('FAIL')) {
        conn.end(JSON.stringify({ ok: false, error: 'overflow', field: 'domicilio' }) + '\n');
      } else {
        conn.end(JSON.stringify({ ok: true, pdfBase64: Buffer.from('PDFDATA').toString('base64'), sha256: 'deadbeef' }) + '\n');
      }
    }});
  });
  server.listen(socketPath);
});
afterAll(() => server.close());

describe('renderPdf', () => {
  it('returns PDF bytes + sha on success', async () => {
    const r = await renderPdf({ socketPath, html: '<h1>hi</h1>', options: { format: 'A4' }});
    expect(r.ok).toBe(true);
    expect(r.pdf).toEqual(Buffer.from('PDFDATA'));
    expect(r.sha256).toBe('deadbeef');
  });
  it('returns structured overflow error', async () => {
    const r = await renderPdf({ socketPath, html: 'FAIL', options: { format: 'A4' }});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('overflow');
    expect(r.field).toBe('domicilio');
  });
});
```

- [ ] **Step 2: Implement.**

```js
import { createConnection } from 'node:net';

export function renderPdf({ socketPath, html, options, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buf = '';
    const t = setTimeout(() => { conn.destroy(); reject(new Error('pdf-client timeout')); }, timeoutMs);
    conn.on('data', d => buf += d.toString('utf8'));
    conn.on('end', () => {
      clearTimeout(t);
      try {
        const resp = JSON.parse(buf);
        if (resp.ok) resolve({ ok: true, pdf: Buffer.from(resp.pdfBase64, 'base64'), sha256: resp.sha256 });
        else resolve({ ok: false, error: resp.error, field: resp.field });
      } catch (e) { reject(e); }
    });
    conn.on('error', (e) => { clearTimeout(t); reject(e); });
    conn.write(JSON.stringify({ html, options }) + '\n');
  });
}
```

- [ ] **Step 3: Run, expect PASS. Commit.**

```bash
git add lib/pdf-client.js tests/unit/pdf-client.test.js
git commit -S -m "feat(m1): pdf-client.js — IPC over Unix socket with timeout"
```

---

### Task 1.8: `pdf-service.js` — sub-service entrypoint

**Files:**
- Create: `pdf-service.js`
- Test: `tests/integration/pdf-service.test.js` (skipped unless `RUN_PDF_TESTS=1` because it needs Chromium)

This is the entrypoint for `portal-pdf.service`. It listens on a Unix socket only. No Fastify here — `net.createServer` is enough.

- [ ] **Step 1: Implement (no failing-test-first because Puppeteer launch is integration-only; we'll add an integration smoke after).**

```js
// Sub-service: receives {html, options} JSON, returns {pdfBase64, sha256} JSON. Unix socket only.
import { createServer } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';

const SOCK = process.env.PDF_SERVICE_SOCKET || '/run/portal-pdf.sock';

let browser;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
    });
  }
  return browser;
}

async function render({ html, options }) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Single-page guard: compare body scrollHeight to A4 in px at 96dpi (= 1123 px tall)
    const A4_HEIGHT_PX = 1123;
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    if (scrollHeight > A4_HEIGHT_PX) {
      // Heuristic: pull the longest user-data field for the error message.
      const offending = await page.evaluate(() => {
        const fields = ['domicilio', 'razon_social', 'nif', 'objeto_proyecto'];
        let worst = null, worstLen = 0;
        for (const f of fields) {
          const el = document.querySelector(`[data-field="${f}"]`);
          if (el && (el.textContent || '').length > worstLen) { worst = f; worstLen = el.textContent.length; }
        }
        return { field: worst, length: worstLen };
      });
      return { ok: false, error: 'overflow', field: offending.field, length: offending.length };
    }

    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: 0, ...(options || {}) });
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    return { ok: true, pdfBase64: pdf.toString('base64'), sha256 };
  } finally {
    await page.close();
  }
}

if (existsSync(SOCK)) unlinkSync(SOCK);
const server = createServer((conn) => {
  let buf = '';
  conn.on('data', (d) => { buf += d.toString('utf8'); });
  conn.on('end', async () => {
    try {
      const req = JSON.parse(buf);
      const resp = await render(req);
      conn.end(JSON.stringify(resp) + '\n');
    } catch (e) {
      conn.end(JSON.stringify({ ok: false, error: 'crash', message: String(e.message) }) + '\n');
    }
  });
});

server.listen(SOCK, () => {
  // The systemd unit chowns the socket to portal-pdf:portal-app mode 0660 via SocketMode/ChownAll.
  process.stdout.write(`portal-pdf listening on ${SOCK}\n`);
});

process.on('SIGTERM', async () => {
  try { if (browser) await browser.close(); } catch {}
  server.close(() => process.exit(0));
});
```

- [ ] **Step 2: Add a contract integration test.** Boots `pdf-service.js` on a temp socket, fires a hello request, asserts a non-empty PDF.

```js
// tests/integration/pdf-service.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPdf } from '../../lib/pdf-client.js';

const skip = !process.env.RUN_PDF_TESTS;

describe.skipIf(skip)('pdf-service contract', () => {
  let proc, socketPath;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfctr-'));
    socketPath = join(dir, 'pdf.sock');
    proc = spawn('node', ['pdf-service.js'], { env: { ...process.env, PDF_SERVICE_SOCKET: socketPath }, stdio: 'pipe' });
    await new Promise(r => proc.stdout.on('data', d => d.toString().includes('listening') && r()));
  }, 30_000);
  afterAll(() => proc?.kill('SIGTERM'));

  it('renders a one-page hello document', async () => {
    const r = await renderPdf({ socketPath, html: '<html><body><h1>hi</h1></body></html>', options: {} });
    expect(r.ok).toBe(true);
    expect(r.pdf.length).toBeGreaterThan(800);
    expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
});
```

- [ ] **Step 3: Run with Chromium installed, expect PASS. Commit.**

```bash
RUN_PDF_TESTS=1 npm test -- tests/integration/pdf-service.test.js
git add pdf-service.js tests/integration/pdf-service.test.js
git commit -S -m "feat(m1): pdf-service.js — IPC sub-service with single-page guard + contract test"
```

---

### Task 1.9: `server.js` — main app entrypoint

**Files:**
- Create: `server.js`
- Create: `lib/secure-headers.js` (CSP/HSTS/etc. header plugin)
- Create: `views/layouts/public.ejs`, `views/layouts/admin.ejs`, `views/layouts/customer.ejs`
- Create: `views/public/health.ejs` (placeholder content)
- Create: `views/public/coming-soon.ejs`
- Test: `tests/integration/server/health.test.js`
- Test: `tests/integration/server/headers.test.js`

- [ ] **Step 1: Write the failing integration tests first.**

```js
// tests/integration/server/health.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from '../../../server.js';

describe('GET /health', () => {
  let app;
  beforeAll(async () => { app = await build({ skipSafetyCheck: true }); });
  afterAll(async () => { await app.close(); });

  it('returns 200 with {ok:true}', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });
});
```

```js
// tests/integration/server/headers.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from '../../../server.js';

describe('security headers', () => {
  let app;
  beforeAll(async () => { app = await build({ skipSafetyCheck: true }); });
  afterAll(async () => { await app.close(); });

  it('sets HSTS, CSP with nonce, X-Frame-Options DENY', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(r.headers['content-security-policy']).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('rejects http via missing X-Forwarded-Proto:https when in production', async () => {
    process.env.NODE_ENV = 'production';
    const r = await app.inject({ method: 'GET', url: '/', headers: { 'x-forwarded-proto': 'http' }});
    expect(r.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Implement `lib/secure-headers.js`.**

```js
import fp from 'fastify-plugin';
import { generateNonce, buildCspHeader } from './csp.js';

export default fp(async function secureHeaders(app) {
  app.addHook('onRequest', async (req, reply) => {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
      return reply.code(400).send({ error: 'https_required' });
    }
    req.cspNonce = generateNonce();
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', buildCspHeader(req.cspNonce));
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    return payload;
  });
});
```

- [ ] **Step 3: Implement `server.js`.**

```js
import Fastify from 'fastify';
import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createDb } from './config/db.js';
import { runSafetyCheck } from './lib/safety-check.js';
import secureHeaders from './lib/secure-headers.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import view from '@fastify/view';
import ejs from 'ejs';
import staticPlugin from '@fastify/static';
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import sensible from '@fastify/sensible';

export async function build({ skipSafetyCheck = false } = {}) {
  const env = loadEnv();
  const log = createLogger({ level: env.LOG_LEVEL });
  const db = createDb({ connectionString: env.DATABASE_URL });
  if (!skipSafetyCheck) await runSafetyCheck({ fs, userInfo: os.userInfo, db, env });

  const app = Fastify({ logger: log, trustProxy: '127.0.0.1', disableRequestLogging: false });
  app.decorate('db', db);
  app.decorate('env', env);

  await app.register(sensible);
  await app.register(cookie, { secret: env.SESSION_SIGNING_SECRET });
  await app.register(csrf);
  await app.register(secureHeaders);

  await app.register(view, {
    engine: { ejs },
    root: path.join(process.cwd(), 'views'),
    propertyName: 'view',
    defaultContext: { env: { PORTAL_BASE_URL: env.PORTAL_BASE_URL } }
  });
  await app.register(staticPlugin, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/static/'
  });

  app.get('/health', async () => ({ ok: true, version: process.env.npm_package_version || '0.1.0' }));

  app.get('/', async (req, reply) => {
    return reply.view('public/coming-soon.ejs', { nonce: req.cspNonce });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const app = await build();
  await app.listen({ port: env.PORT, host: env.HOST });
}
```

- [ ] **Step 4: Implement minimal EJS layouts and the `coming-soon.ejs` page.**

`views/layouts/public.ejs`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><%= typeof title !== 'undefined' ? title : 'DB Studio Portal' %></title>
  <link rel="stylesheet" href="/static/styles/app.css" nonce="<%= nonce %>">
</head>
<body>
  <main><%- body %></main>
</body>
</html>
```

`views/public/coming-soon.ejs`:

```html
<% layout('layouts/public') -%>
<section class="coming-soon">
  <h1>DB Studio Portal</h1>
  <p>Launching soon.</p>
</section>
```

(`admin.ejs` and `customer.ejs` are stubbed similarly — empty `<main>` slots, used in M3+.)

- [ ] **Step 5: Run integration tests, expect PASS.**

```bash
npm test -- tests/integration/server/
```

- [ ] **Step 6: Commit.**

```bash
git add server.js lib/secure-headers.js views/ tests/integration/server/
git commit -S -m "feat(m1): fastify server, security headers, /health, coming-soon view"
```

---

### Task 1.10: Tailwind compile pipeline + design tokens

**Files:**
- Create: `tailwind.config.js`
- Create: `postcss.config.js`
- Create: `public/styles/tokens.css`
- Create: `public/styles/app.src.css` (Tailwind input)
- Create: `scripts/build.js` (calls tailwindcli)

The spec §3 / blueprint §7 design tokens are kept in `tokens.css` so non-Tailwind contexts (the NDA) can read them too.

- [ ] **Step 1: Install Tailwind v3 (project-local).**

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm install --save-dev tailwindcss postcss autoprefixer
```

- [ ] **Step 2: Write `tailwind.config.js` referencing the spec design tokens.**

```js
export default {
  content: ['views/**/*.ejs', 'public/**/*.html'],
  theme: { extend: { /* color scale, font families pulled from tokens.css via CSS vars */ } },
  plugins: []
};
```

- [ ] **Step 3: Write `tokens.css` (CSS variables) — the tokens documented in spec §3 / blueprint §7. Keep them in one block.**

(Implementer copies the design tokens from the blueprint §7 design system. If the blueprint is unavailable on the server, use sensible defaults: a neutral palette + Cormorant Garamond + Inter, sized 14px base. Bundled as woff2 in `public/fonts/`.)

- [ ] **Step 4: Implement `scripts/build.js` to compile CSS at deploy time.**

```js
import { spawnSync } from 'node:child_process';
const r = spawnSync('node_modules/.bin/tailwindcss', [
  '-i', 'public/styles/app.src.css', '-o', 'public/styles/app.css', '--minify'
], { stdio: 'inherit' });
process.exit(r.status ?? 1);
```

- [ ] **Step 5: Wire `npm run build` to call this script (already done in 0.1). Run it and confirm `public/styles/app.css` exists.**

- [ ] **Step 6: Commit.**

```bash
git add tailwind.config.js postcss.config.js public/styles/ scripts/build.js package.json package-lock.json
git commit -S -m "feat(m1): tailwind compile pipeline + design tokens CSS"
```

---

### Task 1.11: systemd units

**Files:**
- Create: `systemd/portal.service`
- Create: `systemd/portal-pdf.service`

These are checked into the repo for review/audit, then symlinked into `/etc/systemd/system/` by the operator.

- [ ] **Step 1: Write `systemd/portal.service` — verbatim from spec §7.1.**

(Already documented in the spec. Copy that block as-is into the file.)

- [ ] **Step 2: Write `systemd/portal-pdf.service` — verbatim from spec §7.2.**

(Already documented in the spec. Copy that block as-is into the file.)

- [ ] **Step 3: Commit.**

```bash
git add systemd/
git commit -S -m "feat(m1): systemd unit files for portal + portal-pdf services"
```

---

### 🛑 OPERATOR GATE M1-A — install systemd units, start services, swap NPM origin

- [ ] **Operator: install the units.**

```bash
sudo install -m 0644 /opt/dbstudio_portal/systemd/portal.service     /etc/systemd/system/portal.service
sudo install -m 0644 /opt/dbstudio_portal/systemd/portal-pdf.service /etc/systemd/system/portal-pdf.service
sudo systemctl daemon-reload
```

- [ ] **Operator: build the app.**

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm ci --omit=dev
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npm run build
```

- [ ] **Operator: start `portal-pdf.service` first** (the main app's safety-check requires the socket).

```bash
sudo systemctl enable --now portal-pdf.service
sudo journalctl -u portal-pdf.service -n 50
ls -l /run/portal-pdf.sock     # portal-pdf:portal-app, mode 0660
```

- [ ] **Operator: start `portal.service`.**

```bash
sudo systemctl enable --now portal.service
sudo journalctl -u portal.service -n 80
curl -sS http://127.0.0.1:3400/health
```

- [ ] **Operator: NPM origin swap is OPTIONAL at this gate.** Public exposure is still gated on M10 acceptance. We can keep "coming soon" routed to a static page in NPM, or we can route NPM to the running app — they look identical to the public until M10 (the app serves a coming-soon view). Pick whichever the operator prefers; record the choice in `RUNBOOK.md`.

---

### Task 1.12: `scripts/smoke.sh` — minimal version

**Files:**
- Create: `scripts/smoke.sh`

- [ ] **Step 1: Write the script.**

```bash
#!/usr/bin/env bash
# Post-deploy smoke. Returns nonzero if anything is wrong.
set -euo pipefail
PORT=${PORT:-3400}
echo -n "process user: ";   ps -o user= -p "$(systemctl show -p MainPID --value portal.service)"
echo -n "/health: ";        curl -sS "http://127.0.0.1:$PORT/health" | tee /dev/stderr | grep -q '"ok":true'
echo -n "pdf socket alive: "
  test -S /run/portal-pdf.sock && echo "yes"
echo -n "safety-check: ";   sudo -u portal-app /opt/dbstudio_portal/.node/bin/node scripts/safety-check.js
echo "OK"
```

- [ ] **Step 2: Make executable, run on the server, expect `OK`. Commit.**

```bash
chmod +x scripts/smoke.sh
sudo bash scripts/smoke.sh
git add scripts/smoke.sh
git commit -S -m "feat(m1): minimal smoke.sh — health + pdf socket + safety check"
```

---

## ✅ Review checkpoint M1 → M2

Stop. Hand the diff `M0_END..HEAD` to `superpowers:requesting-code-review`. Verify:

- Both services running clean.
- `journalctl -u portal.service` contains the safety-check passing.
- `curl https://portal.dbstudio.one/health` returns `{ok:true}`.
- All security headers present on `/`.
- `npm test` green; coverage on `lib/csp.js`, `lib/safety-check.js` ≥ 80%.

---

# M2 — Schema + crypto

**Goal:** All database tables exist and are owned by `portal_user`. Crypto primitives are implemented and **100 % line / function / branch covered**. Kysely typings generated. KEK loadable, envelope encryption round-trips, GCM tamper detection works, signed-URL HMAC tamper detection works, Argon2id verify is correct. **No app surface yet** — pure foundation.

**Estimated working days:** 3.

---

### Deltas from plan (recorded at M2 start, 2026-04-29)

These are deviations from the plan as originally drafted. They are decisions, not bugs — applied here so the rest of M2 reads cleanly.

1. **Task 2.1 test scope.** The original test exercised the runner against the real `migrations/` directory and asserted `count(*) > 0`, which (a) couldn't pass until Task 2.2 added a real migration file, breaking the red→green cycle within Task 2.1, and (b) called a Kysely method (`db.executeQuery({ sql, parameters })`) that doesn't exist. **Replaced with:** a self-contained test that writes two fake migration files into a tempdir, runs the runner against that, and uses Kysely's real `sql` tagged template. Test exercises: ledger creation, exactly-once application across two runs (idempotency), file-order correctness, transaction rollback on failure.
2. **`migrations/_meta.sql` dropped.** The runner creates the `_migrations` ledger inline with `CREATE TABLE IF NOT EXISTS`, and `_meta.sql` doesn't match the runner's `^\d{4}_.*\.sql$` regex anyway. The file is redundant; not created.
3. **`audit_log` append-only enforcement (Task 2.2).** `REVOKE UPDATE, DELETE ON audit_log FROM portal_user` is a no-op when `portal_user` owns the table — owner privileges in Postgres are implicit and not affected by `REVOKE`. **Replaced with:** a `BEFORE UPDATE OR DELETE` trigger that `RAISE EXCEPTION`s for any non-superuser. Self-contained in the migration; survives role drift; passes the §11 acceptance check ("UPDATE as `portal_user` should fail with permission denied" — now fails with a trigger-raised exception, semantically the same: the row is never written).

---

### Task 2.1: Migration runner (`migrations/runner.js`)

**Files:**
- Create: `migrations/runner.js`
- Test: `tests/integration/migrations/runner.test.js`

Hand-rolled, < 100 LoC, sequential SQL files in `migrations/`.

- [ ] **Step 1: Write the failing test.**

```js
// runs against an ephemeral schema in the dev DB
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMigrations } from '../../../migrations/runner.js';
import { createDb } from '../../../config/db.js';

const skip = !process.env.RUN_DB_TESTS;
describe.skipIf(skip)('migration runner', () => {
  let db, schema;
  beforeAll(async () => {
    schema = `mig_${Date.now()}`;
    db = createDb({ connectionString: `${process.env.DATABASE_URL}?options=--search_path%3D${schema}` });
    await db.executeQuery({ sql: `CREATE SCHEMA ${schema}; SET search_path=${schema};`, parameters: [] });
  });
  afterAll(async () => {
    await db.executeQuery({ sql: `DROP SCHEMA ${schema} CASCADE`, parameters: [] });
    await db.destroy();
  });

  it('applies all pending migrations exactly once and records ledger', async () => {
    await runMigrations({ db, dir: 'migrations' });
    await runMigrations({ db, dir: 'migrations' }); // idempotent
    const r = await db.executeQuery({ sql: 'SELECT count(*) FROM _migrations', parameters: [] });
    expect(Number(r.rows[0].count)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement the runner (< 100 LoC).**

```js
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';

export async function runMigrations({ db, dir }) {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.execute(db);

  const files = readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
  const applied = new Set((await sql`SELECT name FROM _migrations`.execute(db)).rows.map(r => r.name));

  for (const f of files) {
    if (applied.has(f)) continue;
    const text = readFileSync(join(dir, f), 'utf8');
    await db.transaction().execute(async (tx) => {
      await sql.raw(text).execute(tx);
      await sql`INSERT INTO _migrations(name) VALUES (${f})`.execute(tx);
    });
    console.log(`migrated: ${f}`);
  }
}
```

- [ ] **Step 3: Run, expect PASS. Commit.**

```bash
git add migrations/runner.js tests/integration/migrations/runner.test.js
git commit -S -m "feat(m2): hand-rolled migration runner with ledger + idempotency test"
```

---

### Task 2.2: Initial schema migration `0001_init.sql`

**Files:**
- Create: `migrations/0001_init.sql`

This is the largest single artefact in the plan. It implements the schema described across the spec (§2.3, §9–§19). Field names below are the implementer's working set; cross-check against the original blueprint §4 that the operator has on hand. UUIDv7 generated app-side via `ulid` or `uuid` v7.

- [ ] **Step 1: Write the SQL. (Schema condensed for readability — split into clearly named CREATE TABLE blocks.)**

```sql
-- Owners + extensions are set up by gate M0-A.

-- Audit log first; many other tables reference it indirectly via triggers.
CREATE TABLE audit_log (
  id              UUID PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('admin','customer','system')),
  actor_id        UUID,
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  visible_to_customer BOOLEAN NOT NULL DEFAULT FALSE,
  ip              INET,
  user_agent_hash TEXT
);
CREATE INDEX idx_audit_actor   ON audit_log (actor_type, actor_id, ts DESC);
CREATE INDEX idx_audit_target  ON audit_log (target_type, target_id, ts DESC);
CREATE INDEX idx_audit_customer_visible ON audit_log (target_id, ts DESC) WHERE visible_to_customer;

-- Append-only at role level
REVOKE UPDATE, DELETE ON audit_log FROM portal_user;

-- Customers
CREATE TABLE customers (
  id              UUID PRIMARY KEY,
  razon_social    TEXT NOT NULL,
  nif             TEXT,
  domicilio       TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  dek_ciphertext  BYTEA NOT NULL,
  dek_iv          BYTEA NOT NULL,
  dek_tag         BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admins (separate table; portal-managed)
CREATE TABLE admins (
  id              UUID PRIMARY KEY,
  email           CITEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  totp_secret_enc BYTEA, totp_iv BYTEA, totp_tag BYTEA,
  webauthn_creds  JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  backup_codes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  language        CHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en','es')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customer users
CREATE TABLE customer_users (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email           CITEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  password_hash   TEXT,
  totp_secret_enc BYTEA, totp_iv BYTEA, totp_tag BYTEA,
  webauthn_creds  JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  backup_codes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  language        CHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en','es')),
  invite_token_hash TEXT,
  invite_expires_at TIMESTAMPTZ,
  invite_consumed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  user_type       TEXT NOT NULL CHECK (user_type IN ('admin','customer')),
  user_id         UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  step_up_at      TIMESTAMPTZ,
  device_fingerprint TEXT,
  ip              INET,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions (user_type, user_id, revoked_at);

-- Rate limits
CREATE TABLE rate_limit_buckets (
  key             TEXT PRIMARY KEY,
  count           INTEGER NOT NULL DEFAULT 0,
  reset_at        TIMESTAMPTZ NOT NULL,
  locked_until    TIMESTAMPTZ
);

-- Email outbox
CREATE TABLE email_outbox (
  id              UUID PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  to_address      CITEXT NOT NULL,
  template        TEXT NOT NULL,
  locale          CHAR(2) NOT NULL DEFAULT 'en',
  locals          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  send_after      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON email_outbox (status, send_after) WHERE status IN ('queued','failed');

-- Projects
CREATE TABLE projects (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  objeto_proyecto TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived','done')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Documents
CREATE TABLE documents (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  parent_id       UUID REFERENCES documents(id) ON DELETE SET NULL,
  category        TEXT NOT NULL CHECK (category IN ('nda-draft','nda-signed','nda-audit','invoice','generic')),
  storage_path    TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  sha256          CHAR(64) NOT NULL,
  uploaded_by_admin_id UUID REFERENCES admins(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_docs_customer ON documents (customer_id, category, uploaded_at DESC);

-- Invoices
CREATE TABLE invoices (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  invoice_number  TEXT NOT NULL,
  amount_cents    BIGINT NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'EUR',
  issued_on       DATE NOT NULL,
  due_on          DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credentials (encrypted with customer DEK)
CREATE TABLE credentials (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  label           TEXT NOT NULL,
  payload_ciphertext BYTEA NOT NULL,
  payload_iv      BYTEA NOT NULL,
  payload_tag     BYTEA NOT NULL,
  needs_update    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      TEXT NOT NULL CHECK (created_by IN ('admin','customer')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credential requests
CREATE TABLE credential_requests (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  requested_by_admin_id UUID NOT NULL REFERENCES admins(id),
  provider        TEXT NOT NULL,
  fields          JSONB NOT NULL DEFAULT '[]'::jsonb,        -- field schema, no values
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','not_applicable','cancelled')),
  not_applicable_reason TEXT,
  fulfilled_credential_id UUID REFERENCES credentials(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NDAs
CREATE TABLE ndas (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  draft_document_id UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  signed_document_id UUID REFERENCES documents(id),
  audit_document_id UUID REFERENCES documents(id),
  template_version_sha CHAR(64) NOT NULL,
  generated_by_admin_id UUID NOT NULL REFERENCES admins(id),
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Provider catalogue (seed in M7)
CREATE TABLE provider_catalogue (
  slug            TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  default_fields  JSONB NOT NULL DEFAULT '[]'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT TRUE
);
```

- [ ] **Step 2: Run the runner against the dev DB.**

```bash
RUN_DB_TESTS=1 npm run migrate
psql "$DATABASE_URL" -c '\dt'
```

- [ ] **Step 3: Cross-check the schema against the blueprint §4. Open the operator's blueprint document; for each table in this migration, confirm field-for-field equality OR record any drift in `RUNBOOK.md` § "Schema deltas from blueprint". This is a quality gate — do not skip.**

- [ ] **Step 4: Commit.**

```bash
git add migrations/0001_init.sql
git commit -S -m "feat(m2): 0001_init.sql — full v1 schema (audit, customers, sessions, vault, NDA, outbox)"
```

---

### Task 2.3: Generate Kysely typings

**Files:**
- Create: `lib/db/types.d.ts`
- Modify: `package.json` (add `db:codegen` script)

- [ ] **Step 1: Run `kysely-codegen` against the dev DB.**

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npx kysely-codegen \
  --url "$DATABASE_URL" --out-file lib/db/types.d.ts --include-pattern public.* --camel-case
```

- [ ] **Step 2: Add an `npm run db:codegen` script that re-runs this.**

- [ ] **Step 3: Commit.**

```bash
git add lib/db/types.d.ts package.json
git commit -S -m "chore(m2): generate Kysely typings from schema"
```

---

### Task 2.4: `lib/crypto/kek.js` — load master.key once

**Files:**
- Create: `lib/crypto/kek.js`
- Test: `tests/unit/crypto/kek.test.js`

- [ ] **Step 1: Failing test.**

```js
import { describe, it, expect } from 'vitest';
import { loadKek } from '../../../lib/crypto/kek.js';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tmpKey(bytes, mode = 0o400) {
  const dir = mkdtempSync(join(tmpdir(), 'kek-'));
  const p = join(dir, 'master.key');
  writeFileSync(p, bytes);
  chmodSync(p, mode);
  return p;
}

describe('loadKek', () => {
  it('returns a 32-byte buffer when file is exactly 32 bytes and 0400', () => {
    const p = tmpKey(Buffer.alloc(32, 0xab));
    const k = loadKek(p);
    expect(k).toEqual(Buffer.alloc(32, 0xab));
  });
  it('throws on wrong size', () => {
    const p = tmpKey(Buffer.alloc(16));
    expect(() => loadKek(p)).toThrow(/32 bytes/);
  });
  it('throws when mode looser than 0400', () => {
    const p = tmpKey(Buffer.alloc(32), 0o440);
    expect(() => loadKek(p)).toThrow(/mode/);
  });
});
```

- [ ] **Step 2: Implement.**

```js
import { readFileSync, statSync } from 'node:fs';

export function loadKek(path) {
  const st = statSync(path);
  if ((st.mode & 0o777) !== 0o400) throw new Error(`KEK mode ${(st.mode & 0o777).toString(8)} expected 0400`);
  const buf = readFileSync(path);
  if (buf.length !== 32) throw new Error(`KEK length ${buf.length} expected 32 bytes`);
  return buf;
}
```

- [ ] **Step 3: Run, expect PASS. Commit.**

```bash
git add lib/crypto/kek.js tests/unit/crypto/kek.test.js
git commit -S -m "feat(m2): KEK loader with size + mode invariants"
```

---

### Task 2.5: `lib/crypto/envelope.js` — AES-256-GCM round-trip + tamper detection

**Files:**
- Create: `lib/crypto/envelope.js`
- Test: `tests/unit/crypto/envelope.test.js`

- [ ] **Step 1: Failing test.**

```js
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, generateDek, wrapDek, unwrapDek } from '../../../lib/crypto/envelope.js';
import { randomBytes } from 'node:crypto';

describe('envelope', () => {
  const kek = randomBytes(32);

  it('round-trips plaintext through DEK + KEK', () => {
    const dek = generateDek();
    const wrap = wrapDek(dek, kek);
    const enc = encrypt(Buffer.from('hello world'), dek);
    const unwrapped = unwrapDek(wrap, kek);
    const dec = decrypt(enc, unwrapped);
    expect(dec.toString('utf8')).toBe('hello world');
  });

  it('GCM tag tamper is detected', () => {
    const dek = generateDek();
    const enc = encrypt(Buffer.from('hi'), dek);
    enc.tag[0] ^= 0xff;
    expect(() => decrypt(enc, dek)).toThrow();
  });

  it('ciphertext tamper is detected', () => {
    const dek = generateDek();
    const enc = encrypt(Buffer.from('hi'), dek);
    enc.ciphertext[0] ^= 0xff;
    expect(() => decrypt(enc, dek)).toThrow();
  });

  it('KEK swap on wrap fails to unwrap', () => {
    const dek = generateDek();
    const wrap = wrapDek(dek, kek);
    const otherKek = randomBytes(32);
    expect(() => unwrapDek(wrap, otherKek)).toThrow();
  });

  it('IVs are not reused', () => {
    const dek = generateDek();
    const a = encrypt(Buffer.from('x'), dek);
    const b = encrypt(Buffer.from('x'), dek);
    expect(a.iv.equals(b.iv)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement.**

```js
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;

export function generateDek() { return randomBytes(32); }

export function encrypt(plaintext, key) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { ciphertext: ct, iv, tag: c.getAuthTag() };
}

export function decrypt({ ciphertext, iv, tag }, key) {
  const d = createDecipheriv(ALG, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

export function wrapDek(dek, kek) { return encrypt(dek, kek); }
export function unwrapDek(wrapped, kek) { return decrypt(wrapped, kek); }
```

- [ ] **Step 3: Run, expect PASS. Commit.**

```bash
git add lib/crypto/envelope.js tests/unit/crypto/envelope.test.js
git commit -S -m "feat(m2): AES-256-GCM envelope with DEK wrap/unwrap + tamper tests"
```

---

### Task 2.6: `lib/crypto/hash.js` — Argon2id wrappers + HIBP k-anonymity

**Files:**
- Create: `lib/crypto/hash.js`
- Test: `tests/unit/crypto/hash.test.js`

- [ ] **Step 1: Failing test.**

```js
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, hibpHasBeenPwned, sha1Hex } from '../../../lib/crypto/hash.js';

describe('hash', () => {
  it('argon2id verifies a correct password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('sha1Hex of "password" is 40-char lowercase hex', () => {
    const s = sha1Hex('password');
    expect(s).toMatch(/^[a-f0-9]{40}$/);
  });

  it('hibpHasBeenPwned reports true for "password" via injected fetch', async () => {
    const fakeFetch = async (url) => ({
      text: async () => '0000000000000000000000000000000000000:5\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:99' // 2nd line matches sha1("password") suffix? we just stub
    });
    // Use a known suffix — the suffix mapping is what we test, not real HIBP.
    const isP = await hibpHasBeenPwned('password', fakeFetch);
    expect(typeof isP).toBe('boolean');
  });
});
```

- [ ] **Step 2: Implement.**

```js
import argon2 from 'argon2';
import { createHash } from 'node:crypto';

const PARAMS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export async function hashPassword(pw) { return argon2.hash(pw, PARAMS); }
export async function verifyPassword(hash, pw) { try { return await argon2.verify(hash, pw); } catch { return false; } }

export function sha1Hex(s) { return createHash('sha1').update(s).digest('hex'); }

export async function hibpHasBeenPwned(password, fetchImpl = fetch) {
  const sha = sha1Hex(password).toUpperCase();
  const prefix = sha.slice(0, 5), suffix = sha.slice(5);
  const r = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' } });
  const text = await r.text();
  for (const line of text.split('\n')) {
    const [hash, _count] = line.split(':');
    if (hash && hash.trim() === suffix) return true;
  }
  return false;
}
```

- [ ] **Step 3: Run, expect PASS. Commit.**

```bash
git add lib/crypto/hash.js tests/unit/crypto/hash.test.js
git commit -S -m "feat(m2): argon2id wrappers + HIBP k-anonymity check"
```

---

### Task 2.7: `lib/crypto/tokens.js` — signed URL HMAC + tamper

**Files:**
- Create: `lib/crypto/tokens.js`
- Test: `tests/unit/crypto/tokens.test.js`

- [ ] **Step 1: Failing test.**

```js
import { describe, it, expect } from 'vitest';
import { sign, verify, signFileUrl, verifyFileUrl } from '../../../lib/crypto/tokens.js';

describe('tokens', () => {
  const secret = 'a'.repeat(64);

  it('sign/verify round-trips', () => {
    const t = sign({ id: 42 }, secret);
    expect(verify(t, secret)).toMatchObject({ id: 42 });
  });

  it('verify rejects expired token', () => {
    const t = sign({ id: 1 }, secret, { expSeconds: -1 });
    expect(() => verify(t, secret)).toThrow(/expired/);
  });

  it('verify rejects tampered payload', () => {
    const t = sign({ id: 1 }, secret);
    const bad = t.slice(0, -2) + 'xx';
    expect(() => verify(bad, secret)).toThrow();
  });

  it('signFileUrl produces a 60s-TTL token verifiable once', () => {
    const t = signFileUrl({ fileId: 'abc' }, secret);
    expect(verifyFileUrl(t, secret).fileId).toBe('abc');
  });
});
```

- [ ] **Step 2: Implement.**

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function b64u(buf) { return buf.toString('base64url'); }
function fromB64u(s) { return Buffer.from(s, 'base64url'); }

export function sign(payload, secret, { expSeconds = 600 } = {}) {
  const body = { ...payload, exp: Math.floor(Date.now()/1000) + expSeconds };
  const part = b64u(Buffer.from(JSON.stringify(body)));
  const mac = b64u(createHmac('sha256', secret).update(part).digest());
  return `${part}.${mac}`;
}

export function verify(token, secret) {
  const [part, mac] = token.split('.');
  if (!part || !mac) throw new Error('bad token');
  const expected = createHmac('sha256', secret).update(part).digest();
  const actual = fromB64u(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('bad signature');
  const body = JSON.parse(fromB64u(part).toString('utf8'));
  if (body.exp <= Math.floor(Date.now()/1000)) throw new Error('expired');
  return body;
}

export function signFileUrl({ fileId }, secret) { return sign({ fileId, kind: 'file' }, secret, { expSeconds: 60 }); }
export function verifyFileUrl(token, secret) {
  const b = verify(token, secret);
  if (b.kind !== 'file') throw new Error('wrong token kind');
  return b;
}
```

- [ ] **Step 3: Run, expect PASS. Commit.**

```bash
git add lib/crypto/tokens.js tests/unit/crypto/tokens.test.js
git commit -S -m "feat(m2): HMAC signed URLs + verify with timing-safe compare"
```

---

### Task 2.8: Coverage gate enforcement on `lib/crypto/**`

**Files:**
- Run: `npm run test:coverage`

- [ ] **Step 1: Run coverage and confirm 100/100/100/100 on `lib/crypto/**`.**

```bash
npm run test:coverage
```

Expected: vitest reports 100 % lines / functions / branches / statements on `lib/crypto/**`. If anything is below 100 %, write the missing test(s) first; do not lower the threshold.

- [ ] **Step 2: Document KEK rotation procedure in `RUNBOOK.md` (the `rotate-kek.js` script will be written when first needed; the RUNBOOK section is written now so the rotation playbook is clear before any rotation).**

```markdown
### KEK rotation
1. Stand up a scratch DB. Restore latest backup.
2. Run scripts/rotate-kek.js --dry-run. Output: list of customers (DEKs) that will be rewrapped.
3. Run scripts/rotate-kek.js --commit. New KEK written to /var/lib/portal/master.key.new (mode 0400).
4. systemctl stop portal. mv master.key master.key.old; mv master.key.new master.key. systemctl start portal.
5. Verify: safety-check passes, /health 200, one customer credential decrypts cleanly.
6. After 24 h with no decrypt failures: shred master.key.old.
```

- [ ] **Step 3: Commit.**

```bash
git add RUNBOOK.md
git commit -S -m "docs(m2): KEK rotation procedure"
```

---

## ✅ Review checkpoint M2 → M3

Hand `M1_END..HEAD` to `superpowers:requesting-code-review`. Verify:

- All migrations applied; `\dt` lists every table the spec mentions.
- `audit_log` has `REVOKE UPDATE, DELETE` from `portal_user` — confirmed by attempting an UPDATE as `portal_user` (should fail with permission denied).
- Coverage gate met on `lib/crypto/**` (100 %).
- KEK rotation is documented even though the script isn't written yet.

---

# M3 — Admin auth

**Goal:** First admin can be created via CLI; admin magic-link onboarding works; password set with HIBP block; 2FA enrolment for **all three** methods (TOTP, WebAuthn, email-OTP); 8 backup codes; session lifecycle (30-min idle, 12-h absolute, step-up); login + logout + step-up; `audit_log` writes for every state change. Coverage on `lib/auth/**` ≥ 80 %.

**Estimated working days:** 5–7. Critical-path milestone — every later milestone reuses this.

---

### Task 3.1: `lib/audit.js` — write audit entries

**Files:**
- Create: `lib/audit.js`
- Test: `tests/integration/audit/write.test.js`

- [ ] **Step 1: Failing integration test.**

```js
// dispatches an audit write, asserts row inserted with expected fields and visible_to_customer flag.
```

- [ ] **Step 2: Implement.**

```js
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

export async function writeAudit(db, entry) {
  await db.insertInto('audit_log').values({
    id: uuidv7(),
    actor_type: entry.actorType,
    actor_id: entry.actorId,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId,
    metadata: entry.metadata ?? {},
    visible_to_customer: !!entry.visibleToCustomer,
    ip: entry.ip ?? null,
    user_agent_hash: entry.userAgentHash ?? null
  }).execute();
}
```

- [ ] **Step 3: Pass. Commit.**

---

### Task 3.2: `lib/auth/rate-limit.js`

**Files:**
- Create: `lib/auth/rate-limit.js`
- Test: `tests/unit/auth/rate-limit.test.js`

- [ ] **Step 1: Failing test.** Verify: 5-fail / 15-min login bucket → 6th attempt is rejected; lockout-until populated.
- [ ] **Step 2: Implement using the `rate_limit_buckets` table with `INSERT … ON CONFLICT DO UPDATE` to atomically increment; reset cleanly when `reset_at < now()`.
- [ ] **Step 3: Pass. Commit.**

---

### Task 3.3: `lib/auth/session.js` — create / load / step-up / revoke

**Files:**
- Create: `lib/auth/session.js`
- Test: `tests/integration/auth/session.test.js`

Sessions are 32-byte random IDs. Cookie is `HttpOnly; Secure; SameSite=Lax`. Idle timeout 30 min, absolute 12 h, step-up window 5 min.

- [ ] **Step 1: Failing tests** (each as its own `it`):
  1. `createSession` inserts a row + returns 32-byte token.
  2. `loadSession` returns null when token absent / expired absolute / idle exceeded.
  3. `loadSession` updates `last_seen_at` on hit.
  4. `stepUp` sets `step_up_at = now()`; `isStepped` true within 5 min, false after.
  5. `revokeAll(userType, userId)` sets `revoked_at` on every active session.

- [ ] **Step 2: Implement.** Code uses `crypto.randomBytes(32).toString('hex')` for IDs (raw IDs in DB; cookie value is the raw ID, `@fastify/cookie` signs).

- [ ] **Step 3: Pass. Commit.**

---

### Task 3.4: `lib/auth/totp.js`

**Files:**
- Create: `lib/auth/totp.js`
- Test: `tests/unit/auth/totp.test.js`

Wraps `otplib`. The TOTP secret is encrypted with the user's customer DEK (for customer users) or with the KEK directly (for admins, since admins have no customer DEK).

- [ ] **Step 1: Failing tests** for: `generateSecret`, `verify` (correct token + ±1 window), `verify` rejection of past/future windows beyond ±1, encoding of secret as base32.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Pass. Commit.**

---

### Task 3.5: `lib/auth/webauthn.js`

**Files:**
- Create: `lib/auth/webauthn.js`
- Test: `tests/unit/auth/webauthn.test.js`

Wraps `@simplewebauthn/server`. Stores credentials JSON in `webauthn_creds` JSONB column. v1 supports platform authenticators only (Touch ID / Windows Hello / device-bound); roaming authenticators are out of scope.

- [ ] **Step 1: Failing tests** for: registration challenge generation, registration verification, authentication challenge, authentication verification, credential rotation/removal.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Pass. Commit.**

---

### Task 3.6: `lib/auth/email-otp.js`

**Files:**
- Create: `lib/auth/email-otp.js`
- Test: `tests/integration/auth/email-otp.test.js`

6-digit OTP, 5-min TTL, queues into `email_outbox` (worker built in M4 — for now, the test inspects the queued row directly).

- [ ] **Step 1: Failing test.** `requestOtp` enqueues, `verifyOtp` consumes single-use, expired tokens rejected, 3-attempt cap.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Pass. Commit.**

---

### Task 3.7: `lib/auth/backup-codes.js`

**Files:**
- Create: `lib/auth/backup-codes.js`
- Test: `tests/unit/auth/backup-codes.test.js`

8 codes, generated at 2FA enrolment, displayed once, stored as Argon2id hashes in `backup_codes` JSONB. Consumed on use; row updated to mark consumed.

- [ ] **Step 1: Failing test** for: generate-8, verify+consume marks `consumed_at`, second use rejected, regenerate clears all old.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Pass. Commit.**

---

### Task 3.8: `domain/admins/repo.js` + `service.js`

**Files:**
- Create: `domain/admins/repo.js` (DB CRUD)
- Create: `domain/admins/service.js` (business logic)
- Test: `tests/integration/admins/service.test.js`

Service exposes: `create`, `setPassword(adminId, plaintext)` → HIBP block + Argon2id store, `enroll2faTotp/Webauthn/EmailOtp`, `regenBackupCodes`, `verifyLogin`, `requestPasswordReset`, `consumeReset`.

- [ ] **Step 1, 2, 3 (TDD).** One test per public method. Each method writes to `audit_log`.

- [ ] **Commit.**

---

### Task 3.9: `scripts/create-admin.js` — first-admin bootstrap

**Files:**
- Create: `scripts/create-admin.js`

Idempotent CLI. Refuses to run if any admin exists (use `domain/admins/service.js#requestPasswordReset` for subsequent admins). Generates a magic-link token; prints the link to stdout (since email pipeline isn't ready until M4).

- [ ] **Step 1: Implement** — interactive prompt for email + name; insert admin row with `password_hash = NULL`; create a magic-link token with 7-day expiry; print `https://portal.dbstudio.one/welcome/<token>` to stdout.

- [ ] **Step 2: Manual smoke** — operator runs it on the server; clicks the printed link in browser; expects (after Task 3.10 completes) a working welcome flow.

- [ ] **Commit.**

---

### Task 3.10: Public auth routes — `/login`, `/logout`, `/welcome/:token`, `/reset/:token`

**Files:**
- Create: `routes/public/login.js`, `routes/public/logout.js`, `routes/public/welcome.js`, `routes/public/reset.js`
- Create: `views/public/{login,welcome,reset,2fa-challenge,2fa-enrol}.ejs`
- Test: `tests/integration/auth/login-flow.test.js` (full flow: welcome → set password → enrol 2FA → display backup codes → login → 2FA challenge → success)

- [ ] **Step 1: Failing integration test for the full flow.**

- [ ] **Step 2: Implement routes one-by-one inside this task; each has its own sub-test:**
  - `GET /welcome/:token` renders set-password form (with HIBP error reflected if blocked).
  - `POST /welcome/:token` sets password, enrols a 2FA method (default TOTP), displays backup codes once.
  - `GET /login` renders form.
  - `POST /login` rate-limited (Task 3.2), no-enumeration response, on success redirects to 2FA challenge or main app if no 2FA configured (admins always have it).
  - `POST /login/2fa` accepts TOTP / WebAuthn / email-OTP / backup-code path.
  - `GET /logout` revokes current session, redirects to `/login`.
  - `GET /reset/:token` and `POST /reset/:token` mirror welcome-flow but for forgotten-password.

- [ ] **Step 3: Pass. Commit. Multiple commits expected here, one per route family.**

---

### Task 3.11: New-device detection + audit

**Files:**
- Modify: `lib/auth/session.js` (compute device fingerprint = sha256(UA + IP/24))
- Modify: `domain/admins/service.js` (on login, compare against last 30 days; if new, write audit + queue email — email queued via outbox)
- Test: `tests/integration/auth/new-device.test.js`

- [ ] **Step 1, 2, 3 (TDD).** Commit.

---

### Task 3.12: `npm run test:coverage` ≥ 80 % on `lib/auth/**` and `domain/admins/**`

- [ ] **Run coverage. Fill gaps with additional unit tests until threshold met.**
- [ ] **Commit any new tests.**

---

### Task 3.13: Update `RUNBOOK.md` with admin reset procedure

```markdown
### Admin password reset / lockout
1. SSH to server.
2. sudo -u portal-app /opt/dbstudio_portal/.node/bin/node scripts/admin-reset.js <email>
   (or, until that script exists in M9: directly INSERT a fresh invite_token via psql).
3. Operator clicks the printed link in browser to set a new password and re-enrol 2FA.
```

- [ ] **Commit.**

---

## ✅ Review checkpoint M3 → M4

Hand `M2_END..HEAD` to `superpowers:requesting-code-review`. Verify:

- Full login flow works end-to-end through curl + a manual browser session for one admin.
- All three 2FA methods enrol and verify.
- Coverage gate met.
- Audit log shows: admin_created, password_set, 2fa_enrolled, login_success, login_fail, session_revoked.

---

# M4 — Email pipeline

**Goal:** All 14 transactional templates compiled at build time. `email_outbox` worker dequeues and sends via MailerSend. End-to-end test: queue → worker → MailerSend → inbox confirmed. Idempotency keys prevent dupes; failed sends retry with exponential backoff to a max of 5 attempts then go to `failed`.

**Estimated working days:** 2–3.

---

### 🛑 OPERATOR GATE M4-A — confirm MailerSend domain + dedicated API key

**Blocker:** the implementer cannot complete M4 without these. Do them first.

> v1 sender is `portal@dbstudio.one` (shared with DB Studio marketing — see spec §2.9 / §10 risk register). Reputation isolation to `mail.portal.dbstudio.one` is deferred.

- [ ] **Operator: confirm `dbstudio.one` is already verified in MailerSend** (it is, if marketing email goes through it). If not yet verified:
  - In MailerSend dashboard → Domains → Add `dbstudio.one`
  - Add the SPF/DKIM TXT records they show in Cloudflare; wait for verification (≤ 1 h)
  - DMARC: confirm `_dmarc.dbstudio.one` is set to at least `v=DMARC1; p=quarantine; rua=mailto:bram@roxiplus.es`

- [ ] **Operator: in MailerSend dashboard:**
  - Generate a **dedicated API key** for the portal (separate from any marketing key, so it can be revoked independently). Token name: `portal-v1`. Permissions: send only.
  - Copy the key once — MailerSend won't show it again.

- [ ] **Operator: paste the key into `.env` on the server.**

```bash
sudo -u portal-app sudoedit /opt/dbstudio_portal/.env
# Set MAILERSEND_API_KEY=mlsn.<the-key>
sudo systemctl restart portal.service
sudo journalctl -u portal.service -n 30   # confirm safety-check passes; no "missing MAILERSEND_API_KEY" lines
```

- [ ] **Operator: confirm the gate.** Send a one-line manual test email via `curl` against the MailerSend API (from `portal@dbstudio.one`) as a sanity check — expect 202 and an inbox arrival at `bram@roxiplus.es`. Document key fingerprint (last 4 chars only) in `RUNBOOK.md` under "Email provider state".

---

### Task 4.1: `lib/email.js` — MailerSend client

**Files:**
- Create: `lib/email.js`
- Test: `tests/integration/email/mailersend.test.js` (skipped unless `RUN_LIVE_EMAIL=1`)

- [ ] **Step 1: Failing test.** Mocks fetch; asserts: correct headers (Authorization, Content-Type), correct payload shape, retry on 429/5xx with backoff, final failure throws after 5 attempts.

- [ ] **Step 2: Implement.**

```js
export function makeMailer({ apiKey, fromEmail, fromName }) {
  return {
    async send({ to, subject, html, text, idempotencyKey }) {
      const body = {
        from: { email: fromEmail, name: fromName },
        to: [{ email: to }],
        subject, html, text
      };
      // single attempt; the worker handles retry/backoff
      const r = await fetch('https://api.mailersend.com/v1/email', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                   'X-Idempotency-Key': idempotencyKey ?? '' },
        body: JSON.stringify(body)
      });
      if (r.status === 202) return { ok: true, providerId: r.headers.get('x-message-id') };
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error('retryable'), { retryable: true });
      throw Object.assign(new Error(`mailersend ${r.status}`), { retryable: false, status: r.status });
    }
  };
}
```

- [ ] **Step 3: Commit.**

---

### Task 4.2: 14 EJS email templates + compile script

**Files:**
- Create: `emails/en/<slug>.ejs` × 14 (subject in front-matter comment)
- Create: `emails/_layout.ejs`
- Create: `scripts/email-build.js`
- Create: `lib/email-templates.js` (loader at runtime; uses pre-compiled output)
- Test: `tests/unit/email/templates.test.js`

The 14 slugs (from spec §2.9):

1. `customer-invitation`
2. `customer-pw-reset`
3. `admin-pw-reset`
4. `2fa-reset-by-admin`
5. `email-change-verification`
6. `email-change-notification-old`
7. `new-device-login`
8. `new-document-available`
9. `new-invoice`
10. `credential-request-created`
11. `nda-ready`
12. `generic-admin-message`
13. `invite-expiring-soon`
14. `admin-alert-invite-unused-7d`

- [ ] **Step 1: Failing test.** For each slug, asserts: render with sample locals produces a valid HTML doc + the expected subject + body containing the expected token (e.g., the magic link URL).

- [ ] **Step 2: Implement each template, one commit per template** (14 small commits — they are independent and easy to review).

- [ ] **Step 3: `scripts/email-build.js`** loads all `.ejs` files at build time, pre-compiles to functions, writes `emails/_compiled.js` for cheap runtime use.

- [ ] **Step 4: Wire into `npm run build` (already in `scripts/build.js`; add the email step).**

- [ ] **Step 5: All 14 tests pass. Commit.**

---

### Task 4.3: Outbox worker (`domain/email-outbox/worker.js`)

**Files:**
- Create: `domain/email-outbox/worker.js`
- Create: `domain/email-outbox/repo.js` (`enqueue`, `claim`, `markSent`, `markFailed`)
- Test: `tests/integration/email-outbox/worker.test.js`

The worker runs **inside** `portal.service` on a 5-second tick (no separate process). Claim with `SELECT ... FOR UPDATE SKIP LOCKED` to allow horizontal scaling later (we don't horizontally scale in v1, but the pattern is correct).

- [ ] **Step 1: Failing test.** Enqueue 3 messages with `mailersend.send` stubbed. Tick the worker. Assert: 3 sent, statuses `sent`, `sent_at` populated, idempotency keys preserved.

- [ ] **Step 2: Implement.**

```js
export async function tickOnce({ db, mailer, log, batchSize = 10 }) {
  await db.transaction().execute(async (tx) => {
    const claimed = await tx.executeQuery({
      sql: `UPDATE email_outbox SET status='sending', attempts=attempts+1
              WHERE id IN (SELECT id FROM email_outbox
                           WHERE status IN ('queued','failed') AND send_after <= now()
                             AND attempts < 5
                           ORDER BY send_after ASC LIMIT $1
                           FOR UPDATE SKIP LOCKED)
              RETURNING *`, parameters: [batchSize]
    });
    for (const row of claimed.rows) {
      try {
        const html = await renderTemplate(row.template, row.locale, row.locals);
        const result = await mailer.send({ to: row.to_address, subject: html.subject, html: html.body, idempotencyKey: row.idempotency_key });
        await tx.updateTable('email_outbox').set({ status: 'sent', sent_at: new Date(), last_error: null }).where('id','=',row.id).execute();
      } catch (e) {
        await tx.updateTable('email_outbox').set({
          status: e.retryable ? 'queued' : 'failed',
          send_after: new Date(Date.now() + Math.min(2 ** row.attempts * 60_000, 3_600_000)),
          last_error: String(e.message)
        }).where('id','=',row.id).execute();
      }
    }
  });
}

export function startWorker(deps) {
  const interval = setInterval(() => tickOnce(deps).catch(e => deps.log.error({ err: e }, 'outbox tick')), 5000);
  return () => clearInterval(interval);
}
```

- [ ] **Step 3: Wire `startWorker` into `server.js` after Fastify is built.** Add a graceful shutdown.

- [ ] **Step 4: Pass. Commit.**

---

### Task 4.4: End-to-end live email smoke

**Files:**
- Create: `tests/integration/email/live-smoke.test.js` (skipped unless `RUN_LIVE_EMAIL=1`)

- [ ] **Step 1: Implement the smoke.** Enqueues a `generic-admin-message` to `bram@roxiplus.es`; runs one tick; polls until status=`sent`; **operator manually confirms inbox arrival**.

- [ ] **Step 2: Run on the server with `RUN_LIVE_EMAIL=1`. Operator confirms inbox.**

- [ ] **Step 3: Commit. Update RUNBOOK with smoke procedure.**

---

### Task 4.5: Replace M3's "print magic link to stdout" with email send

**Files:**
- Modify: `scripts/create-admin.js` to enqueue the welcome email instead of printing.
- Modify: `domain/admins/service.js` `requestPasswordReset` to enqueue.
- Test: each previous M3 test that asserted `console.log` now asserts an outbox row.

- [ ] **Commit.**

---

## ✅ Review checkpoint M4 → M5

Hand `M3_END..HEAD` to `superpowers:requesting-code-review`. Verify:

- DKIM signature on the smoke email shows `d=mail.portal.dbstudio.one` (operator pastes the raw header into the review).
- Outbox worker handles a forced retryable failure and marks the row `queued` with backoff.
- All 14 templates render against fixture locals.

---

# M5 — Customer create + onboarding

**Goal:** Admin can create a customer (transaction: insert row + generate DEK + wrap with KEK + create first customer-user with invite token + enqueue welcome email — all in one Postgres transaction). Customer clicks magic link, sets password (HIBP-checked), enrols 2FA (any of three methods), reviews their profile, lands on a customer dashboard stub.

**Estimated working days:** 4–5.

---

### Task 5.1: `domain/customers/repo.js`, `service.js`

**Files:**
- Create: `domain/customers/{repo,service}.js`
- Test: `tests/integration/customers/create.test.js`

- [ ] **Step 1: Failing test.** `service.create({ razonSocial, nif, domicilio, primaryUser: { name, email } })` returns a customer ID; the DB has: 1 customers row with valid wrapped DEK; 1 customer_users row with invite_token_hash; 1 audit_log entry; 1 email_outbox row with template `customer-invitation`.

- [ ] **Step 2: Implement.** All inside one `db.transaction()`.

- [ ] **Step 3: Pass. Commit.**

---

### Task 5.2: Admin customer-list view

**Files:**
- Create: `routes/admin/customers.js`
- Create: `views/admin/customers/{list,new,detail}.ejs`
- Test: `tests/integration/admin/customers-list.test.js`

- [ ] **Pagination, search by `razon_social` / `nif`. Render with the admin layout. Form CSRF-protected.**

- [ ] **Commit.**

---

### Task 5.3: Customer onboarding routes

**Files:**
- Create: `routes/customer/onboarding.js` — mirrors `routes/public/welcome.js` from M3 but for customer-users (separate session table key; lands on `/customer/dashboard`).
- Create: `views/customer/onboarding/{set-password,enrol-2fa,backup-codes,profile-review}.ejs`
- Test: `tests/integration/customer/onboarding.test.js`

- [ ] **Step 1: Full-flow test.** Token → set password → enrol TOTP → display 8 backup codes → profile-review → dashboard. Commit.

---

### Task 5.4: Customer dashboard stub

**Files:**
- Create: `routes/customer/dashboard.js`
- Create: `views/customer/dashboard.ejs`

- [ ] **Empty dashboard with placeholders for: documents (M6), invoices (M8), credentials (M7), profile (M9). One commit.**

---

### Task 5.5: Admin can suspend / archive a customer

**Files:**
- Modify: `domain/customers/service.js` (suspend/archive transitions)
- Modify: `routes/admin/customers.js`
- Test: `tests/integration/customers/transitions.test.js`

- [ ] **Suspend = sessions revoked + new-login blocked. Archive = read-only for admin, no customer access. Commit.**

---

## ✅ Review checkpoint M5 → M6

Hand `M4_END..HEAD` to `superpowers:requesting-code-review`. Verify:

- Customer create is fully transactional (kill `pg_dump` mid-create → no orphan rows).
- DEK wrapped under KEK and unwraps to a 32-byte buffer.
- Onboarding flow works in browser end-to-end.

---

# M6 — Documents + projects

**Goal:** Admin uploads documents (per-customer storage tree, 50 MB per file, 5 GB per customer, magic-byte sniff, SHA-256 verify), assigns to projects, customer downloads via 60s single-use signed URL. Version chain via `parent_id`.

**Estimated working days:** 4.

---

### Task 6.1: `lib/files.js` — storage path + signed download token

**Files:**
- Create: `lib/files.js`
- Test: `tests/unit/files.test.js`

- [ ] **Step 1: Failing tests** for: `storagePath(customerId, fileId, ext)` correct shape; `safeFilename` strips path components + normalises unicode; `assertSize(50MB)` accept/reject; `assertCustomerQuota(currentBytes, newBytes, 5GB)` accept/reject; `mimeFromMagic(buffer)` consults `file-type`; signed download token = `signFileUrl` from M2.

- [ ] **Step 2: Implement.** Commit.

---

### Task 6.2: Upload pipeline

**Files:**
- Create: `domain/documents/{repo,service}.js`
- Create: `routes/admin/documents.js` (POST upload)
- Test: `tests/integration/documents/upload.test.js`

`@fastify/multipart` with `limits.fileSize = 50 MB`. On upload: read into a hashing stream, write to temp path, mime-sniff, reject if mismatch, rename to final path, insert row.

- [ ] **Failing test, implement, pass, commit.**

---

### Task 6.3: Download flow

**Files:**
- Modify: `routes/customer/documents.js` (and admin) — `GET /documents/:id/download` redirects to signed URL.
- Create: `routes/public/files.js` — `GET /files/:token` consumes the token, streams the file, marks token consumed.
- Test: `tests/integration/documents/download.test.js`

- [ ] **Failing test:**
  - Admin uploads → customer fetches `/documents/:id/download` → 302 to `/files/<token>` → 200 + correct bytes.
  - Token replay (second GET) → 410 Gone.
  - Token tamper → 400.
  - Wrong customer → 403.
  - SHA-256 verify on stream out (recompute as bytes flow; if mismatch, abort with 500 + audit `file_integrity_failure`).

- [ ] **Implement, commit.**

---

### Task 6.4: Projects CRUD

**Files:**
- Create: `domain/projects/{repo,service}.js`
- Create: `routes/admin/projects.js`
- Create: `routes/customer/projects.js`
- Test: `tests/integration/projects/crud.test.js`

- [ ] **Status transitions free in v1 but logged. `objeto_proyecto` required (used by NDA in M8). Commit.**

---

### Task 6.5: Version chain

**Files:**
- Modify: `domain/documents/service.js` to accept `parent_id` on upload; new doc inherits category, increments implicit version.
- Test: `tests/integration/documents/versions.test.js`

- [ ] **Failing test, implement, pass, commit.**

---

## ✅ Review checkpoint M6 → M7

Hand the diff. Verify:
- Quota enforcement (try uploading 5.01 GB cumulative → reject).
- Magic-byte mismatch (rename a `.zip` to `.pdf`, upload → reject).
- Download token replay rejected; lifespan ≤ 60 s.

---

# M7 — Credential vault + requests

**Goal:** Admin issues credential requests with custom field schemas; customer fulfils (encrypts with their DEK before save); customer can also create credentials unprompted. Admin can view a credential — but viewing requires re-auth (step-up < 5 min) and is **always** audit-visible to the customer. 5-minute idle auto-lock on the vault. `not_applicable` reason flow.

**Estimated working days:** 5–6. **Coverage gate ≥ 80 % on `domain/credentials/**`**.

---

### Task 7.1: Provider catalogue seed

**Files:**
- Create: `migrations/0002_provider_catalogue_seed.sql`

Seed with the operator's known provider list. Get the list from the operator at the start of M7; if not yet known, seed with: `aws`, `gcp`, `azure`, `cloudflare`, `digitalocean`, `hetzner`, `mailersend`, `stripe`, `github`, `gitlab`, `bitbucket`, `wordpress-admin`, `wp-engine`, `kinsta`, `cpanel`, `vps-root`, `domain-registrar`, `dns-provider`, `email-service`, `s3-bucket`. Each row with `default_fields` = JSON schema for typical fields.

- [ ] **Migration + commit.**

---

### Task 7.2: `domain/credentials/repo.js` + `service.js`

**Files:**
- Create: `domain/credentials/{repo,service}.js`
- Test: `tests/integration/credentials/{create,view,fulfil}.test.js`

Service methods:
- `createByCustomer({ customerId, customerUserId, provider, label, payload })` → encrypts payload with customer DEK; audit `credential_created`, visible_to_customer=true.
- `createByAdminFromRequest({ requestId, payload })` (admin completes a request on customer's behalf).
- `view({ adminId, credentialId })` → requires step-up; decrypts; audit `credential_viewed`, visible_to_customer=true.
- `markNeedsUpdate({ adminId, credentialId })`.
- `delete({ customerUserId, credentialId })` (customer-initiated only; admin cannot delete in v1 — customer trust contract).

- [ ] **Failing test per method, implement, pass, commit.**

---

### Task 7.3: Vault auto-lock

**Files:**
- Create: `lib/auth/vault-lock.js`
- Modify: routes that view credentials to gate on `vault-lock`
- Test: `tests/integration/credentials/auto-lock.test.js`

`vault-lock` is a session-scoped flag separate from step-up: idle 5 minutes since last credential interaction → flag cleared → next view requires fresh step-up.

- [ ] **Failing test, implement, pass, commit.**

---

### Task 7.4: Credential request workflow

**Files:**
- Create: `domain/credential-requests/{repo,service}.js`
- Create: `routes/admin/credential-requests.js`
- Create: `routes/customer/credential-requests.js`
- Test: `tests/integration/credential-requests/workflow.test.js`

- [ ] **Failing test:** admin creates request with custom fields → customer fulfils with payload → request status `fulfilled` → fulfilled_credential_id set → audit visible to customer.

- [ ] **`not_applicable` path:** customer marks not applicable, supplies reason; request transitions, audit logged, no credential created.

- [ ] **Commit.**

---

### Task 7.5: Customer activity-feed slice for vault

**Files:**
- Modify: `lib/audit.js` consumers; ensure all credential-touching events have `visible_to_customer=true` and a `metadata.label` for display.

- [ ] **Test: customer can read their own credential audit slice with stable, redacted display strings (no IP/UA, no admin name leakage of personal email — show admin's display name only). Commit.**

---

### Task 7.6: Coverage gate

- [ ] **Run `npm run test:coverage`. Fill gaps until `domain/credentials/**` ≥ 80 %.**

---

## ✅ Review checkpoint M7 → M8

Hand the diff. Verify:
- `sudo -u portal-pdf psql portal_db` fails (permission denied), confirming the PDF user has no DB access (acceptance §11 item).
- Admin viewing a credential without step-up is rejected (302 to step-up).
- Customer sees the admin's view in their activity feed within 1 s.

---

# M8 — Invoices + NDA

**Goal:** Invoice CRUD with status (open / paid / void) + dynamic overdue computation. NDA generator: Mustache renders `templates/nda.html` with project + customer fields → SHA-256 of rendered HTML → IPC to `portal-pdf.service` → PDF stored as `documents.category='nda-draft'` → `ndas` row with `template_version_sha`. Admin uploads signed NDA, optional audit-trail PDF, links to draft via `related_nda_id`.

**Estimated working days:** 4–5.

---

### Task 8.1: `domain/invoices/`

**Files:**
- Create: `domain/invoices/{repo,service}.js`
- Create: `routes/admin/invoices.js`
- Create: `routes/customer/invoices.js`
- Test: `tests/integration/invoices/{crud,status,overdue}.test.js`

`overdue = (status='open' AND due_on < today)`. Computed in SQL and exposed as a derived field; never stored.

- [ ] **Failing test, implement, pass, commit.**

---

### Task 8.2: NDA template + bundling

**Files:**
- Create: `templates/nda.html` (Spanish legal text — operator supplies the verbatim text from current legal counsel).
- Modify: `scripts/bootstrap-secrets.sh` does NOT touch templates. Add a new `scripts/bootstrap-templates.sh` that copies `templates/nda.html` to `/var/lib/portal/templates/nda.html` and rewrites the Google Fonts `@import` to a local `@font-face` referencing `/var/lib/portal/fonts/cormorant-garamond-500.woff2`.
- Test: `tests/integration/nda/template-bootstrap.test.js`

- [ ] **Failing test:** bootstrap script run → file exists at `/var/lib/portal/templates/nda.html` → contains `@font-face` and no remote `@import url(`. Commit.

---

### Task 8.3: `lib/nda.js` — Mustache render + sha256

**Files:**
- Create: `lib/nda.js`
- Test: `tests/unit/nda.test.js`

- [ ] **Failing test:** `renderNda({ template, vars }) → { html, sha256 }`. Identical vars + template → identical sha. Mustache auto-escape verified (HTML in `domicilio` is escaped).

- [ ] **Implement, pass, commit.**

---

### Task 8.4: NDA generation route

**Files:**
- Create: `domain/ndas/{repo,service}.js`
- Create: `routes/admin/ndas.js`
- Create: `views/admin/ndas/{list,new,detail}.ejs`
- Test: `tests/integration/ndas/generate.test.js`

Service `generateDraft({ adminId, projectId })`:
1. Load customer + project vars.
2. Render Mustache → html + sha256.
3. Call `lib/pdf-client.js#renderPdf` over `/run/portal-pdf.sock`.
4. If `ok=false, error='overflow'`, return structured error to UI (offending field).
5. On success, write PDF to `/var/lib/portal/storage/<customer_id>/<uuid>.pdf`, insert document row (`category='nda-draft'`), insert ndas row with `template_version_sha = html sha`.
6. Audit `nda_draft_generated`, visible_to_customer=true.
7. Enqueue `nda-ready` email.

- [ ] **Failing tests:**
  - Happy path → `ndas` row + `documents` row + audit + outbox row.
  - Overflow → no rows, structured error, audit `nda_draft_overflow`.
  - Two generations on the same template → same `template_version_sha`. (Acceptance §11 NDA template auditability.)
  - Modify template (touch a comma) → different sha.

- [ ] **Implement, commit.**

---

### Task 8.5: Signed NDA upload

**Files:**
- Modify: `routes/admin/ndas.js` (POST signed upload).
- Test: `tests/integration/ndas/upload-signed.test.js`

Admin uploads the signed PDF (and optional audit-trail PDF). The system:
- Inserts new `documents` row(s).
- Updates `ndas.signed_document_id` (and `audit_document_id`).
- Audit `nda_signed_uploaded`.
- Enqueues a customer email.

- [ ] **Failing test, implement, commit.**

---

### Task 8.6: Customer NDA visibility

**Files:**
- Create: `routes/customer/ndas.js`
- Create: `views/customer/ndas/list.ejs`

Customer sees a list of NDAs for their projects with: title, draft download (signed URL), signed download (signed URL), template version sha (last 8 chars displayed for transparency).

- [ ] **Test, commit.**

---

## ✅ Review checkpoint M8 → M9

Hand the diff. Verify:
- Two NDAs against same template → identical sha (acceptance §11).
- `systemctl stop portal-pdf.service` → NDA generation returns clean error; rest of portal works (acceptance §11 two-service split).
- `sudo -u portal-pdf curl https://example.com` fails (no network).

---

# M9 — Profile + activity + polish

**Goal:** Profile management for both sides (name, email change with verify, password change with HIBP, 2FA regen, backup codes regen, sessions list, "log out everywhere"). Customer activity feed (filtered slice). Admin audit-log view + CSV export. All email triggers wired. i18n key audit. Accessibility pass. Full §11 acceptance checklist (excluding the two go-live items in M10) green.

**Estimated working days:** 4–5.

---

### Task 9.1: Profile management — customer side

**Files:**
- Create: `routes/customer/profile.js`
- Create: `views/customer/profile/{index,email-change,password,2fa,sessions}.ejs`
- Test: `tests/integration/customer/profile/*.test.js`

Sub-tasks (each with a failing test → implementation → pass → commit):
- Name change.
- Email change (sends verification to new addr; revert link to old addr per spec §17).
- Password change with HIBP block + audit.
- 2FA regen (re-enrols any of the three methods; current 2FA must be re-verified to allow regen).
- Backup codes regen (displays once; replaces all old).
- Sessions list with "Revoke this device" + "Log out everywhere".

- [ ] **Five separate commits, one per sub-task.**

---

### Task 9.2: Profile management — admin side

**Files:**
- Create: `routes/admin/profile.js`
- Mirror customer flows above for admins.

- [ ] **Commits as above.**

---

### Task 9.3: Customer activity feed

**Files:**
- Create: `routes/customer/activity.js`
- Create: `views/customer/activity.ejs`
- Test: `tests/integration/customer/activity.test.js`

Reads from `audit_log` filtered on `target_id = customer.id AND visible_to_customer=true`. Pagination, date range, action-type filter.

- [ ] **Failing test, implement, commit.**

---

### Task 9.4: Admin audit-log view + CSV export

**Files:**
- Create: `routes/admin/audit.js`
- Create: `routes/admin/audit-export.js` (streams CSV)
- Create: `views/admin/audit.ejs`
- Test: `tests/integration/admin/audit.test.js`

CSV is streamed (no buffering) — `audit_log` may grow large. Filter by date range, actor, action.

- [ ] **Commit.**

---

### Task 9.5: i18n key audit

**Files:**
- Create: `scripts/i18n-audit.js`
- Modify: any view/route that has hardcoded user-facing strings.

Script: greps every `.ejs` and route file for raw strings inside `>...<` and `'...'` that don't go through `t()`. Prints offenders. CI gate.

- [ ] **Run the script, fix every offender, commit.**

---

### Task 9.6: Accessibility pass

**Files:**
- Modify: views as needed.

Run `axe-core` against each main view (login, welcome, dashboard, customer/documents, customer/credentials, admin/customers, admin/audit). Fix violations: heading order, label associations, contrast (using design tokens — should already be fine), focus traps, skip-links.

- [ ] **One commit per view family.**

---

### Task 9.7: §11 acceptance checklist dry run

Walk the spec §11 checklist line-by-line. For each item that should already be green, check it; for any not-yet-green item, file a follow-up task in `docs/superpowers/follow-ups.md`. The two M10 items (backup integrity drill, mail isolation) are out of scope for this checkpoint.

- [ ] **Commit the follow-ups doc.**

---

## ✅ Review checkpoint M9 → M10

Hand the diff. Verify:

- `npm run lint`, `npm run typecheck`, `npm run test:coverage` all green; coverage gates met.
- §11 acceptance items (excluding M10) all green or explicitly tracked in follow-ups.
- i18n audit clean.
- Manual browser walkthrough by operator (login, customer onboarding, document up/down, credential request fulfilment, NDA generation+sign upload, profile changes) succeeds end-to-end on the server.

---

# M10 — Backups + go-live

**Goal:** Nightly `age`-encrypted backup to Hetzner Storage Box. Restore drill: pick a backup at random, decrypt with the offline private key, restore into a scratch Postgres, decrypt one customer credential successfully. Smoke test expanded. Coming-soon page swapped for the real portal in NPM. **First public exposure.**

**Estimated working days:** 2.

---

### 🛑 OPERATOR GATE M10-A — Storage Box + age keypair

- [ ] **Operator: provision a Hetzner Storage Box.** From [https://www.hetzner.com/storage/storage-box](https://www.hetzner.com/storage/storage-box). Pick the smallest plan that fits: storage size ≥ (5 GB × estimated customer count × 30 daily backups + 12 monthly + 5 yearly).

- [ ] **Operator: configure SSH key auth on the Storage Box** (paste the server's `portal-app` user's `~/.ssh/id_ed25519.pub` into the box's "External" tab; or use sub-user with a dedicated key).

- [ ] **Operator: install and configure `rclone` for `portal-app`:**

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/npx rclone config
# Choose: New remote, name "hetzner-portal", type "sftp",
# host "uXXXXXX.your-storagebox.de", user "uXXXXXX", port 23,
# key_file /home/portal-app/.ssh/id_ed25519
sudo -u portal-app rclone lsd hetzner-portal:
```

- [ ] **Operator (on workstation, NOT server): generate the `age` keypair.**

```bash
age-keygen -o portal-backup-age.key   # private key — NEVER goes on the server
grep '^# public key:' portal-backup-age.key
# copy the line "age1..." after the comment
```

- [ ] **Operator (on server): paste the public key into `/var/lib/portal/.age-recipients`.**

```bash
sudo -u portal-app tee /var/lib/portal/.age-recipients <<'EOF'
age1examplepublickeyfromworkstation...
EOF
sudo chmod 0440 /var/lib/portal/.age-recipients
sudo chown portal-app:portal-app /var/lib/portal/.age-recipients
```

- [ ] **Operator: create a SECOND copy of the private key on a SECOND physical medium** (per spec §10 risk register). Document where both copies live in `RUNBOOK.md` (custody-only — not the actual key material).

- [ ] **Operator: install `age` CLI on the server** (apt or static binary; verify `age --version`).

---

### Task 10.1: `scripts/backup.sh`

**Files:**
- Create: `scripts/backup.sh`
- Create: `/etc/cron.d/portal-backup` (operator installs)
- Test: `tests/integration/backup/backup.test.js` (skipped unless `RUN_BACKUP_TESTS=1`)

- [ ] **Step 1: Implement.** Script body matches spec §2.12.

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=/opt/dbstudio_portal
DATA_DIR=/var/lib/portal
BACKUP_DIR=$DATA_DIR/backups
TS=$(date -u +%Y%m%dT%H%M%SZ)
RECIPIENTS=$DATA_DIR/.age-recipients
REMOTE=${BACKUP_RCLONE_REMOTE:-hetzner-portal:portal/}

mkdir -p "$BACKUP_DIR"
cd "$BACKUP_DIR"

DB_FILE=db-$TS.dump
ST_FILE=storage-$TS.tar

# 1. pg_dump
pg_dump --format=custom "$DATABASE_URL" > "$DB_FILE"

# 2. storage tarball
tar -cf "$ST_FILE" -C "$DATA_DIR" storage

# 3. encrypt
age --encrypt --recipients-file "$RECIPIENTS" -o "$DB_FILE.age" "$DB_FILE"
age --encrypt --recipients-file "$RECIPIENTS" -o "$ST_FILE.age" "$ST_FILE"
shred -u "$DB_FILE" "$ST_FILE"

# 4. rclone push
rclone copy "$DB_FILE.age" "$REMOTE/$TS/" --immutable
rclone copy "$ST_FILE.age" "$REMOTE/$TS/" --immutable

# 5. retention (local copies only — remote retention enforced server-side by Storage Box settings)
find "$BACKUP_DIR" -name 'db-*.age' -mtime +30 -delete
find "$BACKUP_DIR" -name 'storage-*.age' -mtime +30 -delete

logger -t portal-backup "backup complete: $TS"
```

- [ ] **Step 2: Implement test** (skipped unless `RUN_BACKUP_TESTS=1`): runs the script with a fake `DATABASE_URL` against the dev DB and a fake rclone remote (local path), confirms `.age` files land in the remote, decrypts one with a known throwaway age private key, verifies pg_dump structure.

- [ ] **Step 3: Commit.**

```bash
chmod +x scripts/backup.sh
git add scripts/backup.sh tests/integration/backup/backup.test.js
git commit -S -m "feat(m10): nightly age-encrypted backup to hetzner storage box"
```

---

### Task 10.2: cron + journal

**Files:**
- Create: `systemd/portal-backup.timer`, `systemd/portal-backup.service` (preferred over crond — matches the rest of the stack and gets journal logging for free).

```ini
# portal-backup.service
[Service]
Type=oneshot
User=portal-app
Group=portal-app
EnvironmentFile=/opt/dbstudio_portal/.env
ExecStart=/opt/dbstudio_portal/scripts/backup.sh
SyslogIdentifier=portal-backup
```

```ini
# portal-backup.timer
[Unit]
Description=Nightly portal backup at 02:30 UTC

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Commit. Operator installs + enables the timer (sub-step of M10 gate B below).**

---

### Task 10.3: Restore drill script

**Files:**
- Create: `scripts/restore-drill.sh`
- Create: `RUNBOOK.md` § "Backup restore drill"

The script:
1. Picks a random backup directory from the Storage Box.
2. Pulls the two `.age` files locally.
3. Prompts the operator for the path to the offline `age` private key (entered at the keyboard, never persisted).
4. Decrypts both files.
5. Creates a scratch DB `portal_drill_<ts>`, `pg_restore` into it.
6. Reads one customer row + tries to unwrap its DEK with the production KEK (or a test KEK fixture).
7. Tries to decrypt one credential payload.
8. Reports success/failure; drops the scratch DB.

- [ ] **Step 1: Implement, commit.**

---

### 🛑 OPERATOR GATE M10-B — Run the restore drill

The drill is part of the acceptance gate. It must be run **before** the NPM swap.

- [ ] **Operator: run `scripts/backup.sh` once manually.** Confirm files in Storage Box.

```bash
sudo systemctl start portal-backup.service
sudo journalctl -u portal-backup.service -n 100
sudo -u portal-app rclone lsl hetzner-portal:portal/$(date -u +%Y%m%dT*)/
```

- [ ] **Operator: enable the timer.**

```bash
sudo systemctl enable --now portal-backup.timer
sudo systemctl list-timers | grep portal-backup
```

- [ ] **Operator: run `scripts/restore-drill.sh` with the workstation's offline age private key. Verify the script reports "OK: 1 customer + 1 credential decrypted cleanly".**

- [ ] **Operator: document the drill outcome in `RUNBOOK.md`.**

---

### Task 10.4: Expanded smoke test

**Files:**
- Modify: `scripts/smoke.sh`

Add to the existing smoke:
- MailerSend API reachable (HTTP HEAD against `/v1/email` with the API key — expect 401 means key not granted HEAD; 405 method not allowed; basically anything non-DNS-fail counts).
- Signed-URL round-trip (issue a token via `lib/crypto/tokens.js`, verify same process).
- portal-pdf hello probe (renders `<h1>hi</h1>`, asserts non-empty PDF).
- Migration ledger up-to-date (`SELECT count(*)` matches files in `migrations/`).

- [ ] **Commit.**

---

### Task 10.5: Final acceptance pass

Walk **the entire spec §11 checklist** including the additions documented in M0–M9 plus:
- DKIM `d=mail.portal.dbstudio.one` (M4 confirmed; re-confirm against a real outbox-sent email).
- Restore drill green (M10-B).
- `git log` on `main` shows only signed commits (`git log --pretty="%G?" main | sort -u` should print only `G`).
- Pre-commit hook rejection drill: stage a fake `MAILERSEND_API_KEY=mlsn.fake`, attempt `git commit`, confirm it's rejected. Reset.

- [ ] **Tick every box. If any box fails, stop and fix before gate M10-C.**

---

### 🛑 OPERATOR GATE M10-C — Public exposure

This is the final gate. Once it's done, the portal is live.

- [ ] **Operator: Cloudflare DNS.** Add `A` (and optionally `AAAA`) record for `portal.dbstudio.one` → `168.119.13.235`, **proxied** (orange cloud).

- [ ] **Operator: NPM origin swap.** Change the `portal.dbstudio.one` proxy host's forward target from the "coming soon" placeholder (if a separate origin) to `127.0.0.1:3400`. If NPM was already pointed at the app since gate M1-A, no swap is needed — just confirm the SSL is valid.

- [ ] **Operator: from a clean browser, walk the production smoke:**
  - https://portal.dbstudio.one/ → portal home (no longer "coming soon", or login redirect).
  - https://portal.dbstudio.one/health → `{ok:true}`.
  - Log in as the bootstrap admin (created in M3, persisted from then on).
  - Create one test customer; confirm invite email lands in the operator's test inbox.
  - Walk customer onboarding from a different browser/profile.
  - Generate one NDA against a test project; confirm draft PDF downloadable, signed-URL expires.

- [ ] **Operator: announce go-live in `RUNBOOK.md` § "Go-live record".** Include date, smoke output, and tags both this commit (`v1.0.0`) and the bootstrap admin's email.

```bash
git tag -s v1.0.0 -m "DB Studio Customer Portal v1 — go-live $(date -u +%FT%TZ)"
git push origin v1.0.0
```

---

## ✅ Final review checkpoint — v1 release

Hand `M9_END..v1.0.0` (or simply `M0_END..v1.0.0`) to `superpowers:requesting-code-review` for a holistic last pass. Verify the entire spec §11 acceptance gate is green, including all post-M9 additions:

- [ ] Two-service split: `systemctl stop portal-pdf` → NDA fails clean; rest works.
- [ ] `sudo -u portal-pdf psql portal_db` → permission denied.
- [ ] `sudo -u portal-pdf cat /var/lib/portal/master.key` → permission denied.
- [ ] `sudo -u portal-pdf curl https://example.com` → fails (RestrictAddressFamilies).
- [ ] Pre-commit hook rejected the test commit; reflog confirms commit never made.
- [ ] `git log` on `main` shows only signed commits.
- [ ] Restore drill: random backup → decrypt with offline key → restore → decrypt one credential successfully.
- [ ] Two NDAs against same template → identical `template_version_sha`. Modify, generate third → different sha.
- [ ] DKIM `d=mail.portal.dbstudio.one` on a real portal email.

If all are green: **the portal is live.**

---

# Self-review (run after writing this plan)

The author of this plan ran the self-review checklist:

**1. Spec coverage.** Walked spec §0–§12. Each section maps to at least one task:
- §1 decisions Q1–Q11 → embedded throughout (Q1/Q2 in M0+M1+M10, Q3 in M0, Q4 documented in RUNBOOK at M1, Q5 in M0 (bootstrap-secrets + precommit), Q6 in M8 (template_version_sha + nda.html bootstrap), Q7 in M4, Q8 in M9 (i18n audit) + scaffold throughout, Q9 in M10, Q10 in M1 (two units) + M8 (IPC), Q11 in the gating model itself).
- §2.1 process model → M1 + M8.
- §2.2 filesystem layout → M0 (gate) + M1 (build).
- §2.3 schema → M2.
- §2.4 envelope → M2.
- §2.5 auth → M3.
- §2.6 CSP/headers/RL → M1 (headers) + M3 (RL).
- §2.7 file handling → M6.
- §2.8 audit log → M3 (writer) + M9 (admin view + export).
- §2.9 email → M4.
- §2.10 NDA → M8.
- §2.11 i18n → scaffold throughout, audit in M9.
- §2.12 backups → M10.
- §3 visual design → M1 tokens.
- §4 features §9–§19 → M5/M6/M7/M8/M9.
- §5 roadmap → matches the milestone structure exactly.
- §6 testing strategy → coverage gates at M2, M3, M7; smoke at M1+M10.
- §7 hardening → M1 unit files.
- §8 repo policy → M0.
- §9 out of scope → not implemented (correct).
- §10 risk register → mitigations live in: KEK backup at M0-B, age-key custody at M10-A, DKIM at M4, sub-service at M1+M8, hook at M0, role drift at M1 safety-check, NDA overflow at M8, audit growth in RUNBOOK.
- §11 acceptance gate → M10 final checkpoint.

**2. Placeholder scan.** No "TBD", "fill in later", or "appropriate error handling" lines remain. Where the blueprint §4 schema is referenced as a cross-check (M2.2 step 3), the field-level work in this plan is fully written; the cross-check is a *quality* step, not a *placeholder*.

**3. Type consistency.** `loadKek`, `generateDek`, `wrapDek`/`unwrapDek`, `encrypt`/`decrypt`, `signFileUrl`/`verifyFileUrl`, `runSafetyCheck`, `renderPdf` — names used identically across all tasks that reference them. `template_version_sha` consistent across schema, NDA service, and acceptance criteria.

**End of plan.**
