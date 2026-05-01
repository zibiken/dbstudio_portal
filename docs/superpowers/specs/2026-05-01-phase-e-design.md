# Phase E — Design Spec

> **Status:** approved 2026-05-01. Implementation pending.
> **Bundles items 1–5 from `docs/superpowers/follow-ups.md` "Phase D operator feedback batch (2026-05-01)".** Items 1 + 2 already shipped in commits `70c0d0e` and `4b7ef81`; this spec covers items 3, 4, 5.
> **Successor:** `docs/superpowers/plans/2026-05-01-phase-e.md` (to be written by `superpowers:writing-plans`).

## Goal

1. Wire admin-side credential decryption (item 3 — operationally blocking).
2. Replace the misleading "DB Studio never sees plaintext" customer-side copy with a plain-truth statement that anchors the trust contract on the audit log.
3. Soften the password-reset success-page copy from definitive to conditional, so a typo'd address still produces helpful UX without leaking account existence (item 4).
4. Add an integration test that catches "correct password rejected after a successful reset" if it ever happens, and audit 2FA bucket isolation (item 5).

Items 1 (credential-eye toggle) and 2 (bento alignment) shipped before this spec was written.

## Approved scope (operator-confirmed 2026-05-01)

1. **Admin credential decryption.** New `/admin/customers/:cid/credentials/:credId` detail page with reveal/hide flow. Reuses the existing `domain/credentials/service.view` (KEK→DEK→GCM-decrypt + vault-unlock gate + `credential.viewed` audit + Phase B digest fan-out). New `/admin/step-up` route handles re-2FA.
2. **Customer-copy fix.** Replace the misleading line on `/customer/credentials` and the dashboard Credentials card body with: *"Values are encrypted under your account vault key. DB Studio admins can decrypt them when they need to read one — every read leaves an entry in your Activity log."*
3. **Password-reset copy softening.** `/reset` success page (admin + customer paths) returns *"If your address is registered, we've sent a reset link. Check your inbox in a few minutes; if nothing arrives, double-check the address."*
4. **verifyLogin investigation.** Integration test asserting reset → first-attempt sign-in succeeds. Audit `routes/public/login-2fa.js` bucket isolation.

## Architecture overview

Item 3 is the heaviest by far; items 4 + 5 are copy-and-test work that piggybacks on this ship to keep Phase E as a single small bundle rather than three follow-on cycles.

**Implementation order:**
1. Step-up route (`/admin/step-up`) — foundation for any admin re-auth flow.
2. Admin credential detail page (`GET /admin/customers/:cid/credentials/:credId`) — read-only metadata version first, no decrypt.
3. Reveal endpoint (`POST .../reveal` + GET `?mode=reveal` branch) — hooks `service.view` into the page.
4. Customer-copy fixes (one EJS per surface).
5. Password-reset copy softening.
6. verifyLogin investigation test + 2FA bucket audit.
7. Build-log / docs (no project-wide build-log on this repo; docs cluster lives in `docs/superpowers/`).

## Reused infrastructure (no new code needed)

| Component | Status | Source |
|---|---|---|
| `service.view(db, {adminId, sessionId, credentialId}, ctx)` | Complete with KEK→DEK unwrap, vault-unlock gate, decrypt-failure forensic audit, `credential.viewed` visible_to_customer audit, Phase B `credential.viewed` digest fan-out (coalescing) | `domain/credentials/service.js:313` |
| `isVaultUnlocked / unlockVault` | Complete; sliding 5-min idle window | `lib/auth/vault-lock.js` |
| `stepUp(db, sid)` / `isStepped(db, sid)` | Complete | `lib/auth/session.js:49,62` |
| `recordForDigest` for `credential.viewed` | Complete; coalesces multiple reads into one digest line | Phase B-12, `lib/digest.js` |
| Admin TOTP verify | Complete | `lib/auth/totp.js` + admins service |

The only thing missing today is the route layer that binds these pieces together.

## File map

### NEW files

| Path | Purpose |
|---|---|
| `routes/admin/step-up.js` | GET form + POST handler for `/admin/step-up`. Verifies TOTP, calls `stepUp` + `unlockVault`, 302s to validated `?return=`. |
| `views/admin/step-up.ejs` | Single TOTP input page; mirrors `views/public/login-2fa.ejs` styling. |
| `views/admin/credentials/show.ejs` | Credential detail page. Metadata card + reveal/hide block. Mirrors `views/admin/customers/detail.ejs` page-header + tabs + card structure. |
| `tests/integration/credentials/admin-view.test.js` | HTTP flow: list → detail → reveal locked → step-up → reveal unlocked → audit + digest. Cross-customer 404. Decrypt failure path. |
| `tests/integration/admin/step-up.test.js` | TOTP verify success/failure, internal-path allowlist on `?return=`, rate-limit at 5 fails / 15 min / 30-min lockout. |
| `tests/integration/auth/reset-then-signin.test.js` | Reset flow → immediate sign-in with new password succeeds on first attempt. |

