# Phase F — handoff for next session

> **How to pick up:** Open `/opt/dbstudio_portal/`, read this file, then invoke `superpowers:brainstorming`. Skip the "explore project state" step — Phase D + E are shipped, see commits `c63ebeb..76989ba` on `main`.

## Status as you enter

- `main` synced to `origin/main` at `76989ba`.
- Full suite: **657 passing / 3 skipped / 0 failing.**
- `node scripts/clean-stale-test-rows.js` reports 0 stale rows.
- Migration ledger ends at `0011_phase_d`. Phase F is unlikely to need a new migration (digest table already exists; this is a copy/template ship).
- Live portal running on the Phase E build: `/admin/customers/:cid/credentials/:credId` reveal flow + `/admin/step-up` are live and audited.
- Phase D operator feedback batch (5 items) is FULLY closed; see `docs/superpowers/follow-ups.md` "ROADMAP STATUS" block at the top.

## Phase F — what it is

**Digest email copy / layout / grouping rework.** The Phase B digest worker fans events into per-recipient `pending_digest_items` rows; the worker debounces and renders an EJS digest email. The CONTENT of those emails works but reads poorly, especially for admin recipients.

The original operator complaint (verbatim quote, captured in the Phase D handoff at `docs/superpowers/2026-05-01-phase-d-handoff.md`):

```
For your information

provided github credentials
cr_workflow_1777632730201 na-happy-co S.L. marked wp-engine as not applicable
cred_autolock_1777632827753 view-ok S.L. added 1 credential
cred_autolock_1777632827753 view-locked S.L. added 1 credential
[…23 lines of similar test-fixture-flavoured noise…]
```

Two distinct problems were filed at the time:
- **a)** test-fixture pollution leaking into production digest mails — **SHIPPED in Phase D**, no longer relevant.
- **b)** the digest itself is hard to read for non-technical readers — **this is Phase F**.

## Specific items the operator flagged (verbatim)

- *"`<companyName> added 1 credential` → '<companyName> uploaded a new credential to their vault' reads better"*
- *"the current admin digest has no visual grouping per customer when multiple customers were active"*
- *"no timestamps on items — a date or 'today / yesterday' hint would help context"*
- *"the 'subject' is generic ('Activity update from DB Studio Portal') — ranges like '5 things to action, 12 FYI' would tell the reader what's inside before they open"*
- *"'Sign in to see the full timeline' is fine but the link target is generic — could deep-link to the activity feed"*
- *"visual hierarchy: today, items are a flat bulleted list; for admin digests with 20+ lines this is overwhelming"*

## Specific copy/format reworks worth proposing during the brainstorm

- Drop the visible internal IDs.
- Group admin digest items by customer with a small sub-heading.
- Show counts per customer in the header ("Acme Corp — 4 items").
- Use natural-language verbs: "uploaded", "viewed", "marked …", "fully paid".
- Date stamps on each line (or "Today", "Yesterday", "2 days ago" using the recipient's locale).
- Subject line: "1 action required, 4 updates from DB Studio Portal".
- Render time: test on Gmail, Apple Mail, Outlook web — current email is dark-themed; some clients normalise to light mode and the lists may break.

## Concrete files to look at first when restarting

- `lib/digest-strings.js` — title strings per locale + event type. Soft-target for the natural-language verb rewrite.
- `domain/digest/worker.js` — locals fan-out. Adding timestamps/grouping means the worker passes more locals to the template.
- `emails/{en,nl,es}/digest.ejs` — the rendered HTML structure. Per-customer grouping for admin digests goes here. Light/dark mode compatibility audit lives here.
- `lib/digest.js` (`recordForDigest`) — the coalescing logic for events like `credential.viewed` already collapses N reads into one digest line; check whether the Phase F rework benefits from a coalescing shape change.
- `tests/integration/email/` — existing digest snapshot/render tests to extend.

## Likely sub-decisions during the brainstorm

1. **Subject-line content scheme.** Static vs dynamic, count-based ("1 action required, 4 updates") vs per-event-type, English-only vs localised counts.
2. **Per-customer grouping for admin digest.** When admin digest has events from 5 different customers, group with a sub-heading per customer? Or interleave chronologically? What about admin events that have no `customerId` (system-level events)?
3. **Date/locale label scheme.** "Today" / "Yesterday" / "2 days ago" using recipient's locale. Falls back to absolute date past N days.
4. **Light-mode mail-client compatibility.** Audit current digest.ejs against Gmail web, Apple Mail, Outlook web. Document what breaks. Decide whether to redesign for dual-mode or stick with one.
5. **Deep-link strategy.** "Sign in to see the full timeline" — link to `/customer/activity?filter=…` with a pre-applied filter so the customer lands on the relevant slice?
6. **Verb rewrites.** New strings in `lib/digest-strings.js`. Need to bump the slug/title-count test if such an assertion exists.

## What stays for after Phase F

- Customer-side view-with-decrypt UI ("Vault view-with-decrypt (M9.X partial)" in follow-ups.md).
- Admin credential-edit UI (M7 deferred minor).
- i18n localisation grind (~620 strings — separate workstream).
- Accessibility pass (axe-core + skip-link + heading-order).
- M3/M5/M6/M9/M10 review-deferred items (LIKE pattern wildcards, audit metadata index, controlled error vocab, regex backreference bug, TOCTOU note).

## Concrete first commands when restarting

```bash
cd /opt/dbstudio_portal
git log --oneline -5     # verify 76989ba is HEAD or newer
sudo bash scripts/smoke.sh   # confirm portal + DB
sudo bash scripts/run-tests.sh tests/integration/email tests/integration/digest 2>&1 | tail -5  # baseline digest test count
```

Then read `docs/superpowers/2026-05-01-phase-d-handoff.md` (the "Independent issue surfaced 2026-05-01" section captures the operator's verbatim digest grievances) and invoke `superpowers:brainstorming`.

## Operational reminders

1. **File permissions.** Test runner runs as `portal-app`. New files written by root land at mode 640 (group-only). `chmod 644` after every Write/Edit. The most common foot-gun on this repo.
2. **Email build.** Templates compile via `scripts/email-build.js` (called from `scripts/build.js`). After editing any `.ejs` in `emails/`, run `node scripts/build.js` so `_compiled.js` picks it up. The slug-count test in `tests/unit/email/templates.test.js` expects 18 slugs today; if Phase F adds or splits templates, bump it.
3. **CSS build.** Editing `public/styles/app.src.css` requires `node scripts/build.js` to regenerate `app.css`. Browser cache is a real surprise — hard refresh after CSS changes.
4. **Phase E test sweep.** `tests/integration/email-outbox/worker.test.js` now sweeps stale `queued`/`failed` outbox rows in `beforeAll`; that's intentional defensive cleanup and shouldn't be removed.

That's it. Phase F is a focused copy + layout ship; one spec → one plan → one execution cycle.
