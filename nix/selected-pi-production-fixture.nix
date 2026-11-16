# Newly authored inert documents for the real production PPA build/dispatcher.
# The flake's private builder selects this payload at build time; no runtime
# root, host override, grant, alternate bootstrap or copied denied document.
{ payload }:
payload.overrideAttrs (old: {
  pname = "pa-selected-pi-inert-documents";
  postInstall = (old.postInstall or "") + ''
    root="$out/lib/node_modules/pi-monorepo"
    mkdir -p "$root/docs" "$root/examples"
    printf 'INERT_PPA_SELECTED_README\nordinary second line\n' > "$root/README.md"
    ln "$root/README.md" "$root/docs/pap298-readme-alias.md"
    ln "$root/README.md" "$root/pap298-outside.txt"
    printf 'ordinary before\n-----BEGIN PRIVATE KEY-----\nINERT_PRIVATE_DOCUMENT_CANARY\n-----END PRIVATE KEY-----\nordinary after\n' > "$root/docs/pap298-note.txt"
    ln "$root/docs/pap298-note.txt" "$root/docs/pap298-note-alias.txt"
    printf '// INERT_PPA_SELECTED_EXAMPLE\n' > "$root/examples/pap298-example.ts"
    ln "$root/examples/pap298-example.ts" "$root/examples/pap298-example-alias.ts"
    printf 'GIF89aINERT_PPA_IMAGE' > "$root/docs/pap298-image.gif"
    ln "$root/docs/pap298-image.gif" "$root/docs/pap298-image-alias.gif"
  '';
})
