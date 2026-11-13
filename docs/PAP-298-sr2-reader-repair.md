# PAP-298 Phase 2a — SR-2 reader repair, SR-1 still blocked

Implementer: d-6cf785. Parent candidate: `3e73a1f47cecf5062be2ed8054b274d1d5772882`.
Branch/worktree: `feature/PAP-298-selected-pi-docs-reader`,
`/home/sinh/.treehouse/pa-platform-cdb114/9/pa-platform`.
This is source implementation evidence, **not renewed independent review**.

## Review consumed and scope

Read d-426bad's complete independent report:
`agent-teams/requirements/artifacts/reviews/PAP-298/d-426bad/phase-1-security-review.md`
in the external ai-usage store. SHA-256 verified:
`7440acb57d18e060ce9f757cf9f1bd484e5b6fc4f49ccc50b8fbb2a044d17141`.
Disposition: Phase 1 evidence acceptable; hard-link enabling gate NOT CLEARED.

- **SR-2:** inherited path-based MIME preflight read a rejected link and could hang
  on a FIFO before artifact NONBLOCK checks. This candidate replaces that I/O order.
- **SR-1:** no concrete authenticated actually-running Pi package producer exists.
  All hard links still fail closed. No selected-host exception or fixture-root
  override is implemented. Sinh separately authorized host/bootstrap **design work**
  for the next phase, not installation, a dependency bump, or enabling unreviewed
  support. The proof contract must return for independent review.

No artifact reader/manifest/review-asset code or strict assertion changed. No new
model tool, config allowlist, permission, version/dependency, installation, active
selection, downstream resumption or lease-return action was introduced.

## Implemented source contract

`packages/pa-core/src/local-source-file.ts:acquireLocalSourceFile` is a separate
Linux general-source owner. It checks logical and resolved path policy, resolves
and checks the physical source, pins directories with DIRECTORY/NOFOLLOW, then
opens the final file NOFOLLOW/NONBLOCK. Regular file, positive single link and
16MiB bound are required **before any content read**. Unsupported/nonregular links
are typed; absent, replaced, interrupted or unknown I/O remains unavailable.

It reads at most the recorded size plus one byte and validates complete length,
growth, dev/ino/size/uid/gid/mode/nlink/mtime/ctime. The returned owned acquisition
keeps all descriptors until close. `assertStable` also rechecks directory identity,
owner/mode, live fd paths, no-symlink parent-child association, final entry and
logical/physical source policy. Directory entry timestamps are intentionally not
compared for ordinary mutable parents: an unrelated sibling creation isn't a file
identity change. This is not immutable-host qualification.

Pi's access/media/read callbacks share one acquisition. `prepare` scans all acquired
bytes before pagination; image classification is a pure function over the same
admitted buffer, not a pathname open. Sensitive-shaped image bytes remain withheld
under existing image policy. Pi still owns image processing and text pagination.
Descriptors stay pinned across its async processing; identity and abort are checked
again before delivering the filtered result. Cleanup is in finally, including
failure/cancellation; a cleanup failure cannot become content success.

`local-image-type.ts` adapts the local Pi 0.84.4 MIT signature policy and its 4100-byte
sniff window, with attribution. It avoids a new dependency or private subpath import.
Parity tests compare inert ordinary single-link fixtures against the existing Pi
helper, covering JPEG/JPEG-LS exclusion, PNG/APNG, GIF, WebP, BMP and truncated
headers. This does not qualify the installed Pi 1.4.0 reader or future signatures.

Synchronous ingress/scanning still cannot service an externally scheduled abort
mid-turn. Tests cover pre-abort, an actual synchronous test seam and abort in the
async callback gap. No cooperative mid-read external interruption, hostile same-UID
sandbox, universal binary/secret detection or persistent operation journal is claimed.

## Messages and compatibility

Affected categories: local read failure/blocker; shared unavailable wording only.
Path: `SourceContentSecurityError -> guarded read -> localContentFailure -> direct /
registered result filtering`. No success/help/bash presentation redesign.

Before: unsupported links returned `LOCAL_SOURCE_UNAVAILABLE` with supported-file /
possibly missing-or-changing reason, although the link policy caused the rejection.
After: additive `LOCAL_SOURCE_UNSUPPORTED_FILE` in the existing `details.code`, with
reason:

> The opened source did not meet supported regular-file/single-link policy.
> Selected immutable Pi documentation eligibility has not been established.
> No content is delivered.

Unavailable now says a complete stable read could not be established, possibly
absent/changed/interrupted. It does not diagnose an arbitrary I/O error as link
policy. Invalid read-policy loading is explicitly `LOCAL_CONTENT_POLICY` before
acquisition. Existing isError/outputWithheld/effectState, result/stream shape,
filename/path rejection, full-file projection, final result filtering and capability
admission remain in place. No new machine fields or exit/stream owner changes.

Existing pure five-field guidance is reused: ask the security/runtime owner to
inspect classification/rules (impact none, actor agent/operator, no approval to ask,
preserve source/original coordinates, no denied-byte copying/bypass); retry only
after permitted access/working policy, preserving uncertain effect inspection.
Finite fixed diagnostics have no caller text/context field to pad to the 2000-unit
boundary. Tests cover all finite codes, <=2000 UTF-16 units, one of each label,
NO_COLOR/plain output, no paths/private unknown I/O text, and actual returned direct
and registered failures. Independent human clarity review is NOT RUN.

