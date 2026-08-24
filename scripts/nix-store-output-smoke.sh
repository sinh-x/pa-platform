#!/usr/bin/env bash
set -euo pipefail

store_output=$(nix build .#ppa --no-link --print-out-paths)
for command in "opa status" "ppa status" "opa --help" "ppa --help"; do
  "$store_output/bin/${command%% *}" ${command#* } >/dev/null
done

printf '%s\n' "$store_output"
