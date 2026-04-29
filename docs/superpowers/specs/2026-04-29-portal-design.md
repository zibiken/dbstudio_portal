# DB Studio Customer Portal — v1 Design Spec

**Date:** 2026-04-29
**Status:** Approved design, implementation not yet started
**Domain:** `portal.dbstudio.one`
**Operator:** Solbizz Canarias S.L.U. (CIF B76607415, Tenerife, Spain)
**Repo:** `git@github.com:zibiken/dbstudio_portal.git` (private, branch `main`)

---

## 0 · Source documents

This spec consolidates two inputs:

1. The original implementation blueprint provided by the operator (long-form, prescriptive).
2. The brainstorm session of 2026-04-29 that resolved 11 open decisions.

Where this spec disagrees with the original blueprint, **this spec wins.** Deltas are flagged inline as `> Delta from blueprint:` so readers coming from the original document can find them quickly.

---

## 1 · Decisions taken in the brainstorm

| # | Decision | Result |
|---|---|---|
| Q1 | Reverse proxy reality | Cloudflare → NPM (94.72.96.105) → Fastify on `127.0.0.1:3400`. **No local nginx.** All security headers, CSP w/ per-request nonces, login rate-limiting, HSTS — enforced inside the Fastify app. |
| Q2 | Local port | **3400** (production only; no staging in v1). |
| Q3 | Repo + working directory | Repo `dbstudio_portal` already exists on GitHub (private, branch `main`). Working dir on host is **`/opt/dbstudio_portal/`** — replaces every `/srv/portal/` path in the original blueprint. |
| Q4 | Deploy model | In-place `git pull --ff-only origin main` → `npm ci --omit=dev` → `npm run build` → `systemctl restart portal.service portal-pdf.service`. Rollback = `git reset --hard <sha>` + rebuild + restart. **No symlink farm.** |
| Q5 | Secrets workflow | `.env.example` in repo. `scripts/bootstrap-secrets.sh` generates the master KEK, session-signing secret, and file-URL signing secret on the server (mode 0400). `scripts/precommit-secrets-check.sh` blocks committing anything that smells like a secret. |
| Q6 | NDA template handling | Committed at `templates/nda.html`. The `ndas` table records `template_version_sha` (sha256 of the rendered template at generation time) so we can answer "what exact wording did Customer X sign?" Install rewrites the template's Google Fonts `@import` → local woff2. |
| Q7 | Email provider | **MailerSend** (matches DB Studio). v1 sends from `portal@dbstudio.one` (shared with marketing) to stay inside MailerSend's free tier. Reputation-isolation to a dedicated subdomain (`mail.portal.dbstudio.one`) is deferred — see §10 risk register and §13 deferred-isolation plan. **Operator-assisted at M4: confirm `dbstudio.one` is already verified in MailerSend and issue a dedicated API key for the portal.** |
| Q8 | i18n | i18next scaffolded throughout v1, all user-facing strings wrapped in `t()`, `locales/en/` populated, `locales/es/` empty placeholder for later translator drop-in. |
| Q9 | Off-server backups | Hetzner Storage Box. Nightly `pg_dump` + storage-tree archive, `age`-encrypted with public key on server, **private key offline** (operator workstation, *not* on the server). |
| Q10 | Puppeteer + Chromium | **Two systemd units.** `portal.service` (full hardening, no Chromium) + `portal-pdf.service` (looser hardening, Chromium V8 needs JIT) running as a separate Linux user (`portal-pdf`) and talking only over a Unix socket. |
| Q11 | Shipping cadence | Single shipped release. Whole §11 acceptance checklist must be green before the "coming soon" page comes down. Internal phasing (M0–M10) is for development discipline, not for incremental public exposure. |

---

## 2 · Architecture

### 2.1 Process model

