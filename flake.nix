{
  description = "pa-platform - runtime-agnostic core library and adapters for PA";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    properPiExtensions = {
      url = "github:sharaf-nassar/proper-pi-extensions/859feb321ec81d773beea379d28e21d0b7d0c8c0";
      flake = false;
    };
    piVimMode = {
      url = "github:pekochan069/pi-vimmode/52bd6ac5e905157ac46ec15c120b7d0cc61a62df";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, properPiExtensions, piVimMode }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      pkgsFor = system: nixpkgs.legacyPackages.${system};
      axiToolsFor = system: import ./nix/axi-tools.nix { pkgs = pkgsFor system; };

      requireBooleanOption = name: value:
        if builtins.isBool value then value
        else throw "lib.mkPaPlatform: option `${name}` must be a boolean, received ${builtins.typeOf value}.";

      paPlatformFor = system: {
        enablePiVimMode ? false,
        enableProperBase ? false,
        enableGhAxi ? false,
        enableChromeDevtoolsAxi ? false,
        enableQuotaAxi ? false,
        enableLavishAxi ? false,
      }:
        let
          pkgs = pkgsFor system;
          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
          treehouse = pkgs.callPackage ./nix/treehouse.nix {};
          reviewProvenance = pkgs.writeText "review-runtime-provenance.json" (builtins.toJSON {
            schemaVersion = "pa-review-runtime/v1";
            sourceSha = self.rev or "unversioned-dirty-source";
            configSha = pkgs.lib.removeSuffix "\n" (builtins.readFile ./.pa-platform-config.sha);
            packageName = "pa-platform";
            packageVersion = packageJson.version;
            objectiveSchema = "pa-review-objective/v1";
            matrixSchema = "pa-review-matrix/v1";
          });
          pluginSelection = {
            "pi-vimmode" = requireBooleanOption "enablePiVimMode" enablePiVimMode;
            "proper-base" = requireBooleanOption "enableProperBase" enableProperBase;
          };
          axiSelection = {
            "gh-axi" = requireBooleanOption "enableGhAxi" enableGhAxi;
            "chrome-devtools-axi" = requireBooleanOption "enableChromeDevtoolsAxi" enableChromeDevtoolsAxi;
            "quota-axi" = requireBooleanOption "enableQuotaAxi" enableQuotaAxi;
            "lavish-axi" = requireBooleanOption "enableLavishAxi" enableLavishAxi;
          };
          selectedAxiTools = pkgs.lib.filterAttrs (name: _: axiSelection.${name} or false) (axiToolsFor system);
          selectedAxiDependencies = pkgs.lib.unique (pkgs.lib.concatMap
            (tool: [ tool.node ] ++ tool.dependencies) (builtins.attrValues selectedAxiTools));
          # Only the managed selected-tool directory and its declared dependencies
          # enter PPA PATH. Raw upstream AXI bins are not the managed boundary.
          axiDependencyPath = pkgs.lib.makeBinPath selectedAxiDependencies;
          baseSource = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: _type:
              let baseName = builtins.baseNameOf path;
              in !(builtins.elem baseName [ "node_modules" "dist" ".git" "bundled-editor-factories.ts" ]);
          };
          # Git flakes do not materialize gitlink contents. Compose the exact
          # reviewed commits into the build source so validation still checks
          # entrypoints, manifests, licenses, and content digests from scratch.
          composedSource = pkgs.runCommand "pa-platform-source-${packageJson.version}" {} ''
            mkdir -p $out
            cp -R ${baseSource}/. $out/
            chmod -R u+w $out
            rm -rf $out/packages/pi-pa/vendor/proper-pi-extensions $out/packages/pi-pa/vendor/pi-vimmode
            mkdir -p $out/packages/pi-pa/vendor/proper-pi-extensions $out/packages/pi-pa/vendor/pi-vimmode
            cp -R ${properPiExtensions}/. $out/packages/pi-pa/vendor/proper-pi-extensions/
            cp -R ${piVimMode}/. $out/packages/pi-pa/vendor/pi-vimmode/
            test -f $out/packages/pi-pa/vendor/proper-pi-extensions/proper-base/index.ts
            test -f $out/packages/pi-pa/vendor/pi-vimmode/index.ts
          '';
          runtimePath = pkgs.lib.makeBinPath (with pkgs; [
            bash
            bubblewrap
            coreutils
            util-linux
            systemd
            git
            sqlcipher
          ]);
        in
        # Force all selectors even when a caller requests only drvPath.
        builtins.deepSeq axiSelection (pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "pa-platform";
          version = packageJson.version;

          src = composedSource;

          nativeBuildInputs = with pkgs; [
            nodejs_22
            nodejs_24
            pnpm
            pnpmConfigHook
            makeWrapper
            python3
            pkg-config
            gnumake
            sqlite.dev
            node-gyp
          ];

          buildInputs = with pkgs; [
            sqlite.out
          ];

          PI_PA_PLUGIN_SELECTION = builtins.toJSON pluginSelection;

          passthru = {
            inherit pluginSelection axiSelection selectedAxiTools selectedAxiDependencies treehouse;
          };

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname src;
            hash = "sha256-iHborBoIZe9LLALxwipBvuolrhvrDnTdzVkpPWJRvfs=";
            fetcherVersion = 4;
          };

          buildPhase = ''
            runHook preBuild
            pnpm --reporter=append-only -r build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            share=$out/share/pa-platform
            # Selected managed shims: fixed pinned Node/tool/MCP arguments;
            # metadata is unauthenticated, operational policy is deployment-bound.
            mkdir -p $share/axi-tools
            # Fixed util-linux fd-lock helper; supervisors never resolve PATH.
            ln -s ${pkgs.lib.getBin pkgs.util-linux}/bin/flock $share/artifact-review-flock
            printf '%s\n' ${pkgs.lib.escapeShellArg (builtins.toJSON axiSelection)} > $share/axi-selection.json
            ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (name: tool: ''
              ln -s ${tool} $share/axi-tools/${name}
              mkdir -p $share/axi-bin
              ${if name == "lavish-axi" then ''
                # Native fail-closed gate: never route through the generic AXI
                # Node shim or run the unqualified upstream CLI. Phase 3 owns
                # independently qualified cross-adapter lifecycle integration.
                ln -s ${tool}/${tool.axiEntrypoint} $share/axi-bin/lavish-axi
              '' else ''
                makeWrapper ${tool.node}/bin/node $share/axi-bin/${name} \
                  --add-flags "$share/packages/pi-pa/dist/axi-policy.js ${name} ${tool.node}/bin/node ${tool}/${tool.axiEntrypoint} ${if name == "gh-axi" then "${pkgs.gh}/bin/gh" else "-"} ${if name == "chrome-devtools-axi" then "${builtins.head tool.dependencies}/${(builtins.head tool.dependencies).mcpEntrypoint}" else "-"}"
              ''}
            '') selectedAxiTools)}
            mkdir -p $share/packages/pa-core $share/packages/opencode-pa $share/packages/pi-pa $share/packages/runtime-host $out/bin $out/share/fish/vendor_completions.d

            cp package.json pnpm-lock.yaml pnpm-workspace.yaml $share/
            install -Dm644 ${reviewProvenance} $share/review-runtime-provenance.json
            install -Dm755 scripts/pap-237-installed-preflight-smoke.mjs $share/scripts/pap-237-installed-preflight-smoke.mjs
            cp -r packages/pa-core/src/__tests__/fixtures/protected-review-v1 $share/protected-review-v1-fixtures
            install -Dm755 scripts/pap-167-pi-retry-smoke.mjs $share/scripts/pap-167-pi-retry-smoke.mjs
            cp packages/pa-core/package.json $share/packages/pa-core/package.json
            cp -r packages/pa-core/dist $share/packages/pa-core/dist
            cp -r packages/pa-core/node_modules $share/packages/pa-core/node_modules
            cp packages/opencode-pa/package.json $share/packages/opencode-pa/package.json
            cp -r packages/opencode-pa/dist $share/packages/opencode-pa/dist
            mkdir -p $share/packages/opencode-pa/node_modules/@pa-platform
            ln -s ../../../pa-core $share/packages/opencode-pa/node_modules/@pa-platform/pa-core
            cp packages/pi-pa/dist/pi-pa-package.json $share/packages/pi-pa/package.json
            cp packages/pi-pa/dist/THIRD_PARTY_NOTICES.md $share/packages/pi-pa/THIRD_PARTY_NOTICES.md
            cp -r packages/pi-pa/dist $share/packages/pi-pa/dist
            rm $share/packages/pi-pa/dist/pi-pa-package.json $share/packages/pi-pa/dist/THIRD_PARTY_NOTICES.md
            cp -r packages/pi-pa/node_modules $share/packages/pi-pa/node_modules
            test -f packages/pi-pa/package.json
            rm -f $share/packages/pi-pa/node_modules/@pa-platform/pa-core
            mkdir -p $share/packages/pi-pa/node_modules/@pa-platform
            ln -s ../../../pa-core $share/packages/pi-pa/node_modules/@pa-platform/pa-core

            cp packages/runtime-host/package.json $share/packages/runtime-host/package.json
            cp -r packages/runtime-host/dist $share/packages/runtime-host/dist
             test -f packages/runtime-host/package.json
            mkdir -p $share/packages/runtime-host/node_modules/@pa-platform
            ln -s ../../../pa-core $share/packages/runtime-host/node_modules/@pa-platform/pa-core
            ln -s ../../../opencode-pa $share/packages/runtime-host/node_modules/@pa-platform/opencode-pa
            ln -s ../../../pi-pa $share/packages/runtime-host/node_modules/@pa-platform/pi-pa

            install -Dm644 /dev/stdin $share/pa-core-cli.mjs <<'EOF'
            import { runCoreCommand } from "./packages/pa-core/dist/cli/core-command.js";

            process.exitCode = await runCoreCommand(process.argv.slice(2));
            EOF

            for dir in docs; do
              [ -d "$dir" ] && cp -r "$dir" "$share/"
            done

            if [ -f completions/pa-core.fish ]; then
              install -Dm644 completions/pa-core.fish $out/share/fish/vendor_completions.d/pa-core.fish
            fi

            if [ -f completions/opa.fish ]; then
              install -Dm644 completions/opa.fish $out/share/fish/vendor_completions.d/opa.fish
            fi

            if [ -f completions/ppa.fish ]; then
              install -Dm644 completions/ppa.fish $out/share/fish/vendor_completions.d/ppa.fish
            fi

            cp -r node_modules $share/node_modules

            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/pa-core \
              --add-flags "$share/pa-core-cli.mjs" \
              --set PA_SQLITE_NATIVE_BINDING "$share/native-addons/node-22/better_sqlite3.node" \
              --prefix PATH : "${runtimePath}"

            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/opa \
              --add-flags "$share/packages/opencode-pa/dist/cli.js" \
              --set PA_SQLITE_NATIVE_BINDING "$share/native-addons/node-22/better_sqlite3.node" \
              --prefix PATH : "${runtimePath}"

            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/ppa \
              --add-flags "$share/packages/pi-pa/dist/cli.js" \
              --set PA_SQLITE_NATIVE_BINDING "$share/native-addons/node-22/better_sqlite3.node" \
              --set PA_PI_SQLITE_NATIVE_BINDING "$share/native-addons/pi-node-24/better_sqlite3.node" \
              --set PA_REQUIRE_PI_SQLITE_NATIVE_BINDING "1" \
              --set PA_TREEHOUSE_BINARY "${treehouse}/bin/treehouse" \
              --set PA_AXI_PATH "${pkgs.lib.optionalString (selectedAxiTools != {}) "$share/axi-bin:${axiDependencyPath}"}" \
              --prefix PATH : "${pkgs.lib.optionalString (selectedAxiTools != {}) "$share/axi-bin:${axiDependencyPath}:"}${runtimePath}"

            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/pa-platform-node \
              --set PA_SQLITE_NATIVE_BINDING "$share/native-addons/node-22/better_sqlite3.node" \
              --prefix PATH : "${runtimePath}"

            if [ -d "$share/node_modules/better-sqlite3" ]; then
              mkdir -p "$share/native-addons/node-22" "$share/native-addons/pi-node-24"

              cd "$share/node_modules/better-sqlite3"
              patchShebangs .
              export npm_config_nodedir=${pkgs.nodejs_22}
              ${pkgs.nodejs_22}/bin/node ${pkgs.nodejs_22}/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=${pkgs.nodejs_22} --force_build=1 --openssl-fips=false
              install -Dm755 build/Release/better_sqlite3.node "$share/native-addons/node-22/better_sqlite3.node"

              piSqliteSource="$TMPDIR/better-sqlite3-pi-host"
              sqlitePackageSource="$(readlink -f "$share/node_modules/better-sqlite3")"
              cp -rL "$sqlitePackageSource" "$piSqliteSource"
              mkdir -p "$piSqliteSource/node_modules"
              cp -rL "$(dirname "$sqlitePackageSource")/node-addon-api" "$piSqliteSource/node_modules/node-addon-api"
              chmod -R u+w "$piSqliteSource"
              rm -rf "$piSqliteSource/build"
              cd "$piSqliteSource"
              patchShebangs .
              export npm_config_nodedir=${pkgs.nodejs_24}
              ${pkgs.nodejs_24}/bin/node ${pkgs.nodejs_24}/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=${pkgs.nodejs_24} --force_build=1 --openssl-fips=false
              install -Dm755 build/Release/better_sqlite3.node "$share/native-addons/pi-node-24/better_sqlite3.node"
            fi

            for nodePty in "$share"/node_modules/.pnpm/node-pty@*/node_modules/node-pty; do
              if [ -d "$nodePty" ]; then
                cd "$nodePty"
                patchShebangs .
                export npm_config_nodedir=${pkgs.nodejs_22}
                ${pkgs.nodejs_22}/bin/node ${pkgs.nodejs_22}/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=${pkgs.nodejs_22}
              fi
            done

            runHook postInstall
          '';

          dontStrip = true;

          meta = with pkgs.lib; {
            description = "Runtime-agnostic core library and adapters for PA";
            license = licenses.mit;
            platforms = platforms.linux;
          };
        }));
    in
    {
      lib.mkPaPlatform = paPlatformFor;

      packages = forAllSystems (system:
        let
          defaultPaPlatform = paPlatformFor system {
            enablePiVimMode = false;
            enableProperBase = false;
          };
        in (axiToolsFor system) // {
          pa-platform = defaultPaPlatform;
          pa-core = defaultPaPlatform;
          opa = defaultPaPlatform;
          ppa = defaultPaPlatform;
          default = defaultPaPlatform;
        });

      checks = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          packagesForSystem = self.packages.${system};
          overlayPackages = self.overlays.default pkgs pkgs;
          selectionOf = package: package.pluginSelection;
          neither = { "pi-vimmode" = false; "proper-base" = false; };
          vimOnly = { "pi-vimmode" = true; "proper-base" = false; };
          properOnly = { "pi-vimmode" = false; "proper-base" = true; };
          both = { "pi-vimmode" = true; "proper-base" = true; };
          invalidVim = builtins.tryEval (builtins.deepSeq (paPlatformFor system { enablePiVimMode = "yes"; }) true);
          invalidProper = builtins.tryEval (builtins.deepSeq (paPlatformFor system { enableProperBase = 1; }) true);
          noAxi = { "gh-axi" = false; "chrome-devtools-axi" = false; "quota-axi" = false; "lavish-axi" = false; };
          invalidAxi = option: value:
            builtins.tryEval ((paPlatformFor system { ${option} = value; }).drvPath);
          axiOptionContracts = [
            { option = "enableGhAxi"; tool = "gh-axi"; version = "0.1.35"; }
            { option = "enableChromeDevtoolsAxi"; tool = "chrome-devtools-axi"; version = "0.1.38"; }
            { option = "enableQuotaAxi"; tool = "quota-axi"; version = "0.1.56"; }
            { option = "enableLavishAxi"; tool = "lavish-axi"; version = "0.1.67"; }
          ];
        in {
          treehouse-runtime = pkgs.runCommand "ppa-treehouse-runtime" {
            nativeBuildInputs = [ pkgs.bash pkgs.coreutils ];
          } ''
            bash ${./scripts}/pap-252-packaged-treehouse-smoke.sh ${packagesForSystem.ppa}
            touch $out
          '';
          # Phase-1 evaluation assertions, not the installed-output matrix.
          axi-packaging-contract =
            assert builtins.all (contract:
              let selected = paPlatformFor system { ${contract.option} = true; };
              in selected.axiSelection == (noAxi // { ${contract.tool} = true; })
                && builtins.attrNames selected.selectedAxiTools == [ contract.tool ]
                && packagesForSystem.${contract.tool}.version == contract.version
                && builtins.all (value: !(invalidAxi contract.option value).success)
                  [ "true" 1 null [] {} ]
            ) axiOptionContracts;
            assert builtins.all (name:
              packagesForSystem.${name}.axiSelection == noAxi
                && packagesForSystem.${name}.selectedAxiTools == {}
            ) [ "pa-platform" "pa-core" "opa" "ppa" "default" ];
            assert builtins.all (name: overlayPackages.${name}.axiSelection == noAxi)
              [ "pa-platform" "pa-core" "opa" "ppa" ];
            assert (paPlatformFor system {}).axiSelection == noAxi;
            assert packagesForSystem.lavish-axi.managedGate;
            assert packagesForSystem.lavish-axi.axiEntrypoint == "bin/lavish-axi";
            assert packagesForSystem.lavish-axi.dependencies == [];
            assert packagesForSystem.chrome-devtools-mcp.version == "1.10.1";
            assert pkgs.lib.versionAtLeast packagesForSystem.quota-axi.node.version "22.19.0";
            assert packagesForSystem.gh-axi.dependencies == [ pkgs.gh ];
            assert packagesForSystem.chrome-devtools-axi.dependencies == [ packagesForSystem.chrome-devtools-mcp ];
            pkgs.runCommand "pa-platform-axi-packaging-contract" {} ''
              touch $out
            '';
          plugin-selection-contract =
            assert selectionOf (paPlatformFor system {}) == neither;
            assert selectionOf (paPlatformFor system { enablePiVimMode = true; }) == vimOnly;
            assert selectionOf (paPlatformFor system { enableProperBase = true; }) == properOnly;
            assert selectionOf (paPlatformFor system { enablePiVimMode = true; enableProperBase = true; }) == both;
            assert selectionOf packagesForSystem.pa-platform == neither;
            assert selectionOf packagesForSystem.ppa == neither;
            assert selectionOf packagesForSystem.default == neither;
            assert selectionOf overlayPackages.pa-platform == neither;
            assert selectionOf overlayPackages.ppa == neither;
            assert !invalidVim.success;
            assert !invalidProper.success;
            pkgs.runCommand "pa-platform-plugin-selection-contract" {} ''
              touch $out
            '';
        });

      overlays.default = final: prev: {
        pa-platform = self.packages.${prev.stdenv.hostPlatform.system}.pa-platform;
        pa-core = self.packages.${prev.stdenv.hostPlatform.system}.pa-core;
        opa = self.packages.${prev.stdenv.hostPlatform.system}.opa;
        ppa = self.packages.${prev.stdenv.hostPlatform.system}.ppa;
      };

      devShells = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          treehouse = pkgs.callPackage ./nix/treehouse.nix {};
          dev-pa-platform = pkgs.writeShellScriptBin "dev-pa-platform" ''
            set -euo pipefail
            PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
            cd "$PROJECT_ROOT"
            if [ "$#" -eq 0 ]; then
              exec pnpm build
            fi
            exec pnpm "$@"
          '';
          # dev-pa-serve: dev-shell convenience wrapper for phone/Tailscale access.
          # Bakes in --host 0.0.0.0 --cors so the API is reachable from non-loopback
          # peers (e.g. iPhone via Tailscale). Uses dtach for backgrounding —
          # do NOT pass --background to the inner CLI or it will double-detach.
          # pa-core defaults remain 127.0.0.1 / CORS off; this wrapper is opt-in.
          dev-pa-serve = pkgs.writeShellScriptBin "dev-pa-serve" ''
            set -euo pipefail
            PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
            cd "$PROJECT_ROOT"

            DTACH_SOCKET="/tmp/pa-platform-serve.dtach"
            CLI="$PROJECT_ROOT/packages/opencode-pa/dist/cli.js"
            HOST="0.0.0.0"
            PORT="9848"

            case "''${1:-}" in
              stop|status)
                subcommand="$1"
                if [ "$#" -ne 1 ]; then
                  echo "[dev-pa-serve] Error: '$subcommand' does not accept extra arguments." >&2
                  echo "[dev-pa-serve] Usage: dev-pa-serve $subcommand" >&2
                  exit 64
                fi
                exec node "$CLI" serve "$subcommand"
                ;;
              restart)
                shift
                pnpm build
                node "$CLI" serve stop 2>/dev/null || true
                sleep 1
                ${pkgs.dtach}/bin/dtach -n "$DTACH_SOCKET" \
                  node "$CLI" serve --port "$PORT" --host "$HOST" --cors "$@"
                echo "[dev-pa-serve] Restarted with defaults $HOST:$PORT (CORS on; caller flags may override). Attach: dtach -a $DTACH_SOCKET" >&2
                ;;
              -h|--help|help)
                cat <<'USAGE'
            dev-pa-serve — pa-platform dev API server (phone/Tailscale-friendly)

            Usage:
              dev-pa-serve [extra-args...]   Start serve in background via dtach
                                             (defaults: --host 0.0.0.0 --port 9848 --cors)
              dev-pa-serve stop              Stop the running server
              dev-pa-serve status            Show running server status
              dev-pa-serve restart [extra-args...]
                                             Stop, rebuild, and start fresh

            Notes:
              - Wrapper bakes in --host 0.0.0.0 --cors for LAN/Tailscale access.
              - pa-core defaults remain 127.0.0.1 + CORS off — only this wrapper opts in.
              - dtach socket: /tmp/pa-platform-serve.dtach (attach with `dtach -a`)
              - Pass extra flags after `dev-pa-serve` to override (e.g. `--port 19848`).
            USAGE
                ;;
              *)
                pnpm build
                ${pkgs.dtach}/bin/dtach -n "$DTACH_SOCKET" \
                  node "$CLI" serve --port "$PORT" --host "$HOST" --cors "$@"
                echo "[dev-pa-serve] Started with defaults $HOST:$PORT (CORS on; caller flags may override). Attach: dtach -a $DTACH_SOCKET" >&2
                ;;
            esac
          '';
        in {
          default = pkgs.mkShell {
            PA_TREEHOUSE_BINARY = "${treehouse}/bin/treehouse";
            packages = with pkgs; [
              bash
              bubblewrap
              coreutils
              util-linux
              systemd
              dtach
              git
              git-cliff
              nodejs_22
              pnpm
              python3
              pkg-config
              sqlite.dev
              node-gyp
              sqlcipher
              dev-pa-platform
              dev-pa-serve
            ];
          };
        });
    };
}
