#!/usr/bin/env bash
# Bootstrap portal secrets. Run ONCE as root on the server.
# Generates: /var/lib/portal/master.key (32-byte KEK), /opt/dbstudio_portal/.env signing secrets,
#            .git/hooks/pre-commit symlink.
# Idempotent: refuses to overwrite existing secret files unless --rotate-signing is passed.
#
# Entropy:
#   - Master KEK:                32 bytes  /dev/urandom (256 bits — required by AES-256-GCM).
#   - SESSION_SIGNING_SECRET:    64 bytes  /dev/urandom, base64-encoded (~88 chars, 512 bits).
#   - FILE_URL_SIGNING_SECRET:   64 bytes  /dev/urandom, base64-encoded (~88 chars, 512 bits).
# All secrets land in mode-0400 files owned by portal-app. The KEK never re-enters userspace
# after generation (loaded once at process boot, kept in memory only).
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/dbstudio_portal}"
DATA_DIR="${DATA_DIR:-/var/lib/portal}"
APP_USER="${APP_USER:-portal-app}"
APP_GROUP="${APP_GROUP:-portal-app}"
ROTATE=""
DB_PW_FILE="${DB_PW_FILE:-/root/.portal_db_pw}"

for arg in "$@"; do
  case "$arg" in
    --rotate-signing) ROTATE="signing" ;;
    --help|-h) sed -n '1,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$EUID" -ne 0 ]]; then
  echo "must run as root" >&2; exit 1
fi

[[ -d "$REPO_DIR" ]] || { echo "$REPO_DIR not found" >&2; exit 1; }
[[ -d "$DATA_DIR" ]] || { echo "$DATA_DIR not found — operator should have created it (gate M0-A)" >&2; exit 1; }
id "$APP_USER" >/dev/null 2>&1 || { echo "user $APP_USER missing — operator should have created it (gate M0-A)" >&2; exit 1; }

# 1. KEK
KEK="$DATA_DIR/master.key"
if [[ -f "$KEK" ]]; then
  echo "[ok] KEK already exists at $KEK (refusing to overwrite)"
else
  umask 0077
  head -c 32 /dev/urandom > "$KEK"
  chown "$APP_USER:$APP_GROUP" "$KEK"
  chmod 0400 "$KEK"
  KEK_SHA="$(sha256sum "$KEK" | cut -d' ' -f1)"
  echo "[ok] generated KEK at $KEK (32 bytes, mode 0400, owned $APP_USER:$APP_GROUP)"
  echo "[ok] KEK sha256 fingerprint (for later integrity audits): ${KEK_SHA:0:16}..."
  echo ""
  echo "WARNING: BACK THIS FILE UP NOW to a separate offline medium."
  echo "  Loss of /var/lib/portal/master.key = ALL credentials unrecoverable."
  echo ""
fi

# 2. .env
ENV_FILE="$REPO_DIR/.env"

read_db_pw() {
  if [[ -f "$DB_PW_FILE" ]]; then
    cat "$DB_PW_FILE"
  else
    echo "" >&2
    echo "DB password file $DB_PW_FILE not found." >&2
    echo "Either save the portal_user password to $DB_PW_FILE (mode 0400) before running this script," >&2
    echo "or set DB_PW_FILE=/some/other/path. Aborting." >&2
    exit 1
  fi
}

if [[ -f "$ENV_FILE" && -z "$ROTATE" ]]; then
  echo "[ok] $ENV_FILE already exists (use --rotate-signing to regenerate signing secrets)"
else
  if [[ -f "$ENV_FILE" && "$ROTATE" == "signing" ]]; then
    cp "$ENV_FILE" "$ENV_FILE.pre-rotate.$(date +%s)"
    chmod 0400 "$ENV_FILE.pre-rotate."*
  fi
  SESSION="$(head -c 64 /dev/urandom | base64 | tr -d '\n')"
  FILE_URL="$(head -c 64 /dev/urandom | base64 | tr -d '\n')"
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$REPO_DIR/.env.example" "$ENV_FILE"
    DB_PW="$(read_db_pw)"
    DB_URL="postgres://portal_user:${DB_PW}@127.0.0.1:5432/portal_db"
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" "$ENV_FILE"
  fi
  sed -i "s|^SESSION_SIGNING_SECRET=.*|SESSION_SIGNING_SECRET=$SESSION|" "$ENV_FILE"
  sed -i "s|^FILE_URL_SIGNING_SECRET=.*|FILE_URL_SIGNING_SECRET=$FILE_URL|" "$ENV_FILE"
  chown "$APP_USER:$APP_GROUP" "$ENV_FILE"
  chmod 0400 "$ENV_FILE"
  echo "[ok] wrote $ENV_FILE with fresh 64-byte signing secrets (mode 0400, $APP_USER)"
  echo "[ok] DATABASE_URL populated from $DB_PW_FILE"
  echo ""
  echo "Operator: at M4, edit $ENV_FILE again to set MAILERSEND_API_KEY:"
  echo "  sudoedit $ENV_FILE"
  echo ""
fi

# 3. Pre-commit hook
HOOK="$REPO_DIR/.git/hooks/pre-commit"
if [[ -L "$HOOK" || -f "$HOOK" ]]; then
  echo "[ok] pre-commit hook already installed at $HOOK"
else
  ln -s "$REPO_DIR/scripts/precommit-secrets-check.sh" "$HOOK"
  echo "[ok] installed pre-commit hook -> scripts/precommit-secrets-check.sh"
fi

echo ""
echo "Bootstrap complete."