```
                                  Cloudflare
                                       │  (DNS proxied, TLS terminated by NPM)
                                       ▼
                                NPM (94.72.96.105)
                                       │  (TLS, no origin verification — trust on private VLAN)
                                       ▼
                  ┌───────────────────────────────────────────┐
                  │  portal.service (user: portal-app)        │
                  │  Fastify on 127.0.0.1:3400                │
                  │  - Auth, sessions, CSRF, CSP w/ nonces    │
                  │  - DB access (Kysely + pg)                │
                  │  - Crypto: KEK + per-customer DEK         │
                  │  - Signed URL token issuance & redemption │
                  │  - Mail outbox runner                     │
                  │  Hardening: full systemd profile          │
                  └───────────────────────────────────────────┘
                                       │
                          (Unix socket /run/portal-pdf.sock)
                                       ▼
                  ┌───────────────────────────────────────────┐
                  │  portal-pdf.service (user: portal-pdf)    │
                  │  Tiny Fastify app, Puppeteer + Chromium   │
                  │  - Listens on Unix socket only            │
                  │  - RestrictAddressFamilies=AF_UNIX        │
                  │    (no network egress, none possible)     │
                  │  - No DB access, no secrets               │
                  │  - Receives {template_html, data, options}│
                  │  - Returns rendered PDF bytes + sha256    │
                  │  Hardening: looser profile (V8 JIT needs  │
                  │  WriteExecute pages)                      │
                  └───────────────────────────────────────────┘
```

The PDF service has zero access to the customer DB, the master KEK, the storage tree, or the network. A worst-case Chromium RCE yields a sandbox with nothing in it.

### 2.2 Filesystem layout

```
/opt/dbstudio_portal/                    # repo checkout, owned root:portal-app, mode 0750
├── server.js                            # main app entrypoint
├── pdf-service.js                       # PDF sub-service entrypoint
├── config/
│   ├── env.js                           # validates required env vars at startup
│   ├── logger.js                        # pino, redacts known sensitive fields
│   └── db.js                            # pg pool + Kysely setup
├── lib/
│   ├── crypto/
│   │   ├── kek.js                       # loads /var/lib/portal/master.key once at boot
│   │   ├── envelope.js                  # AES-256-GCM, DEK encrypt/decrypt helpers
│   │   ├── hash.js                      # Argon2id wrappers (per OWASP params)
│   │   └── tokens.js                    # signed URL HMAC, invite/reset tokens
│   ├── auth/
│   │   ├── session.js
│   │   ├── totp.js
│   │   ├── webauthn.js
│   │   ├── email-otp.js
│   │   ├── backup-codes.js
│   │   └── rate-limit.js
│   ├── audit.js
│   ├── files.js                         # storage path resolution, signed URL flow
│   ├── email.js                         # MailerSend client + outbox worker
│   ├── i18n.js
│   ├── pdf-client.js                    # IPC client for portal-pdf.service
│   ├── csp.js                           # per-request nonce + CSP header helpers
│   └── safety-check.js                  # startup invariants — single source of truth
├── domain/
│   ├── customers/
│   ├── projects/
│   ├── documents/
│   ├── invoices/
│   ├── credentials/
│   ├── credential-requests/
│   ├── ndas/
│   └── admins/
├── routes/
│   ├── public/                          # /login, /welcome/:token, /reset/:token
│   ├── customer/
│   └── admin/
├── views/                               # EJS templates
│   ├── layouts/
│   ├── components/
│   ├── public/
│   ├── customer/
│   └── admin/
├── public/                              # static assets, compiled CSS, bundled JS, fonts
├── emails/                              # email EJS sources, compiled at build
├── locales/
│   ├── en/                              # populated in v1
│   └── es/                              # placeholder, empty in v1
├── templates/
│   └── nda.html                         # versioned legal text (commit-tracked)
├── migrations/
│   └── 0001_init.sql
├── scripts/
│   ├── bootstrap-secrets.sh             # generates KEK + signing secrets on host
│   ├── create-admin.js                  # CLI for first-admin bootstrap
│   ├── rotate-kek.js                    # KEK rotation procedure (see RUNBOOK)
│   ├── backup.sh                        # nightly pg_dump + storage tarball + age encrypt
│   ├── safety-check.js                  # thin CLI wrapper that calls lib/safety-check.js
│   ├── smoke.sh                         # post-deploy production smoke test
│   └── precommit-secrets-check.sh       # blocks commits that look secret-bearing
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── docs/
│   └── superpowers/
│       ├── specs/                       # this file lives here
│       └── plans/                       # implementation plan
├── SAFETY.md
├── RUNBOOK.md
├── README.md
├── .env.example
├── .gitignore
└── package.json

/var/lib/portal/                         # runtime data, owned portal-app:portal-app, mode 0750
├── master.key                           # 32 random bytes, mode 0400 (the KEK)
├── storage/<customer_id>/<file_id>.<ext>
├── fonts/cormorant-garamond-500.woff2   # bundled for NDA rendering
├── templates/nda.html                   # written by bootstrap from repo, font @import rewritten
├── backups/                             # local age-encrypted backups before push
└── .age-recipients                      # public key only; private key lives offline

/run/portal-pdf.sock                     # IPC socket between portal.service and portal-pdf.service

/etc/systemd/system/
├── portal.service                       # full hardening
└── portal-pdf.service                   # looser, Chromium-friendly

/opt/dbstudio_portal/.env                # mode 0400, owned portal-app
                                         # MASTER_KEY_PATH, DATABASE_URL,
                                         # SESSION_SIGNING_SECRET, FILE_URL_SIGNING_SECRET,
                                         # MAILERSEND_API_KEY, MAILERSEND_FROM_EMAIL=portal@mail.portal.dbstudio.one,
                                         # PORTAL_BASE_URL, ADMIN_NOTIFICATION_EMAIL,
                                         # NDA_TEMPLATE_PATH=/var/lib/portal/templates/nda.html,
                                         # PDF_SERVICE_SOCKET=/run/portal-pdf.sock
```

