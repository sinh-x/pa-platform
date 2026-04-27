#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not in a git repository" >&2
  exit 1
fi

status=0
while IFS= read -r -d '' file; do
  [[ -z "$file" ]] && continue
  [[ ! -f "$file" ]] && continue

  if git show ":$file" 2>/dev/null | grep -E -n '(sk-[A-Za-z0-9_-]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|api[_-]?key[[:space:]]*[:=][[:space:]]*[A-Za-z0-9._-]{16,}|password[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,})' >/tmp/pa-platform-secret-scan.$$; then
    echo "Potential secret in staged file: $file" >&2
    sed 's/^/  /' /tmp/pa-platform-secret-scan.$$ >&2
    status=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

rm -f /tmp/pa-platform-secret-scan.$$

if [[ "$status" -ne 0 ]]; then
  echo "Secret scan failed. Remove secret-like values or commit with an explicit documented exception." >&2
fi

exit "$status"
