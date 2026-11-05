# PAP-277 qualification and handoff

Implementation follows r004's four phases. Each phase has a separate source
commit. This is **not rollout acceptance**: no package/config install, activation,
push/merge, live-state reconciliation, checkout return or human UAT was performed.

## Installed verifier

```sh
node scripts/dev/verify_advisory_runtime.mjs --selected-installed \
  --require-candidate "$PA_FEATURE_SHA" --require-paired-config
```

Only the exact ordered argument contract is accepted. No source, module, binary,
config-root, result-file, skip or passed-flag override exists. Reuses the existing
workflow qualification's physical provenance/module/import-audit/harness owners,
not a second runtime ledger. PPA and OPA must physically resolve to the same
immutable Nix package, bound to the exact clean full candidate SHA, lockfile,
built implementation inventory, package metadata and native registry addons.
Both selected adapters' core dependency must resolve to that closure.

Selected PAPC HEAD/cleanliness/resources must match the package's exact config
and template-registry pins. A separately prepared PAPC-074 candidate supplies
`contracts/advisory-runtime-v1.json`:

```json
{
  "schemaVersion": "pa-advisory-policy/v1",
  "runtimeContract": "pa-advisory-runtime/v1",
  "resultContract": "pa-operation-result/v1",
  "owner": "PAPC-074",
  "sources": ["teams/builder.yaml", "teams/builder/modes/orchestrator.md"]
}
```

This manifest is **qualification-only interface metadata**, never runtime
permission, policy code or a prerequisite for ordinary safe tools. Its sources
are exact committed instruction/YAML bytes, not executable config imports. PAPC
still owns order, retry, review, escalation and adoption. No PAPC source was
modified here, no current compatible candidate or operator readiness is asserted,
and source tests do not certify instruction quality or agent compliance.

The verifier pins driver CODE to the candidate and bridges every product import
to verified installed implementations; an inherited import audit rejects source
fallback or altered bridges in workers/children too. Twenty mandatory native case
anchors have exact test-source owners. Missing/duplicate/swapped/failed/skipped/
cancelled/summaryless cases reject. Tests cover results/bounds/freshness, actual
failure/repair/commit, default Pi launch and SDK effects, OpenCode CLI/hooks,
optional absence, native process interruption/timeout/abort/output cleanup,
32-process contention, duplicate/fifth capacity and retained controllers.

A separate driver executes actual selected public **PPA and OPA binaries** for
16 new/retained observations, including child failure, safe follow-up, protected
denial and unmarked legacy non-upgrade. Admission/provider/Treehouse identities
in disposable fixtures are labelled synthetic; this is installed executable
qualification, **not a genuine foreground agent/human acceptance test**. Unknown
OpenCode hook observations cannot be substituted for native process facts.

Source/config/package/modules/selected binaries and policy bytes are reread at
the end. Private original event/stdout/stderr/import evidence is retained outside
source/config checkouts. Blocked reports retain partial/unknown/not-run states;
they never turn a prerequisite-only probe into a passing case inventory.

## Evidence separation

| Evidence | Observed status in d-ceb124 |
|---|---|
| Result contract and core/API unit tests | Passed; focused source regression 152/152; final recovery/redaction changes 16/16 |
| Source-built actual Pi launch/SDK failure/repair/local commit | Passed; simulated provider and Treehouse, no foreground agent claim |
| Core security/custody/new-run/legacy-focused checks | Passed, including 32 real processes: 1 winner/31 conflicts |
| Workspace typecheck/build | Passed |
| Completion generation/drift, secret scan, whitespace | Passed |
| Verifier regression and existing installed-audit regression | Passed: 19/19 in final combined verifier run; these are source tests |
| Public-entry DRIVER against local built CLIs | 16/16 development observations; NOT selected installed acceptance |
| Full workspace test command | Original run timed out at 1800s; NOT passed. Core 1754 passed/14 external-fixture skips and OPA 105 passed/1 external-fixture skip were observed before Pi-suite completion. Those skips are retained debt, not waived acceptance. |
| Initial Pi fixture regressions | Corrected by explicit retained-profile fixtures, native reservation coexistence and preserving legacy tool composition; focused reruns passed. Original failures retained. |
| Exact installed runtime/PAPC pair | Blocked until matching immutable candidate package and PAPC-074 policy candidate/readiness exist; never source fallback |
| Independent exact 14-command review matrix | Not executed as an independent review; do not equate development checks with its approval |
| Genuine foreground agent transcript | Not run |
| Hosted CI | Not run |
| Sinh human UAT / adoption | Not run |

No `AC`/`TS` item is marked accepted merely because its source fixture passed.
The full matrix's 100%, zero-required-skips, Critical=0/Major=0 acceptance has
**not** been established. PAP-273 and other retained incident/accounting/acceptance
owners remain open. No original failure, signed artifact, pending intent, holder,
resource, counter or deadline is reset by this implementation.

Final qualification repairs also preserve the original operation ID/evidence on
interrupted result publication, redact OpenCode activity strings through the
shared native redactor, and allow proven read-only `pwd`/controlled Git-status
diagnosis without clearing an uncertain writer's lease bytes. These are local
security/evidence corrections, not additional workflow permission ceremonies.

Private original logs are retained under this deployment's
`artifacts/PAP-277/checks/`, including the timed-out workspace run and original
fixture failures. Later passes do not replace those records.

## Remaining authorized follow-up

1. PAPC-074 prepares an exact compatible policy/instruction candidate and reviews
   the direct-only new-session profile plus retained coexistence guidance.
2. Operator separately authorizes packaging/selection of that exact runtime/config
   pair. Preserve originals; no silent installed or live-run upgrade.
3. Run the installed verifier and independently approved complete 14-command
   matrix; resolve full-suite timeout/external-fixture skips rather than waiving
   them. Keep original failed and later successful evidence.
4. Obtain real foreground-agent behavior, independent review, exact hosted CI and
   Sinh UAT/adoption separately. Foreground OpenCode TUI behavior also needs its
   actual installed-host observation; a source hook test is not a substitute.
5. Legacy removal/rollback requires its existing owner and separate authorization;
   never settle PAP-276's pending intent or release/return resources from this
   ticket's cancellation/implementation status.
