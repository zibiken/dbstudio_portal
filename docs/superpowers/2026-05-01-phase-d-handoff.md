# Phase D — handoff for next session

> **How to pick up:** Open `/opt/dbstudio_portal/`, read this file, then invoke `superpowers:brainstorming`. Skip the "explore project state" step — A/B/C is shipped, see commits `c63ebeb..fcbd3b9` on `main`.

## Approved scope (operator-confirmed 2026-05-01)

Four items for Phase D. Operator paraphrase: "all good if you believe this is the best way forward".

1. **NDA gate.** Customer cannot reach `/customer/dashboard` or any feature surface until `customers.nda_signed_at` is set. Only `/customer/profile` (so they can change password/email) and a new `/customer/waiting` interstitial are reachable. The waiting page tells the customer DB Studio will email them and unlock automatically once the signed NDA is uploaded by an admin. Set `customers.nda_signed_at = now()` inside `domain/ndas/service.attachUploadedDocument(kind:'signed')` in the same tx as the existing audit. Add a customer-side gate middleware. Schema: one new `timestamptz` column on `customers`.

2. **Type C — short-answer questionnaire.** New table `customer_questions(id, customer_id, project_id NULL, question, answer_text NULL, status ∈ {open, answered, skipped}, created_at, answered_at NULL)`. Plain text — **NOT** vault-encrypted (these aren't secrets). "Skip / I don't know" is a first-class action that writes `status='skipped'`, leaves `answer_text` NULL. Admin creates questions per project; customer answers via `/customer/questions/<id>`. Digest events: `question.created` → customer Action-required; `question.answered` and `question.skipped` → admin FYI.

3. **Per-project workspace.** New views `/customer/projects/<id>` and `/admin/customers/<cid>/projects/<pid>/workspace`. Lists open credential_requests + open Type-C questions for that project, grouped by status. The current customer dashboard stays as the company-level overview; the project workspace is where Phase 0.5-style work happens.

4. **"Cleaned up" dashboard banner.** When `credential.deleted` (admin actor) audit lands with `visible_to_customer=true`, surface it as a dismissible banner on `/customer/dashboard` for 7 days: *"DB Studio cleaned up your <provider> credential on <date>"*. Mechanism: read recent (≤ 7 days) `credential.deleted` audit rows where actor_type='admin' and visible_to_customer=true, dedupe by user-dismissal cookie or per-customer dismissed_at column.

**Skipped (decided against in audit cross-reference):**
- Type B as a distinct portal feature — covered in the PDF dossier instead.
- Per-item "release" toggle — breaks operational flow; trust contract via real-time activity feed already covers visibility.

## Independent issue surfaced 2026-05-01 (handle in this same Phase D, or split — operator's call)

Operator received a real digest email containing items like:

```
For your information

provided github credentials
cr_workflow_1777632730201 na-happy-co S.L. marked wp-engine as not applicable
cred_autolock_1777632827753 view-ok S.L. added 1 credential
cred_autolock_1777632827753 view-locked S.L. added 1 credential
[…23 lines of similar test-fixture-flavoured noise…]
```

**Two distinct problems:**

a. **Test data leaked into a production-style email.** The integration tests (which we ran against the live `portal_db` per project workflow) created `pending_digest_items` rows for fictional admin/customer accounts whose `razon_social` is a Date.now()-tagged fixture name (`cr_workflow_1777632730201 na-happy-co S.L.`). Those rows survived the test run; the digest worker fired its 60s tick after the post-test service restart and emailed them to the operator. Test cleanup needs to delete or skip pending_digest_items / digest_schedules rows tagged by the test scaffolding. Audit `tests/helpers/audit.js` and the per-test `tag` pattern — likely a one-line addition to the cleanup query.

b. **Even with clean data the email is hard to read for non-technical readers.** Today's titles are terse and developer-flavoured:
- `<companyName> added 1 credential` → "<companyName> uploaded a new credential to their vault" reads better
- The current admin digest has no visual grouping per customer when multiple customers were active
- No timestamps on items — a date or "today / yesterday" hint would help context
- The "subject" is generic ("Activity update from DB Studio Portal") — ranges like "5 things to action, 12 FYI" would tell the reader what's inside before they open
- "Sign in to see the full timeline" is fine but the link target is generic — could deep-link to the activity feed
- Visual hierarchy: today, items are a flat bulleted list; for admin digests with 20+ lines this is overwhelming

Specific copy/format reworks worth proposing during the brainstorm:
- Drop the visible internal IDs (the test pollution leaked these — but real customer names like "Solbizz Canarias S.L.U." are also long; consider truncation or boldening)
- Group admin digest items by customer with a small sub-heading
- Show counts per customer in the header ("Acme Corp — 4 items")
- Use natural-language verbs: "uploaded", "viewed", "marked …", "fully paid"
- Date stamps on each line (or "Today", "Yesterday", "2 days ago" using the recipient's locale)
- Subject line should reflect content: "1 action required, 4 updates from DB Studio Portal"
- Render time: test on Gmail, Apple Mail, Outlook web — current email is dark-themed; some clients normalise to light mode and the lists may break

## Concrete files to look at first when restarting

- `lib/digest-strings.js` — title strings per locale + event type. Soft-target for the copy rewrite.
- `domain/digest/worker.js` — locals fan-out. If we add timestamps/grouping the worker passes more locals.
- `emails/{en,nl,es}/digest.ejs` — the rendered HTML structure. Add per-customer grouping for admin digests here.
- `tests/helpers/audit.js` + every test using `tag = '*_test_${Date.now()}'` — extend cleanup to also drop pending_digest_items + digest_schedules tagged by metadata or by recipient_id matching tag-emitting helpers.

## Order suggestion when brainstorming Phase D

1. Decide: is the email-readability rework one Phase D bundle, or split into Phase D (workflow features 1–4) + Phase E (digest polish)?
2. If bundled: add it as item 5 to Phase D. If split: Phase D ships items 1–4 first, Phase E reworks digest copy/layout/grouping later.
3. Test-pollution cleanup is a Phase D bug-class side-task regardless — **do this first** so subsequent test runs don't email the operator garbage during development.

## Status of the codebase as you enter Phase D

- `main` synced to `origin/main` at `fcbd3b9`.
- Migration ledger ends at `0010_digest_and_payments`.
- Test suite: 610 passing / 3 skipped / 0 failing on `sudo bash scripts/run-tests.sh`.
- Service running cleanly: `portal.service` + `portal-pdf.service` both active; smoke 1–9 OK.
- New email template `digest` is wired and live; if you flip `PORTAL_EMAIL_DEV_HOLD=true` in `/opt/dbstudio_portal/.env` and restart, no emails will leave the box during dev work.

That's everything you need to pick up.
