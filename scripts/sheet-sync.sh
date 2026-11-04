#!/usr/bin/env bash
# Copies the drafting sheet from pipeline-ui, its source of truth, into ui/: sheet.css, theme.js
# and the Barlow faces with their licence. pipeline-ui is ../pipeline-ui next to this repository
# unless PIPELINE_UI_DIR says where it is. server/http/sheet.test.ts fails when the copy falls
# behind; an edit to the sheet is made there, never here.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source="${PIPELINE_UI_DIR:-$root/../pipeline-ui}"
if [[ ! -f "$source/ui/src/sheet.css" ]]; then
  echo "No sheet at $source/ui/src/sheet.css: set PIPELINE_UI_DIR to the pipeline-ui checkout." >&2
  exit 1
fi

cp "$source/ui/src/sheet.css" "$root/ui/sheet.css"
cp "$source/ui/public/theme.js" "$root/ui/theme.js"
mkdir -p "$root/ui/fonts"
rm -f "$root/ui/fonts/"*.woff2
cp "$source/ui/public/fonts/"*.woff2 "$source/ui/public/fonts/OFL.txt" "$root/ui/fonts/"
echo "ui/sheet.css, ui/theme.js and ui/fonts/ now match $source"
