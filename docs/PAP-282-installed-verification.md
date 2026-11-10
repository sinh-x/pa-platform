# PAP-282 installed interaction observations

PAP-282 is **not complete**. The implemented slices are source inventory,
requirements-v4 ticket intake, exact-ticket inspection/reuse, and five-field
scalar planning. This document does not replace the approved requirements,
change signed package bytes, activate configuration, or approve the external-read
amendment.

## What the selected installation contains

Observed during deployment `d-b9e71b`:

- `ppa --version`: `ppa 0.1.158-pap282.1`.
- Installed package: `/nix/store/aav82n6nh6lx736prm2i6bh0m81d7fm9-pa-platform-0.1.158-pap282.1`.
- Comparison worktree commit: `24b99576962c9b74bbf323cdcdcc0ba5a2ce4523`.
- Native package provenance says **`unversioned-dirty-source`**, not that commit.
- After building with the same `pi-vimmode` selection, **306 implementation and
  package-metadata files match byte-for-byte**, including the installed Pi
  adapter, core handlers, and generated plugin metadata. Inventory SHA-256:
  `8a5a7ed0349404d49c5065f35d28c972ba846efc1cc641d3c6b948101a21c37c`.
- Build config pin: `1c4994670088e5ac33e53e31065781d1fc2b0dc3`;
  template registry pin:
  `86c78a59faf6b2130ef8a73c44112c94b584706d36ca54007a540d0c2d14b7d5`.

Byte parity establishes the compared product contents, **not** native commit
provenance or reproducible build inputs. Do not relabel the installed metadata or
turn a comparison-mode pass into an exact-provenance qualification.

## Can requirements/analyze create a ticket in another project?

The installed code supports **explicit companion creation** through
`pa_ticket_intake` in a fresh foreground requirements/analyze session selected
with `document_profile: pa-document-interactions/v4`. The caller must have a bound
primary ticket, and the destination must be an exact registered project key.
Companion creation preserves the original primary association and grants no
access to the other project's files. Ordinary ticketless intake stays in the
current project and requires explicit metadata.

The actual selected requirements/analyze configuration observed in this session
still selects **`pa-document-confirmation/v3`**. Consequently, it does **not**
expose the new intake port. Source support and installed bytes do not activate
it. A separately authorized configuration change and a fresh session are needed;
retained v1/v2/v3 sessions do not acquire new permissions. No config change,
activation or real user ticket creation was performed for this verification.

## Running the installed-slice verifier

The verifier is local qualification tooling, not a new installed PA tool or CLI
command. It never installs packages or falls back to source implementations.
Build local comparison outputs using the installed editor selection first:

```sh
PI_PA_PLUGIN_SELECTION='{"pi-vimmode":true}' corepack pnpm build
node --test scripts/dev/verify_interactions_runtime.test.mjs
node scripts/dev/verify_interactions_runtime.mjs \
  --selected-installed --compare-worktree \
  24b99576962c9b74bbf323cdcdcc0ba5a2ce4523
```

Use the exact current candidate commit when applying this to another build; do
not substitute `HEAD`, a branch, an abbreviated SHA or fixture evidence. Source
runtime/test paths and package/build inputs must remain unchanged at that commit.
Local tooling/docs additions may exist: their bytes are hashed separately and
must remain unchanged throughout observation. This intentionally allows a new
verifier to inspect the already-installed older trial without reinstalling it.

For a package with genuine exact source provenance, the stricter form is:

```sh
node scripts/dev/verify_interactions_runtime.mjs \
  --selected-installed --require-candidate \
  24b99576962c9b74bbf323cdcdcc0ba5a2ce4523
```

That form **rejects the currently installed dirty-source marker**. Comparison
mode accepts only the exact requested source SHA or the literal dirty-build
marker, never another commit, malformed/duplicate metadata or caller-supplied
results, binary roots, config roots, permissions or skip switches. It still
requires complete product/module/package byte parity and build pins.

The public JSON report is unsigned and bounded. `status: passed` means only that
this implemented-slice observation completed. Consult `identityMode`,
`exactCandidateProvenance`, cases and limitations separately. Neither mode proves
live selected-profile adoption, permission for a future operation, full PAP-282
qualification or product acceptance.

## What is actually exercised

Seven immutable test drivers run **51 tests**, including 22 mandatory exact-name,
exact-file anchors. Product implementation imports are bridges to the verified
installed Nix closure; an import audit rejects runtime-source fallback and changed
bridges/modules. Child-process creation/planning contention cases also use those
installed implementations. All 51 passed, with no skipped, failed or cancelled
cases in the observed installed run.

Coverage includes strict schemas/duplicate keys/Unicode/byte limits; complete
source-catalogue pagination without availability promotion; cursor isolation;
correct-project companion creation and required metadata; read-only selection;
caller/project/retained-owner negatives; creation/planning response loss and
concurrent owner processes; unsafe lock aliases; fresh-v4-only tool registration;
retained-profile exclusion; and composed launcher-to-intake/planning behavior.

