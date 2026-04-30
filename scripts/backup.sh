#!/usr/bin/env bash
# Nightly age-encrypted backup. Produces two encrypted artefacts per run:
#   db-<TS>.dump.age      — pg_dump --format=custom of $DATABASE_URL
#   storage-<TS>.tar.age  — tar of $DATA_DIR/storage
#
# Both encrypted with the recipients listed in $RECIPIENTS (public keys
# only — the matching age private key lives off-server on the operator
# workstation per spec §2.12).
#
# Pushed to $REMOTE (rclone remote) under $REMOTE/<TS>/. Local copies in
# $BACKUP_DIR are pruned after 30 days; remote retention is enforced
# server-side by the Storage Box (--immutable on copy).
#
# Usage (operator, manual): sudo systemctl start portal-backup.service
# Usage (timer): nightly 02:30 UTC via portal-backup.timer.
# Usage (test): see tests/integration/backup/backup.test.js — overrides
# $BACKUP_RCLONE_REMOTE / $AGE_RECIPIENTS_FILE / $BACKUP_DIR / $DATABASE_URL.

set -euo pipefail

DATA_DIR=${PORTAL_DATA_DIR:-/var/lib/portal}
BACKUP_DIR=${BACKUP_DIR:-$DATA_DIR/backups}
RECIPIENTS=${AGE_RECIPIENTS_FILE:-$DATA_DIR/.age-recipients}
REMOTE=${BACKUP_RCLONE_REMOTE:-hetzner-portal:portal/}
TS=$(date -u +%Y%m%dT%H%M%SZ)

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set (EnvironmentFile=/opt/dbstudio_portal/.env in the systemd unit)" >&2
  exit 2
fi
if ! command -v age >/dev/null 2>&1; then
  echo "age binary not found in PATH — install age (apt install age) before running backup.sh" >&2
  exit 2
fi
if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone binary not found in PATH — install rclone before running backup.sh" >&2
  exit 2
fi
if [[ ! -r "$RECIPIENTS" ]]; then
  echo "age recipients file unreadable at $RECIPIENTS" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
cd "$BACKUP_DIR"

DB_FILE=db-$TS.dump
ST_FILE=storage-$TS.tar

# 1. pg_dump (custom format)
pg_dump --format=custom --file="$DB_FILE" "$DATABASE_URL"

# 2. storage tarball
tar -cf "$ST_FILE" -C "$DATA_DIR" storage

# 3. encrypt to age recipients, then shred the plaintexts in place
age --encrypt --recipients-file "$RECIPIENTS" -o "$DB_FILE.age" "$DB_FILE"
age --encrypt --recipients-file "$RECIPIENTS" -o "$ST_FILE.age" "$ST_FILE"
shred -u "$DB_FILE" "$ST_FILE"

# 4. rclone push to remote under the per-run timestamp directory
rclone copy "$DB_FILE.age" "$REMOTE$TS/" --immutable
rclone copy "$ST_FILE.age" "$REMOTE$TS/" --immutable

# 5. local retention — keep 30 days. Remote retention is enforced
#    server-side by Storage Box settings (spec §2.12).
find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.age' -mtime +30 -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'storage-*.age' -mtime +30 -delete

logger -t portal-backup "backup complete: $TS db=$DB_FILE.age storage=$ST_FILE.age remote=$REMOTE$TS/"
