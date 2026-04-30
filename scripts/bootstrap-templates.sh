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
FONT_LATIN="$FONTS_DIR/cormorant-garamond-500.woff2"
FONT_LATIN_EXT="$FONTS_DIR/cormorant-garamond-500-latin-ext.woff2"

[[ -f "$SRC" ]] || { echo "missing source template: $SRC" >&2; exit 1; }
[[ -d "$TEMPLATES_DIR" ]] || { echo "missing templates dir: $TEMPLATES_DIR" >&2; exit 1; }

if [[ "$SKIP_FONT_CHECK" != "1" ]]; then
  missing=()
  [[ -f "$FONT_LATIN" ]] || missing+=("$FONT_LATIN")
  [[ -f "$FONT_LATIN_EXT" ]] || missing+=("$FONT_LATIN_EXT")
  if (( ${#missing[@]} > 0 )); then
    cat >&2 <<EOF
missing font file(s):
$(printf '  - %s\n' "${missing[@]}")

Cormorant Garamond is OFL-licensed and split into Latin + Latin-Extended
unicode-range subsets by Google Fonts. Fetch both on the server with:

  curl -sS -A "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0" \\
    "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500&display=swap"
  # → grep the woff2 URLs for /* latin */ and /* latin-ext */
  curl -o $FONT_LATIN     <latin woff2 URL>
  curl -o $FONT_LATIN_EXT <latin-ext woff2 URL>
  chown $APP_USER:$APP_GROUP "$FONT_LATIN" "$FONT_LATIN_EXT"
  chmod 0640 "$FONT_LATIN" "$FONT_LATIN_EXT"
EOF
    exit 1
  fi
fi

# Render to a tempfile so a partial write never replaces the live template.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# `perl -0777` reads via $ENV{...}, which only sees exported variables.
export FONT_LATIN FONT_LATIN_EXT

# Build a Perl one-liner: it streams the file once, drops the two
# preconnect <link> tags exactly (matched anywhere on a line so we don't
# care about line-ending nuances), and swaps the @import url() block for
# two local @font-face blocks (latin + latin-ext, mirroring how Google
# Fonts itself splits Cormorant Garamond by unicode-range — the Spanish
# legal text mostly lives in the basic-Latin range, but legal counsel
# might use any character in latin-ext too, so we cover both). The
# original {{PLACEHOLDERS}} are preserved verbatim; Mustache renders
# them at request time.
perl -0777 -pe '
  s{<link rel="preconnect" href="https://fonts\.googleapis\.com"[^>]*>\s*}{}g;
  s{<link rel="preconnect" href="https://fonts\.gstatic\.com"[^>]*>\s*}{}g;
  s{\@import\s+url\([^)]*Cormorant\+Garamond[^)]*\);}{
    join("\n",
      "\@font-face {",
      "  font-family: '\''Cormorant Garamond'\'';",
      "  font-style: normal;",
      "  font-weight: 500;",
      "  font-display: swap;",
      "  src: url('\''file://" . $ENV{FONT_LATIN_EXT} . "'\'') format('\''woff2'\'');",
      "  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;",
      "}",
      "\@font-face {",
      "  font-family: '\''Cormorant Garamond'\'';",
      "  font-style: normal;",
      "  font-weight: 500;",
      "  font-display: swap;",
      "  src: url('\''file://" . $ENV{FONT_LATIN} . "'\'') format('\''woff2'\'');",
      "  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;",
      "}",
    )
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
