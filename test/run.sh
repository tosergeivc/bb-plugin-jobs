#!/usr/bin/env sh
# Bundles each TypeScript test with esbuild and runs them on node.
# Uses the esbuild from node_modules (npm install), else bb's toolchain copy.
set -e
cd "$(dirname "$0")/.."
ES=node_modules/.bin/esbuild
[ -x "$ES" ] || ES="$(ls -d "${BB_DATA_DIR:-$HOME/.bb}"/plugins/toolchain-*/node_modules/@esbuild/*/bin/esbuild | head -1)"
out=.test-build
rm -rf "$out" && mkdir -p "$out"
for test in test/*.test.ts; do
  "$ES" "$test" --bundle --platform=node --format=esm --packages=external \
    --outfile="$out/$(basename "$test" .ts).mjs" --log-level=warning
done
node --test "$out"/*.mjs
