# Non-default PAP-298 qualification artifact. It cannot launch an agent: the
# program accepts no args and invokes only fixed offline Pi help with an inline
# native closure. It is not installed into PPA or added to any runtime PATH.
{ pkgs, host }:
pkgs.runCommand "pa-selected-pi-qualification-${host.pi.version}" {
  nativeBuildInputs = [ pkgs.pkgsStatic.stdenv.cc ];
  passthru = { inherit host; readExceptionEnabled = false; };
} ''
  # Static entry checks inherited loader/preload conflicts BEFORE Node starts.
  # Neither this private command nor the fixed help bootstrap launches an agent.
  mkdir -p "$out/lib" "$out/bin"
  cat > selection.h <<EOF
  #define SELECTED_ENTRY "$out/bin/qualify-selected-pi"
  #define SELECTED_NODE "${host.node}/bin/node"
  #define SELECTED_BOOTSTRAP "$out/lib/qualify.mjs"
  EOF
  $CC -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -O2 -static \
    -I. ${../packages/pi-pa/runtime/selected-host-entry.c} -o "$out/bin/qualify-selected-pi"
  install -Dm444 ${../packages/pi-pa/runtime/selected-host-qualification.mjs} "$out/lib/qualify.mjs"
  mkdir -p "$out/lib"
  # All values are build-selected; $out is expanded once by this trusted builder.
  cat > "$out/lib/selection.mjs" <<EOF
  export const selection = Object.freeze(${builtins.toJSON {
    bootstrapFile = "$out/lib/qualify.mjs";
    selectionFile = "$out/lib/selection.mjs";
    packageRoot = "${host.pi}/lib/node_modules/pi-monorepo";
    hostModule = "${host.pi}/lib/node_modules/pi-monorepo/dist/bundle/index.js";
    nodeFile = "${host.node}/bin/node";
    nodeVersion = host.node.version;
    piVersion = host.pi.version;
  }});
  EOF
''
