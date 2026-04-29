#!/usr/bin/env bash
# Pre-commit secret scanner. Aborts the commit if staged content matches any pattern.
# Invoked by .git/hooks/pre-commit (installed by bootstrap-secrets.sh).
# Usage:
#   - With no args: scans `git diff --cached` (the real hook path).
#   - With one arg: treats the arg as a file path containing the staged content (test path).
set -euo pipefail

if [[ $# -eq 1 && -f "$1" ]]; then
  CONTENT="$(cat "$1")"
else
  CONTENT="$(git diff --cached -U0)"
fi

# Allow CHANGEME placeholders and clearly commented values.
WHITELIST_REGEX='(CHANGEME|placeholder|<your-|<the-|example|TODO|fake)'

# Patterns. Each is an extended-regex that triggers a rejection.
PATTERNS=(
  '-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----'
  '^MAILERSEND_API_KEY=[^[:space:]]+$'
  '^[A-Z][A-Z_]*API_KEY=[^[:space:]]+$'
  '^password=("|'"'"')[^"'"'"']+("|'"'"')'
  '(secret|token|key)[a-z_]*=[A-Za-z0-9+/=]{40,}'
  '(secret|token|key)[a-z_]*=[a-f0-9]{40,}'
  'mlsn\.[A-Za-z0-9]{20,}'
)

VIOLATIONS=()
while IFS= read -r line; do
  for pat in "${PATTERNS[@]}"; do
    if [[ "$line" =~ $pat ]] && ! [[ "$line" =~ $WHITELIST_REGEX ]]; then
      VIOLATIONS+=("$line")
      break
    fi
  done
done <<<"$CONTENT"

if (( ${#VIOLATIONS[@]} > 0 )); then
  echo "ERROR: pre-commit secret scan REJECTED ${#VIOLATIONS[@]} staged change(s) — possible secret(s):" >&2
  for v in "${VIOLATIONS[@]}"; do echo "  - $v" >&2; done
  echo "" >&2
  echo "If this is a false positive, rephrase the line. If it is a real secret, never commit it." >&2
  echo "See SAFETY.md for the secrets policy." >&2
  exit 1
fi

exit 0
