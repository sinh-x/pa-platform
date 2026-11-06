# PAP-283 / PAPC-077 validation lanes

Do not use one moving runtime or one global `PA_PLATFORM_REPOSITORY` for every test. Runtime selection is an explicit input to each lane, not a permission or passing-result import. Keep failed/partial attempts and perform identity/cleanliness checks before **and after** execution. An unavailable new-profile candidate does not disable independent retained validation.

## Lane A — retained JSON-workflow compatibility

The historical PAPC JSON tests explicitly require runtime:

```
62b0f4162aab59d3ec69228e9e7ba3f9c91d1b78
```

The corresponding retained PAPC baseline used here is:

```
1c4994670088e5ac33e53e31065781d1fc2b0dc3
```

Use clean physical checkouts of those exact commits, with their original cached dependencies and built core/Pi modules. Do not reset an active branch, change the assertion pin or reinterpret a current document-profile config as the historical enabled graph. Example using the existing retained fixture and canonical **read-only test input** checkout (recheck both before using them):

```sh
LEGACY_RUNTIME=/tmp/papc074-retained-runtime-62
LEGACY_PAPC_ROOT=/home/sinh/git-repos/sinh-x/tools/pa-platform-config

test "$(git -C "$LEGACY_RUNTIME" rev-parse HEAD)" = 62b0f4162aab59d3ec69228e9e7ba3f9c91d1b78
test "$(git -C "$LEGACY_PAPC_ROOT" rev-parse HEAD)" = 1c4994670088e5ac33e53e31065781d1fc2b0dc3
test -z "$(git -C "$LEGACY_RUNTIME" status --porcelain=v2 --untracked-files=all)"
test -z "$(git -C "$LEGACY_PAPC_ROOT" status --porcelain=v2 --untracked-files=all)"
(cd "$LEGACY_PAPC_ROOT" && PA_PLATFORM_REPOSITORY="$LEGACY_RUNTIME" \
  node --test scripts/json-workflow-contract.test.mjs)
```

Repeat the exact same identity/cleanliness assertions after the command before accepting its result. This exact lane was actually rerun: **34 passed, zero failed/skipped**. The initial attempt against the concurrently changing PAPC-077 worktree produced 32 passes/two composer failures and is retained as a drifted/in-progress input attempt, not an exact-pair result.

`PA_PLATFORM_REPOSITORY` is REQUIRED even when Node tests are invoked directly. Its omission is a setup error, not a semantic product failure or a reason to skip required cases. Existing PAPC CI pins and historical assertions remain unchanged.

## Lane B — new document-profile source/composition

Select the PAP-283 feature runtime and PAPC-077 feature config **separately**. Required variables for an exact candidate run:

- `DOCUMENT_RUNTIME`: physical runtime feature checkout, never the retained `62b0f416…` fixture.
- `DOCUMENT_RUNTIME_SHA`: explicit full clean runtime commit supplied by its owner.
- `DOCUMENT_PAPC_ROOT` / `DOCUMENT_PAPC_SHA`: explicit physical clean PAPC-077 candidate and full commit supplied by its owner.

Check both clean HEADs against the selected SHAs; preserve original failures if either changes while tests run. Build cached compatible dependencies with the actual existing owners (`corepack pnpm typecheck` / `corepack pnpm build` in runtime). Native profile source tests and installed-verifier unit tests are different observations:

```sh
(cd "$DOCUMENT_RUNTIME" && node --test scripts/dev/verify_document_runtime.test.mjs)
(cd "$DOCUMENT_RUNTIME" && node --import=tsx --test \
  packages/pa-core/src/__tests__/document-*.test.ts \
  packages/pi-pa/src/__tests__/document-*.test.ts)
(cd "$DOCUMENT_PAPC_ROOT" && PA_PLATFORM_REPOSITORY="$DOCUMENT_RUNTIME" \
  node scripts/check-guided-requirements.mjs --source-pair)
(cd "$DOCUMENT_PAPC_ROOT" && PA_PLATFORM_REPOSITORY="$DOCUMENT_RUNTIME" \
  node --test scripts/guided-requirements.test.mjs)
```

