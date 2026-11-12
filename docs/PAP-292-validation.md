# PAP-292 source delivery and qualification status

2026-11-12 UTC. **PARTIAL DELIVERY; not full system-adoption readiness.**

Later local-source confidentiality follow-up: [source-aware checks and validation](local-source-content-security.md),
worktree label `0.1.161-pap292.1`. The original source checkpoints/results below
remain historical; neither they nor d-09f8df's exposed-content incident become a
clean qualification pass because the source was subsequently fixed.
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

## Installed follow-up and integration disposition

The operator separately ran `sudo sys test .`; the agent monitored that existing
rebuild, not a second installation. The selected PPA then reported
`0.1.161-pap292.1`, Pi `1.4.0`. Nine installed security/capability modules matched
the worktree's compiled bytes. This is bounded component evidence, not proof of
whole-package commit provenance. Trial source checkpoint:
`5a09cc033326ee42ed9e6dd109e04370d5cec291`.

Fresh automated foreground deployment **d-2bdb5d** used normal requirements/analyze,
`rogue_one=false`, `fallback=false`, and native PAPC binding
`8deb96ccd8077342262864b0152f9ab6a5d9d7ae`. Its Q-01–Q-11 report records
**9 bounded PASS, 2 BLOCKED**, no observed raw-canary failure:

- Ordinary tools, cross-project/historical discovery, complete long UTF-8 reading,
  native/CLI status CAS/replay/negative cases and preserved cancellation passed.
- Inert local read/shell redaction, in-file source-spoof resistance, private-key
  body-only pagination protection and absent protected-path denial passed. No real
  credential/config/incident-log read was used to test the fix.
- Sole fixture **PAP-295** remains cancelled; original ticket/intent history remains.
- Q-01: managed provenance read returned LOCAL_SOURCE_UNAVAILABLE (file metadata
  showed link count 3). No reader workaround followed. Separately observed package
  metadata says sourceSha=unversioned-dirty-source; exact source stays UNVERIFIED.
- Q-04: workflow listing succeeded; an unsupported capabilities action was retained
  as a contract rejection. No real decision subject existed for a supported native
  read/verify check, so that admission observation is BLOCKED, not a proven defect.
- CLI exited 0 after the controller closed its own idle session. Native registry
  is **partial**: foreground session exited without a staged completion payload.
  This status is preserved, not replaced with a completed/publication claim.

Durable local evidence (private ai-usage, not committed raw transcripts):
`deployments/d-2bdb5d/qualification-pap-292/report.md`, SHA-256
`964f444d696f90f0550bcbdf7c6108df031e1da59f073341211cc10ae3cced3a`;
adjacent `requests.json`, SHA-256
`2c671433366af1a08944844c4688e386a3a709e7d966aec3c7342b711069f620`.
The external controller/installation observations are under
`agent-teams/requirements/artifacts/drafts/d-f441ea/qualification/installed-smoke-monitor/`.
These are automated observations, not independent review or human UAT.

The operator explicitly set aside unversioned provenance as a blocker for this
smoke/integration and subsequently requested commit, PR and merge to develop.
That instruction does not turn missing provenance or decision coverage into PASS,
waive repository CI/review gates, or approve production acceptance. The integration
candidate restores the then-current plain develop version **0.1.161** across four
manifests for the normal auto-patch flow; the installed trial remains unchanged.
Packaged-default config pin, dependency/lockfile/Nix hashes and runtime-host version
are unchanged.

### Final integration checks and companion merge

- PAPC [PR #53](https://github.com/sinh-x/pa-platform-config/pull/53) merged to
  develop at `4ba2b865ed56baec84d52fb423956d79c343163c`; canonical local develop
  and origin/develop matched afterward. Its feature follow-up `f8cf1cf` retained
  the helper word bound and exact authorized capability-delta assertion, not a
  relaxed provider/model/other-mode baseline. All hosted PR lanes passed.
- The operator explicitly approved refreshing ONLY the document-source CI variable
  to reachable trial commit `5a09cc033326ee42ed9e6dd109e04370d5cec291`; JSON/template/
  advisory pins remain unchanged. This is source CI selection, not native approval,
  package pinning or installation. Final PAPC affected tests: 56/56 plus 10/10 PASS;
  contract/config validation and staged scan passed. Unrelated local files preserved.
- Final runtime typecheck/build/completions PASS; completion files unchanged.
  Logs: `/tmp/pap292-integration-{typecheck,build,completions}-final.log`.
  CI patch-helper dry run accepts plain 0.1.161 and plans 0.1.162, without writes.
- Final runtime focused lane: **74 PASS, zero failures, one existing installed-output
  SKIP**, `/tmp/pap292-integration-focused-final.log`. Covers source/sensitive/safety/
  capabilities/catalogue/status and Pi local-security/parity/composition/session/
  native status plus PAP-156 characterization.
- The integration full-suite attempt timed out during Pi after the combined command's
  1200-second bound. Root 42/42 passed; core 1943 PASS/14 existing SKIP, zero failed;
  OPA 106 PASS/1 existing SKIP; runtime-host 11/11 passed. Pi reported a stale frozen
  fixture counting built-in read/bash and their new secured overrides twice. The
  fixture now models SDK replacement-by-name, independently rejects duplicate custom
  registrations and requires exactly one secured override each. Historical fixture
  bytes and exact effective loadout are unchanged; its corrected focused lane passes.
  The original failure/timeout remains in `/tmp/pap292-integration-full-test.log`.
  No complete full-workspace regression PASS is claimed.
- Staged secret scan and whitespace check passed before handoff commit e0644c5.
  Hosted runtime CI on the preceding trial SHA then identified three test-harness
  assumptions: the frozen fixture above, a second legacy module/registration count,
  and a CLI path resolved from CWD instead of the test module. The second fixture
  now explicitly accounts for both secured overrides/result modules; CLI source
  resolution is module-relative. No runtime permission/parser/effect guard changed.
  Corrected root-CWD harness lane: 16 PASS/1 existing installed SKIP; package-CWD
  actual native/CLI lane: 1/1 PASS. Logs `/tmp/pap292-ci-harness-{root,package}.log`.
  Historical hosted failures remain recorded; fresh PR CI is separate from these
  local/installed observations and must assess the current head.

Full PAP-292 remains partial: independent owner/security review, universal PAP-290
bridges, broader installed/profile variants and human acceptance are outstanding.
The original source failures above remain historical evidence, not silently erased
by the later source/security or installed smoke checks. No native requirements
approval, ticket completion, queue, launch or active-session migration is fabricated.
Rollback affects NEW selection only, preserving original intents/decisions/history.
