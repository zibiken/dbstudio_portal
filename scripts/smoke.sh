#!/usr/bin/env bash
# Post-deploy smoke. Returns nonzero if anything is wrong.
# Run as: sudo bash scripts/smoke.sh
set -euo pipefail

PORT=${PORT:-3400}
ROOT=/opt/dbstudio_portal
NODE=$ROOT/.node/bin/node
fail=0

echo -n "[1/9] portal.service active: "
if systemctl is-active --quiet portal.service; then echo OK; else echo FAIL; fail=1; fi

echo -n "[2/9] portal-pdf.service active: "
if systemctl is-active --quiet portal-pdf.service; then echo OK; else echo FAIL; fail=1; fi

echo -n "[3/9] /health 200 with ok:true: "
if curl -sS -m 5 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then echo OK; else echo FAIL; fail=1; fi

echo -n "[4/9] portal-pdf socket mode 0660 portal-pdf:portal-app: "
mode_owner=$(stat -c '%a %U:%G' /run/portal-pdf/portal.sock 2>/dev/null || echo "missing")
if [[ "$mode_owner" == "660 portal-pdf:portal-app" ]]; then echo "OK ($mode_owner)"; else echo "FAIL ($mode_owner)"; fail=1; fi

echo -n "[5/9] safety-check passes: "
# Load .env into the sudo-as-portal-app environment using systemd-run (handles values with spaces).
if sudo systemd-run --quiet --pipe --wait --uid=portal-app --gid=portal-app \
    --property="EnvironmentFile=$ROOT/.env" \
    $NODE $ROOT/scripts/safety-check.js >/dev/null 2>&1; then echo OK; else echo FAIL; fail=1; fi

# ---- M10 additions ------------------------------------------------------

echo -n "[6/9] MailerSend API reachable: "
# HEAD against the v1 send endpoint. Anything not a DNS/conn fail counts —
# 401 (no auth header) / 405 (HEAD not allowed) / 404 (endpoint shape) are
# all "we got a response from the API". Curl exits 0 on any HTTP response.
if curl -sS -m 8 -I -o /dev/null -w '%{http_code}' https://api.mailersend.com/v1/email | grep -qE '^[0-9]{3}$'; then echo OK; else echo FAIL; fail=1; fi

echo -n "[7/9] file-URL signing round-trip: "
# Sign a synthetic fileId and verify it in the same process. Catches drift
# between sign() / verify() and a missing/short FILE_URL_SIGNING_SECRET.
if sudo systemd-run --quiet --pipe --wait --uid=portal-app --gid=portal-app \
    --working-directory="$ROOT" \
    --property="EnvironmentFile=$ROOT/.env" \
    $NODE --input-type=module -e '
      import { signFileUrl, verifyFileUrl } from "/opt/dbstudio_portal/lib/crypto/tokens.js";
      const s = process.env.FILE_URL_SIGNING_SECRET;
      const t = signFileUrl({ fileId: "smoke-" + Date.now() }, s);
      const r = verifyFileUrl(t, s);
      if (!r.fileId.startsWith("smoke-")) { console.error("verify returned wrong fileId"); process.exit(1); }
    ' >/dev/null 2>&1; then echo OK; else echo FAIL; fail=1; fi

echo -n "[8/9] portal-pdf hello probe: "
# Render <h1>hi</h1> through the IPC socket and assert non-empty PDF output.
# Uses pdf-client.js the same way routes do.
if sudo systemd-run --quiet --pipe --wait --uid=portal-app --gid=portal-app \
    --working-directory="$ROOT" \
    --property="EnvironmentFile=$ROOT/.env" \
    $NODE --input-type=module -e '
      import { renderPdf } from "/opt/dbstudio_portal/lib/pdf-client.js";
      const r = await renderPdf({
        socketPath: process.env.PDF_SERVICE_SOCKET,
        html: "<!doctype html><html><body><h1>hi</h1></body></html>",
        timeoutMs: 30_000
      });
      if (!r.ok) { console.error("pdf !ok:", r.error, r.message); process.exit(1); }
      if (!r.pdf || r.pdf.length < 256) { console.error("pdf too small:", r.pdf?.length); process.exit(1); }
      if (r.pdf.subarray(0, 4).toString("utf8") !== "%PDF") { console.error("not a PDF"); process.exit(1); }
    ' >/dev/null 2>&1; then echo OK; else echo FAIL; fail=1; fi

echo -n "[9/9] migration ledger up-to-date: "
# Compare count of migration files with rows in _migrations. Any drift means
# a deploy landed without running `runMigrations` — guarantees we don't ship
# an admin UI that references columns that don't exist.
if sudo systemd-run --quiet --pipe --wait --uid=portal-app --gid=portal-app \
    --working-directory="$ROOT" \
    --property="EnvironmentFile=$ROOT/.env" \
    $NODE --input-type=module -e '
      import { readdirSync } from "node:fs";
      import { sql } from "kysely";
      import { createDb } from "/opt/dbstudio_portal/config/db.js";
      const files = readdirSync("/opt/dbstudio_portal/migrations").filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
      const db = createDb({ connectionString: process.env.DATABASE_URL });
      try {
        const r = await sql`SELECT name FROM _migrations ORDER BY name`.execute(db);
        const applied = r.rows.map(x => x.name).sort();
        const missing = files.filter(f => !applied.includes(f));
        const extra   = applied.filter(a => !files.includes(a));
        if (missing.length || extra.length) {
          console.error("missing:", missing, "extra:", extra);
          process.exit(1);
        }
      } finally { await db.destroy(); }
    ' >/dev/null 2>&1; then echo OK; else echo FAIL; fail=1; fi

# ---- M11 additions ------------------------------------------------------

# Probe 10 — TOTP enrol page renders QR (gated). Default OFF so production
# smoke runs (1-9) don't generate throwaway tokens against the live DB.
# To exercise: mint a one-shot welcome token, then run:
#   sudo RUN_M11_SMOKE=1 M11_SMOKE_WELCOME_TOKEN=<token> bash scripts/smoke.sh
if [[ "${RUN_M11_SMOKE:-}" == "1" ]]; then
  echo -n "[10/10] TOTP enrol page renders inline SVG QR: "
  TOKEN="${M11_SMOKE_WELCOME_TOKEN:-}"
  if [[ -z "$TOKEN" ]]; then
    echo "FAIL (RUN_M11_SMOKE=1 but M11_SMOKE_WELCOME_TOKEN is empty — set it to a seeded admin or customer welcome token)"
    fail=1
  else
    BODY=$(curl -sS -m 5 "http://127.0.0.1:$PORT/welcome/$TOKEN" || true)
    if echo "$BODY" | grep -q '<svg[^>]*role="img"[^>]*aria-label="[^"]*TOTP'; then
      echo OK
    else
      echo FAIL
      fail=1
    fi
  fi
else
  echo "[10/10] TOTP enrol QR (skipped: set RUN_M11_SMOKE=1 + M11_SMOKE_WELCOME_TOKEN to exercise)"
fi

if [[ $fail -eq 0 ]]; then echo "SMOKE: OK"; else echo "SMOKE: FAILED"; fi
exit $fail
