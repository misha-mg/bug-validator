#!/bin/sh
#
# Print this tool's version, counted from the repository's commits, oldest first, as the tools
# of the CGS tools repository count theirs: a breaking one (`type!:`) bumps the major, a `feat`
# the minor, any other the patch. Nothing is tagged or written back; it needs the full history.
# The service reads it at start for the console's footer (server/version.ts).

set -eu

cd "$(dirname "$0")/.."

if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  echo "version.sh: the clone is shallow, so too few commits would be counted" >&2
  exit 1
fi
git log --reverse --format=%s -- . | awk '
  /^[a-z]+(\([^)]*\))?!:/ { major++; minor = 0; patch = 0; next }
  /^feat(\([^)]*\))?:/ { minor++; patch = 0; next }
  { patch++ }
  END { printf "%d.%d.%d\n", major, minor, patch }'