> Delta from blueprint: working dir is `/opt/dbstudio_portal/` (matches DB Studio convention) instead of `/srv/portal/`. No `releases/` symlink farm; in-place `git pull` deploys.

### 2.3 Database

PostgreSQL 15+ on `localhost:5432`. New role and DB:

```sql
CREATE ROLE portal_user WITH LOGIN PASSWORD '<generated-by-bootstrap>';
CREATE DATABASE portal_db OWNER portal_user;
\c portal_db
CREATE EXTENSION pgcrypto;
CREATE EXTENSION citext;

REVOKE ALL ON DATABASE dbfootball_prod    FROM portal_user;
REVOKE ALL ON DATABASE dbfootball_staging FROM portal_user;
-- Defence in depth; Postgres role grants are off by default for non-owners,
-- but explicit revoke makes the intent legible to anyone reading pg_hba.
```

Schema is the blueprint's §4 schema verbatim, with **two additions**:

- `ndas.template_version_sha CHAR(64) NOT NULL` — sha256 hex of the rendered NDA template at generation time. Lets us audit which legal text any customer signed.
- `customer_users.language CHAR(2) DEFAULT 'en' CHECK (language IN ('en','es'))` — i18n scaffold expects this field even though `'es'` strings don't ship in v1.

UUIDv7 primary keys throughout, generated app-side. Migrations as single-file SQL in `migrations/`, run via a hand-rolled runner kept under 100 LoC for auditability.

### 2.4 Encryption envelope

Two-tier as the blueprint specifies:

1. **Master KEK** — 32 random bytes at `/var/lib/portal/master.key`, mode `0400`, owned `portal-app`. Loaded once at process start, held in memory only. Never logged, never serialised.
2. **Per-customer DEK** — 32 random bytes generated when a customer is created. Encrypted with the KEK using AES-256-GCM, stored as `customers.dek_ciphertext / dek_iv / dek_tag`.

Credential payloads (and customer-user TOTP secrets) are encrypted with the customer's DEK. Decryption only on explicit, re-auth'd request. KEK rotation procedure documented in `RUNBOOK.md`; tested in a scratch DB before any production rotation.

### 2.5 Auth

The blueprint's §6 is adopted in full:

