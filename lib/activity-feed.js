import { sql } from 'kysely';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Allow-list (M7 review M1) — only these metadata keys reach the
// customer slice. Adding a new key to a credential audit-writer
// requires a deliberate addition here; leaking by default is forbidden
// (admins.email, rawPayloadSnippet, ip, user_agent_hash, etc. would
// all bleed through with a deny-list and unaware future writers).
const SAFE_METADATA_KEYS = new Set([
  'customerId',
  'provider',
  'label',
  'previousLabel',
  'payloadChanged',
  'createdBy',
  'requestId',
  'credentialId',
  'fieldCount',
  'reason',
  // M9 additions — name + email + 2FA + sessions + projects + ndas/docs.
  // Whitelist any value the customer should be able to see in their own
  // timeline; sensitive values like sessionId / keptSessionId / IP / UA
  // are intentionally excluded.
  'previousName',
  'newName',
  'oldEmail',
  'newEmail',
  'restoredEmail',
  'undoneEmail',
  'proof',
  'previousStatus',
  'newStatus',
  'projectId',
  'ndaId',
  'documentId',
  'revokedCount',
]);

function pickSafeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SAFE_METADATA_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// Customer activity-feed reader for credential-vault events (Task 7.5).
//
// Returns a redacted, customer-safe slice of audit_log:
//   - Scoped to the given customer via metadata->>'customerId' (the audit
//     writers in domain/credentials/** + domain/credential-requests/**
//     all stamp this on every visible row), with a fallback for legacy
//     credential.* rows that target the credential id directly via a
//     join to the credentials table.
//   - visible_to_customer = TRUE only.
//   - Action prefix in {'credential.', 'credential_request.'} only.
//   - actor_display_name resolved from admins.name (admin actor) or
//     customer_users.name (customer actor). admins.email NEVER reaches
//     the customer slice.
//   - Operator-forensic columns (ip, user_agent_hash) are stripped.
//   - metadata returned with the audit-internal 'tag' field stripped
//     (the test-tag noise is operator-side only).
//
// Broader customer activity feed (M9 §18). Reads any
// visible_to_customer=true row scoped to the customer either by
// metadata->>'customerId' OR by target_type='customer' AND target_id =
// the customer id (the M5 customer.suspended/reactivated/archived path).
// Stripped/projected with the same SAFE_METADATA_KEYS allow-list so a
// future audit-writer that adds a sensitive metadata key cannot leak it
// to the customer surface by default. Newest-first; supports
// actionPrefixes ([] = no filter), since/until ISO timestamps, and a
// limit (default 50, hard cap 200).
export async function listActivityForCustomer(db, customerId, opts = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit ?? DEFAULT_LIMIT) | 0), MAX_LIMIT);
  const prefixes = Array.isArray(opts.actionPrefixes) && opts.actionPrefixes.length > 0
    ? opts.actionPrefixes.map((p) => `${p}%`)
    : null;
  const since = opts.since ? new Date(opts.since) : null;
  const until = opts.until ? new Date(opts.until) : null;

  const r = await sql`
    SELECT a.id::text AS id,
           a.ts,
           a.actor_type,
           a.actor_id::text AS actor_id,
           a.action,
           a.target_type,
           a.target_id::text AS target_id,
           a.metadata,
           ad.name AS admin_name,
           cu.name AS customer_user_name
      FROM audit_log a
      LEFT JOIN admins ad
             ON a.actor_type = 'admin' AND ad.id = a.actor_id
      LEFT JOIN customer_users cu
             ON a.actor_type = 'customer' AND cu.id = a.actor_id
     WHERE a.visible_to_customer = TRUE
       AND (
            (a.metadata->>'customerId' = ${customerId})
         OR (a.target_type = 'customer' AND a.target_id = ${customerId}::uuid)
       )
       AND (${prefixes}::text[] IS NULL OR a.action LIKE ANY(${prefixes}::text[]))
       AND (${since}::timestamptz IS NULL OR a.ts >= ${since}::timestamptz)
       AND (${until}::timestamptz IS NULL OR a.ts <= ${until}::timestamptz)
     ORDER BY a.ts DESC
     LIMIT ${limit}
  `.execute(db);

  return r.rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    actor_type: row.actor_type,
    actor_display_name: row.actor_type === 'admin'
      ? row.admin_name
      : row.actor_type === 'customer'
        ? row.customer_user_name
        : null,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    metadata: pickSafeMetadata(row.metadata),
  }));
}

// Newest-first by ts; default limit 50, hard cap 200.
export async function listCredentialActivityForCustomer(db, customerId, opts = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit ?? DEFAULT_LIMIT) | 0), MAX_LIMIT);

  const r = await sql`
    SELECT a.id::text AS id,
           a.ts,
           a.actor_type,
           a.actor_id::text AS actor_id,
           a.action,
           a.target_type,
           a.target_id::text AS target_id,
           a.metadata,
           ad.name AS admin_name,
           cu.name AS customer_user_name
      FROM audit_log a
      LEFT JOIN admins ad
             ON a.actor_type = 'admin' AND ad.id = a.actor_id
      LEFT JOIN customer_users cu
             ON a.actor_type = 'customer' AND cu.id = a.actor_id
     WHERE a.visible_to_customer = TRUE
       AND (a.action LIKE 'credential.%' OR a.action LIKE 'credential_request.%')
       AND (a.metadata->>'customerId' = ${customerId})
     ORDER BY a.ts DESC
     LIMIT ${limit}
  `.execute(db);

  return r.rows.map((row) => {
    const safeMeta = pickSafeMetadata(row.metadata);
    const label = (row.metadata && typeof row.metadata.label === 'string' && row.metadata.label.trim() !== '')
      ? row.metadata.label
      : (row.metadata?.provider ?? row.action);
    return {
      id: row.id,
      ts: row.ts,
      actor_type: row.actor_type,
      actor_display_name: row.actor_type === 'admin'
        ? row.admin_name
        : row.actor_type === 'customer'
          ? row.customer_user_name
          : null,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
      label,
      metadata: safeMeta,
    };
  });
}
