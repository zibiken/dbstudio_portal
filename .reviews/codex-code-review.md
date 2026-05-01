## Summary

Third-pass review of DB Studio Portal, targeting two fixes deferred from the second review: (1) the backup-code double-spend race in `routes/public/login-2fa.js` has been addressed with a `FOR UPDATE` transaction, and (2) an integration test file `tests/integration/customers/verifyLogin.test.js` has been added. Both fixes are verified below. One minor issue is noted in the timing test assertion but is not blocking.

---

## Fix Verification — Pass 3 Targets

### Fix 1 — Backup code transaction (was Important #2): VERIFIED CORRECT

**File:** `/opt/dbstudio_portal/routes/public/login-2fa.js` lines 146–171

The customer backup-code branch now wraps the entire read-verify-update-audit cycle in a single Kysely transaction with `FOR UPDATE`:

```js
ok = await app.db.transaction().execute(async (tx) => {
  const lr = await sql`
    SELECT backup_codes FROM customer_users
     WHERE id = ${cu.id}::uuid
       FOR UPDATE
  `.execute(tx);
  const stored = lr.rows[0]?.backup_codes ?? [];
  const result = await verifyAndConsume(stored, backupCode.trim());
  if (!result.ok) return false;
  await sql`
    UPDATE customer_users
       SET backup_codes = ${JSON.stringify(result.stored)}::jsonb
     WHERE id = ${cu.id}::uuid
  `.execute(tx);
  await writeAudit(tx, { ... });
  return true;
});
```

**Transaction correctness:** `app.db.transaction().execute(async (tx) => { ... })` is the standard Kysely transaction pattern. All three SQL operations — the locked `SELECT`, the `UPDATE`, and the `writeAudit` INSERT — execute against `tx`, keeping them inside the same database transaction. The transaction commits when the callback resolves `true` and rolls back if it throws. This correctly prevents double-spend.

**FOR UPDATE semantics:** The `SELECT backup_codes FROM customer_users WHERE id = … FOR UPDATE` targets a single table with a known primary key (UUID). This is a point-lookup row lock with no join, so there is no deadlock risk from table-order issues. A second concurrent request for the same user will block at the `FOR UPDATE` until the first transaction commits or rolls back, then reads the updated `backup_codes` column and correctly finds the code already consumed. This matches the pattern used by `domain/admins/service.js` `consumeBackupCode` (line 435–447), which also uses `FOR UPDATE` on a single-table select.

**writeAudit inside transaction — VERIFIED CORRECT:** `writeAudit` is defined in `/opt/dbstudio_portal/lib/audit.js` as:

```js
export async function writeAudit(db, entry) {
  await db.insertInto('audit_log').values({ ... }).execute();
}
```

`db.insertInto(...)` is a Kysely query builder method. Kysely transaction executors (`tx`) expose the full Kysely query builder API including `insertInto`, so passing `tx` as the `db` argument is correct and the INSERT runs within the transaction. This is the established pattern in the codebase — `audit(tx, ...)` (the `domain/admins/service.js` wrapper around `writeAudit`) is called with a transaction executor throughout `domain/admins/service.js` (lines 69, 153, 154, 155, 169, 206, 413, 425, 445). The new customer path follows the identical pattern.

**Outer read at line 127–134 is not a problem:** The initial query that populates `cu` (including `cu.backup_codes`) is read outside the transaction at line 127. The transaction re-reads `backup_codes` with `FOR UPDATE` at line 150. This re-read is intentional and correct — it discards any stale value from the outer query and acquires a fresh locked snapshot. The outer read's `cu.id` is still used as the WHERE predicate, which is safe because `cu.id` is the session-validated user ID, not a value subject to race.

Important #2 is resolved.

---

### Fix 2 — verifyLogin integration tests (was Important #5): VERIFIED CORRECT WITH MINOR NOTE

**File:** `/opt/dbstudio_portal/tests/integration/customers/verifyLogin.test.js`

Six test cases are present and cover the same surface area as the admin `verifyLogin` suite in `tests/integration/admins/service.test.js` lines 190–218.

**makeActiveCustomer — VERIFIED CORRECT:**

```js
async function makeActiveCustomer(slug, password) {
  const r = await service.create(db, { ... }, baseCtx());
  const hash = await hashPassword(password);
  await sql`UPDATE customer_users SET password_hash = ${hash}
             WHERE email = ${tagEmail(slug)}::citext`.execute(db);
  return { customerId: r.customerId, userId: r.primaryUserId, email: tagEmail(slug) };
}
```