- Argon2id for passwords (OWASP params), HIBP k-anonymity check on every set/change.
- Server-side sessions (`sessions` table), 32-byte random IDs in `HttpOnly; Secure; SameSite=Lax` cookies. 30-min idle, 12-hour absolute, 5-min step-up window cached for vault decryption gates.
- 2FA: TOTP / WebAuthn / email-OTP (one chosen per user), 8 backup codes hashed with Argon2id, displayed once at enrolment. Backup codes consumed on use.
- Magic-link onboarding for both customers and admins. Admin bootstrap via `scripts/create-admin.js` for the first admin only.
- Admin-initiated and customer-initiated password resets, both with the no-enumeration generic response.
- "Log out everywhere" revokes all sessions for the user.
- New device fingerprint (hash of UA + IP /24 subnet) → notification email + audit entry.

### 2.6 CSP, headers, rate limiting

Delivered by Fastify, not by NPM:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<r>'; style-src 'self' 'nonce-<r>'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

Per-request nonce in `Astro.locals.nonce`-style — the EJS layout reads it once and passes it to every `<script>` and `<style>` tag.

Rate limits as blueprint §5, keyed by IP + identifier, persisted in `rate_limit_buckets`. Login: 5 fails / 15 min, 30-min lockout. Password reset: 3 / hour. 2FA verify: 5 / 5 min. Magic-link request: 3 / hour. Signed-URL issuance: 60 / minute.

CSRF: double-submit token on every state-changing form. JSON HTMX requests use `X-Requested-With: XMLHttpRequest` + same-origin enforcement.

### 2.7 File handling

- 50 MB per-file cap (`@fastify/multipart` `limits.fileSize`).
- 5 GB per-customer cap, computed before write from `documents.size_bytes`.
- MIME sniffed via magic bytes (`file-type`), `Content-Type` header ignored.
- Filename sanitised (path components stripped, unicode normalised).
- Stored at `/var/lib/portal/storage/<customer_id>/<uuid>.<safe_ext>`. Original filename preserved in DB only.
- SHA-256 computed at write, stored on the row, verified on every download.
- Downloads via `GET /documents/:id/download` → authz check → 302 to `/files/<token>` where token = base64url(`file_id || expires_at || HMAC-SHA256(secret, file_id||expires_at)`). 60s TTL, single-use (consumed on first valid GET).

### 2.8 Audit log

Append-only at the DB role level (`REVOKE UPDATE, DELETE ON audit_log FROM portal_user`). Customer-visible events filterable on `visible_to_customer = TRUE`. Admin views the full stream, filterable + CSV-exportable.

The trust contract: **every admin view of a customer credential is timestamped, attributed, and visible to that customer in their activity feed.**

### 2.9 Email

MailerSend, sender `portal@dbstudio.one` for v1 (shared with marketing — see Q7 delta). Templates are compiled at build time from EJS sources in `emails/` and rendered in-app — MailerSend is the SMTP delivery layer only, never the templating layer. Every send is logged in `email_outbox` with idempotency key + retry handling. Admin notification email lands at `bram@roxiplus.es`.

Templates needed (14): customer invitation, customer pw reset, admin-initiated pw reset, 2FA reset by admin, email change verification (new addr), email change notification (old addr w/ revert), new-device login, new document available, new invoice, credential request created, NDA ready, generic admin→customer free-form, invite expiring soon, admin alert (invite unused 7d).

> Delta from blueprint: provider is MailerSend (not Mandrill); sender for v1 is `portal@dbstudio.one`. The dedicated subdomain `mail.portal.dbstudio.one` was originally chosen for reputation isolation but is deferred to post-launch (free-tier MailerSend allows one verified domain).

### 2.10 NDA generation

Mustache renders `templates/nda.html` (server-side, customer-data-bearing fields auto-escape). Sha256 of the rendered HTML is captured before handing off to PDF service. PDF client (`lib/pdf-client.js`) opens the Unix socket, sends `{html, options: {format: 'A4', margin: 0}}`, receives bytes + sha256.

