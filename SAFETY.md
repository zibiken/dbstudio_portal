# SAFETY — read before you commit, deploy, or change infrastructure

**This file states the operational invariants that protect customer data in this portal. They are not aspirational. They are enforced by the startup self-check and by the pre-commit secret scanner.**

---

## The first rule

**NEVER commit secrets to this repository.**

Not env files, not API keys, not the master KEK, not any file that touches `/var/lib/portal/master.key`, not session-signing secrets, not Mandrill/MailerSend API keys, not customer data, not encrypted blobs, not PEM/PFX/PKCS12, not database dumps, not backups, not signed-URL HMAC keys.

The repository is for code, configuration templates, and the NDA template — nothing else. Secrets are generated on the server by `scripts/bootstrap-secrets.sh`, stored at `/opt/dbstudio_portal/.env` (mode 0400, owned by `portal-app`) and `/var/lib/portal/master.key` (mode 0400, owned by `portal-app`). They never leave the server in any direction.

If a secret leaks into a commit, that commit is treated as a security incident: rotate the affected secret, force-push the cleaned history (this is the only legitimate force-push on `main`), and document the incident in `RUNBOOK.md`.

---

## Isolation invariants (enforced at startup by `scripts/safety-check.js`)

The portal aborts on startup if any of the following is false:

1. The process runs as user `portal-app` (UID matches), not root, not another shared service user.
2. The Postgres role connected to `portal_db` is `portal_user` and has no permissions on any other database on this host.
3. `/var/lib/portal/master.key` exists, is mode `0400`, and is owned by `portal-app`.
4. `/opt/dbstudio_portal/.env` exists, is mode `0400`, and is owned by `portal-app`.
5. `/var/lib/portal/storage/` exists, is mode `0750` or stricter, has no world-writable bit, and contains no symlinks pointing outside the tree.
6. The session-signing secret and file-URL signing secret are at least 32 bytes each.
7. The `portal-pdf` IPC socket exists at `/run/portal-pdf.sock` and is owned by `portal-pdf:portal-app` with mode `0660`.

If any of these fail the process exits with a clear error to the journal. Do not weaken any check to "make it start." Fix the underlying invariant.

---

## What this portal must never do

- Read from, write to, import from, or depend on any other project on this server (notably DB Football and DB Studio). They share no code, no DB role, no Mandrill/MailerSend API key, no Linux user, no storage path.
- Spawn shell commands constructed from user input.
- Write any sensitive value to `console.log`, `pino` info logs, error messages, or audit-log metadata.
- Render customer-supplied content into emails or PDFs without escaping.
- Cache decrypted credentials anywhere other than the request-scoped memory required to send the response.
- Issue a download URL longer than 60 seconds, or reuse a download token after first valid GET.
- Allow plaintext HTTP. HSTS is on; the app refuses non-`X-Forwarded-Proto: https` traffic.

---

## What `portal-pdf.service` must never do

- Read from `/var/lib/portal/master.key`, `/opt/dbstudio_portal/.env`, or anything other than the IPC socket and its own working dir.
- Connect to Postgres.
- Make outbound network connections of any kind. Its `RestrictAddressFamilies=AF_UNIX` confines it to its socket.

---

## When in doubt

Stop. Ask. The cost of a paused deploy is hours; the cost of a credential-vault leak is the company.
