#!/usr/bin/env bash
# PAP-240: independent-review installed-output matrix. No source/runtime fallback.
set -euo pipefail
if [[ $# -ne 9 || "$1" != --system || "$2" != x86_64-linux ||
      "$3" != --eval-system || "$4" != aarch64-linux || "$5" != --all-selections ||
      "$6" != --chrome || "$7" != /* || "$8" != --log-file || -z "$9" ]]; then
  printf '%s\n' 'usage: axi-nix-output-smoke.sh --system x86_64-linux --eval-system aarch64-linux --all-selections --chrome PATH --log-file PATH' >&2
  exit 2
fi
if [[ -z "${PA_DEPLOYMENT_DIR:-}" || -z "${PA_DEPLOYMENT_ID:-}" ]]; then
  printf '%s\n' 'AXI smoke requires trusted PA_DEPLOYMENT_ID and PA_DEPLOYMENT_DIR' >&2
  exit 2
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# The Python coordinator records starts/ends/exits, enforces completeness and
# bounds, and always writes failure JSON after evidence admission. Runtime tests
# use the built output's Node and modules, never workspace-built modules.
exec python3 "$script_dir/axi-smoke/matrix.py" "$@"
