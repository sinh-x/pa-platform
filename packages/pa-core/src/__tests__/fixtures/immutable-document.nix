# Inert core-mechanics fixture ONLY, not a selected/running Pi identity.
{ pkgs }:
pkgs.runCommand "pa-inert-immutable-document-mechanics" {} ''
  mkdir -p "$out/docs" "$out/examples"
  printf 'inert immutable readme\n' > "$out/README.md"
  ln "$out/README.md" "$out/docs/readme-alias.md"
  ln "$out/README.md" "$out/outside.txt"
  # Deliberately invalid instructional key block; no credential material.
  printf 'ordinary before\n-----BEGIN PRIVATE KEY-----\nINERT_MECHANICS_CANARY_1234567890\n-----END PRIVATE KEY-----\nordinary after\n' > "$out/docs/note.txt"
  ln "$out/docs/note.txt" "$out/docs/note-alias.txt"
  printf 'GIF89aASCII-shaped-inert-image' > "$out/docs/image.gif"
  ln "$out/docs/image.gif" "$out/docs/image-alias.gif"
  printf '\300\257' > "$out/docs/invalid.txt"
  ln "$out/docs/invalid.txt" "$out/docs/invalid-alias.txt"
  printf '// inert immutable example\n' > "$out/examples/example.ts"
  ln "$out/examples/example.ts" "$out/examples/example-alias.ts"
  ln -s ../README.md "$out/docs/symlink.md"
  truncate -s 16777217 "$out/docs/oversized.txt"
  ln "$out/docs/oversized.txt" "$out/docs/oversized-alias.txt"
''
