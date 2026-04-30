{
  description = "pa-platform - runtime-agnostic core library and adapters for PA";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      pkgsFor = system: nixpkgs.legacyPackages.${system};

      paPlatformFor = system:
        let
          pkgs = pkgsFor system;
          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
          runtimePath = pkgs.lib.makeBinPath (with pkgs; [
            bash
            coreutils
            util-linux
            systemd
            git
            sqlcipher
          ]);
        in
        pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "pa-platform";
          version = packageJson.version;

          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: _type:
              let baseName = builtins.baseNameOf path;
              in !(builtins.elem baseName [ "node_modules" "dist" ".git" ]);
          };

          nativeBuildInputs = with pkgs; [
            nodejs_22
            pnpm
            pnpmConfigHook
            makeWrapper
            python3
            pkg-config
            sqlite.dev
            node-gyp
          ];

          buildInputs = with pkgs; [
            sqlite.out
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname src;
            hash = "sha256-PcBA+6qozxVeAxOO0B5nG8oi169wVmVUNh7JOiEuPlI=";
            fetcherVersion = 3;
          };

          buildPhase = ''
            runHook preBuild
            pnpm -r build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            share=$out/share/pa-platform
            mkdir -p $share/packages/pa-core $share/packages/opencode-pa $out/bin $out/share/fish/vendor_completions.d

            cp package.json pnpm-lock.yaml pnpm-workspace.yaml $share/
            cp packages/pa-core/package.json $share/packages/pa-core/package.json
            cp -r packages/pa-core/dist $share/packages/pa-core/dist
            cp -r packages/pa-core/node_modules $share/packages/pa-core/node_modules
            cp packages/opencode-pa/package.json $share/packages/opencode-pa/package.json
            cp -r packages/opencode-pa/dist $share/packages/opencode-pa/dist
            mkdir -p $share/packages/opencode-pa/node_modules/@pa-platform
            ln -s ../../../pa-core $share/packages/opencode-pa/node_modules/@pa-platform/pa-core

            install -Dm644 /dev/stdin $share/pa-core-cli.mjs <<'EOF'
            import { runCoreCommand } from "./packages/pa-core/dist/cli/core-command.js";

            process.exitCode = await runCoreCommand(process.argv.slice(2));
            EOF

            for dir in docs skills teams; do
              [ -d "$dir" ] && cp -r "$dir" "$share/"
            done

            if [ -f completions/pa-core.fish ]; then
              install -Dm644 completions/pa-core.fish $out/share/fish/vendor_completions.d/pa-core.fish
            fi

            if [ -f completions/opa.fish ]; then
              install -Dm644 completions/opa.fish $out/share/fish/vendor_completions.d/opa.fish
            fi

            cp -r node_modules $share/node_modules

            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/pa-core \
              --add-flags "$share/pa-core-cli.mjs" \
              --prefix PATH : "${runtimePath}"

            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/opa \
              --add-flags "$share/packages/opencode-pa/dist/cli.js" \
              --prefix PATH : "${runtimePath}"

            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/pa-platform-node \
              --prefix PATH : "${runtimePath}"

            if [ -d "$share/node_modules/better-sqlite3" ]; then
              cd "$share/node_modules/better-sqlite3"
              patchShebangs .
              export npm_config_nodedir=${pkgs.nodejs_22}
              ${pkgs.nodejs_22}/bin/node ${pkgs.nodejs_22}/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=${pkgs.nodejs_22} --openssl-fips=false
            fi

            runHook postInstall
          '';

          dontStrip = true;

          meta = with pkgs.lib; {
            description = "Runtime-agnostic core library and adapters for PA";
            license = licenses.mit;
            platforms = platforms.linux;
          };
        });
    in
    {
      packages = forAllSystems (system: {
        pa-platform = paPlatformFor system;
        pa-core = paPlatformFor system;
        opa = paPlatformFor system;
        default = paPlatformFor system;
      });

      overlays.default = final: prev: {
        pa-platform = self.packages.${prev.stdenv.hostPlatform.system}.pa-platform;
        pa-core = self.packages.${prev.stdenv.hostPlatform.system}.pa-core;
        opa = self.packages.${prev.stdenv.hostPlatform.system}.opa;
      };

      devShells = forAllSystems (system:
        let
          pkgs = pkgsFor system;
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
            packages = with pkgs; [
              bash
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
