#!/usr/bin/env sh
# Bundles the TypeScript test with bb's esbuild toolchain and runs it on node.
set -e
cd "$(dirname "$0")/.."
ES="$(ls -d "${BB_DATA_DIR:-$HOME/.bb}"/plugins/toolchain-*/node_modules/@esbuild/*/bin/esbuild | head -1)"
out="$(mktemp -d)"
"$ES" test/jobs-core.test.ts --bundle --platform=node --format=esm --packages=external --outfile="$out/jobs-core.test.mjs" --log-level=warning
node --test "$out/jobs-core.test.mjs"
