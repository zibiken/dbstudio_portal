#!/usr/bin/env bash
# Post-deploy smoke. Returns nonzero if anything is wrong.
# Run as: sudo bash scripts/smoke.sh
set -euo pipefail

PORT=${PORT:-3400}
fail=0

echo -n "[1/5] portal.service active: "
if systemctl is-active --quiet portal.service; then echo OK; else echo FAIL; fail=1; fi

echo -n "[2/5] portal-pdf.service active: "
if systemctl is-active --quiet portal-pdf.service; then echo OK; else echo FAIL; fail=1; fi

echo -n "[3/5] /health 200 with ok:true: "
if curl -sS -m 5 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then echo OK; else echo FAIL; fail=1; fi

echo -n "[4/5] portal-pdf socket mode 0660 portal-pdf:portal-app: "
mode_owner=$(stat -c '%a %U:%G' /run/portal-pdf/portal.sock 2>/dev/null || echo "missing")
if [[ "$mode_owner" == "660 portal-pdf:portal-app" ]]; then echo "OK ($mode_owner)"; else echo "FAIL ($mode_owner)"; fail=1; fi

echo -n "[5/5] safety-check passes: "
# Load .env into the sudo-as-portal-app environment using systemd-run (handles values with spaces).
if sudo systemd-run --quiet --pipe --wait --uid=portal-app --gid=portal-app \
    --property="EnvironmentFile=/opt/dbstudio_portal/.env" \
    /opt/dbstudio_portal/.node/bin/node /opt/dbstudio_portal/scripts/safety-check.js >/dev/null 2>&1; then echo OK; else echo FAIL; fail=1; fi

if [[ $fail -eq 0 ]]; then echo "SMOKE: OK"; else echo "SMOKE: FAILED"; fi
exit $fail
