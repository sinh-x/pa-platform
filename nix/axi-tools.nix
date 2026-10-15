{ pkgs }:

let
  inherit (pkgs) lib;
  node = pkgs.nodejs_22;

  # Use npm's committed node_modules layout, including nested resolutions. The
  # published tarballs contain compiled JS; installation never runs npm, package
  # lifecycle scripts, browser provisioning, or an online dependency resolver.
  mkPinnedTool = { name, version, bins, license, dependencies ? [], wrapperArgs ? "", managedGate ? false }:
    let
      records = ./axi + "/${name}";
      manifest = builtins.fromJSON (builtins.readFile (records + "/package.json"));
      upstream = builtins.fromJSON (builtins.readFile (records + "/upstream-package.json"));
      lock = builtins.fromJSON (builtins.readFile (records + "/package-lock.json"));
      inventory = builtins.fromJSON (builtins.readFile (records + "/integrity.json"));
      entries = inventory.packages;
      lockedPaths = builtins.filter (path: path != "") (builtins.attrNames lock.packages);
      validEntry = entry:
        let locked = lock.packages.${entry.path};
        in builtins.match "node_modules/(@[a-zA-Z0-9_-]+/)?[a-zA-Z0-9_.-]+(/node_modules/(@[a-zA-Z0-9_-]+/)?[a-zA-Z0-9_.-]+)*" entry.path != null
          && lib.hasPrefix "https://registry.npmjs.org/" entry.url
          && lib.hasPrefix "sha512-" entry.integrity
          && lib.hasPrefix "sha256-" entry.sha256
          && entry.license != null && entry.licenseFiles != []
          && locked.version == entry.version
          && locked.resolved == entry.url
          && locked.integrity == entry.integrity
          && !(locked.hasInstallScript or false);
      sources = map (entry: {
        inherit (entry) path;
        archive = pkgs.fetchurl {
          url = entry.url;
          hash = entry.integrity;
        };
      }) entries;
      moduleRoot = "$out/lib/${name}";
    in
    assert lib.versionAtLeast node.version "22.19.0";
    assert manifest.dependencies.${name} == version;
    assert upstream.name == name && upstream.version == version;
    # Published bin paths may carry an equivalent leading ./.
    assert lib.mapAttrs (_: lib.removePrefix "./") upstream.bin == bins;
    assert lock.lockfileVersion == 3;
    assert lock.packages."".dependencies == manifest.dependencies;
    assert lock.packages."node_modules/${name}".version == version;
    assert inventory.schemaVersion == 1;
    assert lib.sort builtins.lessThan (map (entry: entry.path) entries) == lockedPaths;
    assert builtins.all validEntry entries;
    assert !managedGate || (
      upstream.dependencies == lock.packages."node_modules/lavish-axi".dependencies
      && lock.packages."node_modules/lavish-axi".integrity == "sha512-7qU7tF1ShNQEQY3SMceNkIR2T1Iuy3kOvatoOgPwUW1QJuXoi+vzF5NOiDSt7xMfNaKJMNLefY856yylFxOxHg=="
      && builtins.all (entry: entry.path != "node_modules/lavish-axi"
        || entry.sha256 == "sha256-sEvY7qcezoJMpdxoN8mN4ENyt2ymoo/m4aGrAl5QrP0=") entries
      && builtins.all (adaptation:
        builtins.hashFile "sha256" (records + "/${adaptation.path}") == adaptation.sha256
      ) (builtins.fromJSON (builtins.readFile (records + "/adaptations.json"))).adaptations
    );
    (if managedGate then pkgs.pkgsStatic.stdenv else pkgs.stdenvNoCC).mkDerivation {
      pname = name;
      inherit version;
      dontUnpack = true;
      dontBuild = !managedGate;
      nativeBuildInputs = if managedGate then [ pkgs.python3 ] else [ pkgs.makeWrapper ];
      buildPhase = lib.optionalString managedGate ''
        runHook preBuild
        $CC -static -std=c11 -O2 -Wall -Wextra -Werror \
          ${records}/adaptations/managed-entrypoint.c -o managed-gate
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p ${moduleRoot} $out/bin $out/share/${name}
        ${lib.concatMapStringsSep "\n" (source: ''
          mkdir -p "${moduleRoot}/${source.path}"
          tar --extract --gzip --file ${source.archive} \
            --directory "${moduleRoot}/${source.path}" --strip-components=1 \
            ${lib.optionalString (managedGate && source.path == "node_modules/lavish-axi") ''
              package/package.json package/LICENSE package/THIRD-PARTY-NOTICES.md \
              package/dist/cli.mjs package/dist/chrome-client.js package/dist/chrome.css \
              package/dist/design/daisyui.css package/dist/design/daisyui-themes.css \
              package/dist/design/tailwindcss-browser.js
            ''}
        '') sources}
        cp ${records}/package.json ${records}/package-lock.json \
          ${records}/upstream-package.json ${records}/integrity.json \
          ${records}/THIRD_PARTY_NOTICES.md $out/share/${name}/
        ${lib.optionalString (name == "chrome-devtools-mcp") ''
          cp ${records}/bundled-packages.json $out/share/${name}/
        ''}
        ${if managedGate then ''
          install -m755 managed-gate $out/bin/lavish-axi
          chmod a-x ${moduleRoot}/node_modules/lavish-axi/dist/cli.mjs
          ln -s ${node}/bin/node ${moduleRoot}/pinned-node
          # Extract only digest-pinned annotation/queue code. Never execute or
          # import the upstream CLI, browser SDK initializer or unsafe server.
          python3 ${records}/adaptations/adapt-upstream.py \
            ${moduleRoot}/node_modules/lavish-axi/dist/cli.mjs \
            ${moduleRoot}/node_modules/lavish-axi/dist/chrome-client.js \
            $out/share/lavish-axi/review
          cp ${records}/adaptations.json ${records}/upstream-files.json \
            $out/share/${name}/
          cp -r ${records}/adaptations $out/share/${name}/
        '' else lib.concatStringsSep "\n" (lib.mapAttrsToList (bin: entrypoint: ''
          test -f "${moduleRoot}/node_modules/${name}/${entrypoint}"
          makeWrapper ${node}/bin/node "$out/bin/${bin}" \
            --add-flags "${moduleRoot}/node_modules/${name}/${entrypoint}" \
            --prefix PATH : ${lib.escapeShellArg (lib.makeBinPath ([ node ] ++ dependencies))} \
            ${wrapperArgs}
        '') bins)}
        runHook postInstall
      '';

      passthru = {
        inherit node dependencies;
        dependencyLock = records + "/package-lock.json";
        integrityRecords = records + "/integrity.json";
        licenseRecords = records + "/THIRD_PARTY_NOTICES.md";
        # Fixed managed-shim entrypoint, avoiding PATH/npm/npx resolution.
        axiEntrypoint = if managedGate then "bin/lavish-axi"
          else "lib/${name}/node_modules/${name}/${bins.${name}}";
        inherit managedGate;
        # Direct entrypoint for the AXI bridge, avoiding npm/npx bootstrap.
        mcpEntrypoint = if name == "chrome-devtools-mcp"
          then "lib/${name}/node_modules/${name}/build/src/bin/chrome-devtools-mcp.js"
          else null;
      };
      meta = {
        description = if managedGate then "Pinned selectively adapted Lavish assets for core-owned local review; raw CLI denied"
          else "Integrity-pinned ${name} CLI (independent of PA application dependencies)";
        inherit license;
        mainProgram = name;
        platforms = [ "x86_64-linux" "aarch64-linux" ];
      };
    };

  mcp = mkPinnedTool {
    name = "chrome-devtools-mcp";
    version = "1.10.1";
    bins = {
      chrome-devtools = "build/src/bin/chrome-devtools.js";
      chrome-devtools-mcp = "build/src/bin/chrome-devtools-mcp.js";
    };
    license = lib.licenses.asl20;
    wrapperArgs = ''
      --set CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS 1 \
      --set CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS 1
    '';
  };
in {
  lavish-axi = mkPinnedTool {
    name = "lavish-axi";
    version = "0.1.67";
    bins.lavish-axi = "dist/cli.mjs";
    license = lib.licenses.mit;
    managedGate = true;
  };
  chrome-devtools-mcp = mcp;
  gh-axi = mkPinnedTool {
    name = "gh-axi";
    version = "0.1.35";
    bins.gh-axi = "dist/bin/gh-axi.js";
    license = lib.licenses.mit;
    dependencies = [ pkgs.gh ];
  };
  chrome-devtools-axi = mkPinnedTool {
    name = "chrome-devtools-axi";
    version = "0.1.38";
    bins.chrome-devtools-axi = "dist/bin/chrome-devtools-axi.js";
    license = lib.licenses.mit;
    dependencies = [ mcp ];
    wrapperArgs = ''
      --set CHROME_DEVTOOLS_AXI_MCP_PATH ${mcp}/${mcp.mcpEntrypoint} \
      --set CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS 1 \
      --set CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS 1
    '';
  };
  quota-axi = mkPinnedTool {
    name = "quota-axi";
    version = "0.1.56";
    bins.quota-axi = "dist/bin/quota-axi.js";
    license = lib.licenses.mit;
  };
}
