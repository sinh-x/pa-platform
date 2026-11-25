#!/usr/bin/env bash
# Hosted Ubuntu 24.04 only. Tests replace commands with isolated fake transports.
set -euo pipefail

readonly fish_package_version='3.7.0-1'
readonly fish_runtime_version='fish, version 3.7.0'
readonly max_attempts=2
readonly -a apt_options=(
  -o APT::Update::Error-Mode=any
  -o Acquire::Retries=0
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
  -o DPkg::Lock::Timeout=15
)

summary() {
  printf '%s\n' "$1"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

fail() {
  summary "Fish infrastructure provisioning failed: $1. Completion checks are not verified."
  echo '::error title=Fish infrastructure provisioning failed::Inspect the provisioning step; fix the runner/package source or review the pin, then rerun. Do not waive completion checks.' >&2
  exit 1
}

provisioned=false
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  echo "Fish provisioning attempt $attempt/$max_attempts (90s per apt command; fish=$fish_package_version)."
  # Strict update prevents a partial DNS failure from reusing stale indexes.
  if timeout --signal=TERM --kill-after=5s 90s sudo -n apt-get "${apt_options[@]}" update; then
    if timeout --signal=TERM --kill-after=5s 90s sudo -n env DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" install -y --no-install-recommends "fish=$fish_package_version" "fish-common=$fish_package_version"; then
      provisioned=true
      break
    else
      status=$?
      echo "Fish package installation failed (attempt $attempt/$max_attempts, exit $status)." >&2
    fi
  else
    status=$?
    echo "Fish package index update failed (attempt $attempt/$max_attempts, exit $status); installation was not attempted." >&2
  fi
  if ((attempt < max_attempts)); then
    echo 'One bounded recovery attempt follows after 5s; package sources and version pins are unchanged.'
    sleep 5
  fi
done

[[ "$provisioned" == true ]] || fail 'both bounded apt attempts failed'
installed_versions="$(timeout --signal=TERM --kill-after=5s 10s dpkg-query -W '-f=${Version}\n' fish fish-common)" || fail 'package version query failed'
[[ "$installed_versions" == "$fish_package_version"$'\n'"$fish_package_version" ]] || fail 'installed fish/fish-common versions do not match the reviewed pin'
runtime_version="$(timeout --signal=TERM --kill-after=5s 10s fish --version)" || fail 'fish executable verification failed'
[[ "$runtime_version" == "$fish_runtime_version" ]] || fail 'fish executable version does not match the reviewed pin'
summary "Fish infrastructure provisioning succeeded on attempt $attempt/$max_attempts: fish=$fish_package_version, fish-common=$fish_package_version; $runtime_version. Syntax and timing checks are still required."
