# Runtime diagnostic coverage (PAP-352)

This is a maintained coverage map, **not runtime-wide completion**. Formatting rules
remain in [the CLI message standard](cli-message-standard.md). Inventory discovery
is reproducible with `node scripts/dev/inventory_runtime_diagnostics.mjs`. Its JSON
lists file/line/kind/owner for conservative candidate sites without copying source,
exception bodies or payloads. Every discovered site initially needs semantic review;
absence from that scan is not proof of absence from the runtime.

## Route crosswalk and qualification gaps

| Runtime surface / registration | Canonical check owner / producer | Public contract / propagation | Disposition |
| --- | --- | --- | --- |
| Shared CLI `cli/{index,run,core-command}.ts`, `cli/commands/*.ts` | Imported pa-core domains and command argument checks | Existing human stdout/stderr, exits; JSON-mode contracts vary by command | Ticket ownership slice targeted; all other command causes require semantic review |
| Pi CLI `packages/pi-pa/src/cli.ts` | Core commands, Pi launch, document/workflow/auto/session owners | Core delegation plus Pi-specific command human/JSON seams | Ticket status preserves typed errors; remaining owners unqualified |
| OPA CLI `packages/opencode-pa/src/cli.ts` | Shared core plus OpenCode launch/adapter | `runCoreCommand`, existing streams and exit | Core ticket slice shared; installed OPA not qualified |
| Pi native `pi-extension/{index,ticket-tool,ticket-status-tool}.ts` | Core tickets/{admin-service,status-service,status-intent,store}.ts and native authentication | Existing `content[].text`, `details.code`, `isError`; no extra fields | Ticket owner cause propagation targeted; composed host fixtures required |
| Other Pi native `pi-extension/*-tool.ts`, `native-host.ts` | workflow/document/decision/template/prepared/execution/phase-report/resource owners | Per-tool text/JSON and flags; returned and thrown failures differ | Unqualified; same umbrella code does not prove same cause |
| Pi hook/lower tool admission `native-execution-tools.ts`, `runtime-start-gate.ts`, execution evidence | Existing native custody/security/capability checks | Rejection vs warning/continuation must remain unchanged | Unqualified; do not replace with global catch formatter |
| OpenCode host plugin `packages/opencode-pa/src/plugins/` | OpenCode host hooks plus shared security/registry owners | Host hook throw/return/metadata, separate from Pi tools | Unqualified; no Pi-native parity claim |
| Agent REST `agent-api/routes/*.ts`, websocket/session hub | Route validation, TicketStore, lifecycle/runtime owners | HTTP status and existing JSON `error`/`code`; ticket UPDATE_FAILED retained | Ticket typed text already forwarded; other route errors unqualified |
| Workflow `workflows/{public,contracts,presentation,preflight}.ts` | Actual gates, journal, source, decision, resources and custody | Existing workflow result diagnostic/code/gate/owner fields | Generic gate/code rendering remains a gap; no cause inferred from code alone |
| Document `documents/`, `registry/{documents,workflows}.ts` | Existing journals, intents, publication, workspace and operation owners | Domain typed failures through CLI/native callers | Pending custody used by ticket check; other causes unqualified |
| Background/resume `deploy/`, Pi/OPA `{deploy,adapter,background-runner,session-owner}.ts` | Existing lifecycle, repository, process and retained snapshot owners | Readiness/status/logging vs returned failure; partial effects possible | Unqualified; no promise of no effects from a caught exception |
| Runtime host `packages/runtime-host/src/` | Session/process/tool host | Runtime protocol / IO | Unqualified; distinguish host failures from PA checks |
| Claude/Droid adapters `packages/{claudecode-pa,droidcode-pa}/` | Adapter entrypoints and upstream host | Actual supported routes must be established | Inventory candidates only; no support parity asserted |
| Security `sensitive-patterns.ts`, `local-source-file.ts`, policies, validation, selected config | Existing privacy/admission owners | Fail-closed public result vs protected evidence | Unqualified; never render raw payload/exception to explain a failure |
| External hooks/processes/provider failures, selected config scripts | Actual external component; PA wrapper owns only observed boundary | Exit/probe failure is not a proven credential/privacy/ownership cause | Attribute upstream boundary; upstream internals outside PA control |

## Ticket custody baseline and safe answer keys

The existing `TICKET_STATUS_OWNER` code remains stable. The original text collapsed
all rows below to “A retained workflow or another deployment has live or unproven
ownership.” These keys describe what the check actually knows, not the historical
PAP-348 cause. Check failures prevent the *current custody-gated write*; earlier
steps of the original operation may already exist. They do not prove a whole
request had no effects. Downstream checks after the decisive branch are not run.

| Cause | Actual check / safe observation | Consequence / first action / resume |
| --- | --- | --- |
| Ticket missing/project mismatch | Ticket record does not establish requested project | No proven matching target; operator asks ticket runtime maintainer to inspect; retry only after scope established |
| Retained workflow (status) | A workflow was returned, not necessarily pending | Status port cannot take over retained lineage; workflow owner establishes eligibility |
| Pending workflow (admin) | Workflow replay returned pending operations | Independent administration cannot cross pending effects; original workflow owner reconciles |
| Workflow read failure | Replay/lookup did not return usable evidence | Availability unknown, not a verified live owner; workflow runtime maintainer inspects original lineage |
| Pending document | Document journal replay returned pending effects | Original document owner reconciles; later deployment checks not evaluated |
| Document/registry probe failure | Existing record could not be read/replayed | Availability unknown; PA registry/document maintainer inspects, not an approval loop |
| Marker rejection (status) | Existing workflow marker guard rejected | Preserve that guard's typed facts where available; otherwise marker eligibility unproven, not a guessed pending document |
| Too many competing records | More than 256 competing records were returned | Bounded process checks were not run; registry maintainer establishes available custody |
| Active/nonterminal record | Registry state outside terminal release labels | Registry reports unreleased competing work; wait for supported owning lifecycle, not a verified process identity |
| Terminal without PID | No PID available for required release probe | Process release unknown; registry/process maintainer inspects original record |
| Terminal with process entry | Original `/proc` lookup found an entry | Process exists or PID reused; exact identity unknown; do not signal/kill/delete records |
| Process probe failure | Original lookup failed other than missing-entry | Process availability unknown; process runtime maintainer inspects |
| Registry lookup failure | No usable competing deployment list | No owner established; registry maintainer inspects; retry after evidence restored |

Waiting/asking has impact **none**, actor **operator**, no new approval to ask/wait;
any repair needs its own authority. All resume conditions require proven eligible
custody and fresh admission, preserving original intent and effect uncertainty.

## Completion rule

Generated discovery, semantic attribution, branch/route tests, installed candidate
observations, independent comprehension and human acceptance are separate evidence.
Unreviewed rows block full PAP-352 acceptance. This crosswalk deliberately retains
unqualified routes instead of counting a generic envelope as a runtime-wide repair.
