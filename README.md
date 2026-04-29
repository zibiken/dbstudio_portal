# DB Studio Customer Portal

Secure customer portal for **Solbizz Canarias S.L.U.** — clients sign in to manage their profile, view documents and invoices, fill in credential requests from the DB Studio team, and store their own credentials in an encrypted vault.

**Status:** v1 specification, implementation not yet started.

**Domain:** `portal.dbstudio.one`
**Port (local):** `3400`
**Operator:** Solbizz Canarias S.L.U. (CIF B76607415, Tenerife, Spain)

---

## Where to start

1. Read [`SAFETY.md`](SAFETY.md). It is short, it is non-negotiable, and the first rule is "never commit secrets."
2. Read [`docs/superpowers/specs/2026-04-29-portal-design.md`](docs/superpowers/specs/2026-04-29-portal-design.md) — the full design spec, the source of truth for v1.
3. The implementation plan (phased milestones M0–M10) lives at [`docs/superpowers/plans/`](docs/superpowers/plans/) once written.

---

## Tech summary

- Node.js 20 LTS, project-local install (no system Node)
- Fastify 4, EJS, Tailwind CSS, HTMX-light client JS
- PostgreSQL 15+ with `pgcrypto` and `citext`, queried via Kysely
- Argon2id for passwords, AES-256-GCM envelope encryption (master KEK + per-customer DEK)
- TOTP / WebAuthn / email-OTP for 2FA, with backup codes
- MailerSend for transactional email via dedicated subdomain `mail.portal.dbstudio.one`
- Two systemd units: `portal.service` (full hardening) + `portal-pdf.service` (Puppeteer for NDA PDFs, sandboxed)
- Hetzner Storage Box for `age`-encrypted nightly backups

## License & ownership

Private repository. All code © Solbizz Canarias S.L.U. unless noted otherwise.
