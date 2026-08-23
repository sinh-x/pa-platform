#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PA_PHASE5_CONFIG_ROOT:-}" ]]; then
  printf 'PA_PHASE5_CONFIG_ROOT is required; set it to the pinned pa-platform-config checkout\n' >&2
  exit 2
fi

if [[ ! -f "$PA_PHASE5_CONFIG_ROOT/config.yaml" || ! -d "$PA_PHASE5_CONFIG_ROOT/teams" || ! -d "$PA_PHASE5_CONFIG_ROOT/skills" ]]; then
  printf 'PA_PHASE5_CONFIG_ROOT must point to a pa-platform-config checkout: %s\n' "$PA_PHASE5_CONFIG_ROOT" >&2
  exit 2
fi

export PA_PHASE5_CONFIG_ROOT
corepack pnpm --filter @pa-platform/pa-core test
corepack pnpm --filter @pa-platform/opencode-pa test
