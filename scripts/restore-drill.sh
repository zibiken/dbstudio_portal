#!/usr/bin/env bash
# Backup restore drill — spec §11 acceptance gate, M10-B operator gate.
#
# What it does:
#   1. Lists every backup folder under $REMOTE on the rclone Storage Box.
#   2. Picks one at random.
#   3. Pulls db-*.dump.age + storage-*.tar.age into a workdir.
#   4. Prompts operator for the path to the offline age private key
#      (NEVER persisted by this script; only read; the operator keeps
#      custody of the key file).
#   5. Decrypts the db dump.
#   6. Creates a scratch Postgres database `portal_drill_<TS>`,
#      pg_restores the dump into it.
#   7. Reads one customer row; unwraps its DEK with the production KEK
#      (/var/lib/portal/master.key); decrypts one credential payload.
#   8. Reports OK / FAIL. Drops the scratch DB and the workdir on exit.
#
# Usage (operator at the keyboard, after gate 10-A):
#   sudo bash /opt/dbstudio_portal/scripts/restore-drill.sh
#
# The age private key is entered interactively (read -s); it is not
# accepted on the command line.

set -euo pipefail

ROOT=/opt/dbstudio_portal
NODE=$ROOT/.node/bin/node
KEK_PATH=${MASTER_KEY_PATH:-/var/lib/portal/master.key}
REMOTE=${BACKUP_RCLONE_REMOTE:-hetzner-portal:portal/}
TS=$(date -u +%Y%m%dT%H%M%SZ)
WORKDIR=$(mktemp -d /tmp/portal-drill-XXXXXX)
SCRATCH_DB=portal_drill_$TS

cleanup() {
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$SCRATCH_DB'" 2>/dev/null | grep -q 1; then
    echo "[cleanup] dropping $SCRATCH_DB"
    sudo -u postgres dropdb --if-exists "$SCRATCH_DB" || true
  fi
  if [[ -d "$WORKDIR" ]]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

if [[ $EUID -ne 0 ]]; then
  echo "this script needs sudo (creates a scratch DB, reads the production KEK)" >&2
  exit 1
fi

for bin in age rclone pg_restore; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "FAIL: $bin not in PATH" >&2; exit 2
  fi
done
if [[ ! -r "$KEK_PATH" ]]; then
  echo "FAIL: KEK at $KEK_PATH unreadable (this script must run as root or portal-app)" >&2; exit 2
fi

echo "== Restore drill: $TS =="
echo "[1/8] listing backup runs at $REMOTE"
mapfile -t RUNS < <(sudo -u portal-app rclone lsf --dirs-only "$REMOTE" | sed 's|/$||' | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort)
if [[ ${#RUNS[@]} -eq 0 ]]; then
  echo "FAIL: no backup runs found under $REMOTE" >&2; exit 3
fi
echo "       found ${#RUNS[@]} runs (oldest=${RUNS[0]} newest=${RUNS[-1]})"

PICK_IDX=$(( RANDOM % ${#RUNS[@]} ))
PICK=${RUNS[$PICK_IDX]}
echo "[2/8] picked run: $PICK (index $PICK_IDX)"

echo "[3/8] pulling encrypted artefacts to $WORKDIR"
sudo -u portal-app rclone copy "$REMOTE$PICK/" "$WORKDIR/" --include 'db-*.dump.age' --include 'storage-*.tar.age'
DB_AGE=$(find "$WORKDIR" -maxdepth 1 -name 'db-*.dump.age' | head -1)
ST_AGE=$(find "$WORKDIR" -maxdepth 1 -name 'storage-*.tar.age' | head -1)
if [[ -z "$DB_AGE" || -z "$ST_AGE" ]]; then
  echo "FAIL: rclone did not return both expected artefacts" >&2; exit 3
fi
chown root:root "$DB_AGE" "$ST_AGE"

echo "[4/8] enter the path to the offline age private key (input hidden):"
read -r -s AGE_KEY_PATH
echo
if [[ ! -r "$AGE_KEY_PATH" ]]; then
  echo "FAIL: age private key unreadable at the supplied path" >&2; exit 3
fi

DB_DUMP=$WORKDIR/db.dump
ST_TAR=$WORKDIR/storage.tar
echo "[5/8] decrypting db dump"
age --decrypt -i "$AGE_KEY_PATH" -o "$DB_DUMP" "$DB_AGE"
echo "       db dump head: $(head -c 5 "$DB_DUMP")"
if [[ "$(head -c 5 "$DB_DUMP")" != "PGDMP" ]]; then
  echo "FAIL: decrypted file is not a pg_dump custom-format archive" >&2; exit 3
fi
# Storage tarball decrypted but not extracted — its purpose in v1 is
# proving the cipher round-trips; not part of the credential decrypt path.
age --decrypt -i "$AGE_KEY_PATH" -o "$ST_TAR" "$ST_AGE"

echo "[6/8] creating scratch DB $SCRATCH_DB and pg_restoring"
sudo -u postgres createdb -O portal_user "$SCRATCH_DB"
SCRATCH_DSN="postgres:///$SCRATCH_DB"
# pg_restore as postgres because the dump may contain owner DDL that needs
# superuser; portal_user inside the scratch DB owns the resulting tables.
sudo -u postgres pg_restore --no-owner --role=portal_user --dbname="$SCRATCH_DSN" "$DB_DUMP" >/dev/null

echo "[7/8] unwrapping one customer DEK + decrypting one credential"
SCRATCH_DSN_PORTAL="postgres://$(grep -oP '(?<=postgres://)[^@]+(?=@)' /opt/dbstudio_portal/.env | head -1)@127.0.0.1:5432/$SCRATCH_DB"
sudo -u portal-app env \
  KEK_PATH="$KEK_PATH" \
  SCRATCH_DSN="$SCRATCH_DSN_PORTAL" \
  PATH="$ROOT/.node/bin:/usr/bin:/bin" \
  $NODE --input-type=module -e '
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { unwrapDek, decrypt } from "/opt/dbstudio_portal/lib/crypto/envelope.js";

const kek = readFileSync(process.env.KEK_PATH);
const pool = new Pool({ connectionString: process.env.SCRATCH_DSN });
try {
  const cust = await pool.query(`
    SELECT c.id, c.razon_social, c.dek_ciphertext, c.dek_iv, c.dek_tag
    FROM customers c
    JOIN credentials cr ON cr.customer_id = c.id
    GROUP BY c.id LIMIT 1`);
  if (cust.rowCount === 0) { console.log("OK: scratch DB restored cleanly (no customers with credentials present — nothing to decrypt)"); process.exit(0); }
  const c = cust.rows[0];
  const dek = unwrapDek({ ciphertext: c.dek_ciphertext, iv: c.dek_iv, tag: c.dek_tag }, kek);
  const cr = await pool.query(`
    SELECT id, payload_ciphertext, payload_iv, payload_tag
    FROM credentials WHERE customer_id = $1 LIMIT 1`, [c.id]);
  const r = cr.rows[0];
  const plaintext = decrypt({ ciphertext: r.payload_ciphertext, iv: r.payload_iv, tag: r.payload_tag }, dek);
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0) throw new Error("decrypted plaintext empty");
  console.log(`OK: 1 customer (${c.razon_social}) + 1 credential decrypted cleanly (plaintext bytes=${plaintext.length})`);
} finally {
  await pool.end();
}
'

echo "[8/8] drill complete"
echo "Document this drill outcome in /opt/dbstudio_portal/RUNBOOK.md § \"Backup restore drill\""
