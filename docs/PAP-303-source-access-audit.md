# PAP-303 — P1 source-access checkpoint

Date: 2026-11-16. Deployment: `d-4b9ba1`, Pi / `rogue-one`.
Status: **P1 incomplete; no Herdr implementation or qualification claimed.**

## Outcome and operator direction

Sinh requested all PAP-303 phases, with a separate commit after each completed
phase. After the required installed-source reads were denied, he selected an
investigation of the repository-local source-access policy. He subsequently asked
to document the issue, capture an idea in today's journal, and continue the planned
implementation. He considers the builder/orchestrator workflow restriction
inappropriate for rogue-one.

Distinguish that workflow concern from the observed security boundary: the
current **rogue-one** deployment also received source-aware read denials. Its
primer bypasses workflow/ticket/repository admission but explicitly retains
sensitive-input validation, adapter safety hooks and host/tool constraints.
Neither a different team label nor an implementation request repairs source
eligibility. No denied content was read through shell, copied, fetched under an
alternate locator or hashed as a substitute for permitted acquisition.

## Exact checkout and source observations

- Ticket checkout: `/home/sinh/.treehouse/pa-platform-cdb114/15/pa-platform`.
- Branch: `feature/PAP-303-herdr-trusted-bridge`.
- Initial HEAD: `4242bf7d74ec783c5363e1d306a5d1311e65406d`, source version 0.1.165.
- Canonical checkout observed read-only at
  `9489913500316d34c2ad892edb2c0f3e7009d22a`, version 0.1.170, clean.
  No fetch, merge, rebase, reset, checkout return or canonical mutation occurred.
- Installed commands reported `ppa 0.1.170` and Pi `1.4.0`. These version strings
  do not authenticate every loaded module or establish exact installed custody.

The following two reads through the normal `read` tool each returned
`LOCAL_SOURCE_UNSUPPORTED_FILE`, with the reason that qualified selected-Pi
documentation eligibility was not established:

| Requested source | Metadata-only observation; not a content digest |
| --- | --- |
| `/nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0/lib/node_modules/pi-monorepo/README.md` | Regular file, mode 0444, 9 links, 4,080 bytes |
| `/home/sinh/.pi/agent/extensions/herdr-agent-state.ts` | HOME symlink through Home Manager; resolves to `/nix/store/x78xy43yn8lhlc64mh8d98agni3v8cla-herdr-agent-state.ts`, regular file, mode 0444, root-owned, 8 links, 6,694 bytes |

Only pathname/link/stat metadata was inspected for those denied sources. Their
bodies, hashes, licenses, privilege inventory, installed APIs and genuine loading
behavior remain **unverified**. Historical `LOCAL_SOURCE_UNAVAILABLE` and the prior
builder `LOCAL_SOURCE_UNSUPPORTED_FILE` observations remain valid history.

## Classifier trace and interpretation

On the ticket baseline:

1. `packages/pi-pa/src/pi-extension/local-source-tools.ts` checks logical and
   physical paths and uses the existing strict artifact-file acquisition owner.
2. `packages/pa-core/src/source-content-security.ts` checks protected paths and
   configured filename/path rules; content projection does not grant source access.
3. `packages/pa-core/src/artifacts/manifest.ts:readArtifactFileAt` requires a
   descriptor-pinned regular file with exactly one link. It rejects multi-links
   before reading payload bytes. The ordinary read wrapper maps acquisition errors
   to `LOCAL_SOURCE_UNAVAILABLE` on this older baseline.

The current denial code is not even present in that baseline's error union. The
running tool and ticket source are different versions; modifying this checkout
cannot hot-patch the already running reader.

Newer canonical source was independently inspected, not substituted for the
unread installed Pi/Herdr bodies:

- `packages/pa-core/src/local-source-file.ts` keeps ordinary acquisition
  single-link and adds a separate internal selected-Pi acquisition route.
- `packages/pa-core/src/immutable-document-policy.ts` limits that route to the
  exact selected Pi's README, docs and examples, with finite text checks.
- `packages/pi-pa/runtime/selected-pi-host.mjs` constructs the private reader only
  around its fixed executing host, validates immutable build/process/lifetime
  custody and does not accept a model-provided root or grant.
- `flake.nix` defaults `enableSelectedPiHost` to false. Its source existence or
  installed version number does not prove this session selected it.

The multi-link metadata is consistent with the documented rejection policy;
there is no evidence of an accidental sensitive-filename match. Even a properly
qualified selected-Pi reader would **not** authorize the Herdr extension: it lies
outside the selected Pi documentation scope. This is not a proven complete
root-cause analysis of installed runtime selection or Herdr agent detection.

