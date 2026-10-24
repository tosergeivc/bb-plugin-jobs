#!/usr/bin/env sh
# Bundles the TypeScript test with esbuild and runs it on node.
# Uses the esbuild from node_modules (npm install), else bb's toolchain copy.
set -e
cd "$(dirname "$0")/.."
ES=node_modules/.bin/esbuild
[ -x "$ES" ] || ES="$(ls -d "${BB_DATA_DIR:-$HOME/.bb}"/plugins/toolchain-*/node_modules/@esbuild/*/bin/esbuild | head -1)"
out="$(mktemp -d)"
"$ES" test/jobs-core.test.ts --bundle --platform=node --format=esm --packages=external --outfile="$out/jobs-core.test.mjs" --log-level=warning
node --test "$out/jobs-core.test.mjs"
