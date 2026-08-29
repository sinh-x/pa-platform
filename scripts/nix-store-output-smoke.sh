#!/usr/bin/env bash
set -euo pipefail

store_output=$(nix build .#ppa --no-link --print-out-paths)
for command in "opa status" "ppa status" "opa --help" "ppa --help"; do
  "$store_output/bin/${command%% *}" ${command#* } >/dev/null
done

test -f "$store_output/share/pa-platform/packages/pi-pa/package.json"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/index.js"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-host-smoke.js"
test -f "$store_output/share/pa-platform/native-addons/node-22/better_sqlite3.node"
test -f "$store_output/share/pa-platform/native-addons/pi-node-24/better_sqlite3.node"
test -f "$store_output/share/pa-platform/packages/runtime-host/dist/index.js"
test -f "$store_output/share/fish/vendor_completions.d/ppa.fish"
! grep -R -E '(sk-[A-Za-z0-9]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,})' "$store_output/share/pa-platform/packages/pi-pa" "$store_output/share/pa-platform/packages/runtime-host"

smoke_root=$(mktemp -d)
trap 'rm -rf "$smoke_root"' EXIT
PA_REGISTRY_DB="$smoke_root/node22-registry.db" \
  "$store_output/bin/pa-platform-node" --input-type=module --eval \
  "const core = await import('$store_output/share/pa-platform/packages/pa-core/dist/index.js'); core.queryDeploymentStatuses();" >/dev/null

preflight=$($store_output/bin/ppa pi preflight)
tool_smoke=$($store_output/bin/ppa pi smoke-tools)
grep -q '"modules":"137"' <<<"$preflight"
for tool in read bash question todo pa_ticket pa_bulletin pa_registry pa_status; do
  grep -q "\"name\":\"$tool\",\"status\":\"passed\"" <<<"$tool_smoke"
done

printf '%s\n' "$store_output"
