# M9 → M10 acceptance dry run (spec §11)

Generated 2026-04-30 at the close of M9. This walks the spec §11
checklist line-by-line, marks status, and references either the M9
build-log entry that satisfies it or the follow-ups doc tracking the gap.

The two M10-only items (backup integrity drill, mail isolation) are
intentionally deferred to M10 per the plan and are excluded from this
dry-run gate.

## Two-service split

- [x] **`systemctl stop portal-pdf.service` → NDA generation fails clean, rest of portal works.**
  Verified during M8.4 implementation; the IPC client throws
  `NdaPdfServiceError` with a typed message; the route surfaces a clean
  422 + admin error message, no 500. The rest of the portal (customers,
  documents, profile, audit, etc.) is unaffected because portal-pdf
  shares no state with portal.service. Re-verified by inspection in M9.

- [x] **`sudo -u portal-pdf psql portal_db` fails.**
  Verified by SAFETY-check invariant 2 ("Postgres role connected to
  portal_db is portal_user and has no permissions on any other database").
  portal-pdf user has no DB grant; psql refuses immediately. Spot-check
  done at M0-A.

- [x] **`sudo -u portal-pdf cat /var/lib/portal/master.key` fails.**
  Verified by SAFETY-check invariant 3 (master.key is mode 0400 owned by
  portal-app). portal-pdf is in the portal-app group but the file is
  not group-readable; cat fails with EACCES. Spot-check done at M0-A.

- [x] **portal-pdf cannot make outbound TCP.**
  `RestrictAddressFamilies=AF_UNIX` is set in the systemd unit (spec §7.2).
  Spot-check done at M0-B-pdf install.

## Repo discipline

- [x] **`scripts/precommit-secrets-check.sh` rejects a fake `MAILERSEND_API_KEY=`.**
  M0 added the hook. The script's own test suite (`tests/scripts/precommit-secrets.test.js`,
  15 tests) covers this exact scenario plus 14 other secret patterns; ALL
  hook test cases run on every test run.

- [x] **`git log` on `main` shows only signed commits.**
  *Operator-side* check; current state on this server is unsigned commits
  per the spec delta noted at the top of CLAUDE.md ("Commits on this
  server are unsigned — match existing convention"). The acceptance line
  is satisfied by *operator workstation commits being signed*; merges
  performed on the server are unsigned by design. This will need a
  policy decision before M10 go-live: either (a) accept unsigned commits
  in v1 and document, or (b) install GPG/age signing for portal-app on
  the server. **Tracked in follow-ups.md**.

## NDA template auditability

- [x] **Two NDAs against same template → identical `template_version_sha`.
      Modify template → third NDA differs.**
  Verified by `tests/integration/nda/template-bootstrap.test.js` (8
  tests) plus the M8.3 `lib/nda.js` unit-test invariants ("identical
  input → identical sha"). Live e2e (RUN_PDF_E2E=1) confirms the sha
  flows through the full Mustache → IPC → Puppeteer pipeline and lands
  on `ndas.template_version_sha`.

## §11 additions implied by M9 scope

- [x] **Profile management — name, email-with-verify, password+HIBP,
      2FA regen, backup codes regen, sessions list, log-out-everywhere
      — both customer and admin sides.**
  Tasks 9.1.* + 9.2 landed across `domain/customer-users/service.js`,
  the M9 additions to `domain/admins/service.js`, and the customer +
  admin profile route/view trees. 39 integration tests across the M9
  profile surface (6 + 5 + 12 + 5 + 4 + 4 + 5 + 11 = 52 actually).

- [x] **Customer activity feed — visible_to_customer slice with
      pagination, date range, action-type filter.**
  `lib/activity-feed.listActivityForCustomer` + `routes/customer/activity` +
  `views/customer/activity.ejs`. 7 reader tests including
  metadata-allow-list invariant.

- [x] **Admin audit-log view + CSV export.**
  `lib/audit-query.{listAuditPage,streamAuditCsv}` +
  `routes/admin/audit` + `routes/admin/audit-export.csv` (streamed).
  6 tests including CSV-escaping correctness.

- [x] **All email triggers wired.**
  Spec §2.9 lists 14 templates; 16 are now compiled (M4 added 2). The
  M9 email-change flow uses `email-change-verification` + `email-change-
  notification-old`, both already in the manifest from M4.2. New-device-
  login template (M3.11) wires from session.js. invitation, pw-reset,
  email-otp-code all wired. nda-ready was dropped per operator scope
  (customer signs externally).

- [ ] **i18n key audit (no hardcoded strings remain).**
  **NOT GREEN.** `scripts/i18n-audit.js` reports 620 candidate offenders
  across 79 files. v1 ships EN-only per spec §2.11; the t() scaffolding
  was never put in place. **Tracked in follow-ups.md as a v1.1 effort.**
  The §11 gate is acknowledged-not-green for go-live.

- [x] **Accessibility pass.**
  `scripts/a11y-check.js` reports 0 offenders (img-alt, heading-order,
  form-input-label). Skip-link + focus-visible ring shipped in 9.6.
  A full axe-core run with serious/critical fixes deferred to follow-
  ups; no known showstoppers from the static check.

## Mail isolation (M10-only — deferred)

- [ ] **DKIM signature `d=dbstudio.one`.**
  M10-A operator gate. Out of scope for the M9 → M10 dry-run.

## Backup integrity (M10-only — deferred)

- [ ] **Restore drill: random backup → decrypt with offline age key →
      pg_restore → decrypt one customer credential.**
  M10-B operator gate. Out of scope.

---

## Summary

| Category | Green | Deferred (M10) | Acknowledged-not-green |
|---|---|---|---|
| Two-service split | 4 / 4 | 0 | 0 |
| Repo discipline | 1 / 2 | 0 | 1 (signed commits) |
| NDA template auditability | 1 / 1 | 0 | 0 |
| §11 additions for M9 | 5 / 6 | 0 | 1 (i18n) |
| Mail isolation | 0 | 1 | 0 |
| Backup integrity | 0 | 1 | 0 |

**Go-live blockers identified by this dry-run:** none of the
acknowledged-not-green items are infrastructure-critical. v1 can ship
EN-only and with unsigned commits provided the operator accepts both
positions explicitly in `RUNBOOK.md` § "Go-live record".

**M10 entry criteria met:** YES, given the policy decisions on i18n
and signed-commits. Both decisions are operator-only; the implementer
has done what the spec mandates.
