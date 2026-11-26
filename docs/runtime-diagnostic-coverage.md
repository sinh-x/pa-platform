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
| Marker rejection (status/admin read) | Existing marker owner supplies typed list-shape, missing-run, conflicting-marker, project-mismatch, registry-read or document-intent facts | Each known branch retains its own reason and workflow code; document intent does not assert live execution; arbitrary lower failures remain explicitly unproven |
| Too many competing records | More than 256 competing records were returned | Bounded process checks were not run; registry maintainer establishes available custody |
| Active/nonterminal record | Registry state outside terminal release labels | Registry reports unreleased competing work; wait for supported owning lifecycle, not a verified process identity |
| Terminal without PID | No PID available for required release probe | Process release unknown; registry/process maintainer inspects original record |
| Terminal with process entry | Original `/proc` lookup found an entry | Process exists or PID reused; exact identity unknown; do not signal/kill/delete records |
| Process probe failure | Original lookup failed other than missing-entry | Process availability unknown; process runtime maintainer inspects |
| Registry lookup failure | No usable competing deployment list | No owner established; registry maintainer inspects; retry after evidence restored |

Waiting/asking has impact **none**, actor **operator**, no new approval to ask/wait;
any repair needs its own authority. All resume conditions require proven eligible
custody and fresh admission, preserving original intent and effect uncertainty.

## P2 source reconciliation

The ticket ownership slice now preserves distinct constants at the original guard
branches, without adding probes or changing verdict/order. A found process entry is
not process identity; absent process entries still allow the existing release path.
The registered competing deployment ID is included only in its existing public
`d-` plus six hexadecimal form, never a PID/path/record body. Original operation
effects remain distinct from the current blocked custody-gated write.

The existing workflow marker owner now throws a `JsonWorkflowError` subtype carrying
its original finite cause privately. Existing code/gate/owner fields remain; marker
checks, SQL, order and cleanup are unchanged. The status owner maps those facts,
not exception text. Other raw infrastructure failures retain existing workflow
contracts and are not guessed into marker conflicts.

After branch tests and contract reconciliation, source-inventory renews only the
two changed ticket status digests and adds their pure formatter plus the existing
marker owner and its typed diagnostic. Interaction forms, null bindings/schema
refs, tool admission, statuses, exits and discovery availability are unchanged.
No adapter capabilities or supported command grammar are added. This is an
implementer reconciliation, not independent coverage or installed qualification.

## P3 propagation qualification (source fixtures only)

No adapter schema or rendering change was needed for this slice: existing seams
already forward the typed error's message. Tests now assert the actual native
`pa_ticket` pending-document reply and `pa_ticket_status` process-presence reply,
its code/error flag, and exactly one envelope. The latter is compared byte-for-byte
(with terminal newline removed) with actual PPA and OPA CLI subprocess stderr;
stdout remains empty and exit remains 1. The OPA case is shared CLI delegation,
**not OpenCode host-hook qualification**. Authenticated REST fixtures check four
causes in the existing `error` field with unchanged `UPDATE_FAILED` and HTTP 400,
and unchanged ticket/audit snapshots. Workflow failure JSON retains the marker
subtype's message and original field set/code.

These are synthetic process/session/host fixtures using candidate-built core,
not installed runtime journeys or independent comprehension. The broad native
suite exceeded a 180-second combined timeout after reporting passing cases; its
result is incomplete, not a pass. Focused reruns are recorded separately in the
deployment report. Warning/partial-effect/lifecycle and other route families above
remain unqualified; they are not repaired by these propagation assertions.

## P4 qualification checkpoint — incomplete combined delivery

Workspace typecheck and build passed on `38f04b8`. `corepack pnpm test` was
attempted with a 480-second bound: the root 71-test group passed, then the core
suite was interrupted after test 673; no completed workspace result exists. This
is **incomplete**, not a regression pass. Installed `ppa` and `opa` report 0.1.190,
but version equality does not bind them to this feature candidate; no installed
journey or installation was performed. Independent review and human UAT are not run.

Qualification inspection corrected inventory exclusion of `.test.mjs`/`.spec.*`,
made shell/Python script boundaries explicit, and refused symlinks/special files.
The resulting conservative inventory has **7,242 candidate sites in 393 files**,
including 13 script boundaries. External selected configuration/hooks remain a
separate-owner gap. The inventory test is included in both root regression commands.
A readability self-review restored sentence separation before a deployment
reference; only that pure formatter's source pin is renewed for this correction.
Focused owner/REST/native/CLI tests are rerun after it; full workspace qualification
remains incomplete. No broad-phase or PAP-352 completion is asserted.

## Follow-up: unsupported local file diagnostics and affected path

The reader-specific follow-up implements `LOCAL_SOURCE_UNSUPPORTED_FILE`, not a
blanket permission change for Nix. Existing file/path, descriptor, selected-host,
immutable metadata, text, stability and cleanup checks retain their order/verdict.
The deciding branches now preserve finite original observations: nonregular file,
ordinary multi-link count without a selected binding, selected multi-link alias,
immutable ownership/link/mode, selected root/scope, image signature, invalid UTF-8
and forbidden controls. A repeated scope check after a payload read must not claim
that reading never started. No facts are inferred from arbitrary exceptions.

For this code, the human headline includes the **requested file path**, not a
resolved target or offending ancestor path, when the original path guards have
established safe disclosure. The guard reuses its loaded policy for a pure
content-pattern disclosure check. An opaque in-memory reference prevents raw
request fields from masquerading as a checked display path; it is neither read
permission nor a native identity/authority ledger. Controls, bidi/format characters
and colons are escaped; a reference exceeding 512 UTF-16 units is withheld whole,
not truncated into another apparent filename. Missing/private/unadmitted references
explicitly say “File path withheld.” No new path resolution/probe or policy load is
performed by formatting. Rechecks refresh disclosure only through their original
path checks, never reusing it after an earlier failed scope check.

The default unknown diagnostic now explicitly says the exact admission predicate
is unknown, rather than listing possible causes as if observed. Error codes,
enumerable Error fields and the native `failureClass` behavior are unchanged;
finite unsupported facts are held privately. The constructor's optional internal
observation is not a tool argument or a new response field. No alternate-reading,
permission-repair or copying workaround is recommended.

The three existing source/immutable-owner pins are renewed after branch/contract
reconciliation, adding only their pure `local-source-diagnostic.ts` dependency.
Interaction forms, effects, tool selection, null native bindings and unproven
installed availability remain unchanged. Real ordinary-file tests and inert
virtual descriptor tests cover cause/phase/disclosure/cleanup; virtual selected
metadata is not genuine installed selected-host qualification. The historical
unspecified Nix documents remain undiagnosed.

Follow-up source qualification: **94 core security/catalogue tests and 49 Pi
read/publication/composition tests pass**, including direct and registered error
replies with unchanged native keys/flags, safe paths, private/long-path withholding,
control/label escaping, FIFO rejection without waiting for a writer, read counts, cleanup,
image delivery, cancellation and publication revocation. Workspace typecheck and
build pass. These are affected regressions, not a complete workspace-test result,
installed selected-Pi journey, OpenCode-host qualification or human UAT. No runtime
installation, selected binding activation or source permission change was made.

## Completion rule

Generated discovery, semantic attribution, branch/route tests, installed candidate
observations, independent comprehension and human acceptance are separate evidence.
Unreviewed rows block full PAP-352 acceptance. This crosswalk deliberately retains
unqualified routes instead of counting a generic envelope as a runtime-wide repair.
