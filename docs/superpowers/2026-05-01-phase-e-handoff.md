# Phase E — handoff for next session

> **How to pick up:** Open `/opt/dbstudio_portal/`, read this file, then invoke `superpowers:executing-plans` with `docs/superpowers/plans/2026-05-01-phase-e.md`.

## Status as you enter

- `main` synced to `origin/main` at `c2f9dcd`.
- Phase D shipped (commits `d810703..edfce31`, plus `70c0d0e` + `4b7ef81` for E-1 / E-2). Live portal running, migration `0011_phase_d` applied, full suite 644 passing / 3 skipped / 0 failing.
- Phase E items 1 (credential-eye toggle) and 2 (bento alignment) shipped already.
- Phase E items 3, 4, 5 are scoped + planned + NOT yet executed. Pickup point.

## What this Phase E execution covers

From `docs/superpowers/plans/2026-05-01-phase-e.md`, 12 tasks across 6 tracks:

| Track | Task # | What |
|---|---|---|
| 1. Step-up route | 1 | GET `/admin/step-up` + view (return-URL sanitised) |
| 1. Step-up route | 2 | POST `/admin/step-up` (TOTP verify + unlock vault + audit) |
| 1. Step-up route | 3 | Lockout after 5 fails |
| 2. Admin credential decryption | 4 | GET `/admin/customers/:cid/credentials/:credId` (metadata + Reveal button) |
| 2. Admin credential decryption | 5 | Reveal flow (locked → step-up → unlocked → decrypt + render) |
| 2. Admin credential decryption | 6 | Decrypt-failure path |
| 2. Admin credential decryption | 7 | List-page row link to detail |
| 3. Customer copy | 8 | `/customer/credentials` list + dashboard card body |
| 4. Reset copy | 9 | `views/public/reset-sent.ejs` soften to typo-friendly conditional |
| 5. verifyLogin investigation | 10 | Reset → first-attempt sign-in regression test |
| 5. verifyLogin investigation | 11 | 2FA bucket-isolation comment (already isolated; just annotation) |
| 6. Wrap-up | 12 | Full suite + smoke + push |

## Critical gotchas the planner discovered

1. **File permissions.** Test runner runs as `portal-app`. New files written by root land at mode 640 (group-only) and tests fail with `EACCES`. Always `chmod 644` after every Write/Edit. The plan reminds you per-task but it's the single most common foot-gun on this repo.
2. **Migration runner.** Migrations don't auto-apply on `systemctl restart portal.service`. To apply Phase E's changes (none new — Phase D already added the gate column) re-run via `node --input-type=module -e 'import { runMigrations } …'`. (Phase E adds NO new migrations; this note is just for if a future task adds one.)
3. **CITEXT in tmp-schema migration tests.** `customer_users.email` uses `CITEXT` which lives in `public`. When testing migrations in a temp schema, set `search_path=${schema},public` so the type resolves. See `tests/integration/migrations/0011_phase_d.test.js:24` for the working pattern.
4. **Existing test-pollution global teardown.** `tests/global-setup.js` already sweeps orphan `pending_digest_items` / `digest_schedules` / `email_outbox` rows after each suite run. Phase E tests don't need their own per-test cleanup of those tables for orphan rows; they DO still need `pruneTestPollution(db, { recipientIds })` for tagged customers/admins they create.
5. **NDA gate is live.** Any new customer-facing test that drives a fresh customer through onboarding must `UPDATE customers SET nda_signed_at = now()` before probing `/customer/dashboard` (or any feature route), otherwise the probe 302s to `/customer/waiting`. See `tests/integration/projects/crud.test.js:104-118` for the canonical fixture.
6. **`req.ip` is the real client IP.** Fastify is configured with `trustProxy: ['127.0.0.1', '94.72.96.105']` + Cloudflare CF-Connecting-IP honouring at `server.js:90`. Step-up's `step-up:admin:<adminId>` rate-limit bucket is admin-keyed, not IP-keyed, so the IP-proxy semantics don't matter here — but worth knowing so you don't re-litigate the "global lockout" suspicion that was misdiagnosed earlier (see `docs/superpowers/follow-ups.md` Phase D batch item 4).

## What stays for after Phase E (already filed in follow-ups.md)

- Customer-side view-with-decrypt UI (the customer reading their own stored secret with re-2FA). Filed; out of scope for Phase E by operator decision.
- Admin credential edit UI (M7 deferred minor). Out of scope.
- Phase E digest copy/layout/grouping rework (the email readability item from the original Phase D handoff). Tracked separately.
- Customer-side credential-request "eye" toggle is DONE (e1, commit `70c0d0e`).
- Bento card alignment is DONE (e2, commit `4b7ef81`).

## Concrete first commands when restarting

```bash
cd /opt/dbstudio_portal
git log --oneline -5     # verify c2f9dcd is HEAD
sudo bash scripts/smoke.sh   # confirm portal + migrations + DB are clean
sudo bash scripts/run-tests.sh tests/integration/credentials/manage.test.js | tail -5  # quick suite sanity
```

Then open `docs/superpowers/plans/2026-05-01-phase-e.md` and start with Task 1, Step 1. The plan is self-contained — every step has either the exact code, the exact command, or a single bracketed pointer to existing scaffolding to copy.

## Roadmap remaining after Phase E

Once Phase E lands:
- Phase F (digest copy/layout rework) is the only remaining open piece from the original Phase D handoff.
- Customer-side view-with-decrypt is a smaller follow-up; can fold into Phase F brainstorm or stand alone.

That's it.
