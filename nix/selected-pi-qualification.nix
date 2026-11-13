# Non-default PAP-298 qualification artifact. It cannot launch an agent: the
# program accepts no args and invokes only fixed offline Pi help with an inline
# native closure. It is not installed into PPA or added to any runtime PATH.
{ pkgs, host }:
pkgs.runCommand "pa-selected-pi-qualification-${host.pi.version}" {
  passthru = { inherit host; readExceptionEnabled = false; };
} ''
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
