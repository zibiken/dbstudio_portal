// Levenshtein-1 typo clustering for password-reset rate limiting.
//
// Threat model: a user (or bot) types similar but distinct email
// addresses against /reset (e.g., `info@brainzr.com` vs
// `info@brainzr.eu` vs `info@branzr.eu`). The per-exact-email bucket
// in `lib/auth/rate-limit.js` keys on the canonical email, so each
// typo gets a fresh bucket and never accumulates fails for the
// cluster. The per-IP bucket already catches the same-IP case, but
// it does NOT catch a multi-IP typo loop. This module adds a third
// bucket keyed off a cluster representative — the lexicographically
// smallest email within Levenshtein distance 1 of the current
// attempt across recent reset buckets.
//
// Performance: the candidate set is bounded by the recent
// `reset:email:*` rate_limit_buckets rows (typically < 50 in any
// 15-minute window). We compute Levenshtein-1 against each — O(n × len)
// — which is cheap.
//
// We deliberately do NOT cluster by guessable derivations (e.g.,
// "strip TLD") because that would lump unrelated org domains together.
// Levenshtein-1 is restrictive enough to keep clusters meaningful.

import { sql } from 'kysely';

// Returns true iff Levenshtein distance between a and b is <= 1.
// Linear-time check: equal, single insertion, single deletion, or single
// substitution. Strings are compared case-insensitively (emails are
// case-insensitive in practice).
export function withinOneEdit(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const lx = x.length;
  const ly = y.length;
  if (Math.abs(lx - ly) > 1) return false;

  if (lx === ly) {
    // Single substitution: exactly one position differs.
    let diffs = 0;
    for (let i = 0; i < lx; i++) {
      if (x[i] !== y[i]) {
        diffs++;
        if (diffs > 1) return false;
      }
    }
    return diffs === 1;
  }

  // One is one char longer: check single-insertion match.
  const longer = lx > ly ? x : y;
  const shorter = lx > ly ? y : x;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j++;
    }
  }
  return true;
}

// Returns the cluster representative for `email`: the lex-smallest
// email within Levenshtein-1 of `email` across either (a) recent
// `reset:email:*` buckets within `windowMs`, or (b) active
// `reset:cluster:*` buckets whose `locked_until` has not expired or
// whose `reset_at` is within `windowMs + lockoutMs`. (b) is what
// prevents the cluster-aging bypass: when an in-cluster `reset:email:*`
// row's `reset_at` ages past the per-email window, the cluster bucket
// itself can still be active (its `lockoutMs` is longer than the
// `windowMs` for individual attempts), and a new typo would otherwise
// compute a fresh representative and bypass the still-locked cluster
// bucket. Querying live `reset:cluster:*` rows keeps the rep
// discoverable for the full lockout duration.
//
// If no neighbour exists, the cluster is a singleton and the email
// itself is the representative.
//
// `windowMs` mirrors the reset-bucket window for individual attempts;
// `lockoutMs` mirrors the cluster lockout duration. Both are required
// so the longer-memory cluster lookup is correct.
//
// Known tradeoff: when a new attempt's nearest Lev-1 neighbour is
// lex-smaller than the current cluster rep, the rep shifts and the
// cluster fragments across multiple bucket rows. This is acceptable —
// real typo loops anchor on a stable seed (so attempts converge on a
// single rep), and an attacker has no incentive to fragment their own
// cluster (the per-IP and per-email buckets remain in place).
export async function clusterKeyForResetEmail(db, email, { windowMs, lockoutMs }) {
  const lower = email.toLowerCase();
  const clusterMemoryMs = windowMs + (lockoutMs ?? 0);
  const rows = await sql`
    SELECT key, kind FROM (
      SELECT key, 'email'::text AS kind FROM rate_limit_buckets
       WHERE key LIKE 'reset:email:%'
         AND reset_at > now() - (${windowMs}::bigint || ' milliseconds')::interval
      UNION
      SELECT key, 'cluster'::text AS kind FROM rate_limit_buckets
       WHERE key LIKE 'reset:cluster:%'
         AND (locked_until > now()
              OR reset_at > now() - (${clusterMemoryMs}::bigint || ' milliseconds')::interval)
    ) c
  `.execute(db);
  let representative = lower;
  for (const row of rows.rows) {
    const prefix = row.kind === 'email' ? 'reset:email:' : 'reset:cluster:';
    const candidate = row.key.slice(prefix.length);
    if (candidate === lower) continue;
    if (withinOneEdit(lower, candidate) && candidate < representative) {
      representative = candidate;
    }
  }
  return representative;
}
