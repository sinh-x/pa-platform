# PAP-273 runtime follow-up / PAPC-073 handoff — 0.1.154-pap273.2

This is source delivery for operator installation and companion configuration
work, not ticket acceptance, native package approval, human UAT or builder launch.
PAP-271/PAPC-072 and their historical decisions remain unchanged.

## Runtime interfaces delivered

### Repo setup: one actually registered tool

The supported deployment remains Pi/PPA CLI, exact `repo-setup/setup`, ticketless,
registered physical primary root, foreground, idle repository; no override,
background, resume, API, OpenCode, Treehouse or builder authority.

`pa_repo_setup` takes exactly one `request` string containing strict JSON:

```json
{"action":"discover","path":"."}
{"action":"read","path":"package.json"}
{"action":"search","path":"package.json","query":"scripts"}
{"action":"observe","paths":["package.json","package-lock.json"]}
{"action":"inspect"}
{"action":"stage","expected":null,"candidate":"<raw project-command-catalogue/v1 JSON>"}
```

- Paths are relative to the authenticated root, not caller roots or arbitrary
  filesystem paths. Descend explicitly through `discover` results.
- `observe` returns `observation={schemaVersion:"repo-setup-inputs/v1",repository,
  files:[{path,sha256,sizeBytes}]}`. These are native byte observations, not grants.
- `inspect.runtime` is `repo-setup-runtime/v1`: `nodeExecutable` (observed root-owned,
  nonwritable Nix-store host Node path or null), `nodeVersion`, `modulesAbi`,
  `platform`, `architecture`, `projectCompatibility:"unproven"`. No PATH lookup
  or command probe occurs. This prevents guessed executable paths; a null or
  project-incompatible host is a blocker, not an execution/profile grant.
- Update uses the exact prior candidate reference in `expected`, not null.
- Stage verifies every prerequisite digest before staging and again before
  publication. Drift, conflicting hashes and unsupported input shapes reject.
- Limits: Linux descriptor-relative no-follow traversal; process-owned files and
  directories without group/other write; no linked/nonregular/sensitive inputs,
  `.git`/`.pa` or traversal. Observe: 128 unique paths, 1 MiB/file, 8 MiB/batch.
  Read/search: one UTF-8 file up to 32768 bytes; literal query up to 128 characters.
  Discover: one directory, at most 512 scanned entries. Observation JSON: 48 KiB.
- All successful results retain `executionReady:false`. Observation/candidate
  data is neither catalogue approval nor task execution scope.
- A fresh disposable **real Pi SDK session** is tested with only `pa_repo_setup`
  active, exercising discovery/read/search/observation without builtin tools.
  This is source/SDK evidence, not a real installed CLI/operator onboarding run.
- The generated setup lifecycle uses native bulletins and runtime-owned terminal
  handling; no shell/log/registry mutation instructions are supplied by that
  runtime projection. PAPC-073 must align its own objective/skills accordingly.

Full details: `repo-setup-candidates.md`. Operator credential/catalogue approval
and task-bound execution remain as documented in `repo-contract-approval.md` and
`repo-catalogue-execution.md`; no password input or approval was performed here.

### Native package review and cancellation recovery

The foreground UI presents bounded ordinary-language review pages, with all
finite document/scope/permission/exclusion bindings before a final decision.
Exact JSON is optional technical detail. v2 evidence binds the original request
and presented responses. Real terminal readability still requires operator UAT.

Status/next expose `packageReview` separately from run admission and execution
prerequisites. For an eligible cancellation, `packageReview.recovery.request`
contains the exact proposed native request:

```json
{"action":"recover","revision":2,"decisionId":"decision-<exact-cancelled-id>","subjectSha256":"<exact-current-subject-sha256>"}
```

Send it through `pa_decision` in the original authenticated foreground requirements
coordinator or its supported same-role registry continuation. The run is derived
from native repository/ticket identity. This is not a CLI password/approval
command and is not accepted by an unrelated analyst or rogue-one session.

Recovery preserves the exact run/subject/resources and original cancellation;
it appends a fresh native decision with a validated predecessor. It grants
nothing on another cancellation, and performs no publication/branch/checkout
operation. Stale revisions, changed subject/evidence, foreign/revoked/noncancelled
predecessors, pending/effected state and exhausted bounds reject. No duplicate
run, automatic retry, fabricated subject revision or legacy phrase fallback is
available. Sixteen decisions per subject (initial included) is the finite bound.
Older unaware runtimes reject the new recovery event; do not downgrade that run.

