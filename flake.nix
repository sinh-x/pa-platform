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
            hash = pkgs.lib.fakeHash;
            fetcherVersion = 3;
          };

          buildPhase = ''
            runHook preBuild
            pnpm build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            share=$out/share/pa-platform
            mkdir -p $share/packages/pa-core $out/bin

            cp package.json pnpm-lock.yaml pnpm-workspace.yaml $share/
            cp packages/pa-core/package.json $share/packages/pa-core/package.json
            cp -r packages/pa-core/dist $share/packages/pa-core/dist

            for dir in docs skills teams; do
              [ -d "$dir" ] && cp -r "$dir" "$share/"
            done

            cp -r node_modules $share/node_modules

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
        default = paPlatformFor system;
      });

      overlays.default = final: prev: {
        pa-platform = self.packages.${prev.stdenv.hostPlatform.system}.pa-platform;
        pa-core = self.packages.${prev.stdenv.hostPlatform.system}.pa-core;
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
            ];
          };
        });
    };
}
