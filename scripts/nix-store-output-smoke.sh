#!/usr/bin/env bash
set -euo pipefail

store_output=$(nix build .#ppa --no-link --print-out-paths)
for command in "opa status" "ppa status" "opa --help" "ppa --help"; do
  "$store_output/bin/${command%% *}" ${command#* } >/dev/null
done

test -f "$store_output/share/pa-platform/packages/pi-pa/package.json"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/index.js"
test -f "$store_output/share/pa-platform/packages/runtime-host/dist/index.js"
test -f "$store_output/share/fish/vendor_completions.d/ppa.fish"
! grep -R -E '(sk-[A-Za-z0-9]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,})' "$store_output/share/pa-platform/packages/pi-pa" "$store_output/share/pa-platform/packages/runtime-host"

printf '%s\n' "$store_output"
