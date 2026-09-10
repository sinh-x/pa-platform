#!/usr/bin/env bash
set -euo pipefail

flake_ref='.?submodules=1'
repo_url="git+file://$PWD?submodules=1"
host_system=$(nix eval --raw --impure --expr builtins.currentSystem)
supported_systems=(x86_64-linux aarch64-linux)
variant_names=(neither vim-only proper-only both)
declare -A variant_vim=( [neither]=false [vim-only]=true [proper-only]=false [both]=true )
declare -A variant_proper=( [neither]=false [vim-only]=false [proper-only]=true [both]=true )
declare -A outputs=()

constructor_expr() {
  local system=$1 vim=$2 proper=$3
  printf 'let flake = builtins.getFlake "%s"; in flake.lib.mkPaPlatform "%s" { enablePiVimMode = %s; enableProperBase = %s; }' \
    "$repo_url" "$system" "$vim" "$proper"
}

# Evaluate every supported-system/selection pair (8/8), and prove every
# supported alias and overlay package remains the both-disabled constructor.
for system in "${supported_systems[@]}"; do
  for variant in "${variant_names[@]}"; do
    eval_expr=$(constructor_expr "$system" "${variant_vim[$variant]}" "${variant_proper[$variant]}")
    nix eval --raw --impure --expr "($eval_expr).drvPath" >/dev/null
  done
  nix eval --json --impure --expr '
    let
      flake = builtins.getFlake "'"$repo_url"'";
      system = "'"$system"'";
      packages = flake.packages.${system};
      pkgs = flake.inputs.nixpkgs.legacyPackages.${system};
      overlay = flake.overlays.default pkgs pkgs;
      expected = (flake.lib.mkPaPlatform system {}).drvPath;
    in
      assert packages.pa-platform.drvPath == expected;
      assert packages.pa-core.drvPath == expected;
      assert packages.opa.drvPath == expected;
      assert packages.cpa.drvPath == expected;
      assert packages.dpa.drvPath == expected;
      assert packages.ppa.drvPath == expected;
      assert packages.default.drvPath == expected;
      assert overlay.pa-platform.drvPath == expected;
      assert overlay.pa-core.drvPath == expected;
      assert overlay.opa.drvPath == expected;
      assert overlay.cpa.drvPath == expected;
      assert overlay.dpa.drvPath == expected;
      assert overlay.ppa.drvPath == expected;
      true
  ' >/dev/null
done

# Invalid constructor values must fail strictly.
for invalid_expr in \
  "$(constructor_expr "$host_system" '"yes"' false)" \
  "$(constructor_expr "$host_system" false 1)"; do
  if nix eval --raw --impure --expr "($invalid_expr).drvPath" >/dev/null 2>&1; then
    echo "invalid plugin constructor input unexpectedly evaluated" >&2
    exit 1
  fi
done

# Dry-run every non-native selection and retain exact derivation evidence.
declare -A drv_paths=()
for system in "${supported_systems[@]}"; do
  for variant in "${variant_names[@]}"; do
    expr=$(constructor_expr "$system" "${variant_vim[$variant]}" "${variant_proper[$variant]}")
    drv_paths["$system/$variant"]=$(nix eval --raw --impure --expr "($expr).drvPath")
    if [[ "$system" != "$host_system" ]]; then
      nix build --impure --expr "$expr" --dry-run --no-link >/dev/null 2>&1
    fi
  done
done

# Build all four native outputs. The default uses the supported ppa alias.
outputs[neither]=$(nix build "$flake_ref#ppa" --no-link --print-out-paths)
for variant in vim-only proper-only both; do
  expr=$(constructor_expr "$host_system" "${variant_vim[$variant]}" "${variant_proper[$variant]}")
  outputs[$variant]=$(nix build --impure --expr "$expr" --no-link --print-out-paths)
done
if [[ $(printf '%s\n' "${outputs[@]}" | sort -u | wc -l) -ne 4 ]]; then
  echo "plugin selections did not produce four distinct store outputs" >&2
  exit 1
fi

smoke_root=$(mktemp -d)
trap 'printf "nix-smoke temporary-evidence=%s\\n" "$smoke_root" >&2' EXIT
actual_pi=${PAP167_REAL_PI:-$(command -v pi)}
expected_pi_node=${PAP183_EXPECTED_PI_NODE_VERSION:-v24.19.0}
selected_output=${outputs[both]}

