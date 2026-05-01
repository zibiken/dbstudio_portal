# M11 — Acceptance Dry Run

> **Purpose:** Walk the M11 acceptance criteria from the design spec
> (`docs/superpowers/specs/2026-04-30-m11-visual-redesign-design.md`)
> line-by-line, prove each one, and capture the side-by-side
> screenshot pairs for the operator's sign-off.
>
> **Filled in by:** the operator after M11 implementation lands (see
> the rewired execution sequence in
> `docs/superpowers/plans/2026-04-30-m11-visual-redesign-implementation.md`).
>
> **Sign-off action:** commit this file with the screenshots and the
> sign-off line at the bottom completed.

---

## 0. Pre-flight — drift scan (already passed by the implementer)

Before the operator starts the screenshot walk, verify the implementer's
final cross-surface sweep:

```bash
# No legacy class names anywhere under views/.
grep -rln "customer-card\|customer-section-header\|customer-form\|admin-card\|admin-section-header\|admin-table\|admin-form\|admin-fields\|customer-table\|customer-meta\|customer-fields" /opt/dbstudio_portal/views/
# Expected: no output.

# A11y check — informational, exit 0.
sudo -u portal-app /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/a11y-check.js
# Expected: ≤ 8 candidate offenders, all pre-existing M9 input/label
# false positives in EJS-templated id/for pairs (documented in T20 commit).

# Tests + smoke.
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
# Expected: 586 passed + 3 skipped.
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
# Expected: probes 1-9 OK; probe 10 (skipped: ...).
```

---

## 1. Visual consistency with `dbstudio.one`

Capture each pair at **1280×800** (desktop) and **390×844** (mobile),
both surfaces in the marketing site's default colour scheme. Save under
`docs/superpowers/m11-screenshots/`.

| Pair | Marketing source | Portal target | 1280×800 | 390×844 |
|---|---|---|---|---|
| Hero rhythm | `https://dbstudio.one/` (above-the-fold) | `https://portal.dbstudio.one/login` | _attach_ | _attach_ |
| Section grid | `https://dbstudio.one/` (Capabilities section) | `/customer/dashboard` (bento grid) | _attach_ | _attach_ |
| Footer | `https://dbstudio.one/` (footer) | any portal page footer | _attach_ | _attach_ |
| Card | `https://dbstudio.one/` (Services tile) | `/customer/dashboard` (single bento card) | _attach_ | — |
| List | — | `/admin/customers` (table view) | _attach_ | _attach_ |
| Empty state | — | `/admin/customers/<id>/ndas` for a fresh customer | _attach_ | _attach_ |
| Detail tab | — | `/admin/customers/<id>` overview | _attach_ | _attach_ |
| Form | — | `/admin/customers/new` | _attach_ | _attach_ |
| Profile | — | `/admin/profile` | _attach_ | _attach_ |
| Audit | — | `/admin/audit` | _attach_ | — |

Operator note any deltas worth fixing in v1.1: ___________________________

---

## 2. A11y re-audit

```bash
sudo -u portal-app /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/a11y-check.js
```

Paste the trailing summary line:

```
(paste here)
```

Expected: `8 a11y candidate offenders across 3 files.` (all pre-existing
M9 false positives — see T20 commit for details). Net-new from M11: 0.

---

## 3. Tests

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Paste the trailing two lines:

```
(paste here)
```

Expected: 586 passed + 3 skipped (or higher if any T18b /
profile-sub-page restyle landed a follow-up test).

---

## 4. Smoke (default — no probe 10)

```bash
sudo bash /opt/dbstudio_portal/scripts/smoke.sh
```

Expected: probes 1–9 OK; probe 10 reports skipped. Paste the trailing
line: ___________________________

---

## 5. Smoke probe 10 (one-shot exercise)

Reset the welcome token (or use the bootstrap admin's existing token if
still valid):

```bash
# from RUNBOOK § "Reset an admin's welcome flow"
# → produces a fresh token URL
```

