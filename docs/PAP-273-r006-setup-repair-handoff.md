# PAP-273 r006 setup launch/diagnostic repair — trial .4

Source delivery in deployment `d-cdfdc6`, selected checkout
`/home/sinh/.treehouse/pa-platform-cdb114/15/pa-platform`, branch
`feature/PAP-273-workflow-startup-compatibility`. Starting HEAD:
`f5aad575918d3907cbbfb4f9c8a41d7ace2cd11d`. The operator requested implementation,
then the `.4` label and a commit for the next installation/verification round.
Use the final Git commit containing this handoff, not the starting SHA or a
path/dirty-source package, as the next packaging candidate.

**Not ticket completion, exact installed qualification, independent review,
human UAT, release, adoption or execution readiness.** The historical signed
requirements/UAT/evidence and failed deployments are not rewritten. PAP-271,
PAPC-072, PAPC-073 r005 and prior PAP-273 v003/C01–C116 obligations remain intact.

## Delivered repair

- `packages/pa-core/src/deploy/plan.ts` now retains the authenticated invocation
  channel on ordinary plans, not just rogue-one. The existing Pi launcher/emitter
  carries it unchanged into immutable start evidence and the current projection.
  No null-channel inference, caller-environment grant or historical backfill.
- Default and explicit setup tests invoke the actual core CLI parser/PPA hooks,
  real planner, launcher, started/PID
  emitters, production `PiAdapter` and its incarnation writer, a distinct real
  child process and the registered native setup tool. The only substituted
  boundaries are terminal transport and external version/native-addon probes.
  Neither a CLI started row nor an authorized actor is inserted for these
  positives. This is source integration, **not** a real installed Pi/operator run.
- Strict raw immutable/current launch checks retain exact role/runtime/binary/
  channel, ticketless/child-free/custody-free roots and process requirements.
  Native results distinguish context, launch, PID/incarnation, repository and
  live/dead/unknown overlap failures. Every stop has static sanitized cause,
  stage and a five-field diagnostic under 2000 JavaScript characters. No supplied
  field names, raw OS/SQLite/parser text, paths or secrets are echoed.
- Infrastructure failures use `SETUP_REGISTRY` and retain missing, unreadable,
  unsafe, over-limit or unstable causes instead of masquerading as actor mismatch.
  Both launch and overlap observations use existing-files-only registry reads.
  The no-WAL checkpoint limit remains **64 MiB**; at-boundary read succeeds and
  over-boundary/unstable evidence rejects without allocating WAL/SHM files.
- Candidate-only fixed-path CAS, prerequisite drift/input confinement, native
  reauthentication/publication, managed-agent tool denials, operator-only
  password/credential/approval/reset/rotate/revoke/exclude ownership and
  task-required execution checks remain enforced. Discovery/inspection never
  writes a candidate or claims execution readiness.
- Exact installed inventory grows from **39 to 41 groups** with
  `setup-launch-channel` and `setup-admission-diagnostics`. All original groups,
  names and source owners are retained. Required skips, substitution, owner/lane
  swaps, dirty provenance and source-import fallback still reject.
- Trial version is synchronized to `0.1.154-pap273.4` in root, core, Pi and
  OpenCode package metadata. Runtime-host stays independently versioned.

## Actual validation and limits

Raw source evidence is in `/tmp/pap273-r006-*`; these are unsigned local logs,
not native package approval or an independent approved matrix result.

| Check | Actual result |
| --- | --- |
| Final `.4` workspace typecheck/build | Both exit 0: `typecheck-4.log`, `build-4.log`. |
| Final `.4` CLI/native setup entry and Pi test typecheck | **16 passed**, zero failures/skips: `setup-cli-4.log`; final Pi `tsc --noEmit` exit 0: `pi-tsc-4-final.log`. |
| Final `.4` core setup matrix | **92 passed**, zero failures/skips: `core-matrix-4.log`. |
| Focused Pi setup/launcher/startup/catalogue matrix | **225 passed**, zero failures/skips: `pi-matrix.log`; run before the metadata-only .4 label. |
| Final `.4` mandatory core/Pi workflow/setup/catalogue/native source entry | **519 passed**, zero failures/skips/cancellations: `mandatory-4-final.jsonl`; empty `mandatory-4-final.stderr`. Includes the new real launch positives and existing operator/confinement/CAS/native cases. Not installed or human evidence. |
| Final `.4` exact anchor/source-owner audit | **109/109** anchors found once in their canonical source owners; all 34 prior native groups unchanged, 36 native + 5 public groups = **41 total**. `source-anchor-audit-4-final.json`, explicitly source-only. The preceding audit separately compared all old group names/owners with starting HEAD. |
| Final `.4` inventory/verifier regressions | **27 passed**, zero failures/skips: `inventory-4-final.log`. |
| Final `.4` runtime-host | **1 passed**, zero failures/skips: `runtime-host-4.log`. |
| Final `.4` completions / whitespace | Generation exit 0, no completion diff; `git diff --check` exit 0. |
| Full workspace, first `.4` attempt | **Failed**: OpenCode's private-input test rejected an unrelated `.123Z` timestamp because its sentinel assertion banned `123` anywhere. Core had 1743 passes/14 existing optional skips; OpenCode 103 passes/1 failure/1 optional skip. Original `workspace-4.log` preserved. |
| Full workspace `.4` rerun | **NOT GREEN**: tool timeout at 1800 seconds. Root scripts 26/26, core 1743 passes/14 optional skips, OpenCode 104 passes/1 optional skip and Pi scripts 11/11 completed. Pi source reached 911 passing top-level events without a final summary. Runtime-host was not reached by this command; its separate pass above is not a substitute. `workspace-4-rerun.log`. |
| Additional Pi tail attempt | **NOT A PASS**: 300-second timeout with only the TAP header and no completed case. Begins with `readonly-helper-contract.test.ts`; root cause unproven. `pi-tail-4.log`. Do not attribute this to host load or transfer a historical pass. |

