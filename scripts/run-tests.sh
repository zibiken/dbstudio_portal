#!/usr/bin/env bash
# Wraps vitest with the operational dance the live portal.service needs.
#
# Why:
#   The outbox worker inside portal.service polls email_outbox every 5s.
#   When integration tests insert rows during a test run, the live worker
#   races them — claims the rows (sometimes before the test's own tickOnce),
#   tries to send via MailerSend, burns API credits, and corrupts the test
#   assertion. Stopping the service for the duration of the run avoids the
#   race deterministically.
#
# Usage:
#   sudo bash /opt/dbstudio_portal/scripts/run-tests.sh [vitest args]
#
# Examples:
#   sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
#   sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/admins/

set -euo pipefail
ROOT=/opt/dbstudio_portal
NODE=$ROOT/.node/bin/node
NPX=$ROOT/.node/bin/npx
VITEST=$ROOT/node_modules/.bin/vitest

if [[ $EUID -ne 0 ]]; then
  echo "this script needs sudo (it stops/starts portal.service)" >&2
  exit 1
fi

WAS_ACTIVE=$(systemctl is-active portal.service || true)

cleanup() {
  if [[ "$WAS_ACTIVE" == "active" ]]; then
    systemctl start portal.service
    sleep 2
    bash "$ROOT/scripts/smoke.sh" || true
  fi
}
trap cleanup EXIT

if [[ "$WAS_ACTIVE" == "active" ]]; then
  echo "[run-tests] stopping portal.service for the duration of the run"
  systemctl stop portal.service
fi

# Load .env into the environment vitest workers will inherit. We disable
# errexit around the source because .env can carry an unquoted value with
# a space (e.g. MAILERSEND_FROM_NAME=DB Studio Portal); bash interprets the
# tail as a command and emits "Studio: command not found" — non-fatal, and
# the values vitest actually needs (DATABASE_URL, PORTAL_BASE_URL, etc.)
# do parse cleanly.
set +e
set -a
# shellcheck disable=SC1091
. "$ROOT/.env" 2>/dev/null || true
set +a
set -e

cd "$ROOT"
sudo -u portal-app -E env \
  PATH="$ROOT/.node/bin:/usr/bin:/bin" \
  RUN_DB_TESTS=1 \
  "$VITEST" run "$@"

# Phase F: advisory layout-pattern check (non-blocking, exit code 0).
sudo -u portal-app -E env PATH="$ROOT/.node/bin:/usr/bin:/bin" \
  "$NODE" "$ROOT/scripts/check-detail-pattern.js" || true

# a11y check — blocking as of Phase B4. Static checks always run; the
# axe-core JSDOM pass on public routes runs when RUN_A11Y_AXE=1 +
# RUN_A11Y_AXE_BLOCKING=1. Static failure or axe failure ⇒ non-zero exit
# from a11y-check.js and the wrapper aborts. Set A11Y_STATIC_ADVISORY=1
# to fall back to advisory mode if a regression needs to merge first.
sudo -u portal-app -E env \
  PATH="$ROOT/.node/bin:/usr/bin:/bin" \
  RUN_A11Y_AXE=1 \
  RUN_A11Y_AXE_BLOCKING=1 \
  "$NODE" "$ROOT/scripts/a11y-check.js"