The actual new PAPC checker/fixture detector names above exist in committed P3a `4247c721953666655a4d61ac16606b1a0ebbbdf5`. The checker explicitly composes a synthetic profile fixture; it does not activate the candidate config. Run all additional PAPC-owner-required source/contract/template/composition cases with their declared runtime contract. Do **not** run a blanket `node --test scripts/*.test.mjs` against the new runtime: that also selects exact-pin historical tests from Lane A. Explicitly partition new, retained and common-compatible tests, with a complete inventory and no silent omission or skip-as-pass.

During P6 the actual PAPC source checker reported zero lexical findings after the runtime-owned fresh-profile bulletin/lifecycle/failure prose was fixed. Its config input was still an actively edited working tree; that observation is **source-composition evidence only**, not a clean pair, installed qualifier result or acceptance. Retained and OPA instruction projections keep their previous runtime semantics.

## Lane C — historical split-builder/report assertions

The ten existing historical tests assert retired implementation-child/report-5.0 behavior. They were already reproduced on runtime baseline `a40c5941…` and PAP-283 candidate against the same direct-only PAPC `1c499467…`. They must remain intact and be exercised against their correctly pinned historical config/resources, or be explicitly version-dispatched by the owner with retained coverage preserved. Supplying a current direct-only config through `PA_PHASE5_CONFIG_ROOT` is not that historical fixture.

Do not weaken regexes, alter expected roles/report versions, blanket-skip them or call them green to make a full aggregate pass. Their correctly pinned historical fixture and full regression completion remain outstanding owner work. Runtime-native document qualification cannot waive this lane.

## Lane D — exact installed document mechanics

Use [document-installed-qualification.md](document-installed-qualification.md), not the advisory-only verifier. It requires 45 exact document anchors, 13 default public entry observations and four identity/composition/import groups (**62 mandatory IDs**), no required skips and no source fallback. Its private synthetic UI remains distinct from genuine foreground trials.

Before building, both document candidates must be clean/committed, the PAPC candidate must actually opt in with the canonical inlined process and `document_profile`, and runtime-owned `.pa-platform-config.sha` plus `.pa-template-registry.sha` must deliberately bind that exact compatible candidate/registry. Commit any authorized pin refresh **before** producing the runtime artifact. An actively edited PAPC worktree is not a clean final pair.

Package-only recipe, not installation/activation, from a clean exact Git revision:

```sh
CANDIDATE_OUTPUT=$(nix build --offline --no-link --no-write-lock-file --print-out-paths \
  "git+file://${DOCUMENT_RUNTIME}?rev=${DOCUMENT_RUNTIME_SHA}#default")
```

This uses the Git revision as `self.rev`, rather than evaluating an unversioned/dirty path. Missing cached Nix/toolchain inputs must report a packaging blocker; do not fetch/install or relabel an old package to pass. Verify `review-runtime-provenance.json` inside the resulting store output names the exact selected runtime and PAPC commits. Never patch this immutable metadata. A package built against the old retained config can prove its own identity but is **not** a qualified new-profile pair.

Select the immutable output only for the verifier invocation, without changing the system/user profile:

```sh
PATH="$CANDIDATE_OUTPUT/bin:$PATH" \
PA_PLATFORM_HOME="$DOCUMENT_PAPC_ROOT" \
PA_PLATFORM_TEAMS="$DOCUMENT_PAPC_ROOT/teams" \
PA_PLATFORM_SKILLS="$DOCUMENT_PAPC_ROOT/skills/global" \
"$CANDIDATE_OUTPUT/bin/pa-platform-node" \
  "$DOCUMENT_RUNTIME/scripts/dev/verify_document_runtime.mjs" --selected-installed \
  --require-candidate "$DOCUMENT_RUNTIME_SHA" --require-paired-config
```

The driver observes native selected config identity and exact installed pins; these environment paths cannot override its candidate/provenance/pair checks. `ppa document describe` working or equal version labels do not prove fidelity. Existing installed `sourceSha: unversioned-dirty-source` was actually rejected at `WORKFLOW_INSTALLED_CANDIDATE_MISMATCH` before any disposable cases, with all cases `not-run`.

## Separate outstanding observations

Full regressions, complete independent review, hosted CI, genuine normal foreground TS-1–TS-18 and Sinh UAT remain required. A source unit, lexical primer check, 62-ID disposable installed pass or artifact build cannot substitute for them. No native requirements approval, system install, rollout, writer admission or customer acceptance is inferred from any lane.
