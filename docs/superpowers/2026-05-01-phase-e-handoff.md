# Phase E — handoff (DONE 2026-05-01)

> **Status:** SHIPPED. All 5 items from the Phase D operator feedback batch are merged to `origin/main` and live on the running portal. This file is kept for archival; the next session should read `docs/superpowers/follow-ups.md` for what's still open.

## What shipped in Phase E

| Item | Commit | Description |
|---|---|---|
| 1 — Customer credential-eye toggle | `70c0d0e` | Show/hide button next to password fields on `/customer/credential-requests/:id` and `/customer/credentials/new`. |
| 2 — NDA / bento card alignment | `4b7ef81` | `.bento + .project-grid` cards no longer inherit the `.card + .card { margin-top }` stack rule. Equal-top alignment in the dashboard grid. |
| 3 — Admin credential decryption | `4473d36` + `70f7429` + `461bbc0` | New `/admin/step-up` route + `/admin/customers/:cid/credentials/:credId` detail page with reveal/hide flow. Reuses existing `service.view` (KEK→DEK→GCM-decrypt + vault-unlock + audit + Phase B digest fan-out). Step-up bucket-rate-limited at 5 fails / 30-min lockout. Customer-side copy on `/customer/credentials` + dashboard Credentials card now reads the plain truth ("admins can decrypt; every read is logged"). Admin list info banner updated likewise. |
| 4 — Reset success-page typo softening | `ad9e1b9` | `views/public/reset-sent.ejs` now reads "If your address is registered with us…" with double-check-the-address hint. |
| 5 — verifyLogin investigation | `ad9e1b9` | New regression test `tests/integration/auth/reset-then-signin.test.js` exercises reset → first-attempt sign-in. 2FA bucket isolation confirmed and annotated in `routes/public/login-2fa.js`. |

Plus `7185507` — defensive `email_outbox` sweep in worker test's `beforeAll` to handle stale rows from the suite's growing outbox surface.

## State at HEAD `7185507`

- 17 Phase E commits on `main`, all pushed to `origin/main`.
- Full suite: **657 passing / 3 skipped / 0 failing.**
- Smoke check: green.
- Live portal restarted; `/admin/step-up` and `/admin/customers/:cid/credentials/:credId` routes are mounted and working.
- `node scripts/clean-stale-test-rows.js` reports 0 stale rows.

## What's left on the roadmap (open items — see `docs/superpowers/follow-ups.md`)

- **Phase F — Digest copy/layout/grouping rework.** From the original Phase D handoff (item 5 of the email-readability batch): the digest emails need subject-line counts, per-customer admin grouping, natural-language verb rewrites, timestamps per item, dropped internal IDs, light/dark mail-client compatibility. Standalone spec → plan → implementation cycle when picked up.
- **Customer-side view-with-decrypt UI** — the customer reading their own stored secret with re-2FA. Same `service.view` path with an `actor_type='customer'` branch. Smaller follow-up; can fold into Phase F brainstorm or stand alone.
- **Admin credential-edit UI** (M7 deferred minor) — admin can already create/fulfil via credential-requests; "edit existing credential" stays a follow-up.
- The other M9-review-deferred items in `follow-ups.md` (LIKE-pattern wildcard escaping, audit_log metadata index, controlled error vocabulary, TOCTOU note, i18n grind, accessibility pass) are still queued from earlier phases.

## Operationally important things to remember

1. **Admin can now read customer credentials.** The misleading copy is gone. The trust-contract is the audit log: every reveal lands in the customer's activity feed AND in their next FYI digest email (via Phase B `credential.viewed` coalescing fan-out).
2. **Step-up window is sliding 5-min idle.** First reveal in a session triggers `/admin/step-up`. Subsequent reveals within 5 min skip step-up. Idle 5+ min → re-2FA. Same posture as the customer-side vault flow.
3. **Reset typos no longer silent.** Form returns "If your address is registered…" with helpful next-step language. Account-enumeration safety preserved.

## Concrete pickup commands for a future session

```bash
cd /opt/dbstudio_portal
git log --oneline -5     # verify 7185507 is HEAD or newer
sudo bash scripts/smoke.sh   # confirm portal + DB
node scripts/clean-stale-test-rows.js   # confirm 0 stale rows

# To start Phase F:
# Read docs/superpowers/2026-05-01-phase-d-handoff.md (item 5 of the
# bundled feedback batch describes the digest readability problem in
# the operator's own words). Then invoke superpowers:brainstorming.
```

That's it.