LM-101/d-076ff1 should retain its current run and r001 documents. After installation,
a supported requirements continuation can inspect and explicitly request recovery.
The operator must actually answer the native question. The prior record-only
answer remains intent, not authority. Publication/handoff owners and later
project-command/custody/execution gates remain separate.

Full details: `readable-native-review.md`, `workflow-cancellation-recovery.md`.

### Causal diagnostics

Builder launch aggregates the adopted package/publication/queue blockers before
branch-only advice; manual linking or queue status is not a complete repair.
Project-command profile state is reported separately from safe drafting/review.

The parser/template/producer expose bounded `inputDiagnostic={field,rule}` for
subject ID/revision, workflow ID/version/digest, repository key and base SHA.
Uppercase subject IDs are producer errors, not missing runtime capabilities.
Rejected values/private exception text are not echoed and validation is unchanged.

## Companion/operator actions after delivery

1. Install from the **exact clean committed Git candidate**, using the final
   runtime commit and trial version supplied with this handoff. A suffix alone
   does not establish provenance. Avoid a path/dirty-source build that yields
   `sourceSha:"unversioned-dirty-source"`; the exact verifier correctly rejects it.
2. Check installed version and provenance against that commit. Do not override
   provenance or substitute another commit's qualification report.
3. Update/publish PAPC-073 through its owner: use these exact actions, align its
   source/composer checks and runtime CI pin, preserve all mandatory qualification
   families, and add real readable-review/cancellation/onboarding UAT cases.
4. Authenticate the actual coherent selected committed config. Historical build
   config pins remain provenance, not manually maintained selected-config pins.
   Retained workflows continue using their original resource closure.
5. Run the exact installed verifier against the selected pair. It now has **34
   mandatory rows** (six added; all original rows retained), including real SDK
   tool discovery, bounded observation, readable review, recovery, diagnostics and
   safe field errors. Its SDK dependency resolves from the verified adapter's
   package closure, never from source-checkout fallback.
6. Perform actual installed fresh-role and operator UAT. Only then resume LM-101
   at its first unproven action. NX-067/TTL-017 continuation and final adoption
   likewise require their own evidence/owners; nothing here replays approval.

No installation, selected-config/CI-variable mutation, credentials, catalogue
approval, live setup/requirements/builder spawn, workflow recovery or merge is
part of this source implementation. Existing historical qualification failures
are retained, not attributed wholesale to host load or converted into passes.

## Source commits and validation checkpoint

Runtime increments: `e0202d9` (bounded inputs/discovery), `14f10b5` (readable native
review), `ab67b94` (cancelled recovery), `e4b740b` (state/launch diagnostics),
`f7981b1` (producer fields), `52cfae8` (mandatory inventory / actual SDK discovery),
`6ce18ee` and `179207a` (native host/continuation coverage), `111c027` (abort
boundary), `a017a0a` (compact primary review), `6dcec4e` (Node host observation).
The final label/handoff commit provides the full candidate SHA; do not install
only one intermediate increment or treat historical CI as covering the final SHA.

The full workspace run completed successfully on this implementation worktree:

| Lane | Passed | Existing optional skips | Failures |
| --- | ---: | ---: | ---: |
| Root script regressions | 25 | 0 | 0 |
| Core | 1707 | 14 | 0 |
| OpenCode | 104 | 1 | 0 |
| Pi script regressions | 11 | 0 | 0 |
| Pi source/local integration | 1339 | 5 | 0 |
| Runtime-host | 1 | 0 | 0 |
| **Total** | **3187** | **20** | **0** |

The optional skips are retained external-config, AXI and installed dual-host
fixtures, not waived workflow qualification rows. Source CLI checks, exact native
two-phase source/restart cases and matrix checks ran. The formerly failing
`roadmap Step 2` case also passed independently on current source. Raw full log:
`/tmp/pap273-followup-full-test-2.log` (exit 0).

Late source refinements have additional focused results: setup+primer 99/99,
actual SDK setup 6/6, and readable review/default-native cancellation/continuation
11/11, all without skips. These supplement the workspace run; they are not an
exact installed-candidate report. Version-only rebuild/CLI/Nix checks are recorded
in the final delivery comment.

The new trial suffix is synchronized across root, core, Pi and OpenCode;
runtime-host remains independently versioned at 0.1.88. No tag/release is made;
restore the plain integration version before normal develop auto-patch merging.

Historical installed failures remain historical, including unclassified protected
source/persistence failures; a passing current source test does not rewrite their
cause or transfer qualification. Exact installed **34-row** qualification, fresh
CLI host reload and human UAT must be obtained after operator installation. The
existing `.1` installation is not this candidate, and its dirty-source provenance
cannot satisfy exact-candidate verification.
