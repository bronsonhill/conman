#!/usr/bin/env bash
# Rebuild dist/ only when a source file is newer than the last build.
#
# This exists for the inner loop of `npm test`, which otherwise runs a full
# `tsc` on every invocation (~1 min). `npm run build` stays an unconditional
# build, and CI runs `npm run build` explicitly before the tests, so CI always
# gets a full compile. Nothing here changes what gets compiled, only whether.
set -euo pipefail
cd "$(dirname "$0")/.."

stamp="dist/.buildstamp"
inputs=(src tsconfig.json package.json)

needs_build() {
  [ -f "dist/cli.js" ] || return 0
  [ -f "$stamp" ] || return 0
  [ -n "$(find "${inputs[@]}" -newer "$stamp" -print -quit 2>/dev/null)" ] && return 0
  return 1
}

if needs_build; then
  echo "build-if-stale: inputs changed, running tsc"
  npm run build
else
  echo "build-if-stale: dist/ is current, skipping tsc"
fi

touch "$stamp"
