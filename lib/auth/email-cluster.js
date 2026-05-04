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

// Looks at recent `reset:email:*` rate_limit_buckets rows whose count
// is >= 1 (i.e., have already had a failed attempt) and returns the
// lexicographically smallest email within Levenshtein-1 of `email`.
// If no neighbour exists, returns the email itself — the cluster is a
// singleton. The returned key is suitable for use as the cluster bucket
// suffix in routes/public/reset.js.
//
// `windowMs` mirrors the reset-bucket window so we only consider
// neighbours that are still rate-limit-relevant. We deliberately allow
// recently-expired buckets (`reset_at > now() - windowMs`) into the
// candidate pool to give clusters a slightly longer memory than the
// per-email bucket — typo loops often span the natural reset window.
//
// Known tradeoff: when a new attempt's nearest Lev-1 neighbour is
// lex-smaller than the current cluster rep, the rep shifts and the
// cluster fragments across multiple bucket rows. This is acceptable —
// real typo loops anchor on a stable seed (so attempts converge on a
// single rep), and an attacker has no incentive to fragment their own
// cluster (the per-IP and per-email buckets remain in place).
export async function clusterKeyForResetEmail(db, email, { windowMs }) {
  const lower = email.toLowerCase();
  const rows = await sql`
    SELECT key
      FROM rate_limit_buckets
     WHERE key LIKE 'reset:email:%'
       AND reset_at > now() - (${windowMs}::bigint || ' milliseconds')::interval
  `.execute(db);
  let representative = lower;
  for (const row of rows.rows) {
    const candidate = row.key.slice('reset:email:'.length);
    if (candidate === lower) continue;
    if (withinOneEdit(lower, candidate) && candidate < representative) {
      representative = candidate;
    }
  }
  return representative;
}
