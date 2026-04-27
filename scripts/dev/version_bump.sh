#!/usr/bin/env bash
# version_bump.sh — bump package versions, generate changelog, tag, and push
# Usage: ./scripts/dev/version_bump.sh [patch|minor|major] [--no-edit] [--force] [--refresh-hash]
set -euo pipefail

BUMP="patch"
NO_EDIT=false
FORCE=false
REFRESH_HASH=false

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --no-edit) NO_EDIT=true ;;
    --force) FORCE=true ;;
    --refresh-hash) REFRESH_HASH=true ;;
    *) echo "Usage: $0 [patch|minor|major] [--no-edit] [--force] [--refresh-hash]"; exit 1 ;;
  esac
done

refresh_pnpm_deps_hash() {
  local last_tag; last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  local lock_changed=false
  if [[ -n "$last_tag" ]] && git diff --quiet "$last_tag" -- pnpm-lock.yaml; then
    :
  else
    lock_changed=true
  fi
  git diff --quiet -- pnpm-lock.yaml || lock_changed=true
  [[ "$lock_changed" == false ]] && echo "pnpm-lock.yaml unchanged — skipping hash refresh" && return 0

  command -v nix >/dev/null || { echo "ERROR: nix not available, cannot refresh pnpmDeps.hash"; return 1; }

  echo "pnpm-lock.yaml changed — refreshing flake.nix pnpmDeps.hash"
  if nix build .#pa-platform --no-link 2>/dev/null; then
    echo "Hash already correct — no refresh needed"
    return 0
  fi

  local tmpfile; tmpfile=$(mktemp)
  sed -i.bak 's|hash = "sha256-[^"]*"|hash = ""|' flake.nix
  nix build .#pa-platform --no-link 2>&1 | tee "$tmpfile" || true
  local got; got=$(grep -oP 'got:\s+\Ksha256-\S+' "$tmpfile" | head -1)
  if [[ -z "$got" ]]; then
    mv flake.nix.bak flake.nix
    rm -f "$tmpfile"
    echo "ERROR: could not extract expected hash from nix build output"
    return 1
  fi
  sed -i "s|hash = \"\"|hash = \"$got\"|" flake.nix
  rm -f flake.nix.bak "$tmpfile"

  nix build .#pa-platform --no-link || { echo "ERROR: build still fails after hash refresh"; return 1; }
  echo "pnpmDeps.hash refreshed to $got"
}

if [[ "$REFRESH_HASH" == true ]]; then
  refresh_pnpm_deps_hash
  exit $?
fi

CURRENT=$(node -e "process.stdout.write(require('./package.json').version)")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
NEW="$MAJOR.$MINOR.$PATCH"

echo "Bumping $CURRENT -> $NEW ($BUMP)"

if [[ "$FORCE" == false ]]; then
  LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  RANGE="${LAST_TAG:+${LAST_TAG}..HEAD}"
  if [[ "$BUMP" == "patch" ]]; then
    FEAT_COMMITS=$(git log ${RANGE:-HEAD} --oneline --grep='^feat' 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$FEAT_COMMITS" -gt 0 ]]; then
      echo "WARNING: $FEAT_COMMITS feat commit(s) found since last tag. Consider bumping minor instead."
    fi
  elif [[ "$BUMP" == "minor" ]]; then
    BREAKING_COMMITS=$(git log ${RANGE:-HEAD} --oneline --grep='BREAKING CHANGE' 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$BREAKING_COMMITS" -gt 0 ]]; then
      echo "WARNING: $BREAKING_COMMITS BREAKING CHANGE commit(s) found since last tag. Consider bumping major instead."
    fi
  fi
fi

node -e "
const fs = require('fs');
for (const file of ['package.json', 'packages/pa-core/package.json', 'packages/opencode-pa/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = '$NEW';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
"

corepack pnpm build
refresh_pnpm_deps_hash || { echo "Aborting bump due to hash-refresh failure"; exit 1; }

if command -v git-cliff &>/dev/null; then
  git-cliff --config cliff.toml --unreleased --tag "v$NEW" --prepend CHANGELOG.md
  echo "Changelog updated."
else
  echo "WARNING: git-cliff not found — skipping changelog generation (run inside nix devshell to enable)"
fi

if [[ "$NO_EDIT" == false ]]; then
  echo "Review CHANGELOG.md before continuing"
  read -r -p "Press Enter to continue (Ctrl+C to abort)..."
fi

git add package.json packages/pa-core/package.json packages/opencode-pa/package.json flake.nix
[[ -f CHANGELOG.md ]] && git add CHANGELOG.md
git commit -m "chore: bump version to $NEW"
git tag -a "v$NEW" -m "Release v$NEW ($(date +%Y-%m-%d))"
git push && git push --tags

echo "Done — v$NEW pushed with tag v$NEW"
