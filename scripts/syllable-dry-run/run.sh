#!/usr/bin/env bash
# PROP-8 dry run, TS half (idtap-contract 0.3.0, rollout step 3).
#
#   pnpm dryRunSyllables <dir-of-piece-json> [--report out.json] [--max-examples N]
#
# Compares, for every stored piece in <dir>:
#   A = BASE_REF's model (default origin/main): load -> save
#   B = this checkout's model:                  load -> heal -> save (dual-write)
# Gate: B's legacy fields equal A's byte-for-byte on every piece. Exit 0 = pass.
# Runs locally under node on a dump. Never run it against the production server.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
BASE_REF="${BASE_REF:-origin/main}"
WORK="$ROOT/node_modules/.cache/syllable-dry-run"   # under node_modules so imports resolve
HERE="$ROOT/scripts/syllable-dry-run"
ESBUILD="$ROOT/node_modules/.bin/esbuild"

rm -rf "$WORK" && mkdir -p "$WORK/base"
git -C "$ROOT" archive "$BASE_REF" src shared | tar -x -C "$WORK/base"
cp "$HERE/side.ts" "$WORK/base/side.ts"

bundle() { # <src root> <entry> <out>
  "$ESBUILD" "$2" --bundle --platform=node --format=cjs --log-level=warning \
    --alias:@shared="$1/shared" --alias:@="$1/src" --alias:@model="$1/src/ts/model/index.ts" \
    --outfile="$3"
}
bundle "$WORK/base" "$WORK/base/side.ts" "$WORK/a.cjs"
bundle "$ROOT" "$HERE/side.ts" "$WORK/b.cjs"
bundle "$ROOT" "$HERE/driver.ts" "$WORK/driver.cjs"

echo "A = $BASE_REF ($(git -C "$ROOT" rev-parse --short "$BASE_REF")), B = working tree ($(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet || echo '+dirty'))"
node "$WORK/driver.cjs" --a "$WORK/a.cjs" --b "$WORK/b.cjs" "$@"
