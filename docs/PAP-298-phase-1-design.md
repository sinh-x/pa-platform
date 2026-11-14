# PAP-298 Phase 1 — reproduction and security-review handoff

Status: **review requested; no hard-link exception implemented or enabled**.
Deployment: d-6cf785. Base: `469e0bf6b12cadd79ddc06a3e050a13760a88e0c`.
Branch: `feature/PAP-298-selected-pi-docs-reader`.
All edits/checks were performed in the selected ticket worktree:
`/home/sinh/.treehouse/pa-platform-cdb114/9/pa-platform`.

The operator selected **Pause for independent reviewer**, then requested this
Phase 1 handoff. This is an implementer's proposal, not independent review or
approval. No runtime installation, selection, active policy, permission, version,
production reader, artifact owner or downstream task was changed.

## Authoritative scope and gate

Published package: `pap-298-selected-pi-docs/r001` under
`agent-teams/requirements/artifacts/packages/PAP-298/` in the external ai-usage
store; read brief, requirements and UAT in full. Package subject:
`896b680f2a298d0ef8d257235f7e048365e02716c3f68994e1f720c47055ccbd`.
Publication decision is separate from implementation/security approval.

Only selected Pi `README.md` and supported text beneath `docs/` and `examples/`
may qualify. No general Nix/store, package, image, binary or mutable-alias
allowance. Keep strict artifact/manifest/package/workspace adoption and review
assets unchanged. Keep complete-file source policy, capability admission and
result checks. Installation and exact installed-reader qualification remain
separately authorized steps.

**Blocking design question:** what internal evidence authenticates the actually
running Pi host and its immutable package, without mistaking the adapter's peer
import, PATH, environment, process argument text or a store-name pattern for
that proof? The present sources do not establish such a contract. Do not enable
an exception while this remains unresolved.

## Reproduction — actual source executor, not installed qualification

Added one historical-baseline test in
`packages/pi-pa/src/__tests__/local-source-security.test.ts`:
`PAP-298 baseline: guarded direct and registered reads reject inert read-only hard links`.
It writes known inert text to an ordinary single-link file and a second regular
file with two names, then makes the latter mode 0444. The fixture is disposable
and user-owned, **not** a simulated authenticated Nix installation.

Both routes execute actual `createSecureLocalReadTool` definitions; the registered
route also passes through `registerPiSessionModules` and its result/safety wrapper.
The single-link control returns the exact known text, including its final newline.
Both two-link calls return:

```text
isError: true
code: LOCAL_SOURCE_UNAVAILABLE
outputWithheld: true
effectState: not-established
```

Neither returned content nor updates contain either inert document line; no
`fullOutputPath` is returned. File identity, size, ownership, mode, link count,
mtime and ctime remain unchanged. Post-denial checks use metadata only; no
alternate reader obtains denied bytes. Atime is intentionally not an invariant:
observation can change it. This test does not independently inspect every possible
internal I/O/spill or prove post-read byte equality; it checks delivered results,
updates, spill reference and recorded metadata.

Source diagnosis remains: `local-source-tools.ts` resolves the file and calls
`readArtifactFile`; `artifacts/manifest.ts:readArtifactFileAt` rejects `nlink !== 1`;
the adapter maps that non-source typed error to `LOCAL_SOURCE_UNAVAILABLE`.
No production behavior was changed to make this reproduction pass. Its success
means **the old failure was reproduced**, not that the bug is repaired. After
review and repair, replace its denial expectation with the reviewed policy cases;
retain this commit and evidence as the original result. A separate trusted positive
fixture must prove selected-document eligibility, not relabel this mutable fixture.

## Proposed architecture for independent review

### 1. Selected-host identity — unresolved prerequisite, deny by default

Preferred trust interface: an internal host-owned identity established at actual
Pi startup, bound to the host's executing entry module, package root, selected
Nix store object and native process lifetime. The adapter consumes an opaque
in-memory identity, not a model argument, JSON assertion, config allowlist,
environment root, global symbol name or filename exception. A caller cannot mint
it through exported production test helpers. Missing/conflicting proof denies only
the multi-link exception; ordinary supported reads continue.

Before implementing that interface, the reviewer/runtime owner must establish:

- How the host identity is obtained from the **actual executing host**, not merely
  `import.meta.resolve` of the adapter's dependency. The adapter development peer
  is 0.84.4; the ticket's configured documentation root is Pi 1.4.0. These can differ.
- How the selected Nix object is authenticated by trusted installation/runtime
  evidence and revalidated, including the exact package/entrypoint association.
  Root ownership and read-only metadata are necessary but are not sufficient
  origin proof. No historical path/hash or store-name regex is permanent authority.
- How startup identity reaches both direct and registered read definitions without
  becoming serializable caller authority or a retained-session permission upgrade.
- What bounded observations can detect a stale host/root/path proof on each read.

Current `native-host.ts:resolvePiNodeHost` discovers a Node executable using PATH
and wrapper parsing for addon compatibility; it does not authenticate the selected
Pi documentation package. Current adapter launch paths execute `pi`; version
preflight is not main-module or package provenance. `selectedReviewAssets` is a
narrow different asset owner and grants no Pi exception.