Single-page guard runs **inside** `portal-pdf.service` — Chromium computes `document.body.scrollHeight`, compares to A4 height; if exceeds, returns a structured error indicating likely overflow field. Main service surfaces a clean error to admin: "NDA exceeds one page; try shortening `domicilio` (X chars) or `razon_social`."

Resulting PDF stored as `documents.category = 'nda-draft'`. New `ndas` row with `template_version_sha` populated and `draft_document_id` linking it.

### 2.11 i18n

i18next + i18next-fs-backend. Every user-facing string in EJS goes through `t()`. `locales/en/<namespace>.json` populated; `locales/es/` empty placeholder. `customer_users.language` honoured on every render; `Accept-Language` is the fallback. Date/time/currency formatting via `Intl`.

NDA template stays Spanish (it's a Spanish legal document; not internationalised). Email templates stored per-language; v1 ships only `en/`.

### 2.12 Backups

Nightly cron under `portal-app` (system cron, not user cron):

```
30 2 * * *  /opt/dbstudio_portal/scripts/backup.sh
```

`backup.sh` does:

1. `pg_dump --format=custom portal_db` → `/var/lib/portal/backups/db-<timestamp>.dump`.
2. `tar c /var/lib/portal/storage/` → `/var/lib/portal/backups/storage-<timestamp>.tar`.
3. `age --encrypt --recipients-file /var/lib/portal/.age-recipients` over both → `.age` files.
4. `rclone copy` to Hetzner Storage Box (sftp:// remote configured at install).
5. Retention: keep 30 daily, 12 monthly, 5 yearly. Deletion safe — Storage Box rclone remote uses `--immutable` and serverside retention to prevent accidental purge.
6. Logs to journal under `portal-backup` syslog tag.

Restore drill documented in `RUNBOOK.md`; rehearsed once before go-live (acceptance criterion).

> Delta from blueprint: destination is named (Hetzner Storage Box) instead of "pick later"; private age key explicitly **offline on operator workstation, not on the server**.

---

## 3 · Visual design

The blueprint's §7 design system is adopted in full. Tokens, typography, components, NDA-style PDF treatment all unchanged. Tailwind extends with the listed CSS variables. No CDNs at runtime; Cormorant Garamond + Inter bundled as `@font-face` woff2 in `public/fonts/`.

---

## 4 · Feature surface

The blueprint's §9–§19 feature specs are adopted in full. Briefly:

- **§9 Customers** — admin CRUD, suspend/archive, full transaction (create row + DEK + invite token + outbox row in one tx).
- **§10 Projects** — required for NDA; status transitions free in v1, all logged.
- **§11 Documents** — categories, versioning chain, per-customer quota, signed-URL downloads.
- **§12 Invoices** — admin uploads PDF, metadata + status + dynamic overdue computation.
- **§13 Credential vault & requests** — provider catalogue seed, request workflow, customer fulfilment, admin viewing with audit transparency, 5-min idle auto-lock.
- **§14 NDA generator** — Mustache + sub-service Puppeteer + single-page guard + template version sha capture.
- **§15 Signed NDA upload** — pairs with original draft via `related_nda_id`.
- **§16 Customer onboarding** — magic-link, forced 2FA, profile review.
- **§17 Profile management** — name, email (with verification), password (with HIBP), 2FA regen, backup codes regen, sessions list, "log out everywhere".
- **§18 Activity feed & audit log** — customer sees their own filtered slice; admin sees all + CSV export.
- **§19 i18n** — scaffolded, EN-only ships.

---

## 5 · Phased implementation roadmap

**No public exposure until M10 acceptance is green.** Internal milestones for development discipline only. Coming-soon static page lives behind NPM throughout M0–M9.

| M | Scope | Operator-assisted? | Days |
|---|---|---|---|
| **M0** Bootstrap | `useradd portal-app` + `useradd portal-pdf`; Postgres role + DB; project-local Node 20.19.6 install at `/opt/dbstudio_portal/.node/`; repo clone + `.gitignore` + `SAFETY.md` already in place; `bootstrap-secrets.sh` run; NPM proxy entry pointing to "coming soon" static page on 3400 (or to a tiny placeholder Fastify route). Safety-check passes. | **Yes** (Linux users, Postgres role create, NPM entry, bootstrap script run, "coming soon" page) | 1–2 |
| **M1** Skeleton | Fastify app, EJS, Tailwind compile, env loading + validation, DB connection, base layouts (admin + customer + public), health endpoint at `/health`, both systemd units installed, both running with hardening, IPC handshake working (PDF service responds to a "render hello.html" probe). | No | 2 |
| **M2** Schema + crypto | `0001_init.sql` migration + runner, KEK loader, AES-GCM envelope, Argon2id wrappers, signed-URL HMAC, Kysely typings generated. **100% line coverage on `lib/crypto/**`.** | No | 3 |
| **M3** Admin auth | `create-admin.js` CLI, magic-link onboarding, password set (HIBP), 2FA enrolment for all three methods, backup codes, session lifecycle, login + logout + step-up re-auth, audit log writes. | No | 5–7 |
| **M4** Email pipeline | `email_outbox` table + worker, all 14 templates compiled at build, MailerSend client wired to `mail.portal.dbstudio.one`. End-to-end: queue → worker → MailerSend → delivery confirmed in inbox. | **Yes** (DNS records SPF/DKIM/DMARC for `mail.portal.dbstudio.one`; MailerSend domain verification; dedicated API key issued and pasted into `.env` on server) | 2–3 |
| **M5** Customer create + onboarding | Admin customer-list + create form (zod-validated), per-customer DEK generation, welcome invite via M4, customer magic-link onboarding mirroring admin auth, profile review screen. | No | 4–5 |
| **M6** Documents + projects | Upload pipeline (`@fastify/multipart`, magic-byte sniffing, SHA-256, signed download URLs, 60s single-use tokens), 5 GB per-customer cap, version chain, projects CRUD with `objeto_proyecto` field. | No | 4 |
| **M7** Credential vault + requests | Provider catalogue seed, request creation (custom fields), customer fulfilment, customer-initiated credentials, admin viewing with re-auth + audit visible to customer, 5-min idle auto-lock, "needs update" flag, `not_applicable` reasons. | No | 5–6 |
| **M8** Invoices + NDA | Invoice metadata + uploads + status transitions + overdue calc; NDA generator (Mustache, IPC to `portal-pdf.service`, single-page guard, `template_version_sha` capture); signed NDA + audit-trail upload + linking. | No | 4–5 |
| **M9** Profile + activity + polish | Profile management both sides; customer activity feed; admin audit-log view + CSV export; all email triggers wired; i18n key audit (no hardcoded strings remain); accessibility pass; full §11 acceptance checklist green. | No | 4–5 |
| **M10** Backups + go-live | `backup.sh` cron, Hetzner Storage Box `age`-encrypted push, restore drill in a scratch DB, smoke-test script, NPM swap from "coming soon" → portal app. | **Yes** (provision Storage Box; generate `age` keypair on operator workstation; paste public key into server; Cloudflare DNS A/AAAA for `portal.dbstudio.one` proxied; NPM origin swap) | 2 |

**Working-day total: 36–48 days.** Critical path is M2 → M3 (crypto + auth spine).

### 5.1 Operator-assisted touchpoint summary

These need the operator (not the implementer) at the keyboard. Roadmap blocks on each.

1. **M0** — `useradd portal-app` + `useradd portal-pdf`. Postgres role + DB (`CREATE ROLE portal_user`, `CREATE DATABASE portal_db`). NPM proxy entry for `portal.dbstudio.one` → `127.0.0.1:3400`. Run `scripts/bootstrap-secrets.sh`.
2. **M4** — DNS records for `mail.portal.dbstudio.one` (SPF, DKIM, DMARC). MailerSend dashboard verification. Provision a dedicated API key. Paste into `.env`.
3. **M10** — Provision Hetzner Storage Box. Generate `age` keypair on operator workstation. Paste public key into `/var/lib/portal/.age-recipients`. **Private key never leaves the workstation.**
4. **M10** — Cloudflare DNS record `portal.dbstudio.one` → server IP, proxied. NPM origin swap from "coming soon" static page → `127.0.0.1:3400`.

---

## 6 · Testing strategy

- **Unit (vitest)**: crypto envelope round-trip, GCM tamper detection, KEK load failure modes, signed URL HMAC tamper detection, Argon2id verify, TOTP window correctness, backup-code consume-once, password-strength + HIBP check, file-type magic-byte rejection.
- **Integration (vitest + disposable Postgres)**: customer-create transaction, magic-link onboarding, login-with-2FA matrix (3 methods × success/fail/backup-code paths), credential save → retrieve round-trip, NDA generate (PDF service mocked, then once with real PDF service in a manual smoke), signed NDA upload + linking, password reset.
- **Contract test for PDF IPC**: pinned request/response schema; if either side drifts, test fails.
- **Smoke test (`scripts/smoke.sh`)** runnable in production after deploy: process is `portal-app`, DB reachable, KEK loadable, MailerSend API reachable, signed-URL round-trip works, `portal-pdf.service` socket alive and responds to a hello probe.
- **Coverage gate**: 80 % line on `lib/crypto/**`, `lib/auth/**`, `domain/credentials/**`. Below gate = build fails.
- **Backup restore drill** as M10 acceptance.

---

## 7 · Hardening profiles

### 7.1 `portal.service`

```ini
[Service]
Type=simple
User=portal-app
Group=portal-app
WorkingDirectory=/opt/dbstudio_portal
ExecStart=/opt/dbstudio_portal/.node/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/dbstudio_portal/.env

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/portal /var/log/portal /run/portal-pdf.sock
ReadOnlyPaths=/opt/dbstudio_portal
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictRealtime=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
```

### 7.2 `portal-pdf.service`

```ini
[Service]
Type=simple
User=portal-pdf
Group=portal-app                          # group write on socket, group read on bundled fonts
WorkingDirectory=/opt/dbstudio_portal
ExecStart=/opt/dbstudio_portal/.node/bin/node pdf-service.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/dbstudio_portal/.env  # only PDF-relevant vars; PDF service ignores others

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/run                       # for the socket
ReadOnlyPaths=/opt/dbstudio_portal /var/lib/portal/fonts /var/lib/portal/templates
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX           # NO network egress
RestrictNamespaces=true
LockPersonality=true
# MemoryDenyWriteExecute=true              # OMITTED — Chromium V8 JIT requires WX pages
RestrictRealtime=true
SystemCallArchitectures=native
```

The PDF service unit deliberately omits `MemoryDenyWriteExecute` and broadens `ReadOnlyPaths` to include the bundled fonts. It deliberately tightens `RestrictAddressFamilies` to `AF_UNIX` only. The trade is correct for this service's threat model.

---

## 8 · Repo policy

- `.gitignore` already excludes `.env`, `*.key`, `master.key`, `/storage/`, `/backups/`, `/logs/`, `*.pem`, `*.crt`, `node_modules/`, `dist/`, `coverage/`.
- `scripts/precommit-secrets-check.sh` runs as a git hook (installed by `bootstrap-secrets.sh`). It greps staged content for: `BEGIN PRIVATE KEY`, `MAILERSEND_API_KEY=` followed by anything non-empty, `password=` followed by quoted strings, base64-looking 32+ byte tokens, sha-256 hex strings prefixed by `secret`/`token`/`key`. Aborts the commit on hit.
- The hook is opt-in (lives in `scripts/`, not `.git/hooks/`) until installed. `bootstrap-secrets.sh` symlinks it into `.git/hooks/pre-commit` on first run.
- `SAFETY.md` first line: "NEVER commit secrets to this repository." Displayed on every PR description template.
- All commits signed with the operator's GPG key (already configured for DB Studio). CI rejects unsigned commits on `main`.

---

## 9 · Out of scope (v1) — explicitly deferred

- Payment links / Stripe on invoices.
- E-signature flow inside the portal (signing happens out-of-band; portal stores the signed result + optional audit-trail PDF).
- Multiple users per customer.
- Granular admin roles (all admins equal in v1).
- SMS-based 2FA (deliberately excluded).
- Customer self-deletion (GDPR deletion is admin-mediated; legal retention on invoices is the constraint).
- Public API for third-party integrations.
- Webhooks.
- Bilingual content (Spanish strings) — scaffolding only.
- Staging environment — single production environment in v1.

---

## 10 · Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Master KEK file lost | Low | Catastrophic (all credentials unrecoverable) | Backup the KEK separately on a secure offline medium during install. KEK rotation procedure rehearsed. |
| Backup `age` private key lost | Low | Catastrophic (no restore possible) | Operator's responsibility; documented. Two copies on two physical media. |
| MailerSend domain reputation hit | Medium | High (transactional + marketing emails fail) | v1 ships from shared `dbstudio.one` (free-tier constraint). If portal volume grows or a deliverability issue appears, split to a dedicated subdomain (`mail.portal.dbstudio.one`) and reissue API key. Documented escape hatch: temporarily proxy via SES/Postmark. |
| Chromium RCE in `portal-pdf.service` | Very low | Medium | Sub-service has no DB access, no secrets, no network egress. Worst case: process compromise, no data exfil. |
| Pre-commit secret hook bypassed (`git commit --no-verify`) | Medium (human error) | High | Server-side git hook on the `dbstudio_portal` GitHub repo (push gate). Out-of-scope for client repo, must be configured in GitHub settings. **Operator-assisted at install time.** |
| `portal_user` Postgres grants drift | Low | High | Safety-check verifies grants on startup. CI test runs `\du portal_user` and diffs. |
| Customer enters huge `domicilio` → NDA overflows | Medium | Low (UX, not security) | Single-page guard in PDF service returns structured error; admin UI shows specific field at fault. |
| Audit log table grows unboundedly | Certain | Low (perf) | Partition by month after one year of data; documented in RUNBOOK. |

---

## 11 · Acceptance gate

The blueprint's §24 checklist is adopted in full. Additions specific to this design:

### Two-service split

- [ ] `systemctl stop portal-pdf.service` causes NDA generation to fail with a clean error; rest of portal still works.
- [ ] `sudo -u portal-pdf psql portal_db` fails (no DB grant).
- [ ] `sudo -u portal-pdf cat /var/lib/portal/master.key` fails (no read perm).
- [ ] `portal-pdf.service` cannot make outbound TCP (`sudo -u portal-pdf curl https://example.com` fails because of `RestrictAddressFamilies=AF_UNIX`).

### Repo discipline

- [ ] `scripts/precommit-secrets-check.sh` rejects an intentional test commit containing a fake `MAILERSEND_API_KEY=` line; the commit is never made (verified via reflog).
- [ ] `git log` on `main` shows only signed commits.

### Backup integrity

- [ ] Restore drill: pick a backup at random, decrypt with offline `age` private key, restore into a scratch Postgres DB, confirm one customer + one credential decrypts cleanly with the matching KEK.

### NDA template auditability

- [ ] Generate two NDAs against the same template, confirm identical `template_version_sha`. Modify the template (e.g., trailing whitespace), generate a third, confirm `template_version_sha` differs.

### Mail isolation

- [ ] DKIM signature on a portal email shows `d=dbstudio.one` (shared with marketing in v1). Verifies that the From header matches the DKIM-signed domain. (Reputation-isolation to a dedicated subdomain is deferred — tracked in the risk register.)

---

## 12 · Where this design ends and the implementation plan begins

This spec defines **what** is built, **why**, and **in what order**. The next document — `docs/superpowers/plans/2026-04-29-portal-implementation.md` — defines **how**: per-milestone task breakdowns, file-level changes, the exact sequence of writes, test scaffolding, and review checkpoints. That plan will be written via the `superpowers:writing-plans` skill in a fresh session, with this spec as the input.

**End of spec.**
