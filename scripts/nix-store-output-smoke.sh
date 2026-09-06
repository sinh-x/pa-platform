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
test -f "$store_output/share/pa-platform/scripts/pap-167-pi-retry-smoke.mjs"
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
node22_addon="$store_output/share/pa-platform/native-addons/node-22/better_sqlite3.node"
pi_addon="$store_output/share/pa-platform/native-addons/pi-node-24/better_sqlite3.node"
node22_smoke=$(PA_REGISTRY_DB="$smoke_root/node22-registry.db" ADDON_PATH="$node22_addon" \
  "$store_output/bin/pa-platform-node" --input-type=module --eval \
  "const core = await import('$store_output/share/pa-platform/packages/pa-core/dist/index.js'); const native = core.verifyRegistryNativeAddon(process.env.ADDON_PATH); const statuses = core.queryDeploymentStatuses(); core.closeDb(); process.stdout.write(JSON.stringify({...native, registryQuery: 'queryDeploymentStatuses', queryRows: statuses.length, close: 'explicit'}));")

actual_pi=/home/sinh/.nix-profile/bin/pi
preflight=$(PAP167_REAL_PI="$actual_pi" "$store_output/bin/ppa" pi preflight)
tool_smoke=$(PAP167_REAL_PI="$actual_pi" "$store_output/bin/ppa" pi smoke-tools)
regression_evidence="$smoke_root/installed-pi-teardown-regression.json"
PAP167_REAL_PI="$actual_pi" "$store_output/bin/ppa" pi teardown-smoke \
  --regression --runs 20 --operations 250 --evidence "$regression_evidence" \
  >"$smoke_root/installed-pi-teardown-regression.stdout"
if [[ -n "${PAP176_INSTALLED_EVIDENCE:-}" ]]; then
  install -Dm600 "$regression_evidence" "$PAP176_INSTALLED_EVIDENCE"
fi

NODE22_SMOKE="$node22_smoke" PREFLIGHT="$preflight" TOOL_SMOKE="$tool_smoke" \
STORE_OUTPUT="$store_output" NODE22_ADDON="$node22_addon" PI_ADDON="$pi_addon" ACTUAL_PI="$actual_pi" \
REGRESSION_EVIDENCE="$regression_evidence" "$store_output/bin/pa-platform-node" --input-type=module --eval '
  const { readFileSync } = await import("node:fs");
  const node22 = JSON.parse(process.env.NODE22_SMOKE);
  const pi = JSON.parse(process.env.PREFLIGHT);
  const tools = JSON.parse(process.env.TOOL_SMOKE);
  const regression = JSON.parse(readFileSync(process.env.REGRESSION_EVIDENCE, "utf8"));
  const major = (version) => Number(/^v?(\d+)/.exec(version)?.[1]);
  const piVersion = (value) => {
    const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value);
    return match ? match.slice(1).map(Number) : undefined;
  };

  if (major(node22.node) !== 22 || !node22.modules || node22.addonPath !== process.env.NODE22_ADDON) process.exit(1);
  if (node22.registryQuery !== "queryDeploymentStatuses" || node22.close !== "explicit") process.exit(1);
  if (major(pi.node) !== 24 || !pi.modules || pi.addonPath !== process.env.PI_ADDON) process.exit(1);
  if (pi.registryQuery !== "PRAGMA user_version" || pi.close !== "explicit") process.exit(1);

  const expectedTools = ["read", "bash", "question", "todo", "pa_ticket", "pa_bulletin", "pa_registry", "pa_status"];
  if (JSON.stringify(tools.tools) !== JSON.stringify(expectedTools.map((name) => ({ name, status: "passed" })))) process.exit(1);
  if (tools.tools.filter(({ name }) => name === "todo").length !== 1) process.exit(1);
  const extension = tools.extension;
  if (JSON.stringify(extension.factories) !== JSON.stringify(["pi-vimmode@0.9.0", "proper-base@0.5.0"])) process.exit(1);
  for (const command of ["vimmode", "clear", "pa-context", "pa-git-context"]) if (!extension.commands.includes(command)) process.exit(1);
  for (const shortcut of ["alt+i", "alt+g"]) if (!extension.shortcuts.includes(shortcut)) process.exit(1);
  for (const handler of ["tool_call", "agent_end", "session_shutdown"]) if (!extension.handlers.includes(handler)) process.exit(1);
  if (extension.guards.destructiveCommand !== "passed" || extension.guards.sensitivePath !== "passed") process.exit(1);
  if (extension.outputBounds.maxBytes !== 50 * 1024 || extension.outputBounds.maxLines !== 2000 || extension.outputBounds.status !== "passed") process.exit(1);
  if (JSON.stringify(extension.todo) !== JSON.stringify({ registrations: 1, add: "passed", list: "passed", activeBranchRestore: "passed" })) process.exit(1);

  const observedPiVersion = piVersion(regression.piVersion);
  if (!observedPiVersion || observedPiVersion[0] < 1 && (observedPiVersion[1] < 84 || observedPiVersion[1] === 84 && observedPiVersion[2] < 4)) process.exit(1);
  if (regression.mode !== "regression" || regression.storeOutput !== process.env.STORE_OUTPUT) process.exit(1);
  if (regression.ppa !== `${process.env.STORE_OUTPUT}/bin/ppa` || regression.invokedByPpa !== true) process.exit(1);
  if (major(regression.coordinator.node) !== 22 || !regression.coordinator.modules) process.exit(1);
  if (regression.piPath !== process.env.ACTUAL_PI || major(regression.cases[0]?.stdoutEvidence?.node) !== 24) process.exit(1);
  if (regression.piNode !== pi.nodePath || regression.addon !== process.env.PI_ADDON || regression.addonVersion !== "13.0.3") process.exit(1);
  if (regression.runs !== 20 || regression.workload.operations !== 250 || regression.cases.length !== 20) process.exit(1);
  for (const item of regression.cases) {
    if (item.status !== 0 || item.signal !== null || item.processExit.code !== 0 || item.childTimeoutMs !== 30_000) process.exit(1);
    if (item.stdoutEvidence.node !== pi.node || item.stdoutEvidence.modules !== pi.modules || item.stdoutEvidence.addonPath !== process.env.PI_ADDON) process.exit(1);
    if (item.diagnostics.configuredSecretLeaks !== 0 || item.boundedStderr.length > 2_000 || (item.error?.length ?? 0) > 2_000) process.exit(1);
    if (Object.values(item.signatures).some(Boolean)) process.exit(1);
  }

  process.stderr.write(`installed-evidence node22=${node22.node} abi22=${node22.modules} addon22=${node22.addonPath} node24=${pi.node} abi24=${pi.modules} pi=${regression.piVersion} pi-host=${regression.piNode} addon24=${pi.addonPath} teardown=20/20 todo=once/add/list/restore\n`);
'

"$store_output/bin/pa-platform-node" ./scripts/pap-156-caller-boundary-smoke.mjs "$store_output"

printf 'nix-smoke host=%s store=%s x86_64-drv=%s aarch64-drv=%s\n' "$host_system" "$store_output" "$x86_drv" "$aarch64_drv" >&2
printf '%s\n' "$store_output"
