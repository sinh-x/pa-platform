{ pkgs }:

let
  inherit (pkgs) lib;
  node = pkgs.nodejs_22;

  # Use npm's committed node_modules layout, including nested resolutions. The
  # published tarballs contain compiled JS; installation never runs npm, package
  # lifecycle scripts, browser provisioning, or an online dependency resolver.
  mkPinnedTool = { name, version, bins, license, dependencies ? [], wrapperArgs ? "" }:
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
    pkgs.stdenvNoCC.mkDerivation {
      pname = name;
      inherit version;
      dontUnpack = true;
      dontBuild = true;
      nativeBuildInputs = [ pkgs.makeWrapper ];

      installPhase = ''
        runHook preInstall
        mkdir -p ${moduleRoot} $out/bin $out/share/${name}
        ${lib.concatMapStringsSep "\n" (source: ''
          mkdir -p "${moduleRoot}/${source.path}"
          tar --extract --gzip --file ${source.archive} \
            --directory "${moduleRoot}/${source.path}" --strip-components=1
        '') sources}
        cp ${records}/package.json ${records}/package-lock.json \
          ${records}/upstream-package.json ${records}/integrity.json \
          ${records}/THIRD_PARTY_NOTICES.md $out/share/${name}/
        ${lib.optionalString (name == "chrome-devtools-mcp") ''
          cp ${records}/bundled-packages.json $out/share/${name}/
        ''}
        ${lib.concatStringsSep "\n" (lib.mapAttrsToList (bin: entrypoint: ''
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
        # Direct entrypoint for the AXI bridge, avoiding npm/npx bootstrap.
        mcpEntrypoint = if name == "chrome-devtools-mcp"
          then "lib/${name}/node_modules/${name}/build/src/bin/chrome-devtools-mcp.js"
          else null;
      };
      meta = {
        description = "Integrity-pinned ${name} CLI (independent of PA application dependencies)";
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