The native host/session/process/UI and provider setup is **synthetic disposable
fixture setup**, not an actual foreground agent or operator approval. Historical
test names containing “source” or “no installed qualification” are retained as
exact accounting anchors; the import audit, not those names, establishes which
implementation bytes ran. No model request or real product-UAT journey is claimed.

Private disposable event logs, import audit and the harness remain under the
returned `evidenceRoot`; retain the original failed/unknown observations when
repairing a run. A missing/renamed/duplicated/foreign-owner/skipped case, failure,
summary mismatch or identity drift cannot pass. Unknown outcomes are never
converted to absent effects or a successful run.

## Check results

Executed in this worktree; these are separate evidence categories:

| Check | Actual result |
| --- | --- |
| `corepack pnpm build` | Exit 0. |
| `PI_PA_PLUGIN_SELECTION='{"pi-vimmode":true}' corepack pnpm --filter @pa-platform/pi-pa build` | Exit 0; restores the installed editor selection for byte comparison. |
| `node --test scripts/dev/verify_interactions_runtime.test.mjs scripts/dev/workflow_installed_support.test.mjs` | 18 passed, 0 failed/skipped/cancelled. |
| Comparison-mode verifier command above | Exit 0; 51 installed tests passed, 22 required anchors, 306 matched files. |
| Strict `--require-candidate` verifier command above | Exit 1, `WORKFLOW_INSTALLED_CANDIDATE_MISMATCH`; expected dirty-source limitation, not a pass. |
| `corepack pnpm exec tsx --test packages/pa-core/src/__tests__/interactions-contract.test.ts packages/pa-core/src/__tests__/interactions-catalogue.test.ts packages/pa-core/src/__tests__/interactions-discovery.test.ts` | 15 passed, 0 failed/skipped/cancelled. |
| `corepack pnpm typecheck` | Exit 0. |
| `corepack pnpm test` | **Not passed**: live requirements-config primer compatibility assertion failed; run then timed out at 480 seconds before a workspace summary. |
| `corepack pnpm exec tsx --test --test-name-pattern='generatePrimer live requirements config' packages/pa-core/src/__tests__/primer.test.ts` | Exit 1; reproduces that live-config compatibility assertion separately. No external config or product code was changed to silence it. |

The full workspace run's root verifier tests passed 35/35 before the core lane.
It stopped after reporting core test 1767, without reaching later workspace
packages; those later lanes are not passing evidence. Original logs are
`/tmp/pap282-workspace-test.log` and `/tmp/pap282-primer-reproduction.log`.
Focused logs are `/tmp/pap282-verifier-unit.log`,
`/tmp/pap282-source-discovery.log`, `/tmp/pap282-typecheck.log`; the public installed
final passing report is `/tmp/pap282-final-installed-result.json`, with evidence
root `/tmp/pa-interactions-installed-kU9HI5`. A post-commit comparison initially
blocked on `WORKFLOW_MODULE_INVENTORY`: after the workspace attempt, the local
comparison output again lacked the installed Vim plugin. That original blocked
result remains `/tmp/pap282-installed-result.json`. Rebuilding the Pi adapter with
the installed plugin selection restored complete byte parity; the final
post-commit installed run passed all 51 tests. No installed bytes or validation
guards were changed to obtain the pass.
These temporary paths are local observations, not durable native approval or
publication receipts. The new verifier unit command is explicit; this tooling-only
change does not alter root package scripts or claim its new tests were included
in the existing workspace command.

No completion definitions changed, so completion generation was not run. No
human/browser UAT, independent review, hosted CI, installation or config activation
was performed.

## Message review and limitations

Affected public category: the **new verifier's blocked diagnostic**, not existing
PPA/OPA human or machine messages. Before: no installed interaction verifier or
its diagnostic. After: “Installed interaction verification could not complete,”
followed by one each of Condition, Source, Reason, Correction and Resume Action.
It directs the agent to ask the runtime owner to inspect the reported gate and
retained evidence, not reinstall, skip checks, repeat approvals or reset state.
The diagnostic is static, plain-text, bounded to 2,000 JavaScript characters and
does not echo arguments/exceptions. Its machine envelope retains `not-run` versus
`unknown`, never claims installation/activation/UAT/acceptance, and returns exit 1
on a blocked observation. Success returns one JSON document and exit 0.

Agent readability review and structural/negative tests are separate from human
readability acceptance. No existing CLI streams/exits, native profile/tool
schemas, admission owners or runtime permissions were changed.

Remaining umbrella work includes exhaustive semantic CLI/alias/effect/role
coverage; wider bounded readers and incremental ticket operations; lifecycle and
resource/preparation bridges; the separately revised/approved external-file-read
amendment; complete differential/negative qualification; protected independent
review, hosted CI, genuine installed foreground behavior and human UAT/adoption.
These remain incomplete, not skipped-and-passing. PAP-282 must not be marked done
on the strength of this report.