The small OpenCode **test-only** correction replaces the ambiguous numeric
private payload with `UNIQUE_PRIVATE_PAYLOAD` and still checks both the private
marker and payload for leaks. No production sensitive-input rule is weakened;
the rerun completed OpenCode successfully. Full-workspace timeout remains an
open gate, not converted into a passing run by the focused/mandatory entries.
The optional broad-suite skips are existing optional integrations, not waived
mandatory qualification cases.

Early launch-test attempts also failed on an invalid test timeout (30 rather
than the existing minimum 60) and a projected false-vs-undefined assertion;
those harness assertions were corrected without changing runtime guards.
The first diagnostic attempt exposed a malformed-SQLite header being classified
as unstable; the final reader distinguishes malformed/unreadable bytes from
actual checkpoint/WAL instability. Earlier logs remain under `/tmp/pap273-*`.

## r006 acceptance/UAT disposition

| AC / TS | Source disposition and remaining acceptance |
| --- | --- |
| 1–2 | Default/explicit normal launcher-to-child-to-native discovery/inspect source regressions pass without injected channel/actor. Real installed CLI/foreground sessions remain unperformed. |
| 3 | Immutable/current null/API/forged channel, role/runtime/binary/custody, wrong PID/root, stale/absent incarnation and live/dead/unknown overlap reject; denied candidate creation remains zero in fixtures. |
| 4–5 | Finite five-field diagnostics, sentinel/raw-error nonleakage, missing/unreadable/unsafe/over-limit/journal-unstable registry, read-time drift and exact unchanged 64 MiB boundary are source-tested. Live registry is not cleaned, resized or rewritten. |
| 6 | **NOT RUN**: fresh installed foreground discovery on `pa-platform-config` and `money-seasons` requires separately authorized exact Git packaging/install/selection and eligible vacant registered roots. |
| 7 | Existing candidate/operator/managed-tool/confinement/native cases pass in the 519-case source entry. Real operator credential/onboarding UAT remains separate and unperformed. |
| 8 | 41-group inventory/source-owner protections delivered and source-audited. Full workspace incomplete; exact installed/hosted/independent approved matrix/human UAT not performed. **Not accepted.** |

## Next installation/deployment-verification round

1. Review the clean final Git candidate/diff. Separately authorize exact-Git
   packaging/install/selection/reload. Verify provenance names that actual commit,
   not `unversioned-dirty-source`, the `.4` string alone or an earlier store.
2. Preserve/reconcile the authentic selected PAPC-073 pair through its owner;
   do not edit the installed store, silently change pins or recapture r005.
3. Resolve the complete-workspace timeout and run the entire approved source
   matrix. Source execution catalogue/custody prerequisites remain their owners'
   responsibility; this rogue-one source delivery does not manufacture them.
4. On the clean exact candidate and installed pair, run the unchanged supported
   verifier with the actual full candidate SHA:
   `node scripts/dev/verify_json_workflow_runtime.mjs --selected-installed --require-candidate "$PA_FEATURE_SHA" --require-paired-config`.
   All **41** groups remain required. Current .3/dirty-source/historical results
   cannot qualify .4. No installed command was run here as a substitute.
5. Operator separately launches ordinary foreground setup for each reported
   registered primary root (default or explicit `--mode setup`). First native
   discover must return `ok:true`, `executionReady:false` without candidate writes;
   retain exact package/config/process evidence. Stage/approval/credentials/local
   exclude remain separately owned actions, never automatic retries or grants.
6. Obtain independently authorized full-matrix review, actual hosted results,
   genuine TS6/TS8 human UAT and explicit adoption. Resume affected application
   tickets only through their owners at first unproven action, preserving all
   valid prior decisions, links and history.

No installation, selected-config write, live setup/builder/reviewer spawn,
credential/approval operation, registry cleanup/backfill, source push/PR/merge,
checkout allocation/return, device action or acceptance claim was performed.
