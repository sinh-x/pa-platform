#!/usr/bin/env bash
set -euo pipefail
package=${1:?usage: pap-252-packaged-treehouse-smoke.sh /nix/store/...-pa-platform}
script=$(realpath "$(dirname "${BASH_SOURCE[0]}")/pap-252-treehouse-smoke.mjs")
for version in 2.3.0 3.1.3 99.0.0; do
  root=$(mktemp -d -t pap252-XXXXXXXX)
  trap 'rm -rf -- "$root"' EXIT
  mkdir -p "$root/hostile" "$root/tmp" "$root/config-home"
  printf '#!/bin/sh\ntouch %q\nprintf "v%s\\n"\nexit 77\n' "$root/ambient-invoked" "$version" > "$root/hostile/treehouse"
  chmod +x "$root/hostile/treehouse"
  env -i HOME="$root" TMPDIR="$root/tmp" XDG_CONFIG_HOME="$root/config-home" \
    PATH="$root/hostile:$PATH" NODE_OPTIONS="--import=$script" \
    PA_TREEHOUSE_BINARY="$root/hostile/treehouse" \
    "$package/bin/ppa" --version
  test ! -e "$root/ambient-invoked"
  rm -rf -- "$root"
  trap - EXIT
done