### MODIFIED files

| Path | Change |
|---|---|
| `routes/admin/credentials.js` | Add `GET /admin/customers/:cid/credentials/:credId` and `POST .../reveal`. Existing list page stays as-is. |
| `views/admin/credentials/list.ejs` | Each row's primary action becomes a link to the detail page (today rows are inert metadata). |
| `views/customer/credentials/list.ejs` | Replace misleading copy with the agreed plain-truth line. |
| `views/customer/dashboard.ejs` | Update Credentials card body line for the same reason. |
| `views/public/reset.ejs` (and customer variant if separate) | Soften success-page copy to "If your address is registered…" form. |
| `server.js` | Register `registerAdminStepUpRoutes(app)`. |

## Routes & flow detail

### `GET /admin/customers/:cid/credentials/:credId`

```
1. requireAdminSession + UUID-validate cid + credId.
2. Load customer (404 if not found). Load credential row by credId
   (404 if not found OR credential.customer_id !== cid — defends
   cross-customer access via path manipulation).
3. Read query param: mode = 'reveal' | 'revealed' | undefined.
4. If mode === 'reveal' AND isVaultUnlocked(session.id):
     - Call service.view(db, {adminId, sessionId, credentialId},
       {ip, userAgentHash, audit:{}}).
     - On success: render show with `payload`. 302 to ?revealed=1
       so back-button doesn't re-trigger.
     - On StepUpRequiredError: 302 /admin/step-up?return=<encoded>.
     - On DecryptFailureError: render show with sticky error.
       service.view already wrote forensic audit OUTSIDE the
       rolled-back tx.
5. If mode === 'revealed': render show with no `payload`; "Reveal"
   button reappears (refresh-safe; plaintext only in DOM during
   the single render that produced it).
6. Otherwise: render metadata + Reveal button.
```

### `POST /admin/customers/:cid/credentials/:credId/reveal`

CSRF-protected entry that just 302s to `?mode=reveal`. Keeps reveal idempotent under refresh / back-button.

### `GET /admin/step-up`

```
1. requireAdminSession.
2. Read ?return=. Validate: must start with '/admin/' literally,
   no '://', no nested '?return=' chains, no URL-encoded variants.
3. If invalid: drop, fall back to '/admin/'.
4. Render TOTP form with the validated return as a hidden field.
```

### `POST /admin/step-up`

```
1. requireAdminSession.
2. CSRF preHandler.
3. Rate-limit 'step-up:admin:<adminId>': 5 fails / 15 min /
   30-min lockout. Mirrors login.js LIMIT/WINDOW_MS/LOCKOUT_MS.
4. Verify TOTP via the existing admin verify path.
5. Fail: recordFail; re-render with error.
6. Pass: stepUp(db, sid) + unlockVault(db, sid); reset bucket;
   302 to validated return.
7. Audit:
     visible_to_customer = false (operator-internal moment)
     action = 'admin.step_up'
     metadata: { return }
```

## Customer-copy edits

### `views/customer/credentials/list.ejs`

Replace:
> "Values are encrypted under your account vault key — DB Studio never sees plaintext on this side. Each credential view leaves an audit row in your Activity log."

With:
> "Values are encrypted under your account vault key. DB Studio admins can decrypt them when they need to read one — every read leaves an entry in your Activity log."

### `views/customer/dashboard.ejs` (Credentials card body)

Replace:
> "Encrypted with your account vault key — admins never see plaintext."

With:
> "Encrypted with your account vault key. Every admin read is recorded in your activity log."

## Password-reset copy softening (item 4)

Both admin and customer reset entry points POST to a route that returns the same neutral page regardless of whether the address is registered. Today the page reads (paraphrasing): *"We've sent you a reset link. Check your inbox."*

New copy:
> *"If your address is registered, we've sent a reset link. Check your inbox in a few minutes; if nothing arrives, double-check the address."*

No backend change. Account-enumeration safety preserved (same response either way).

## verifyLogin investigation (item 5)

Three deliverables:
1. **Integration test:** `tests/integration/auth/reset-then-signin.test.js` — exercise full reset flow, then sign in with the new password and assert success on the FIRST attempt. Catches any regression in the post-reset hash storage path.
2. **Bucket-isolation audit (read-only):** confirm `routes/public/login-2fa.js` records 2FA failures into `2fa:*` keys, not `login:*`. If they share a bucket, file as a separate fix; if isolated, leave a one-line confirming comment near `recordFail`.
3. No code expected to change unless (1) or (2) surfaces a real bug.

