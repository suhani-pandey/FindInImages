#!/usr/bin/env bash
# Compile the report to PDF with Tectonic.
# Usage: ./build.sh            (build once)
#        ./build.sh --watch    (rebuild on save)
set -euo pipefail
cd "$(dirname "$0")"

# Find tectonic: prefer one on PATH, fall back to the local install.
if command -v tectonic >/dev/null 2>&1; then
  TECTONIC="tectonic"
elif [ -x "$HOME/.local/bin/tectonic" ]; then
  TECTONIC="$HOME/.local/bin/tectonic"
else
  echo "error: tectonic not found. Install it from https://tectonic-typesetting.github.io/" >&2
  exit 1
fi

if [ "${1:-}" = "--watch" ]; then
  exec "$TECTONIC" -X watch
fi

# -X compile runs the full loop (incl. biber for the bibliography).
"$TECTONIC" -X compile main.tex --keep-logs
echo "✓ Built main.pdf"