## Proposed owner-scoped repair, not an enabled exception

1. Reuse PAP-298's selected-host reader rather than weakening the artifact reader
   or adding a team-specific hard-link exemption. The runtime owner must qualify
   the actual selected build/reader and normal complete Pi documentation reads.
   Preserve its publication/cancellation and installed-qualification gaps.
2. Define and review a separate finite **audit-source acquisition** contract for
   the exact NX-selected Herdr integration and necessary API/license sources.
   Derive selection from immutable package provenance, not arbitrary HOME/project
   discovery, tool JSON, environment roots or a blanket `/nix/store` rule. Recheck
   aliases, descriptors, immutable ancestry, source identity and lifetime through
   checked publication. Reading this audit input must never execute the extension
   or imply selection of its privileges for managed composition.
3. Preserve protected logical/resolved path rules, complete-file scanning before
   pagination, UTF-8/text and size bounds, no raw progress/spill and fail-closed
   behavior. Keep all strict artifact/adoption owners unchanged. A new access
   contract needs its own runtime/security review; this document does not mint it.
4. After authorized qualification/selection, retry through the normal guarded
   reader. Only then record actual source/API/license hashes and complete PAP-303
   requirements §5's six-item contract, independent security review and Sinh's
   material-contract review. No current-session fallback reader or automatic
   installation/relaunch is proposed.

A non-rewriting integration of newer source into the ticket branch is a separate
Git decision; it would not by itself establish installed source access. No such
integration was performed in this investigation.

### Required repair validation

- Positive: the actual registered executing selected-host reader returns complete
  selected Pi docs with current provenance; the separately admitted Herdr audit
  source can be read without loading/executing it.
- Negative: wrong/absent/forged build binding, unrelated store file, arbitrary HOME
  source, protected logical/resolved alias, mutable hard link, changed alias or
  descriptor, invalid text/media, excessive size and malformed policy all deny.
- Race/lifetime: cancellation, session shutdown, source/host drift and cleanup
  failure before the owned publication boundary withhold content and settle owned
  descriptors; no fallback, unchecked update or spill.
- Regression: ordinary single-link text/images and aliases retain their contract;
  strict artifact adoption still rejects aliases/hard links. Rogue-one and
  builder differences are tested without creating a confidentiality bypass.
- Evidence lanes stay separate: source checks, independent exact-candidate review,
  hosted CI, installed normal-reader qualification and human acceptance.

These are proposed tests, not executed repair results or the full PAP-303 matrix.

## Checks actually executed

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pa-core/src/__tests__/source-content-security.test.ts \
  packages/pa-core/src/artifacts/__tests__/manifest.test.ts
```

Result: **15 passed, 0 failed, 0 skipped**, exit 0. Covers source/path/content
projection and unchanged strict artifact adoption, including hard-link rejection.

A separate in-memory Node test invocation created only new inert temporary text,
verified strict acquisition succeeds with one link and rejects both names after
adding a second link, and removed its fixture. Result: **1 passed**, exit 0.
It used no denied source bytes and is an investigation probe, not a tracked suite
or a test of the installed reader.

No runtime human-facing messages changed. Before/after public runtime wording,
message categories, machine fields, exit/stream behavior and audit owners are
unchanged. The observed source-denial message is not a new product message.
Human readability review and installed propagation are not established by these
source checks. Typecheck/build/full workspace/completions, actual Herdr tests,
independent security review, hosted CI and genuine Sinh UAT were not run for a
product implementation in this investigation.

## Phase and handoff status

| Phase | Current outcome |
| --- | --- |
| P1 audit/contract | Partial investigation only. Exact source/API/license/privilege audit, composition choice, atomic submission feasibility, live loading comparison and material-contract review remain unmet. |
| P2 lifecycle | Not started; depends on the reviewed P1 contract. |
| P3 guarded messaging | Not started. No safe atomic provenance/dialog/identity/read-only submission path has been proven; messaging remains unavailable. |
| P4 qualification/NX handoff | Not run. No installed/default-entry/actual builder-peer R1/R2, standalone, independent review/CI or genuine Sinh UAT claim. |

The commit containing this document is an **audit checkpoint**, not a completed
P1 commit. Subsequent completed phases must still receive separate commits.
No live pane/session operation, peer messaging, installation, activation, push,
NX source mutation or product/ticket completion is performed by this checkpoint.
