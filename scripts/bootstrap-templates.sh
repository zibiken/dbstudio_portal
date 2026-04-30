#!/usr/bin/env bash
# Bootstrap portal templates. Run as root on the server (or via the test
# harness with overrides). Idempotent — re-running is safe.
#
# Copies templates/nda.html (canonical, kept verbatim from legal counsel)
# into $TEMPLATES_DIR and rewrites its <head> so the rendered HTML can
# reach Chromium running inside `portal-pdf.service`, which has zero
# network egress (RestrictAddressFamilies=AF_UNIX). Specifically:
#
#   - removes <link rel="preconnect" ...> tags pointing at fonts.googleapis.com
#     and fonts.gstatic.com
#   - replaces the @import url(...Cormorant+Garamond...) with a local
#     @font-face block referencing $FONTS_DIR/cormorant-garamond-500.woff2
#
# The font file itself is operator-supplied: place a Cormorant Garamond
# 500 weight woff2 at $FONTS_DIR/cormorant-garamond-500.woff2 before
# running this script. Cormorant Garamond is OFL-licensed so it is
# redistributable; the operator typically downloads it once from
# Google Fonts on a workstation and `scp`s it to the box.
#
# Environment overrides (defaults match the production box):
#   REPO_DIR       — repo root (default /opt/dbstudio_portal)
#   TEMPLATES_DIR  — destination dir (default /var/lib/portal/templates)
#   FONTS_DIR      — font dir (default /var/lib/portal/fonts)
#   APP_USER       — owner of the destination file (default portal-app)
#   APP_GROUP      — owning group (default portal-app)
#   SKIP_FONT_CHECK — set to "1" to skip the font-existence check
#                    (the test harness uses this; production should not)
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/dbstudio_portal}"
TEMPLATES_DIR="${TEMPLATES_DIR:-/var/lib/portal/templates}"
FONTS_DIR="${FONTS_DIR:-/var/lib/portal/fonts}"
APP_USER="${APP_USER:-portal-app}"
APP_GROUP="${APP_GROUP:-portal-app}"
SKIP_FONT_CHECK="${SKIP_FONT_CHECK:-0}"

SRC="$REPO_DIR/templates/nda.html"
DST="$TEMPLATES_DIR/nda.html"
FONT="$FONTS_DIR/cormorant-garamond-500.woff2"

[[ -f "$SRC" ]] || { echo "missing source template: $SRC" >&2; exit 1; }
[[ -d "$TEMPLATES_DIR" ]] || { echo "missing templates dir: $TEMPLATES_DIR" >&2; exit 1; }

if [[ "$SKIP_FONT_CHECK" != "1" ]]; then
  if [[ ! -f "$FONT" ]]; then
    cat >&2 <<EOF
missing font file: $FONT

Place a Cormorant Garamond 500-weight woff2 at that path before running
this script. The font is OFL-licensed; download once from Google Fonts on
your workstation and copy it across, e.g.:

  scp ~/Downloads/CormorantGaramond-Medium.woff2 \\
      portal:$FONT
  ssh portal "sudo chown $APP_USER:$APP_GROUP $FONT && sudo chmod 0640 $FONT"
EOF
    exit 1
  fi
fi

# Render to a tempfile so a partial write never replaces the live template.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# `perl -0777` reads via $ENV{...}, which only sees exported variables.
export FONT

# Build a Perl one-liner: it streams the file once, drops the two
# preconnect <link> tags exactly (matched anywhere on a line so we don't
# care about line-ending nuances), and swaps the @import url() block for
# a local @font-face. The original placeholders {{...}} are preserved
# verbatim — Mustache renders them at request time.
perl -0777 -pe '
  s{<link rel="preconnect" href="https://fonts\.googleapis\.com"[^>]*>\s*}{}g;
  s{<link rel="preconnect" href="https://fonts\.gstatic\.com"[^>]*>\s*}{}g;
  s{\@import\s+url\([^)]*Cormorant\+Garamond[^)]*\);}{
    "\@font-face {\n" .
    "  font-family: '\''Cormorant Garamond'\'';\n" .
    "  font-style: normal;\n" .
    "  font-weight: 500;\n" .
    "  font-display: swap;\n" .
    "  src: url('\''file://" . $ENV{FONT} . "'\'') format('\''woff2'\'');\n" .
    "}"
  }gxe;
' "$SRC" > "$TMP"

# Belt-and-braces: refuse to install if any rewrite leaked a remote
# fetch through. Catches future @import rules in the same template.
if grep -qE '@import\s+url\([^)]*https?://' "$TMP"; then
  echo "rewrite failed: still contains remote @import" >&2
  exit 2
fi
if grep -q 'fonts\.googleapis\.com\|fonts\.gstatic\.com' "$TMP"; then
  echo "rewrite failed: still contains a Google Fonts host reference" >&2
  exit 2
fi
if ! grep -q '@font-face' "$TMP"; then
  echo "rewrite failed: did not insert @font-face block" >&2
  exit 2
fi

install -m 0640 -o "$APP_USER" -g "$APP_GROUP" "$TMP" "$DST"
echo "[ok] wrote $DST (mode 0640, owned $APP_USER:$APP_GROUP)"