The operator workaround for an IP lockout (clearing the bucket via SQL) is already documented in `docs/superpowers/follow-ups.md` and not duplicated here.

## Visual conventions to match

- **Page header:** existing `_page-header` partial; eyebrow `'ADMIN · ' + customer.razon_social`.
- **Admin customer tabs:** existing `_admin-customer-tabs` strip with `activeTab: 'credentials'` so the credential detail stays inside the customer-context navigation.
- **Cards:** existing `.card` + `.card__title-row` + `<dl class="kv">` definition list.
- **Buttons:** existing `_button` partial; `variant: 'primary'` for "Reveal secret", `variant: 'secondary'` for "Hide", `variant: 'ghost'` for "Back".
- **Step-up page:** existing `_page-header` + `_input` + `_button` partials. Visual layout mirrors `views/public/login-2fa.ejs` so the TOTP affordance is familiar to the operator.

## Edge cases

- **Credential belongs to a different customer than `:cid`:** 404 at the route. Service-layer also gets correct customer via the credential row, so the 404 is defence-in-depth, not the only gate.
- **Stolen sid + recently-stepped-up window:** unchanged from the existing customer-side vault flow's threat model. 5-min sliding idle. Documented in `lib/auth/vault-lock.js`.
- **Six reveals in five minutes:** six audit rows; Phase B `credential.viewed` digest coalescer collapses them into one digest line. Customer's activity feed shows all six rows; their inbox sees one digest line. Correct.
- **Customer suspended/archived during admin reveal:** `service.view` does not block — admin needs to read during off-boarding. Documented at `domain/credentials/service.js:303`. Behavior preserved.
- **Decrypt failure:** plaintext never reaches DOM; forensic audit (visible_to_customer=false) written. Detail page rerenders with sticky error.
- **`return` open-redirect attempt:** validated against `^/admin/` strict prefix; rejects `://`, recursive `?return=` chains, and URL-encoded variants. Default fallback `/admin/`.
- **Admin session expires during step-up:** standard `/login` redirect; no auto-resume of original reveal target.
- **Multiple admins viewing simultaneously:** per-session `vault_unlocked_at`; one audit + one digest event per admin per view.

## Tests

### `tests/integration/credentials/admin-view.test.js`

- Vault locked + GET detail no mode → 200 + Reveal button + no plaintext.
- POST `/reveal` while vault locked → 302 `/admin/step-up?return=…?mode=reveal`.
- After `unlockVault` direct + GET `?mode=reveal` → 200 + plaintext + `audit_log` row + customer digest item enqueued + vault timer refreshed.
- Idle 5 min → next reveal POST 302s to step-up again.
- Cross-customer URL → 404 + no audit + no decrypt.
- Decrypt-failure path → detail page + sticky error + forensic audit (`visible_to_customer=false`) + no plaintext in body.

### `tests/integration/admin/step-up.test.js`

- GET with valid `return` → 200 + hidden return field present.
- GET with malicious `return` (`https://evil.com`, `/admin/../../foo`, `//evil.com`) → all sanitized to `/admin/`.
- POST valid TOTP → 302 to validated return; `vault_unlocked_at` + `step_up_at` both refreshed.
- POST wrong TOTP → 422 + error alert + bucket count incremented.
- POST 6× wrong → 429 lockout.
- No admin session → 302 `/login`.

### `tests/integration/auth/reset-then-signin.test.js`

- Reset with a known address → success page with conditional copy ("If your address is registered…").
- Consume the reset link, set new password.
- Sign-in with new password on first attempt → success.
- Assert no `login:*` rate-limit bucket count incremented during the success path.

### Smoke checklist after merge

- `sudo bash scripts/run-tests.sh` → all pass (target ≈ 658 passing).
- Manual: admin opens `/admin/customers/<cid>/credentials/<credId>`, clicks Reveal, completes TOTP, plaintext displays. Switch to customer's session: activity feed shows the read; FYI digest in their queue. Idle 5+ min, click Reveal again, must re-2FA.
- Manual: typo'd address on `/reset` → success page reads "If your address is registered…".
- Confirm `/customer/credentials` list and dashboard Credentials card body show the new plain-truth copy.

## Out of scope (future)

- Customer-side view-with-decrypt UI — same `service.view` path but with `actor_type='customer'` branch. Filed in earlier follow-ups.
- Admin-side credential editing UI (M7 deferred minor — the admin can already create/fulfil via credential-requests; "edit existing credential" stays a follow-up).
- Phase E digest copy/layout/grouping rework (item 5 of the original Phase D handoff). Tracked separately.
