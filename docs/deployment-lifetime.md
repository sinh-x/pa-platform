# Deployment lifetime: no wall-clock termination

Operator-requested source change in d-f0ea21, 2026-11-14.

Pi/PPA and OpenCode/OPA deployments are no longer terminated because a deployment
runtime budget elapsed. This applies to foreground, background, fresh, resumed,
advisory and evaluator launch paths. Pi's persistent supervisor ignores a legacy
saved timeoutMs as well; new launches do not write/forward that deadline.
Direct adapter spawn/resume calls also ignore legacy timeoutMs.

Natural exit, explicit cancellation/shutdown, process/transport failure and causal
safety failures retain their existing finalization and ownership behavior. No
cleanup, process-death proof, borrowed-authority or reservation rule is relaxed.

## Compatibility and independent safety budgets

- --timeout, PA_MAX_RUNTIME, ExecutionPlan.timeoutSeconds and registry
  effective_timeout_seconds remain validated legacy planning/finite-authority
  metadata. Existing schemas/history and exact reviewed subjects are not rewritten.
  These values do not create a deployment process kill timer.
- Finite tool/command/workspace/browser-worker, startup/readiness, lock-acquisition
  and cleanup deadlines remain. A reviewed native execution grant's expiry remains
  its own boundary: keeping a session alive does not extend or replace its authority.
- status --wait waits indefinitely by default instead of inheriting deployment
  metadata. An explicitly supplied PA_STATUS_WAIT_TIMEOUT limits the wait command
  only; it neither kills nor changes the running deployment.
- This source change cannot clear timers already installed in older running
  processes. No installation, live reload, runtime replacement or active-session
  retrofit was performed. The selected installed .2 runtime is not this candidate.

## Affected paths and user-facing wording

Runtime changes: pi-pa deploy/adapter/background-runner, opencode-pa deploy/adapter.
No new SDK API, tool/capability, environment override or native approval/effect
interface is introduced. Runtime-api timeoutMs remains an optional legacy field.
The source-inventory guard remains active; only five changed tracked source hashes
were renewed after inspecting unchanged operation/alias/binding identities.

Information/help before -> after:

- --timeout: “Override deployment timeout” -> “Legacy planning budget; does not
  stop the deployment.” Evaluator help uses the equivalent scoped wording.
- Status detail: “Timeout: 1800s” -> “Timeout metadata: 1800s (not a deployment
  runtime limit)”. Historical values remain visible, not relabelled as live policy.
- Wait progress: “Wait timeout: 1800s” -> “Wait timeout: none”. An explicit
  wait-only override additionally states that the deployment is not stopped.

These are information/help/progress changes, not a new blocker envelope. They
preserve JSON keys/values, exit/stream contracts, retained audits and cleanup
owners. Plain/no-color propagation and actual wait-only non-mutation are tested;
independent human readability and installed/default-entry observation are unrun.

## Actual checks

All commands below ran without an imposed tool/shell deadline for these checks.
These results are source fixtures, not installed qualification or human UAT.

| Scope | Actual result |
| --- | --- |
| corepack pnpm typecheck | Whole workspace exit0 |
| corepack pnpm build | Whole workspace exit0 |
| corepack pnpm completions | Exit0, tracked completion bytes unchanged |
| Complete Pi adapter/background-runner plus native-execution-evidence suites | 91/91 pass, zero skipped/failed/cancelled |
| Complete CLI core-command and OpenCode adapter suites | 192 pass, 3 external-config fixture skips, 0 failed; skips are not passes |
| Selected Pi deployment lifetime route cases (explicit name filter, not the whole file) | 5/5 pass; standalone/ticketed/resume/evaluator, foreground/background and explicit shutdown |
| Complete interaction catalogue plus PAP-156/PAP-157 status/ownership suites | 21/21 pass, zero skips |
| git diff --check | Exit0 |
| staged secrets:scan | Required before commit; result recorded by commit step |

Tests include real short-lived OpenCode fixture children that outlive the legacy
1ms deadline with PID supervision, Pi foreground/managed spawn/resume that never
arm a lifetime timer, legacy saved supervisor configuration, actual status waiting
past recorded metadata, unchanged finite command timeout, explicit shutdown
TERM/KILL escalation, cleanup uncertainty, actual nonzero child exit preservation,
terminal restoration and exactly-once finalization.

Original first Pi run: 82/83 passed. The converted explicit-cancellation fixture
expected0 but its actual SIGKILL child exit was137. Corrected the assertion to
preserve that real nonzero failure, rather than changing production finalization
or masking the child result. Final expanded rerun91/91 passed; original log kept.

Local logs: /tmp/pa-no-deployment-timeout-{typecheck,build,completions,pi,pi-rerun,
cli-opa,deploy,ownership}.log. These are ephemeral, not signed authority.
No full-workspace aggregate or independent/hosted/installed/human acceptance is
claimed by these focused runs. Earlier PAP-299 full-suite timeout and separate
PAPC composition failure remain as documented, not repaired by removing timers.