for variant in "${variant_names[@]}"; do
  store_output=${outputs[$variant]}
  expected_vim=${variant_vim[$variant]}
  expected_proper=${variant_proper[$variant]}
  package_root="$store_output/share/pa-platform/packages/pi-pa"
  helper_path="$package_root/dist/pi-host-smoke.js"
  node22_addon="$store_output/share/pa-platform/native-addons/node-22/better_sqlite3.node"
  pi_addon="$store_output/share/pa-platform/native-addons/pi-node-24/better_sqlite3.node"

  for command in "opa status" "ppa status" "opa --help" "ppa --help"; do
    "$store_output/bin/${command%% *}" ${command#* } >/dev/null
  done
  for artifact in \
    "$package_root/package.json" \
    "$package_root/dist/pi-extension/index.js" \
    "$package_root/dist/pi-extension/vendor/provenance.json" \
    "$package_root/THIRD_PARTY_NOTICES.md" \
    "$helper_path" \
    "$store_output/share/pa-platform/scripts/pap-167-pi-retry-smoke.mjs" \
    "$node22_addon" \
    "$pi_addon" \
    "$store_output/share/pa-platform/packages/runtime-host/dist/index.js" \
    "$store_output/share/fish/vendor_completions.d/ppa.fish"; do
    test -f "$artifact"
  done

  PACKAGE_ROOT="$package_root" EXPECTED_VIM="$expected_vim" EXPECTED_PROPER="$expected_proper" \
    "$store_output/bin/pa-platform-node" --input-type=module --eval '
      const { createHash } = await import("node:crypto");
      const { existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const root = process.env.PACKAGE_ROOT;
      const selected = [
        process.env.EXPECTED_VIM === "true" ? "pi-vimmode" : undefined,
        process.env.EXPECTED_PROPER === "true" ? "proper-base" : undefined,
      ].filter(Boolean);
      const reviewed = {
        "pi-vimmode": { version: "0.9.0", import: "#pi-pa-vimmode", target: "./dist/pi-extension/vendor/pi-vimmode.js", bundle: "pi-vimmode.js", commit: "52bd6ac5e905157ac46ec15c120b7d0cc61a62df", contentSha256: "40fba5841b53c042c3cb31c92c86a240d60c9674c37f2d69bb62e5ef6efc52c5", license: "MIT", licenseSha256: "4f0857fdc3d54e6adb6ec2c3602bd8e0e4bed2f83fb206e4522b987f55b9c74b" },
        "proper-base": { version: "0.5.0", import: "#pi-pa-proper-base", target: "./dist/pi-extension/vendor/proper-base.js", bundle: "proper-base.js", commit: "859feb321ec81d773beea379d28e21d0b7d0c8c0", contentSha256: "5150bed13e50a737679ed8ff4f6994b580f744a223c14a1798ec4f4d959b3065", license: "MIT", licenseSha256: "0db23616fd86ab7f86c95f97e24d2df974956fb16b9d8ca1e63a62d19d3278e4" },
      };
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const provenance = JSON.parse(readFileSync(join(root, "dist/pi-extension/vendor/provenance.json"), "utf8"));
      const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
      const imports = Object.fromEntries(selected.map((name) => [reviewed[name].import, reviewed[name].target]));
      if (JSON.stringify(packageJson.imports) !== JSON.stringify(imports)) process.exit(1);
      if (JSON.stringify(provenance.selectedSources) !== JSON.stringify(selected)) process.exit(1);
      if (JSON.stringify(provenance.sources.map(({ name }) => name)) !== JSON.stringify(selected)) process.exit(1);
      for (const [name, expected] of Object.entries(reviewed)) {
        const enabled = selected.includes(name);
        for (const relative of [
          `dist/pi-extension/vendor/${expected.bundle}`,
          `dist/pi-extension/vendor/${expected.bundle}.map`,
          `dist/pi-extension/vendor/licenses/${name}-LICENSE.txt`,
        ]) if (existsSync(join(root, relative)) !== enabled) process.exit(1);
        if (Object.hasOwn(packageJson.imports, expected.import) !== enabled) process.exit(1);
        if (notices.includes(`## ${name} ${expected.version}`) !== enabled) process.exit(1);
        const record = provenance.sources.find((source) => source.name === name);
        if (Boolean(record) !== enabled) process.exit(1);
        if (record && [record.commit, record.contentSha256, record.license, record.licenseSha256].join("|") !== [expected.commit, expected.contentSha256, expected.license, expected.licenseSha256].join("|")) process.exit(1);
        if (enabled) {
          const license = readFileSync(join(root, `dist/pi-extension/vendor/licenses/${name}-LICENSE.txt`));
          if (createHash("sha256").update(license).digest("hex") !== expected.licenseSha256) process.exit(1);
        }
      }
      if (selected.length === 0 && !notices.includes("no bundled reviewed editor plugins")) process.exit(1);
    '

  (
    cd "$package_root"
    if [[ "$expected_vim" == true ]]; then
      "$store_output/bin/pa-platform-node" --input-type=module --eval 'const plugin = await import("#pi-pa-vimmode"); if (typeof plugin.default !== "function") process.exit(1);'
    fi
    if [[ "$expected_proper" == true ]]; then
      "$store_output/bin/pa-platform-node" --input-type=module --eval 'import sharp from "sharp"; const plugin = await import("#pi-pa-proper-base"); if (typeof plugin.default !== "function" || sharp.versions.sharp !== "0.35.3") process.exit(1); const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#00000000" } }).png().toBuffer(); if (png.byteLength === 0) process.exit(1);'
    fi
  )

  node22_smoke=$(PA_REGISTRY_DB="$smoke_root/$variant-node22.db" ADDON_PATH="$node22_addon" \
    "$store_output/bin/pa-platform-node" --input-type=module --eval \
    "const core = await import('$store_output/share/pa-platform/packages/pa-core/dist/index.js'); const native = core.verifyRegistryNativeAddon(process.env.ADDON_PATH); const statuses = core.queryDeploymentStatuses(); core.closeDb(); process.stdout.write(JSON.stringify({...native, registryQuery: 'queryDeploymentStatuses', queryRows: statuses.length, close: 'explicit'}));")
  preflight=$(PAP167_REAL_PI="$actual_pi" "$store_output/bin/ppa" pi preflight)
  tool_smoke=$(PAP167_REAL_PI="$actual_pi" "$store_output/bin/ppa" pi smoke-tools)

  NODE22_SMOKE="$node22_smoke" PREFLIGHT="$preflight" TOOL_SMOKE="$tool_smoke" \
  NODE22_ADDON="$node22_addon" PI_ADDON="$pi_addon" HELPER_PATH="$helper_path" \
  EXPECTED_PI_NODE="$expected_pi_node" EXPECTED_VIM="$expected_vim" EXPECTED_PROPER="$expected_proper" \
  VARIANT="$variant" STORE_OUTPUT="$store_output" \
    "$store_output/bin/pa-platform-node" --input-type=module --eval '
      const { existsSync } = await import("node:fs");
      const node22 = JSON.parse(process.env.NODE22_SMOKE);
      const pi = JSON.parse(process.env.PREFLIGHT);
      const tools = JSON.parse(process.env.TOOL_SMOKE);
      const major = (version) => Number(/^v?(\d+)/.exec(version)?.[1]);
      if (major(node22.node) !== 22 || !node22.modules || node22.addonPath !== process.env.NODE22_ADDON || node22.registryQuery !== "queryDeploymentStatuses" || node22.close !== "explicit") process.exit(1);
      if (pi.node !== process.env.EXPECTED_PI_NODE || major(pi.node) !== 24 || !pi.modules || pi.addonPath !== process.env.PI_ADDON || pi.registryQuery !== "PRAGMA user_version" || pi.close !== "explicit") process.exit(1);
      if (!existsSync(process.env.HELPER_PATH) || !pi.nodePath.endsWith("/bin/node")) process.exit(1);
      const expectedTools = ["read", "bash", "question", "todo", "pa_ticket", "pa_bulletin", "pa_registry", "pa_status"];
      if (JSON.stringify(tools.tools) !== JSON.stringify(expectedTools.map((name) => ({ name, status: "passed" })))) process.exit(1);
      const expectedFactories = [process.env.EXPECTED_VIM === "true" ? "pi-vimmode@0.9.0" : undefined, process.env.EXPECTED_PROPER === "true" ? "proper-base@0.5.0" : undefined].filter(Boolean);
      if (JSON.stringify(tools.extension.factories) !== JSON.stringify(expectedFactories)) process.exit(1);
      if (tools.extension.commands.includes("vimmode") !== (process.env.EXPECTED_VIM === "true")) process.exit(1);
      if (tools.extension.commands.includes("clear") !== (process.env.EXPECTED_PROPER === "true")) process.exit(1);
      for (const command of ["pa-context", "pa-git-context"]) if (!tools.extension.commands.includes(command)) process.exit(1);
      for (const shortcut of ["alt+i", "alt+g"]) if (!tools.extension.shortcuts.includes(shortcut)) process.exit(1);
      for (const handler of ["tool_call", "agent_end", "session_shutdown"]) if (!tools.extension.handlers.includes(handler)) process.exit(1);
      if (tools.extension.guards.destructiveCommand !== "passed" || tools.extension.guards.sensitivePath !== "passed") process.exit(1);
      if (tools.extension.outputBounds.maxBytes !== 50 * 1024 || tools.extension.outputBounds.maxLines !== 2000 || tools.extension.outputBounds.status !== "passed") process.exit(1);
      if (JSON.stringify(tools.extension.todo) !== JSON.stringify({ registrations: 1, add: "passed", list: "passed", activeBranchRestore: "passed" })) process.exit(1);
      process.stderr.write(`runtime-smoke variant=${process.env.VARIANT} store=${process.env.STORE_OUTPUT} node22=${node22.node} abi22=${node22.modules} addon22=${node22.addonPath} node24=${pi.node} abi24=${pi.modules} pi-host=${pi.nodePath} addon24=${pi.addonPath} helper=${process.env.HELPER_PATH} registry=query/close tools=8/8 factories=${expectedFactories.join(",") || "none"}\n`);
    '

  ! grep -R -E '(sk-[A-Za-z0-9]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,})' "$package_root" "$store_output/share/pa-platform/packages/runtime-host"
  printf 'selection-smoke variant=%s store=%s node22-addon=%s pi-addon=%s helper=%s tools=8/8\n' \
    "$variant" "$store_output" "$node22_addon" "$pi_addon" "$helper_path" >&2
done

# Retain the installed teardown and caller-boundary regressions on the fresh
# both-enabled candidate, where the complete editor chain is also exercised.
regression_evidence="$smoke_root/installed-pi-teardown-regression.json"
PAP167_REAL_PI="$actual_pi" "$selected_output/bin/ppa" pi teardown-smoke \
  --regression --runs 20 --operations 250 --evidence "$regression_evidence" \
  >"$smoke_root/installed-pi-teardown-regression.stdout"
if [[ -n "${PAP176_INSTALLED_EVIDENCE:-}" ]]; then
  install -Dm600 "$regression_evidence" "$PAP176_INSTALLED_EVIDENCE"
fi
REGRESSION_EVIDENCE="$regression_evidence" STORE_OUTPUT="$selected_output" ACTUAL_PI="$actual_pi" \
PI_ADDON="$selected_output/share/pa-platform/native-addons/pi-node-24/better_sqlite3.node" EXPECTED_PI_NODE="$expected_pi_node" \
  "$selected_output/bin/pa-platform-node" --input-type=module --eval '
    const { readFileSync } = await import("node:fs");
    const evidence = JSON.parse(readFileSync(process.env.REGRESSION_EVIDENCE, "utf8"));
    if (evidence.mode !== "regression" || evidence.storeOutput !== process.env.STORE_OUTPUT || evidence.ppa !== `${process.env.STORE_OUTPUT}/bin/ppa` || evidence.invokedByPpa !== true) process.exit(1);
    if (evidence.coordinator.node !== "v22.23.2" || evidence.piPath !== process.env.ACTUAL_PI || evidence.piNode === evidence.coordinator.nodePath) process.exit(1);
    if (evidence.addon !== process.env.PI_ADDON || evidence.addonVersion !== "13.0.3" || evidence.runs !== 20 || evidence.workload.operations !== 250 || evidence.cases.length !== 20) process.exit(1);
    for (const item of evidence.cases) {
      if (item.status !== 0 || item.signal !== null || item.processExit.code !== 0 || item.childTimeoutMs !== 30_000 || item.stdoutEvidence.node !== process.env.EXPECTED_PI_NODE || item.stdoutEvidence.addonPath !== process.env.PI_ADDON) process.exit(1);
      if (item.diagnostics.configuredSecretLeaks !== 0 || item.boundedStderr.length > 2_000 || (item.error?.length ?? 0) > 2_000 || Object.values(item.signatures).some(Boolean)) process.exit(1);
    }
  '
"$selected_output/bin/pa-platform-node" ./scripts/pap-156-caller-boundary-smoke.mjs "$selected_output"

printf 'nix-smoke host=%s pi=%s pi-node=%s selections=4/4 evaluations=8/8 alias-systems=2/2 native-tools=32/32 teardown=20/20\n' "$host_system" "$actual_pi" "$expected_pi_node" >&2
for system in "${supported_systems[@]}"; do
  for variant in "${variant_names[@]}"; do
    printf 'nix-smoke drv system=%s variant=%s path=%s\n' "$system" "$variant" "${drv_paths[$system/$variant]}" >&2
  done
done
for variant in "${variant_names[@]}"; do
  printf 'nix-smoke output variant=%s path=%s\n' "$variant" "${outputs[$variant]}" >&2
done
printf '%s\n' "$selected_output"