Then:

```bash
sudo RUN_M11_SMOKE=1 M11_SMOKE_WELCOME_TOKEN=<token-from-the-URL> bash /opt/dbstudio_portal/scripts/smoke.sh
```

Expected: probe 10 passes ("[10/10] TOTP enrol page renders inline SVG
QR: OK"). Paste the line:
___________________________

---

## 6. Bootstrap admin onboarding (live)

Walk this end-to-end on a phone-sized viewport in a clean browser
profile (no portal cookies):

- [ ] Open the welcome email; click the link.
- [ ] Set a password (≥ 12 chars, not in HIBP).
- [ ] Scan the QR with an authenticator app (Authy / 1Password / Google Authenticator / Bitwarden).
- [ ] Enter the 6-digit code; press Finish setup.
- [ ] See the 10 backup codes; save them in your password manager.
- [ ] Click the "I've saved my codes — continue" button.
- [ ] Land on `/admin/customers` (the post-login default for an admin).

Did onboarding complete cleanly? **Yes** / **No** (and notes): ___________________________

---

## 7. §11 acceptance line — "1 customer + 1 credential decrypted cleanly"

Once the bootstrap admin is in:

- [ ] Create one test customer at `/admin/customers/new` (e.g. razón social "M11 Test S.L.", CIF "B99999999"). Capture the invite URL on the post-create confirmation page.
- [ ] Open the customer welcome URL in a different browser profile; walk customer onboarding (password + QR + TOTP + backup codes).
- [ ] Generate one NDA at `/admin/customers/<id>/ndas/new`. Confirm the rendered PDF has signatures on the same page as the body (no orphan page 3 — fixed in commit `43dc365`).
- [ ] Open one credential request at `/admin/customers/<id>/credential-requests/new`. Add 2–3 fields with mixed types (text + secret + url). Confirm the field repeater works and that the customer-side fulfilment form renders the right control per type.
- [ ] On the customer side, fulfil the request. Verify the customer can see their own credentials at `/customer/credentials`.
- [ ] As admin, hit `/admin/customers/<id>/credentials` and confirm metadata-only view renders (label, provider, freshness — no plaintext values).
- [ ] Run `sudo bash /opt/dbstudio_portal/scripts/restore-drill.sh`. Confirm the round-trip green branch fires the "1 customer + 1 credential decrypted cleanly" message.
- [ ] Append a new row to RUNBOOK § "Backup restore drill" log table with the date + outcome.

---

## 8. Cross-surface drift sweep (T22 final pass)

The implementer's sweep at the close of T22 verified:

- ✅ Zero hits on the legacy class-name grep (`customer-card`, `admin-section-header`, etc. — all 30+ legacy hooks across both surfaces are gone).
- ✅ All list surfaces use the contract's four canonical partials (`_list-toolbar`, `_empty-state`, `_pagination`, `_user-mention`).
- ✅ All form surfaces use the polished `_input` + `_button` partials with `.card` + `.card__title` + `.card__subtitle` chrome.
- ✅ All sidebar items resolve activeNav correctly on top-level routes.
- ⚠️ Profile sub-pages (totp-regen, backup-codes-regen / -show, email-verify, sessions) restyled but their routes do NOT yet pass `activeNav: 'profile'`/`mainWidth: 'content'`/`sectionLabel`. Effect: when on those sub-pages the sidebar's "Profile" item doesn't highlight. Cosmetic-only; tracked as a v1.1 follow-up alongside chrome-locals plumbing for the rest of the deep sub-pages.

If the operator finds anything else during the screenshot walk, fix
inline before the v1.0.0 tag fires (T22's whole point is to lock the
bar before tag).

---

## 9. Sign-off

Operator: _____________________________________________

Date (DD/MM/YYYY): __________________________________________

Version tagged: v1.0.0 (after this doc is filled in and committed,
operator runs `git tag v1.0.0 && git push origin v1.0.0`).

---