A kernel-observed main-script candidate (`/proc/self/cmdline`, `/proc/self/exe`,
process birth) may help cross-check a future host identity, but is **not selected
as sufficient proof here**: arguments can describe eval/loaders/wrappers rather
than the executing package. A new host/bootstrap API or packaged attestation may
be necessary. If it needs a dependency or packaging surface change, return that
material necessity to the owner before adding it (NFR-4). No new supported
upstream API is asserted; upstream documentation was not bypassed to invent one.

Reviewer disposition must name a concrete available producer and verification
contract, or keep FR-2 blocked. Approving abstract intent alone cannot establish
missing runtime evidence.

### 2. Separate general-source byte ingress

Proposed new runtime-neutral owner: a dedicated source-file reader next to
`source-content-security.ts`; Pi adapter owns selected-host qualification. No
`allowHardlinks` argument on artifact readers and no change to strict artifact
metadata checks. The source reader's trusted qualification must be internal;
production request input cannot select a fixture root/backend.

Keep valid policy and logical/resolved protected-path checks before access.
Pin physical directories component-by-component from a trusted root, with
`O_DIRECTORY | O_NOFOLLOW`; open the final component relative to its pinned
parent with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. No new multi-link route through
a mutable logical symlink or symlink ancestor, even when its resolved target looks
eligible. Preserve supported single-link logical aliases only under the existing
logical/resolved checks. Do not normalize away evidence of an unsafe route.

For qualified multi-link text, pin/revalidate the selected store object, package
root, document root, every intervening directory and opened regular file. Require
root ownership and no write bits within the immutable object, positive link count,
component-safe relative membership and supported text; exclude sibling-prefix
matches and everything outside exact README/docs/examples scope. `/nix/store`
itself may have writable group/sticky permissions, so blindly requiring every
ancestor to be non-writable is not a usable immutability proof. The trusted Nix
boundary and replacement protections need explicit reviewer disposition; do not
silently exempt writable directories from the proof.

Bound to 16MiB and read at most recorded size plus one byte, checking complete
length and growth. Compare before/after descriptor dev, ino, size, uid, gid, mode,
nlink, mtimeNs and ctimeNs. Recheck live name-to-pinned-object association, directory
identity and logical/resolved source policy against the actual opened object
before returning. An unlinked/replaced file, renamed/replaced ancestor, changed
metadata or selected root denies the entire operation; no partial publication or
automatic retry. Close all owned descriptors in finally blocks. Pinning alone
prevents traversal redirection but does not prove the live pathname still names
the original object; both properties need tests.

### 3. Media, content and publication order

`createSecureLocalReadTool` currently supplies separate access, media-detection
and read callbacks to Pi. The media callback invokes a path-based helper before
the bounded source read. Its exact I/O and cancellation behavior have **not** been
qualified in this phase. The repaired multi-link path must not sniff/read raw bytes
through an unchecked helper before descriptor admission. Review that composition
explicitly: classify only safely acquired bytes, and deny multi-link images/binary
or unsupported text encodings; a `.md` extension is not content qualification.
Single-link image behavior must retain its existing owner/formatting contract.

Once safely acquired, scan all text with `checkSourceContent` under valid selected
and built-in rules before pagination, updates, truncation, spill or result capture.
Private-key body lines remain redacted when their header precedes the requested
page. Keep final `filterLocalToolResult`, native source custody, capability guards,
retained admission and projection notices. Immutable origin never exempts content.

Check abort before ingress and immediately before publishing checked bytes. If
synchronous scanning/reading prevents mid-operation abort delivery, state and test
that limitation; don't claim cooperative mid-read cancellation without a real
async seam. Descriptor cleanup is mandatory on every failure/cancellation path.
No persistent read journal is proposed.

### 4. Typed causes and wording — future changes only

Add finite `LOCAL_SOURCE_UNSUPPORTED_FILE` to `SourceContentCode` for proven
unsupported file/link policy; unknown I/O and changed/missing identity remain
unavailable, oversize stays limit, invalid policy stays policy, protected paths
stay blocked. Do not diagnose exception prose. Preserve existing fields, result
shape, isError, outputWithheld, effectState and stream behavior.

Current failure category/path:
`SourceContentSecurityError -> createSecureLocalReadTool catch -> localContentFailure
-> registered result filter / tool_result`.
Before: unsupported hard links collapse to unavailable/missing-or-changing wording.
Proposed after, only for a proven typed unsupported cause:

```text
Local read blocked: this file type or hard-link policy is unsupported.
Condition: The requested file content was not delivered.
Source: Guarded local source-file policy (LOCAL_SOURCE_UNSUPPORTED_FILE).
Reason: The opened file did not meet supported file/link policy; selected immutable Pi documentation eligibility was not established.
Correction: Ask the runtime/security owner to inspect source eligibility. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs require their owner. Prerequisite: preserve the source and original result; do not copy denied bytes or use another reader.
Resume Action: Retry the normal guarded read only after the owner establishes supported access. Admission and content checks run again; success is not promised.
```

