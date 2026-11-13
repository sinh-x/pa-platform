# Explicit fixed-operation qualification only. Never selected by PPA/defaults.
# The Pi derivation is rebuilt from its approved fixed inputs with newly authored
# inert documents. No denied installed documentation is copied as a fixture.
{ pkgs, host, foundation }:
let
  fixturePi = host.pi.overrideAttrs (old: {
    pname = "pa-inert-selected-pi";
    postInstall = (old.postInstall or "") + ''
      root="$out/lib/node_modules/pi-monorepo"
      mkdir -p "$root/docs" "$root/examples"
      printf 'PAP-298 inert selected documentation\nordinary second line\n' > "$root/README.md"
      ln "$root/README.md" "$root/docs/PAP-298-readme-alias.md"
      ln "$root/README.md" "$root/PAP-298-outside.txt"
      # Deliberately invalid instructional key block; no credential material.
      printf 'ordinary before\n-----BEGIN PRIVATE KEY-----\nINERT_DOCUMENT_CANARY_1234567890\n-----END PRIVATE KEY-----\nordinary after\n' > "$root/docs/PAP-298-note.txt"
      ln "$root/docs/PAP-298-note.txt" "$root/docs/PAP-298-note-alias.txt"
      printf '// inert selected example\n' > "$root/examples/PAP-298-example.ts"
      ln "$root/examples/PAP-298-example.ts" "$root/examples/PAP-298-example-alias.ts"
      printf 'GIF89aASCII-shaped-inert-image' > "$root/docs/PAP-298-image.gif"
      ln "$root/docs/PAP-298-image.gif" "$root/docs/PAP-298-image-alias.gif"
      printf '\300\257' > "$root/docs/PAP-298-invalid.txt"
      ln "$root/docs/PAP-298-invalid.txt" "$root/docs/PAP-298-invalid-alias.txt"
      printf 'inert protected filename fixture\n' > "$root/docs/.env"
      ln -s ../README.md "$root/docs/PAP-298-symlink.md"
    '';
  });
in pkgs.runCommand "pa-selected-pi-document-qualification-${host.pi.version}" {
  nativeBuildInputs = [ pkgs.pkgsStatic.stdenv.cc host.node ];
  passthru = { inherit fixturePi foundation; productionEnabled = false; };
} ''
  mkdir -p "$out/lib" "$out/bin" work/packages/pa-core/src work/packages/pi-pa/src/pi-extension work/packages/pi-pa/runtime
  cp ${../packages/pa-core/src}/{local-source-file,immutable-document-policy,source-content-security,sensitive-patterns,safety-policy,paths}.ts work/packages/pa-core/src/
  cp ${../packages/pi-pa/src/pi-extension}/{bound-local-read,local-read-paths,local-image-type,local-content-security}.ts work/packages/pi-pa/src/pi-extension/
  cp ${../packages/pi-pa/runtime/local-source-core.ts} work/packages/pi-pa/runtime/local-source-core.ts
  cp ${../packages/pi-pa/runtime/selected-document-qualification.mjs} work/packages/pi-pa/runtime/qualify.mjs
  ln -s ${foundation}/share/pa-platform/node_modules work/node_modules
  ${foundation}/share/pa-platform/packages/pi-pa/node_modules/.bin/esbuild \
    work/packages/pi-pa/runtime/qualify.mjs --bundle --platform=node --format=esm --target=node24 \
    --alias:@pa-platform/pa-core="$PWD/work/packages/pi-pa/runtime/local-source-core.ts" \
    --external:./selection.mjs \
    --banner:js="import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(import.meta.url);" \
    --outfile="$out/lib/doc-qualify.mjs"
  nodeExecutable="$(readlink -f ${host.node}/bin/node)"
  cat > selection.h <<EOF
  #define SELECTED_ENTRY "$out/bin/qualify-selected-documents"
  #define SELECTED_NODE "$nodeExecutable"
  #define SELECTED_BOOTSTRAP "$out/lib/doc-qualify.mjs"
  #define SELECTED_SELECTION "$out/lib/selection.mjs"
  #define SELECTED_SUPERVISED 1
  EOF
  $CC -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -O2 -static \
    -I. ${../packages/pi-pa/runtime/selected-host-entry.c} -o "$out/bin/qualify-selected-documents"
  cat > "$out/lib/selection.mjs" <<EOF
  export const selection = Object.freeze(${builtins.toJSON {
    bootstrapFile = "$out/lib/doc-qualify.mjs";
    selectionFile = "$out/lib/selection.mjs";
    entryFile = "$out/bin/qualify-selected-documents";
    packageRoot = "${fixturePi}/lib/node_modules/pi-monorepo";
    hostModule = "${fixturePi}/lib/node_modules/pi-monorepo/dist/bundle/index.js";
    nodeFile = "$nodeExecutable";
    nodeVersion = host.node.version;
    piVersion = host.pi.version;
  }});
  EOF
''
