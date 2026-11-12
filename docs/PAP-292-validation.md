# PAP-292 source delivery and qualification status

2026-11-12 UTC. **PARTIAL DELIVERY; not full system-adoption readiness.**
Engineering contract and missing T/W operation ledger: [implementation](PAP-292-implementation.md).
This report is agent narrative, not native approval, independent review or human UAT.

## Committed phases

- P1 `efc8cfe`: engineering contract/inventory, not independent owner approval.
- P2 `1d71d55`: ordinary tools with immutable read-contract separation.
- P3 `6bba550`: finite status owner, actual native/CLI subprocess-first tests,
  existing workflow/decision request selection. Bounded partial P3, not all bridges.
- P4 PAPC `8deb96ccd8077342262864b0152f9ab6a5d9d7ae`, companion PAPC-084,
  branch `feature/PAPC-084-requirements-tool-parity`, canonical PAPC checkout.
  The operator explicitly chose **Change selected team now**, after disclosure that
  old installed runtimes reject the new IDs. Unrelated `sample.html` remains
  untracked and untouched. No installation or packaged config pin change.
- P5 hardening: selected policy callers cannot bypass status CAS/ownership through
  legacy `ticket update --status` or soft-delete; use the finite owner. Ticket
  equality is rechecked AFTER reauthentication. Catalogue/inventory reconciled.
  Protected publication/queue continue through their existing native owners.

## Actual checks

Commands ran in the feature worktree with existing dependencies and disposable
state. Temporary logs are evidence locators, not durable native acceptance records.

| Check | Result / evidence |
| --- | --- |
| `corepack pnpm typecheck` | PASS, `/tmp/pap292-typecheck-final.log` |
| `corepack pnpm build` | PASS, `/tmp/pap292-build-final.log` |
| Final focused batch below | 27/27 PASS, no skips, `/tmp/pap292-focused-final.log` |
| Final document/admission batch below | 125/125 PASS, no skips, `/tmp/pap292-gates-final.log` |
| Earlier workflow/status/parity batch | 197/197 PASS before final CLI/freshness hardening; not an exact-final aggregate |
| PAPC capability + guided tests | 50/50 PASS, no skips, `/tmp/pap292-papc-focused.log` |
| PAPC `npm run validate:contract` and `npm run validate` with explicit runtime root | PASS; existing recovery-scope check reported SKIPPED, not product acceptance |
| PAPC `check-guided-requirements.mjs --source-pair` | PASS at runtime 6bba550 / PAPC 8deb96c, `/tmp/pap292-source-pair.log`; source composition only |
| `corepack pnpm completions` | PASS, no tracked completion diff |
| Staged secrets scans and `git diff --check` | PASS at phase commits; repeated for final commit |
| `corepack pnpm test` | FAILED/INCOMPLETE exploratory run, `/tmp/pap292-full-test.log`: root 42/42 passed; core reported stale source-inventory guard. Stopped owned test after failure while validation corrections changed candidate. No complete full-suite result. Corrected catalogue/inventory passes final focused lane. |

Exact final focused command:

```sh
node --import=tsx --test \
 packages/pa-core/src/__tests__/mode-capabilities.test.ts \
 packages/pa-core/src/__tests__/ticket-status.test.ts \
 packages/pa-core/src/__tests__/interactions-catalogue.test.ts \
 packages/pa-core/src/__tests__/interactions-discovery.test.ts \
 packages/pi-pa/src/__tests__/mode-capability-session.test.ts \
 packages/pi-pa/src/__tests__/requirements-tool-parity.test.ts \
 packages/pi-pa/src/__tests__/public-web-launch.test.ts \
 packages/pi-pa/src/__tests__/ticket-status-native.test.ts
```