This is not live output. Future tests must check one of each five labels, complete
UTF-16 length <=2000, pure formatting, no raw private context, and real direct,
returned/thrown and registered propagation. Human clarity review remains separate.
No message, code union, inventory digest or public contract changed in Phase 1.

## Review checklist and later phases

Independent reviewer: review the exact Phase 1 commit and published FR-1..7 /
NFR-1..5. Please return findings and disposition with the commit ID; this document
contains no reviewer sign-off.

1. Resolve the concrete selected-host producer and Nix authenticity contract above.
   If it cannot be proven, keep the exception denied and identify the owning change.
2. Review descriptor traversal, mutable logical aliases, writable store boundary,
   live path revalidation, media preflight and cancellation before implementation.
3. Require production-inaccessible test seams; root/owner/mode metadata simulations
   cannot be mistaken for installed proof. Tests must exercise the actual guarded
   executor with an independently qualified inert positive fixture.
4. Phase 2 after review: implement separate reader/binding and negative matrix;
   commit when its applicable checks pass. Include wrong host/package, forged
   arguments/environment, lookalike roots, mutable aliases, owner/mode/link changes,
   symlink/ancestor/path races, missing/directory/FIFO, empty/exact/over-limit,
   UTF-8/growth, cleanup/abort and multi-link image/binary rejection.
5. Phase 3: integrate typed cause/wording, full-file projection, normal/registered
   routes and semantic source-inventory reconciliation; commit after renewed checks.
6. Phase 4: exact final candidate security/code review, full required source matrix
   and hosted CI. Independent final code review cannot be replaced by this design
   review or implementer tests.
7. Phase 5: separately authorized install/selection, exact loaded-module provenance,
   complete selected README/extensions/relevant-example reads, actual human trial.
   Only then notify PAP-287/PAPC-064 of proven access. No dependent API qualification,
   publication/custody reconciliation or Done transition is claimed here.

## Actual Phase 1 checks and preserved failures

All commands ran in the ticket worktree with Node v22.23.4. Local compiled outputs
were rebuilt because package imports resolve pa-core's `dist`; those generated
outputs are not a selected/installed runtime. No tracked generated diff resulted.
Temporary logs are local evidence, not durable publication or independent review.

| Command | Actual result | Log under `/tmp/` |
| --- | --- | --- |
| `NO_COLOR=1 node --import=tsx --test --test-concurrency=1 packages/pi-pa/src/__tests__/local-source-security.test.ts packages/pa-core/src/__tests__/source-content-security.test.ts` (initial) | Exit 1; 6 core pass, Pi import fails: stale dist lacks SourceContentSecurityError | `pap298-phase1-source.log` |
| `corepack pnpm --filter @pa-platform/pa-core build` | Exit 0; local prerequisite rebuilt | `pap298-phase1-core-build.log` |
| Same focused command (after rebuild) | Exit 1; 14 pass/1 fail; new test incorrectly expected Pi to trim the final newline; corrected expectation to preserve exact body | `pap298-phase1-source-rebuilt.log` |
| Same focused command (final) | Exit 0; 15 pass, 0 fail/skip; direct and registered original hard-link rejection reproduced | `pap298-phase1-source-final.log` |
| `NO_COLOR=1 node --import=tsx --test packages/pa-core/src/artifacts/__tests__/manifest.test.ts` | Exit 0; 9 pass, 0 fail/skip, original strict assertions unchanged | `pap298-phase1-manifest.log` |
| `corepack pnpm typecheck` | Exit 0; all workspace projects | `pap298-phase1-typecheck.log` |

Evidence digests (SHA-256, in table order):

```text
2ac5cc998f11abe955d47572276fa82da7abbcc4d591518296a4c96b5e9e0524
6ec9e6df3dc728b115751f26c2e123c495680393eaa49a6d7cbceab48a092783
c3e82b6d99460a5aabd8ed23bfa79a2e7bd0337db0f8bf991205f5927f4cdb1b
a6c67554420a19ae5abf0edb31167d8752ccb9dc37edcc4da12f918f519904cc
341d8d0b3e4afd0e4b83c69ec2b3b876fb0972dbb9c1855253d1662baa5c65d7
884dfa2b8684a5e53c8f0fb81b10084fa0d78d5f85a4ad269c6cb9aca28f8399
```

`git diff --check` and the staged `corepack pnpm secrets:scan` also exited 0.
The scanner covers the staged candidate only; it is not a universal secret audit.

Full repository build/test/completions, V-3 composition, expanded repair/negative
matrix, independent security/code review, hosted CI, installed qualification and
human readability/UAT are **not run for this candidate**. Existing focused cases
cover source-policy/redaction/result behavior but are not the unimplemented
multi-link acceptance matrix. Only Phase 1 is ready for handoff. The source repair
and PAP-287 documentation prerequisite remain blocked on their unproven steps.