Inventory reconciliation: no operation IDs/CLI forms/aliases/effect classifications,
capability lists or retained/public custody changed. `ordinary.read` continues to
name the guarded owner. New acquisition/classifier owners are tracked in the source
inventory; changed index/source-security/adapter hashes were renewed only after
that semantic comparison. Inventory hashes are not independent security approval.

## Actual checks and original failures

All invocations are source checks in the selected worktree, Node v22.23.4. Logs
below are local `/tmp/` evidence, not hosted CI or installed proof.

Focused command F:

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/local-source-security.test.ts \
  packages/pi-pa/src/__tests__/local-image-type.test.ts \
  packages/pa-core/src/__tests__/local-source-file.test.ts \
  packages/pa-core/src/__tests__/source-content-security.test.ts \
  packages/pa-core/src/artifacts/__tests__/manifest.test.ts
```

Composition command C:

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/requirements-tool-parity.test.ts \
  packages/pi-pa/src/__tests__/mode-capability-session.test.ts \
  packages/pi-pa/src/__tests__/pi-extension-composition.test.ts \
  packages/pa-core/src/__tests__/interactions-catalogue.test.ts \
  packages/pa-core/src/__tests__/interactions-discovery.test.ts
```

| Invocation | Actual outcome | Log under `/tmp/` |
| --- | --- | --- |
| `corepack pnpm --filter @pa-platform/pa-core build` | Exit 0, repeated after source edits | `pap298-sr2-core-build{,-final}.log` |
| F, first run | Exit 1: 33 pass/2 fail; inline PNG fixture didn't produce an image, and global fd count changed while async image-worker cleanup ran | `pap298-sr2-focused-initial.log` |
| Pi local-source suite alone, after fixture corrections | Exit 0: 13 pass; generated a valid PNG with existing sharp dependency, tracked owned sync descriptors rather than unrelated global async cleanup | `pap298-sr2-pi-rerun.log` |
| Pi package typecheck | Exit 0 | `pap298-sr2-pi-typecheck.log` |
| F, expanded/final | Exit 0: **38 pass**, no failures/skips/cancellations; includes **9 unchanged strict manifest cases** | `pap298-sr2-focused-final.log` |
| `corepack pnpm typecheck` | Exit 0, all projects | `pap298-sr2-typecheck.log` |
| `corepack pnpm build` | Exit 0, all projects | `pap298-sr2-build.log` |
| C | Exit 0: **16 pass**, no failures/skips/cancellations | `pap298-sr2-composition.log` |
| `corepack pnpm test` | **Incomplete: harness timeout at 600s; no aggregate exit/pass.** Completed root42/42, core1978 pass/14 skip, OPA106 pass/1 skip, Pi script11/11; Pi source suite still running at case473 when interrupted. No failing TAP case observed; NOT a full-suite pass. No matching test processes remained in subsequent process inspection | `pap298-sr2-workspace-test.log` |
| `corepack pnpm --filter @pa-platform/pi-pa bundle:extensions` | Exit 0; restore normal generated selection after interrupted test script | `pap298-sr2-restore-bundle.log` |
| `corepack pnpm completions` | Exit 0, no tracked completion diff | `pap298-sr2-completions.log` |

The new actual-tool FIFO test executes both direct and registered reads in an
isolated child with no FIFO writer, an 8-second hard watchdog and <2-second tool
settlement assertion. Both return typed unsupported results. Unlike the reviewer's
baseline watchdog exit137, this source test exits0 normally. Rejected links produce
zero instrumented data/MIME reads; accepted ordinary text has one bounded acquisition
(body and EOF probe), not a sniff/read duplicate. Other tests cover exact/empty/over
bounds, UTF-8, safe aliases, protected sources, growth, inode/path/ancestor/metadata
changes, pre/during/after-ingress abort seams, cleanup on partial acquisition failure,
invalid policy, secret-block pagination, private exceptions and result guards.

Selected log SHA-256 pins:

```text
1edaf5dd4cad8cabb2669e059a478e39f1d46ea26e0ce2d273b6b755137321f2  focused-initial
73ef37308a2f167f49b82931b47b26ec6d3c66a028e9de5a4aad3c030616b2a7  pi-rerun
3010733bf839457078f1361ab741613502d67d323e49d740114c40be4d1bf2bc  focused-final
884dfa2b8684a5e53c8f0fb81b10084fa0d78d5f85a4ad269c6cb9aca28f8399  typecheck
55f822adab12ca3302f0e682f1390a6cbde650f92790822bd038c144f175ee7f  build
4b479b3e998e75639f5005500dbb6bdb9909faf9997be9009f83cfc94a63d387  composition
d9dcb3c10b6ef916da7c9bf3849e091e616560a6bc27f2075d7e87aec8fab2c9  workspace-test-incomplete
e1d1b07f95d8ca401cfd0cdf0b1c193f297239364f8e4a06d90c6dbbd7ae9300  completions
```

## Review/continuation boundary

SR-2 has a source repair candidate, **not an independent resolved finding** until
the reviewer examines the exact commit and tests. SR-1 remains an enabling blocker.
The next design phase must specify a trusted build/runtime producer that actually
executes its selected Pi payload, not just transports an asserted root. No positive
hard-link implementation is authorized by source-test success. Final security/code
review, completed full regression, hosted CI, separately authorized installed reader
provenance/reads and human clarity/UAT remain outstanding. PAP-287/PAPC-064 remain
blocked; retained histories and resource custody are unchanged.
