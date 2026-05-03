# Codex final review — G4 (credentials per-project scope)

**Date:** 2026-05-03
**Commit:** HEAD (amended after Kimi+DeepSeek pass)
**Verdict:** APPROVE

## Reviewers
- **Kimi (Instant):** APPROVE WITH CHANGES → BLOCK on JSON-error-on-form-POST and "empty 404" inconsistency. JSON fix landed (redirect + scope_error query param). Empty 404 is pre-existing project convention for customer-credentials routes — not G4 scope. The 'revealed' typo Kimi re-flagged in G4 was disproved in G2 and confirmed again here (revealed gates a "just hidden" hint, not the decrypted-state display).
- **DeepSeek (deepseek-v4-pro):** USE WITH CHANGES → TOCTOU on assertProjectBelongsToCustomer (concurrent project.customer_id reassignment between SELECT and INSERT/UPDATE). FOR UPDATE row lock added.
- **Codex round 1:** APPROVE on all six specific checks.

## Final verdict
APPROVE