Exact final gate batch used the same `node --import=tsx --test` runner with:
pa-core `src/__tests__/{document-package,document-service,document-integrity,document-confirmation,repository-admission,treehouse-ticket-concurrency}.test.ts`;
pi-pa `src/__tests__/{document-session,document-confirmation-native,document-confirmation-entry,document-workspace-dispatch}.test.ts`.
The earlier 197-case batch used core ticket-status/workflow-state/workflow-owner-integration
and Pi ticket-status-native/pi-workflow-runtime/document-native/requirements-tool-parity.
PAPC command: `PA_PLATFORM_REPOSITORY=<this runtime checkout> node --test
scripts/requirements-capabilities.test.mjs scripts/guided-requirements.test.mjs`.

### Preserved failures and corrections

- Parity fixture initially lacked Pi's `getSessionFile`, then used the old single-edit
  shape; corrected before P2 commit and passing real ordinary-tool execution.
- Status intent/audit comparisons initially differed on strict-parser object
  prototypes; reconstructed records/digest comparison corrected before P3 commit.
- CLI subprocess initially resolved tsx from the disposable repository; changed to
  its exact import URL before passing actual CLI-first and concurrent CLI tests.
- Later source-inventory failure prompted semantic status catalogue reconciliation,
  including legacy status-route narrowing, not removal of the guard. Final focused
  catalogue tests pass; no final full regression pass is claimed.

## Changed messages and security boundaries

Affected paths/categories: policy primer/registry/tool descriptions (information),
new status CLI/tool success JSON, returned/thrown/CLI-wrapped status blockers.
Before: retained hook denies shell/source operations; finite ticket/intake schemas
cannot set status. After: explicitly selected ordinary tools execute; task policy
says author mutable artifacts in ai-usage, never repositories/Git. Native status
and `ppa ticket-status --request JSON` share one finite owner.

Synthetic success: `status=requirement-review`,
`effect=administrative-status-only`, `executionAdmitted=false`; not queue,
publication or acceptance. Synthetic legacy-route blocker: “Ticket status has no
proven successful result; preserve the original request”, with TICKET_STATUS_ROUTE
and one Condition/Source/Reason/Correction/Resume Action envelope. Native/CLI tests
check fixed bounded diagnostics, zero status effects on legacy-route denial,
actual stderr/exit=1 propagation and unchanged owner data. New CLI success is JSON
only; no prose appended to existing machine streams. Formatting uses fixed text,
no probes or raw exceptions. Independent human readability review is NOT RUN.

Real Pi ordinary implementations ran in synthetic hosts: benign shell, ordinary
artifact write/edit/readback and long-file end read outside old roots. Fixture repo
stayed unchanged; this is not a full agent compliance journey or hostile-process
sandbox proof. Shared host/adapter safety remains; ordinary.read does not silently
reuse/widen context.read. Tests cover immutable include/omit/include, alias denial,
specialist coexistence, supplied decision-outcome rejection, all nine statuses/81
enum edges, lifecycle/child denial, original reply-loss recovery, reauthentication
mutation, actual subprocess CAS and terminal-registry/live-PID owner conflict.

No approval, review, resource, identity or audit exemption is imported. Broad
same-UID tools are not a supported raw-state workaround. General native ticket
collection/ref/assignment/retention and CLI protected-effect bridges remain missing;
source discovery continues to say installed/registered/admitted is unproven.

## Installation and acceptance verdict

The source is buildable with focused checks above. It is **not fully qualified
for system adoption**: complete regression, independent review/CI, immutable package
provenance, matched installed/foreground parity, all catalogue variants and human
UAT are unproven. A build/source check is not installation/adoption authority.
The user intends to install personally after readiness confirmation; the agent
performed no system/user installation and asserts no full readiness. Verify exact
`sourceSha` of any subsequently built artifact and its actual selected PAPC binding,
separately from the unchanged packaged-default config pin.

Full PAP-292 remains partial: P1 independent owner/security review, P3 universal
bridges and P5 installed/human acceptance are outstanding. No native requirements
approval, ticket completion, queue, launch or active-session migration is fabricated.
Rollback affects NEW selection only, preserving original intents/decisions/history.