`service.create` returns `{ customerId, primaryUserId, inviteToken }` (confirmed at `/opt/dbstudio_portal/domain/customers/service.js` line 363). The helper correctly reads `r.customerId` and `r.primaryUserId` — no wrong field names, no undefined destructuring. The `UPDATE` to set the password hash targets the correct row via `citext` email match.

**Test cases — coverage assessment:**

| Case | Covers |
|------|--------|
| correct password returns user row | Happy path + checks `r.id === userId` |
| wrong password returns null | Bad credential rejection |
| unknown email returns null | Non-existent user, SENTINEL_HASH path |
| pre-welcome user (null password_hash) returns null | No-hash guard at line 537 |
| suspended customer returns null | `customer_status !== 'active'` gate |
| timing safety (wrong vs missing) | Anti-enumeration timing invariant |

This is a complete set. All six branches exercised by `verifyLogin` are covered. The suspended-customer test correctly calls `service.suspendCustomer(db, { customerId }, baseCtx())` — `suspendCustomer` is exported at `/opt/dbstudio_portal/domain/customers/service.js` line 234.

**Minor issue — timing test assertion comment mismatch (non-blocking):**

The timing test uses:
```js
expect(hi - lo).toBeLessThan(Math.max(50, lo * 3));
```

This is identical to the admin timing test at `tests/integration/admins/service.test.js` line 212. However, the admin test includes a clarifying comment: `// Allow a generous 4× ratio and 50ms floor to keep this stable on shared CI.` The customer test omits this comment entirely. The formula is correct but the absence of an explanatory comment leaves the `lo * 3` multiplier unexplained — a future reader may not understand why a 3× ratio rather than a fixed delta is used, or why `Math.max(50, ...)` is the floor. This is a minor maintainability gap only.

The second concern with the timing test is that it warm-starts with a wrong-password call, then measures only two single-iteration wall-clock samples. On a loaded CI server, a single-sample comparison is susceptible to OS scheduling jitter — a single GC pause or context switch can push either branch outside the 3× bound. The admin suite has the same structure, so this is not a regression introduced here, and the `Math.max(50, lo * 3)` floor mitigates the worst cases. This is not blocking.

Important #5 is resolved.

---

## Previously Verified Fixes (Passes 1 and 2) — Status Unchanged

All four fixes from the first two review passes remain correct and unmodified:

- **TOTP DEK unwrap** (`login-2fa.js` lines 140–144): `unwrapDek` + `totpSecretFrom(cu, dek)`. Correct.
- **Test assertion** (`summary.test.js` line 196): `toBe(4)`. Correct.
- **verifyLogin JOIN query** (`domain/customers/service.js` lines 527–534): single parameterised JOIN. Correct.
- **noticeLoginDevice comment** (`login-2fa.js` line 205): deferred comment present. Correct.

---

## Critical Issues (BLOCKING)

None.

---

## Important Issues (Recommended)

None new in this pass.

---

## Minor Issues (Optional)

**Missing comment on timing test ratio** (`tests/integration/customers/verifyLogin.test.js` line 117)

The `Math.max(50, lo * 3)` tolerance formula is correct but lacks the explanatory comment present in the identical admin test (`// Allow a generous 4× ratio and 50ms floor to keep this stable on shared CI.`). Add the same comment for parity.

---

## Security Assessment

The `FOR UPDATE` transaction fix closes the backup-code double-spend race that was the only remaining security-adjacent open issue. No new security concerns are introduced. The full customer login path — password check, status gate, TOTP, backup codes, audit, session step-up — is now correct and covered by tests.

---

## Test Coverage Assessment

`tests/integration/customers/verifyLogin.test.js` adds six cases covering the full `verifyLogin` surface. The test structure (tag-isolated fixtures, `beforeEach` teardown, `afterAll` cleanup, audit-log trigger disable/re-enable pattern) is consistent with the rest of the test suite. No coverage gaps remain on the authentication critical path.

---

## Migration / Deployment Risk

None. No schema changes. No new environment variables. All changes are application-layer only.

---

## Final Verdict

APPROVE

Both targeted fixes from the second review are correctly implemented and match the established codebase patterns. The `FOR UPDATE` transaction is structurally sound, `writeAudit(tx, ...)` works correctly inside a Kysely transaction executor, and the `verifyLogin` integration test suite is complete and correct. The single minor issue (missing comment) is cosmetic only. No blocking or important issues remain.
