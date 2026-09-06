#!/usr/bin/env bash
set -euo pipefail

flake_ref='.?submodules=1'
host_system=$(nix eval --raw --impure --expr builtins.currentSystem)
x86_drv=$(nix eval --raw "$flake_ref#packages.x86_64-linux.ppa.drvPath")
aarch64_drv=$(nix eval --raw "$flake_ref#packages.aarch64-linux.ppa.drvPath")
if [[ "$host_system" != "aarch64-linux" ]]; then
  nix build "$flake_ref#packages.aarch64-linux.ppa" --dry-run --no-link >/dev/null 2>&1
fi

store_output=$(nix build "$flake_ref#ppa" --no-link --print-out-paths)
for command in "opa status" "ppa status" "opa --help" "ppa --help"; do
  "$store_output/bin/${command%% *}" ${command#* } >/dev/null
done

test -f "$store_output/share/pa-platform/packages/pi-pa/package.json"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/index.js"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-host-smoke.js"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/vendor/proper-base.js"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/vendor/pi-vimmode.js"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/vendor/provenance.json"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/vendor/licenses/proper-base-LICENSE.txt"
test -f "$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/vendor/licenses/pi-vimmode-LICENSE.txt"
test -f "$store_output/share/pa-platform/packages/pi-pa/THIRD_PARTY_NOTICES.md"
PROVENANCE_PATH="$store_output/share/pa-platform/packages/pi-pa/dist/pi-extension/vendor/provenance.json" \
  "$store_output/bin/pa-platform-node" --input-type=module --eval '
    const { readFileSync } = await import("node:fs");
    const provenance = JSON.parse(readFileSync(process.env.PROVENANCE_PATH, "utf8"));
    const expected = [
      ["proper-base", "0.5.0", "859feb321ec81d773beea379d28e21d0b7d0c8c0", "MIT", "licenses/proper-base-LICENSE.txt"],
      ["pi-vimmode", "0.9.0", "52bd6ac5e905157ac46ec15c120b7d0cc61a62df", "MIT", "licenses/pi-vimmode-LICENSE.txt"],
    ];
    const actual = provenance.sources.map(({ name, version, commit, license, packagedLicense }) => [name, version, commit, license, packagedLicense]);
    if (provenance.sources.length !== 2 || JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
  '
(
  cd "$store_output/share/pa-platform/packages/pi-pa"
  "$store_output/bin/pa-platform-node" --input-type=module --eval '
    import sharp from "sharp";
    const [vim, proper] = await Promise.all([import("#pi-pa-vimmode"), import("#pi-pa-proper-base")]);
    if (typeof vim.default !== "function" || typeof proper.default !== "function") process.exit(1);
    if (sharp.versions.sharp !== "0.35.3") process.exit(1);
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#00000000" } }).png().toBuffer();
    if (png.byteLength === 0 || process.platform !== "linux") process.exit(1);
  '
)
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
TOOL_SMOKE="$tool_smoke" "$store_output/bin/pa-platform-node" --input-type=module --eval '
  const evidence = JSON.parse(process.env.TOOL_SMOKE);
  const extension = evidence.extension;
  if (JSON.stringify(extension.factories) !== JSON.stringify(["pi-vimmode@0.9.0", "proper-base@0.5.0"])) process.exit(1);
  for (const command of ["vimmode", "clear", "pa-context", "pa-git-context"]) if (!extension.commands.includes(command)) process.exit(1);
  for (const shortcut of ["alt+i", "alt+g"]) if (!extension.shortcuts.includes(shortcut)) process.exit(1);
  for (const handler of ["tool_call", "agent_end", "session_shutdown"]) if (!extension.handlers.includes(handler)) process.exit(1);
  if (extension.guards.destructiveCommand !== "passed" || extension.guards.sensitivePath !== "passed") process.exit(1);
  if (extension.outputBounds.maxBytes !== 50 * 1024 || extension.outputBounds.maxLines !== 2000 || extension.outputBounds.status !== "passed") process.exit(1);
'

"$store_output/bin/pa-platform-node" ./scripts/pap-156-caller-boundary-smoke.mjs "$store_output"

printf 'nix-smoke host=%s store=%s x86_64-drv=%s aarch64-drv=%s\n' "$host_system" "$store_output" "$x86_drv" "$aarch64_drv" >&2
printf '%s\n' "$store_output"
