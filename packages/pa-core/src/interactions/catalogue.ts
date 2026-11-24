import {
  INTERACTIONS_VERSION, INTERACTION_DISPOSITIONS, INTERACTION_EFFECTS,
  type InteractionDescriptor, type InteractionDisposition, type InteractionEffect,
} from "./contract.js";

/** This source-owned map describes intended coverage. It is NOT an executable dispatch table.
 * Bindings/schemas remain null until separately implemented and adapter-registered. In particular,
 * targetDisposition=native-supported is not a claim about this process's installed tools. */
export interface CatalogueEntry extends InteractionDescriptor { readonly replacementId: string | null }
type Route = "native" | "owner" | "operator" | "unsupported";
const core = "packages/pa-core/src/cli/commands/";
const pi = "packages/pi-pa/src/";
const disposition: Record<Route, InteractionDisposition> = {
  native: "native-supported", owner: "native-supported", operator: "operator-only", unsupported: "intentionally-unsupported",
};
const reasons: Record<Route, string> = {
  native: "A scoped typed port is required; source inventory alone does not establish an installed native binding.",
  owner: "Only the existing finite effect owner may perform this operation; discovery grants no authority.",
  operator: "This operation retains its existing operator boundary, including preview variants; no agent execution is granted.",
  unsupported: "The selected CLI rejects this form; do not emulate it or infer replacement authority.",
};
function entry(id: string, forms: readonly string[], effect: InteractionEffect, route: Route, source: string, owner: string,
  options: { aliases?: readonly string[]; reason?: string; replacementId?: string } = {}): CatalogueEntry {
  return Object.freeze({
    operationId: id, version: INTERACTIONS_VERSION, family: id.split(".")[0]!,
    cliForms: Object.freeze([...forms]), nativeForms: Object.freeze([]), channels: Object.freeze(["cli"] as const),
    aliases: Object.freeze([...(options.aliases ?? [])]),
    sourceHandler: source, effectClass: effect,
    targetDisposition: options.replacementId ? "deprecated" : disposition[route],
    owner, reason: options.reason ?? reasons[route],
    supportedNextStep: options.replacementId ? `Inspect ${options.replacementId}; its existing admission still applies.`
      : route === "operator" ? `Ask the ${owner} operator to inspect the request; do not execute it through a generic agent port.`
        : route === "unsupported" ? `Consult ${owner} for the supported replacement; do not retry the rejected form.`
          : `Inspect the ${owner} capability in the current session; execute only through its supported, independently admitted interface.`,
    requiredContext: Object.freeze(["authenticated caller", "existing role and resource visibility", route === "owner" ? "finite existing-owner admission" : "no authority from discovery"]),
    // Routing intent is not an authenticated finite service binding.
    nativeBinding: null, delegationBinding: null,
    requestSchemaRef: null, resultSchemaRef: null, replacementId: options.replacementId ?? null,
  });
}
function family(name: string, owner: string, rows: readonly (readonly [string, readonly string[], InteractionEffect, Route, { aliases?: readonly string[]; reason?: string; replacementId?: string }?])[]): CatalogueEntry[] {
  return rows.map(([id, forms, effect, route, options]) => entry(`${name}.${id}`, forms, effect, route, `${core}${name}.ts`, owner, options));
}

function nativeEntry(id: string, tool: string, action: string, effect: InteractionEffect, source: string, owner: string, reason?: string): CatalogueEntry {
  return Object.freeze({ ...entry(id, [], effect, "owner", source, owner, reason ? { reason } : {}),
    nativeForms: Object.freeze([`${tool}:${action}`]), channels: Object.freeze(["native"] as const),
  });
}

export const interactionCatalogue: readonly CatalogueEntry[] = Object.freeze([
  entry("global.help", ["help", "--help", "-h", "<no command>"], "read", "native", "packages/pa-core/src/cli/core-command.ts", "CLI metadata"),
  entry("global.version", ["--version", "-V"], "read", "native", `${pi}cli.ts`, "PPA package identity", { reason: "PPA global version is package metadata, not installed provenance; template --version selects a resource revision." }),
  ...family("status", "deployment status", [
    ["list", ["status", "status --running", "status --today", "status --team", "status --recent"], "read", "native"],
    ["detail", ["status <deployment>"], "read", "native"],
    ["activity", ["status --activity", "status --activity --verbose"], "read", "native"],
    ["report", ["status --report"], "read", "native"],
    ["artifacts", ["status --artifacts"], "read", "native"],
    ["wait", ["status --wait"], "write", "owner", { reason: "Waiting may reconcile lifecycle records or terminate processes. Do not call this wrapper from a read-only native port." }],
  ]),
  ...family("deploy", "deployment launcher", [
    ["modes", ["deploy --list-modes"], "read", "native"],
    ["validate", ["deploy --validate"], "read", "native"],
    ["preview", ["deploy --dry-run"], "write", "owner", { reason: "Dry-run may produce private launch artifacts; it is not a pure read or a launch grant." }],
    ["launch", ["deploy <team>", "deploy --background"], "launch", "owner", { reason: "Existing deployment admission remains authoritative. An explicitly build-selected Pi host admits the actual native runtime child; it adds no caller-controlled host selector, reader root or read grant. Profile-free interactive modes start ordinary instruction-driven sessions without native workflow, branch or approval admission; supplied tickets remain correlation data and selected PAPC instructions own delivery policy. Sensitive-command/data safeguards, canonical identity, runtime validation and retained checkout custody still apply; existing custody synchronization rechecks identity and evidence at startup, without promising exclusive session access. These sessions gain no native document or builder tools. Historical profile-selected public analyst/analyze retains its fixed v2 binding. Explicit v3 pa-readonly-document/v1 starts bind selected public names and committed resources before allocation and native admission; missing mode/default cannot fall through to a generic writer route. Launcher-owned bounded prompt references preserve existing launch effects and gates, not a new command or read grant. Independently authenticated ticket administration grants no workflow, source/Git, branch or approval authority; no retained-session upgrade follows. Source integration is not installed availability." }],
    ["resume", ["deploy --resume"], "launch", "owner", { reason: "Resume retains its existing launch effect and original intent. Ordinary interactive continuation requires the same team, mode, runtime, ticket and physical roots and an entirely unprotected original lineage verified from raw retained rows; it cannot reclassify a retained document, builder, review or checkout-bound session. Selected-host compatibility is checked before allocation; missing or mismatched private session/build evidence cannot silently upgrade or downgrade retained sessions. This is not an artifact permission or recovery grant." }],
    ["ticket-worktree", ["deploy --ticket-worktree"], "resource", "owner"],
    ["force", ["deploy --force"], "resource", "operator"],
    ["rogue-one", ["deploy rogue-one"], "launch", "operator"],
    ["model", ["deploy --model"], "launch", "owner"],
    ["team-model", ["deploy --team-model"], "launch", "owner", { replacementId: "deploy.model" }],
    ["agent-model", ["deploy --agent-model"], "launch", "unsupported"],
    ["removed-interactive", ["deploy --interactive", "deploy --direct"], "launch", "unsupported"],
    ["evaluate", ["deploy --evaluate-deployment"], "launch", "owner"],
  ]),
  ...family("evaluate", "evaluator lifecycle", [
    ["launch", ["evaluate <deployment>", "evaluate --evaluate-deployment", "evaluate --background"], "launch", "owner"],
    ["preview", ["evaluate --dry-run"], "write", "owner"],
    ["record", ["evaluate --record", "evaluate --record --report-path", "evaluate --record --overall", ...["productivity", "quality", "efficiency", "insight", "human-agency", "evidence-grounding", "instruction-compliance", "user-fit", "risk-handling", "outcome-integrity"].map(metric => `evaluate --record --${metric}`)], "write", "owner"],
    ["model", ["evaluate --model"], "launch", "owner"],
    ["team-model", ["evaluate --team-model"], "launch", "owner", { replacementId: "evaluate.model" }],
    ["agent-model", ["evaluate --agent-model"], "launch", "unsupported"],
  ]),
  ...family("serve", "Agent API server", [
    ["status", ["serve status", "serve status --host", "serve status --port"], "write", "owner", { aliases: ["serve-status"], reason: "The existing CLI status wrapper removes stale PID state and rejects --local-review. A future native observational reader must use a separate safe read port, never this lifecycle wrapper." }],
    ["start", ["serve", "serve --background", "serve --force", "serve --dev", "serve --host", "serve --port", "serve --cors", "serve --local-review"], "resource", "operator"],
    ["stop", ["serve stop", "serve stop --host", "serve stop --port"], "resource", "operator", { aliases: ["stop"] }],
    ["restart", ["serve restart", "serve restart --background", "serve restart --dev", "serve restart --force", "serve restart --host", "serve restart --port", "serve restart --cors", "serve restart --local-review"], "resource", "operator", { aliases: ["restart", "restart --local-review"] }],
  ]).map(row => row.operationId === "serve.start" || row.operationId === "serve.restart" ? Object.freeze({ ...row,
    reason: "Starting or restarting allocates a server resource. Explicit --local-review opts in to POST /api/documents/local-review only on numeric 127.0.0.1 or ::1; background propagation retains that opt-in. The shared v2 journal offers show/request/revoke/decide; decisions are local-unverified, not authenticated human consent. Any admitted local process can read eligible reviews and decide. Native socket ingress rejects browser Origin, forwarding and credentials even with --cors. No CLI/API effect parity; no publication, ref/link, queue or runner authority is added by the listener.",
    supportedNextStep: "Inspect the supported adapter's serve --help before explicit server-owner opt-in. Preserve original review coordinates; listener allocation does not admit a decision or dependent effect.",
    requiredContext: Object.freeze(["explicit server-owner invocation; no caller authentication at the review endpoint", "numeric loopback bind and direct peer; strict local-review input", "review actions require a persisted v2 subject and verified original immutable selection; no authority from discovery"]),
  }) : row),
  ...family("schedule", "scheduler", [
    ["create", ["schedule <spec>", "schedule daily:<mode>", "schedule signal:collect", "schedule --command"], "resource", "operator"],
    ["preview", ["schedule --dry-run"], "read", "operator"],
  ]),
  entry("timers.remove", ["remove-timer --yes"], "destructive", "operator", `${core}schedule.ts`, "scheduler"),
  entry("timers.remove-preview", ["remove-timer --dry-run"], "read", "operator", `${core}schedule.ts`, "scheduler"),
  ...family("timers", "scheduler metadata", [["list", ["timers", "timers --json"], "read", "native"]]),
  ...family("board", "ticket visibility", [["list", ["board", "board --project", "board --all", "board --include-archived"], "read", "native"]]),
  ...family("branch", "authenticated Git owner", [
    ["validate", ["branch validate"], "read", "native"], ["create", ["branch create"], "resource", "operator"],
  ]),
  ...family("teams", "selected configuration", [["list", ["teams", "teams --all", "teams --json"], "read", "native"], ["detail", ["teams <name>"], "read", "native"]]),
  ...family("repos", "repository registry", [["list", ["repos list", "repos list --json"], "read", "native"]]),
  ...family("repository", "repository ownership", [
    ["inspect", ["repository inspect"], "read", "native"], ["quarantine", ["repository quarantine"], "resource", "operator"],
  ]),
  ...family("registry", "deployment registry lifecycle", [
    ["list", ["registry list"], "read", "native"], ["show", ["registry show"], "read", "native"],
    ["search", ["registry search"], "read", "native"], ["analytics", ["registry analytics"], "read", "native"],
    ["complete", ["registry complete", "registry complete --fallback"], "write", "owner"],
    ["update", ["registry update", ...["source", "overall", "productivity", "quality", "efficiency", "insight"].map(metric => `registry update --rating-${metric}`)], "write", "owner"],
    ["associate", ["registry update --ticket --expected-ticket --actor --reason"], "write", "owner"],
    ["amend", ["registry amend"], "write", "owner", { replacementId: "registry.update" }],
    ["clean.preview", ["registry clean", "registry clean --dry-run"], "read", "operator"],
    ["clean.apply", ["registry clean --mark-dead"], "write", "operator"],
    ["sweep.preview", ["registry sweep", "registry sweep --dry-run"], "read", "operator"],
    ["sweep.apply", ["registry sweep --fix"], "write", "operator"],
  ]),
  ...family("ticket", "ticket store and lifecycle", [
    ["list", ["ticket list", "ticket list --all", "ticket list --archived"], "read", "native"],
    ["show", ["ticket show"], "read", "native"], ["check-refs", ["ticket check-refs"], "read", "native"],
    ["create", ["ticket create", "ticket create --project"], "write", "native"],
    ["planning", ["ticket update --title", "ticket update --summary", "ticket update --description", "ticket update --priority", "ticket update --estimate", "ticket update --tags", "ticket update --blocked-by"], "write", "native", { reason: "Native planning must be finite/CAS and incremental; CLI array replacement is not a safe native patch contract." }],
    ["comment", ["ticket comment", "ticket comment --content-file"], "write", "native"],
    ["attach", ["ticket attach"], "write", "native"],
    ["references", ["ticket update --doc-ref", "ticket update --remove-doc-ref"], "write", "native"],
    ["primary", ["ticket update --doc-ref-primary"], "write", "owner"],
    ["lifecycle", ["ticket update --status", "ticket update --assignee", "ticket update --force"], "write", "owner", { reason: "Generic CLI status and authenticated REST PATCH /api/tickets/:id use the shared TicketStore update owner, independent of team/mode or document profile and across target projects. Status reauthenticates the trusted running deployment/operator context under the mutex and checks live competing custody, pending workflow/document effects, unsettled ticket intents and open subtickets. Completed history is not a blanket stage restriction. This is not the selected status port's intent/CAS grammar; no CLI/REST/native effect parity, source/Git, approval, resource or launch authority follows. Deletion restrictions remain separate." }],
    ["branches", ["ticket update --linked-branch", "ticket update --remove-linked-branch"], "write", "owner"],
    ["commits", ["ticket update --linked-commit", "ticket update --remove-linked-commit"], "write", "owner"],
    ["move", ["ticket move"], "write", "operator"], ["delete", ["ticket delete"], "destructive", "operator"],
    ["delete-force", ["ticket delete --force --yes"], "destructive", "operator"],
    ["archive", ["ticket archive", "ticket update --archive"], "write", "operator"],
    ["unarchive", ["ticket unarchive"], "write", "operator"],
    ["subticket.list", ["ticket subticket list"], "read", "native"],
    ["subticket.create", ["ticket subticket create"], "write", "native"],
    ["subticket.planning", ["ticket subticket update"], "write", "native"],
    ["subticket.lifecycle", ["ticket subticket complete", "ticket subticket update --status"], "write", "owner"],
  ]),
  ...([
    ["inspect", "read", "Reads one exact ticket and complete snapshot version; oversized native replies retain metadata and explicitly omit the body. Inspection is not a reservation or admission for a later write."],
    ["create", "write", "Creates an idea with bounded administrative fields, default task/medium/M/sinh, and a stable original requestId through the existing creation-intent owner. Changed requests conflict; preserve original coordinates after response loss."],
    ["update", "write", "Updates only supplied title/summary/description/priority/estimate/type/assignee/tags/blockedBy/from/to fields under complete-snapshot CAS. Arrays replace their supplied values; no status, refs, primary, Git evidence or full-ticket replacement. Response-loss recovery is inspect-only, not idempotent replay authority."],
    ["set-status", "write", "Uses the existing durable status-intent owner with requestId, expectedVersion and status. Preserve original coordinates after response loss; same-status is a durable no-op, not execution or acceptance."],
    ["comment", "write", "Appends a bounded comment with author/audit derived from the authenticated public team/mode. Legacy comment(id,author,content) resolves the project from the existing ticket; author may name only the caller or a configured same-team agent, never identity or permission. Inspect after response loss; comments have no replay intent."],
  ] as const).map(([action, effect, detail]) => Object.freeze({
    ...nativeEntry(`ticket.native.${action}`, "pa_ticket", action, effect, `${pi}pi-extension/ticket-tool.ts`, "ticketAdminService / TicketStore; authenticatePiTicketCaller",
      `${detail} Generic native infrastructure supports any exact registered target project independently of team/mode, document capability selection or the launch ticket association. Managed Pi process/session, immutable registry start, canonical roots, private incarnation anchor and lineage must agree; environment labels alone are not authentication. The anchor recorder covers all managed teams/modes, not a role allowlist or a capability grant. Writes reauthenticate under the ticket mutex and reject live competing custody or unsettled owner effects; completed workflow/document history alone is not custody. In native execution sessions even inspect uses the administrative source barrier: no overlapping source operation or pending restart, unchanged source snapshot and separate administrative evidence, never a phase-check pass or failure reset. No source/Git, workflow, approval, publication, queue, resource or launch authority follows. Source support is not installed availability.`),
    aliases: Object.freeze(action === "comment" ? ["pa_ticket:comment(id,author,content)"] : []),
    requiredContext: Object.freeze(["authenticated managed Pi process/session and original launch incarnation", "exact registered target project and matching ticket; target need not be the launch ticket", "current owner checks under the shared ticket mutex; supplied versions and request IDs are preconditions, not authority"]),
    supportedNextStep: "Inspect the actually registered pa_ticket schema before use. Preserve original create/status intents; after uncertain update/comment results inspect the same ticket rather than blindly repeating a mutation. Discovery does not register or admit this interface.",
  })),
  ...(["inspect", "set"] as const).map(action => Object.freeze({
    ...entry(`ticket.status.${action}`, [`ticket-status --request {action:${action}}`, ...(action === "inspect" ? ["ticket-status --help"] : [])], action === "inspect" ? "read" : "write", "owner", `${pi}ticket-status.ts`, "ticket status intent/CAS owner", {
      reason: "Selected Pi policy status-only port: historical requirements/analyze or natively bound analyst/analyze, plus explicit v3 read-only document profiles selecting ticket.status. Native and CLI share document-process authentication, selected finite effective-identity admission, complete-snapshot CAS and original status intent. Any exact registered target project is supported, not just the caller's repository; target ticket/project must match and target workflow/competing-owner checks remain stricter than generic administration. Generic CLI/REST status and pa_ticket administration are separate owners, not bypasses inferred from this selection. This source description is not installed availability, source/Git, approval, resource, launch, publication, queue or acceptance authority.",
    }),
    nativeForms: Object.freeze([`pa_ticket_status:${action}`]), channels: Object.freeze(["cli", "native"] as const),
  })),
  ...family("bulletin", "bulletin administration", [
    ["list", ["bulletin list"], "read", "native"], ["create", ["bulletin create"], "write", "operator"], ["resolve", ["bulletin resolve"], "write", "operator"],
  ]),
  ...family("health", "health snapshots", [
    ["report", ["health", "health <category>", "health --json", "health --primer-summary"], "read", "native"],
    ["history", ["health --history"], "read", "native"], ["save", ["health --save"], "write", "owner"],
  ]),
  ...family("trash", "retention operator", [
    ["list", ["trash list"], "read", "native"], ["show", ["trash show"], "read", "native"],
    ["move", ["trash move", "trash move --yes"], "destructive", "operator"],
    ["restore", ["trash restore", "trash restore --force"], "write", "operator"],
    ["purge", ["trash purge"], "destructive", "operator"], ["purge-preview", ["trash purge --dry-run"], "read", "operator"],
  ]),
  ...family("codectx", "stored code context", [
    ["analyze", ["codectx analyze"], "write", "owner", { aliases: ["codectx refresh"] }],
    ["summary", ["codectx summary"], "read", "native"], ["status", ["codectx status"], "read", "native"],
    ["exists", ["codectx exists"], "read", "native"],
    ["query.exports", ["codectx query exports"], "read", "native"], ["query.file", ["codectx query file"], "read", "native"],
    ["query.function", ["codectx query function"], "read", "native", { aliases: ["codectx query fn"] }],
    ["query.class", ["codectx query class"], "read", "native"],
  ]),
  ...family("semantic", "semantic index", [
    ["query", ["semantic query"], "read", "native"], ["briefing", ["semantic briefing"], "read", "native"],
    ["rebuild", ["semantic rebuild"], "write", "owner", { aliases: ["semantic refresh"] }],
  ]),
  ...family("signal", "private Signal collection", [
    ["collect", ["signal collect", "signal collect --skip-route", "signal collect --conversation-id"], "sensitive", "operator"],
    ["collect.preview", ["signal collect --dry-run"], "sensitive", "operator"],
    ["reprocess", ["signal collect --reprocess"], "sensitive", "operator"],
    ["reprocess.preview", ["signal collect --reprocess --dry-run"], "sensitive", "operator"],
  ]),
  ...family("template", "selected canonical templates", [
    ["list", ["template list"], "read", "native"], ["show", ["template show --version"], "read", "native"],
    ["render", ["template render --version"], "read", "native"], ["validate", ["template validate --version"], "read", "native"],
  ]),
  ...family("operation", "admitted factual operation executor", [
    ["capabilities", ["operation capabilities"], "read", "native"],
    ["run", ["operation run --command --timeout"], "write", "owner", { reason: "Only the separately admitted executor accepts commands. This catalogue cannot forward commands; document profiles do not acquire an executor." }],
  ]),
  ...family("workflow", "selected workflow journal", [
    ["list", ["workflow list"], "read", "native"], ["show", ["workflow show"], "read", "native"],
    ["validate", ["workflow validate"], "read", "native"], ["preflight", ["workflow preflight"], "read", "native"],
    ["status", ["workflow status"], "read", "native"], ["next", ["workflow next"], "read", "native"],
  ]),
  ...["show", "verify"].map(action => entry(`decision.${action}`, [`decision ${action}`], "read", "native", `${core}workflow.ts`, "native decision")),
  entry("document.describe", ["document describe --format json"], "read", "native", `${pi}document-cli.ts`, "document interface"),
  ...[
    entry("document.review.help", ["document review", "document review --help", "document review serve --help"], "read", "native", `${pi}local-review-cli.ts`, "local review interface metadata", { reason: "Store-free help describes guided sign-content-only review and retained stdin/listener forms. Local confirmation is unauthenticated and local-unverified; help establishes neither installed/default selection nor effect authority." }),
    entry("document.review.stdin", ["document review --request-stdin"], "write", "owner", `${pi}local-review-cli.ts`, "shared local v2 review journal", { reason: "One strict pa-local-review/v1 JSON request on stdin: show reads; request/revoke persist pending requests; decide issues or replays local-unverified outcomes. No authentication, human identity evidence, publication, ref/link, queue or shell effects." }),
    entry("document.review.serve", ["document review serve --port"], "resource", "owner", `${pi}local-review-server.ts`, "explicit dedicated loopback review listener", { reason: "Starting a 127.0.0.1-only listener allocates a server resource and exposes eligible v2 review contents/decisions to other local processes. GET /v1/health is store-free; POST /v1/review uses the shared journal. No authentication/CORS, general agent API or CLI/API effect parity." }),
  ].map(row => Object.freeze({ ...row,
    supportedNextStep: "Inspect ppa document review --help before an explicit local invocation; retain original request coordinates for the selected version. No CLI/API effect parity or authenticated human consent is implied.",
    requiredContext: Object.freeze(["explicit local operator invocation; no caller authentication", ...(row.operationId === "document.review.help" ? ["store-free interface metadata only"] : ["persisted v2 subject and verified original immutable selection for review actions", "original request/revision coordinates; discovery grants no authority"])]),
  })),
  ...([
    ["list", "document review list TICKET", "read", "Lists eligible exact sign-content-only references without choosing a revision; a ticket is not a signing target. No request or decision is persisted."],
    ["show", "document review show REFERENCE", "read", "Reads the exact full content and delivery state without creating a pending request or decision. Unverified delivery is nonactionable; historical decisions are not effect authority."],
    ["sign", "document review REFERENCE", "write", "Requests or reconciles one canonical sign-content-only decision; default Cancel is deliberate, detach leaves pending and a saved decision does not prompt again. No publication, branch/ref/link, queue/status, resource or launch effect is authorized or invoked."],
  ] as const).map(([action, form, effect, reason]) => Object.freeze({
    ...entry(`document.review.${action}`, [form], effect, "owner", `${pi}content-review-cli.ts`, "shared exact content-review journal", { reason }),
    supportedNextStep: "Inspect ppa document review --help; list eligible references, then explicitly select one exact reference. Preserve that reference after reply loss; do not guess a revision or repeat a saved signature.",
    requiredContext: Object.freeze(["explicit local operator invocation; no caller authentication", "native-issued exact content-only reference and original immutable selection; a ticket only discovers references", "complete verified delivery before actionable signing; local-unverified outcome, not authenticated human consent"]),
  })),
  ...([
    ["prepare", "write", ["pa_document:review-prepare"], "Derives full immutable delivery and persists an exact branch-independent reference for an already frozen associated document; it issues no decision."],
    ["list", "read", ["pa_document:review-list", "/pa-review TICKET"], "Lists eligible exact references without choosing latest, persisting a request or guessing a pre-subject target."],
    ["show", "read", ["pa_document:review-show"], "Reads full exact content, delivery verification and canonical decision history; an unverified delivery is not actionable."],
    ["review", "write", ["pa_document:review-sign", "/pa-review REFERENCE"], "Requests or reconciles one shared native foreground decision; default Cancel is deliberate, detach leaves pending and a saved outcome does not prompt again."],
    ["request", "write", [], "Persists or reconciles the single canonical pending request without a foreground prompt; saved decisions are returned unchanged."],
    ["decide", "write", [], "Issues or identically replays a local-unverified content outcome; competing outcomes cannot overwrite the canonical decision."],
  ] as const).map(([action, effect, aliases, detail]) => Object.freeze({
    ...nativeEntry(`document.content-review.${action}`, "pa_handoff", `pa-content-review/v1:${action}`, effect, `${pi}content-review-native.ts`, "shared content-review journal and verified delivery owner",
      `${detail} Purpose is sign-content-only with immutable document.local-review + document.handoff + document.package selection and current native caller checks. Local confirmation is not authenticated human consent. No publication, branch/ref/link, queue/status, resource or launch authority or invocation; retained combined-effect scopes are not converted.`),
    nativeForms: Object.freeze([`pa_handoff:pa-content-review/v1:${action}`, ...aliases]),
  })),
  ...([
    ["authorize", "write", "content-publication-authorize", "Persists separate native finite publication authority for the same exact active content approval; it does not publish or sign content again."],
    ["status", "read", "content-publication-status", "Reads retained separate publication authority, lifecycle fence and original operation state; completed readback is not permission for missing effects."],
    ["publish", "write", "content-publish", "Consumes separate finite publication authority under fresh caller/custody/lifecycle/source/delivery/target/predecessor checks. The existing publisher persists intent before files/structured refs/tracking, verifies complete readback before sole requirements primary, and recovers only the original operation."],
    ["revoke", "write", "content-revoke", "Native lifecycle confirmation fences missing effects while preserving completed effects and decision history; no rollback or new signature."],
    ["supersede", "write", "content-supersede", "Native lifecycle confirmation binds an exact approved same-package successor and fences missing effects while preserving completed effects and history; no implicit retarget or new signature."],
  ] as const).map(([action, effect, alias, detail]) => Object.freeze({
    ...nativeEntry(`document.content-publication.${action}`, "pa_handoff", `pa-content-publication/v1:${action}`, effect, `${pi}content-publication-native.ts`, "separate content-publication authority and existing publication owner",
      `${detail} Separate publication authority is never inferred from signing or discovery. Immutable document.local-review + document.handoff + document.package and current caller admission remain required. No authority/outcome import, branch/link, queue/status, resource or launch grant; retained publication routes are unchanged.`),
    nativeForms: Object.freeze([`pa_handoff:pa-content-publication/v1:${action}`, `pa_document:${alias}`]),
  })),
  Object.freeze({
    ...nativeEntry("ticket.planned-actual", "pa_ticket", "read:plannedActual", "read", `${pi}pi-extension/ticket-tool.ts`, "existing ticket references and immutable report/read projection owners",
      "Existing ticket read/show independently discovers accessible draft/approved Planned references and candidate choices. An explicit reference reads Planned without inventing a candidate; adding a candidate selects its exact comparison. Complete snapshot-bound page continuation preserves selection, issues and evidence summaries without protected-store access. Repository, ticket, reviewed subject/revision/manifest and candidate must match; mismatches remain unmatched, missing/denied/integrity states remain explicit. Labelled narrative and separate evidence classes are not acceptance or permission. No latest selection, report policy/session allocation, attachment write or primary/lifecycle change."),
    nativeForms: Object.freeze(["pa_ticket:read:plannedActual", "pa_ticket:show:plannedActual", "pa_ticket:read:reference", "pa_ticket:show:reference", "pa_ticket:read:reference+candidate", "pa_ticket:show:reference+candidate", "pa_ticket:read:page", "pa_ticket:show:page"]),
  }),
  nativeEntry("resource.selected.read", "read", "selected-resource:<selected path>", "read", `${pi}pi-extension/selected-resource-read.ts`, "existing selected read and immutable mode-resource owner",
    "Uses the existing selected guarded/ordinary read tool only for an exact member of the original authenticated session resource inventory, including already admitted transitive resources. Pinned committed bytes and digest are checked with no mutable checkout fallback, arbitrary path or selection extension. Output remains reference-only, never instruction/tool activation. Retained/unselected sessions gain no selected-resource route; ordinary reads retain their existing guards."),
  entry("auto.policy.read", ["auto policy", "auto policy status", "auto policy status --json", "auto policy --json", "auto policy --help"], "read", "native", `${pi}auto-policy-cli.ts`, "PPA native document policy inspection", { reason: "Existing-only current/last native policy decisions, full scope and unresolved-review IDs. No initialization, material eligibility check, authority grant, provider, selection or launch." }),
  entry("auto.policy.review", ["auto policy adopt", "auto policy revoke", "auto policy withdraw"], "write", "operator", `${pi}auto-policy-cli.ts`, "PPA native document global policy decision owner", { reason: "Exact native unmanaged foreground review, default Cancel. Original permission request/capture/issuance are distinct and durable. Withdrawal is explicit exceptional original-review fencing, not an old approval import. No ticket selection, provider/worker, effect enablement, qualification, installation or activation. Old manual/content/publish/queue/start scopes are unchanged." }),
  entry("auto.shortlist.read", ["auto shortlist --json", "auto shortlist --help", "auto shortlist --view", "auto shortlist --section", "auto shortlist --page"], "read", "native", `${pi}auto-shortlist-cli.ts`, "PPA retained shortlist/report inventory", { reason: "Existing-only inspection of immutable native report/view/source pages and original cycle/choice/item state. No migration, scan, provider, policy, selection or launch occurs; time-current is not material admission." }),
  entry("auto.shortlist.foreground", ["auto shortlist"], "launch", "owner", `${pi}auto-shortlist-cli.ts`, "PPA native shortlist reasoning and human-choice owners", { reason: "Only an authenticated unmanaged terminal and the exact new producer pairing may reserve/register bounded reasoning, publish its unsigned shortlist and record one explicit human choice. No ranking/default/noninteractive input chooses work. The original selected item then needs its actual delegated policy/admission owner; no old start receipt, generic deploy fallback, service install or activation is supplied. Source fixtures are not provider/human qualification." }),
  entry("auto.units", ["auto units", "auto units --json"], "read", "native", `${pi}auto-background.ts`, "PPA auto user-unit description", { reason: "Renders fixed opt-in unit text only. It does not write units, call systemctl, install, activate or approve any ticket." }),
  entry("auto.tick", ["auto tick"], "write", "owner", `${pi}auto-background.ts`, "PPA auto periodic observation and informational notification", { reason: "An explicitly enabled wake may refresh unsigned snapshots, reconcile factual original results and request a desktop notification. It never selects, approves, publishes, queues or launches an agent. Default controls are disabled; it is not a pure reader." }),
  entry("auto.help", ["auto --help"], "read", "native", `${pi}auto-cli.ts`, "PPA auto inspection metadata"),
  entry("auto.list", ["auto list", "auto list --section", "auto list --page"], "read", "native", `${pi}auto-cli.ts`, "PPA auto retained unsigned waitlist", { reason: "Reads only a retained snapshot; no initialization, selection, approval, drafting or worker launch is supported." }),
  entry("auto.status", ["auto status"], "read", "native", `${pi}auto-cli.ts`, "PPA auto observed coordination and native local results", { reason: "Reads retained freshness, active coordination/control/notification IDs and existing native result evidence. It does not initialize, grant work, infer a launch or certify human acceptance." }),
  entry("auto.scan", ["auto scan", "auto --json"], "write", "owner", `${pi}auto-cli.ts`, "PPA auto unsigned coordination snapshot", { reason: "Read-only product observations run in a fixed bounded scanner child, but refresh writes an external coordination snapshot and scanner lock. It is not a pure read, Pi agent launch, human decision, selection or execution grant." }),
  entry("auto.foreground", ["auto"], "launch", "owner", `${pi}auto-foreground.ts`, "PPA auto native human foreground controller", { reason: "Interactive opening preserves the original mode owner: native r003 reasoning/choice/item state resumes only its shortlist owner, never an old manual proposal or repeated choice. Retained manual items can explicitly select one global item, capture one claimed exact native start decision and request one ordinary Pi launch. Retained v1 real drafting stays held; new shortlist source support does not widen that route. Fixture drivers are not grants. Document, ticket, capacity, checkout, source/check and pause owners still admit each effect; retained receipts grant no launch authority. Noninteractive opening only scans; no native tool or imported approval binding is exposed." }),
  ...family("artifact", "owned artifact session", [
    ["render", ["artifact render"], "write", "owner"], ["review.start", ["artifact review start"], "resource", "owner"],
    ["review.status", ["artifact review status"], "read", "owner"], ["review.stop", ["artifact review stop"], "resource", "owner"],
    ["review.feedback", ["artifact review feedback"], "write", "owner"],
  ]),
  ...family("repo-setup", "unmanaged operator credential and catalogue", [
    ["credential.init", ["repo-setup credential init"], "sensitive", "operator"],
    ["credential.rotate", ["repo-setup credential rotate"], "sensitive", "operator"],
    ["credential.reset", ["repo-setup credential reset"], "sensitive", "operator"],
    ["approve", ["repo-setup approve"], "write", "operator"], ["revoke", ["repo-setup revoke"], "write", "operator"],
    ["status", ["repo-setup status"], "read", "operator"],
  ]),
  entry("review.preflight", ["review preflight"], "read", "native", `${pi}review-preflight.ts`, "protected review preflight"),
  entry("pi.status", ["pi status", "pi status --local"], "read", "native", `${pi}cli.ts`, "Pi setup metadata"),
  ...["preflight", "smoke-tools", "teardown-smoke", "setup", "remove"].map(action => entry(`pi.${action}`, [`pi ${action}`], "resource", "operator", `${pi}cli.ts`, "Pi host operator")),
  entry("pi.inspect-recovery", ["pi inspect-recovery"], "read", "native", `${pi}ticket-recovery.ts`, "read-only retained ticket execution diagnosis"),
  entry("pi.ticket-worktree.inspect", ["pi ticket-worktree inspect"], "read", "native", `${pi}ticket-worktree-recovery.ts`, "read-only existing checkout and linked-HEAD diagnosis"),
  entry("pi.ticket-worktree.refresh-head", ["pi ticket-worktree refresh-head --expected-observation"], "write", "operator", `${pi}ticket-worktree-recovery.ts`, "existing ticket linked-HEAD and audit owner", { reason: "Metadata-only conditional HEAD refresh; does not settle execution claims, return leases or launch work. No native tool binding is added." }),
  entry("pi.reconcile-child.inspect", ["pi reconcile-child"], "read", "native", `${pi}child-reconciliation.ts`, "native child reconciliation"),
  entry("pi.reconcile-child.apply", ["pi reconcile-child --apply"], "write", "owner", `${pi}child-reconciliation.ts`, "native foreground child reconciliation"),
  // Policy selection changes eligibility, not the finite operations/effect owners.
  // These source descriptions do not prove a selected/live policy binding.
  nativeEntry("ticket.intake.capabilities", "pa_ticket_intake", "capabilities", "read", `${pi}pi-extension/ticket-intake-tool.ts`, "native v4 or explicitly policy-selected ticket.intake interface metadata"),
  ...["inspect", "reuse"].map(action => nativeEntry(`ticket.intake.${action}`, "pa_ticket_intake", action, "read", `${pi}pi-extension/ticket-intake-tool.ts`, "native v4 or explicitly policy-selected ticket.intake read-only exact-ticket selection")),
  nativeEntry("ticket.intake.create", "pa_ticket_intake", "create", "write", `${pi}pi-extension/ticket-intake-tool.ts`, "native v4 or explicitly policy-selected ticket.intake and unchanged creation-intent owner"),
  nativeEntry("ticket.intake.patch-planning", "pa_ticket_intake", "patch-planning", "write", `${pi}pi-extension/ticket-intake-tool.ts`, "native v4 or explicitly policy-selected ticket.intake scalar planning, caller-bound CAS, no other current/historical deployment association"),
  // Native-only operations are not invented CLI subcommands. Exact profile and
  // journal semantics remain with these source handlers; no binding is inferred.
  ...["admit", "revise", "request-step", "reconcile"].map(action => nativeEntry(`workflow.native.${action}`, "pa_workflow", action, "write", `${pi}pi-extension/workflow.ts`, "selected workflow journal")),
  ...["capture", "recover", "adopt", "revoke"].map(action => nativeEntry(`decision.native.${action}`, "pa_decision", action, "write", `${pi}pi-extension/workflow.ts`, "native foreground decision")),
  ...["capabilities", "status", "discover", "context", "show", "read", "compare", "branch-inspect", "check"].map(action => nativeEntry(`document.native.${action}`, "pa_document", action, "read", `${pi}pi-extension/document-tool.ts`, "versioned document session",
    action === "check" ? "Structural source validation only; no snapshot or approval is persisted. New own-deployment artifact intake requires the selected policy document.package owner and exact authenticated deployment; all members are checked before reading. Retained frozen-source continuation is separate; no repository write or publication grant follows." : undefined)),
  ...["ticket-create", "draft", "freeze", "present", "capture", "revoke", "confirm", "confirm-revoke", "publish", "queue"].map(action => nativeEntry(`document.native.${action}`, "pa_document", action, "write", `${pi}pi-extension/document-tool.ts`, "versioned document package and decision",
    action === "draft" || action === "freeze" ? `${action === "draft" ? "Writes an unsigned text draft with exact content CAS" : "Persists an unapproved immutable package snapshot"}. New own-deployment artifact authoring/intake requires the selected policy document.package owner and exact authenticated deployment, not a path-shaped grant. Retained profiles are not upgraded; no repository write, approval, publication, ref/link, queue or runner authority follows.` : undefined)),
  nativeEntry("document.native.publication-diagnose", "pa_document", "publication-diagnose", "read", `${pi}pi-extension/document-tool.ts`, "qualified policy-profile document.package; exact retained publication intent; read-only"),
  nativeEntry("document.native.publication-retire", "pa_document", "publication-retire", "write", `${pi}pi-extension/document-tool.ts`, "qualified policy-profile document.package; eligible fresh unpublished intent and exact native retirement consent; no publication or queue"),
  nativeEntry("handoff.plan-status", "pa_handoff", "plan-status", "read", `${pi}pi-extension/handoff-tool.ts`, "v2-only selected same-session original plan; existing-file-only process authentication and intent/ticket/audit observation; no initialization, repair, foreign-origin adoption or effect admission"),
  nativeEntry("handoff.status", "pa_handoff", "status", "read", `${pi}pi-extension/handoff-tool.ts`, "selected document.handoff; v1 original caller only, v2 shared local show with immutable origin and separate effect states"),
  ...["show", "preflight", "request", "decide", "refresh"].map(action => nativeEntry(`handoff.${action}`, "pa_handoff", action, ["show", "preflight"].includes(action) ? "read" : "write", `${pi}pi-extension/handoff-tool.ts`,
    action === "refresh" ? "v2-only exact stale predecessor/plan/link and complete-ticket CAS; no approval or dependent effects"
      : action === "preflight" ? "v2-only read-only eligibility/local-develop observation; no stale history append or effect grant"
        : "v2-only immutable document.local-review + document.handoff + document.package; local-unverified decision owner, not authenticated human consent")),
  ...["intake", "stage", "plan", "prepare-review", "review", "revoke", "publish", "complete-branch", "queue"].map(action => nativeEntry(`handoff.${action}`, "pa_handoff", action, "write", `${pi}pi-extension/handoff-tool.ts`,
    action === "revoke" ? "v1 native foreground revocation; v2 request-only revocation finalized by decide using original pre-request revision/key; no rollback"
      : "explicit native finite handoff owner; v2 fresh selected continuation rechecks current caller and exact ended origin/custody; no retained grant upgrade, checkout or launch",
    action === "review" ? "The v2 foreground review observes the original request and returns its canonical shared decision across request/view/capture boundaries; detachment is not a shared Cancel or a new approval. Local-unverified outcomes are not authenticated human consent. The v1 genuine foreground evidence owner is unchanged; publication, ref/link, queue and runner effects remain separately admitted." : undefined)),
  nativeEntry("handoff.open", "pa_handoff", "open", "resource", `${pi}pi-extension/handoff-tool.ts`, "verified native delivery; operator-approved system-default-browser fallback only, no isolation/viewing qualification"),
  ...["capabilities", "read"].map(action => nativeEntry(`workspace.${action}`, "pa_workspace", action, "read", `${pi}pi-extension/workspace-tool.ts`, "versioned document workspace")),
  ...["write", "import", "run"].map(action => nativeEntry(`workspace.${action}`, "pa_workspace", action, "write", `${pi}pi-extension/workspace-tool.ts`, "confined document workspace")),
  ...["request", "status", "retry"].map(action => nativeEntry(`preparation.${action}`, "pa_preparation", action, action === "status" ? "read" : "write", `${pi}pi-extension/prepared-workflow.ts`, "retained preparation owner")),
  ...["status", "activate", "bind", "deactivate"].map(action => nativeEntry(`workflow-policy.${action}`, "pa_workflow_policy", action, action === "status" ? "read" : "write", `${pi}pi-extension/prepared-workflow.ts`, "native optional workflow policy")),
  ...["status", "report", "observe", "plan", "advance", "select", "settle", "attempt", "resolve", "candidate", "accept"].map(action => nativeEntry(`execution.${action}`, "pa_execution", action, action === "status" ? "read" : "write", `${pi}pi-extension/prepared-workflow.ts`, "retained execution custody")),
  ...["capture", "observe-delivery", "publish", "status", "settle"].map(action => nativeEntry(`phase-report.${action}`, "pa_phase_report", action, action === "status" ? "read" : "write", `${pi}pi-extension/prepared-workflow.ts`, "native phase report")),
  nativeEntry("phase-report.attach-actual", "pa_phase_report", "attach-actual", "write", `${pi}pi-extension/prepared-workflow.ts`, "existing native phase report and audited ticket-reference owners",
    "Persists an exact reviewed plan + native report/candidate comparison and immutable locator, then adds nonprimary orch/impl/attachment refs through the existing ticket owner. AC dispositions and actual-only scope remain labelled narrative, not acceptance. No reviewed plan rewrite, primary/status change, new report store or execution grant."),
  nativeEntry("phase-report.observe-actual", "pa_phase_report", "observe-actual", "write", `${pi}pi-extension/prepared-workflow.ts`, "existing native report foreground observation and attachment owners",
    "Appends exact-bound local-unverified human UAT evidence and its comparison attachment after an explicit foreground observation; preserves earlier Not run/Pending evidence. It is not a read, authenticated identity, source/installed/browser evidence or automatic acceptance. No plan/primary/lifecycle rewrite or execution grant."),
  nativeEntry("feature.update", "pa_feature_update", "update", "write", `${pi}pi-extension/prepared-workflow.ts`, "expected-remote feature update"),
  nativeEntry("borrow.approval", "pa_dirty_borrow_approval", "request", "write", `${pi}pi-extension/dirty-borrow-approval.ts`, "native foreground dirty borrow decision"),
]);

/** Independent high-risk invariants complement (not replace) semantic source review. */
const mustNotRead = new Set(["health.save", "status.wait", "deploy.preview", "evaluate.preview", "pi.reconcile-child.apply", "pi.ticket-worktree.refresh-head", "operation.run", "serve.status", "serve.start", "serve.restart", "auto.scan", "auto.foreground", "auto.tick", "auto.shortlist.foreground", "auto.policy.review", "document.review.stdin", "document.review.serve", "handoff.request", "handoff.decide", "handoff.refresh"]);
// Exact closure for reconciled finite variants, including reads. This is an
// independent semantic guard, not an executable admission/dispatch table.
const finiteEffects: Readonly<Record<string, InteractionEffect>> = Object.freeze({
  "ticket.native.inspect": "read", "ticket.native.create": "write", "ticket.native.update": "write",
  "ticket.native.set-status": "write", "ticket.native.comment": "write",
  "ticket.status.inspect": "read", "ticket.status.set": "write",
  "document.content-review.prepare": "write", "document.content-review.list": "read", "document.content-review.show": "read",
  "document.content-review.review": "write", "document.content-review.request": "write", "document.content-review.decide": "write",
  "document.content-publication.authorize": "write", "document.content-publication.status": "read", "document.content-publication.publish": "write",
  "document.content-publication.revoke": "write", "document.content-publication.supersede": "write",
  "document.review.list": "read", "document.review.show": "read", "document.review.sign": "write",
  "phase-report.attach-actual": "write", "phase-report.observe-actual": "write", "ticket.planned-actual": "read", "resource.selected.read": "read",
});
const operatorFamilies = new Set(["signal", "repo-setup", "schedule"]);
const operatorOperations = new Set(["serve.start", "serve.restart"]);
export function validateInteractionCatalogue(rows: readonly CatalogueEntry[]): string[] {
  const issues = new Set<string>();
  const ids = new Set<string>();
  const forms = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.operationId)) issues.add("duplicate-operation");
    ids.add(row.operationId);
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(row.operationId) || row.family !== row.operationId.split(".")[0]) issues.add("invalid-identity");
    if (row.version !== INTERACTIONS_VERSION || !INTERACTION_EFFECTS.includes(row.effectClass) || !INTERACTION_DISPOSITIONS.includes(row.targetDisposition)) issues.add("invalid-contract");
    if (row.cliForms.length === 0 && row.nativeForms.length === 0) issues.add("missing-operation-form");
    if (row.channels.includes("cli") !== (row.cliForms.length > 0) || row.channels.includes("native") !== (row.nativeForms.length > 0)) issues.add("invalid-channel");
    for (const form of [...row.cliForms, ...row.nativeForms, ...row.aliases]) {
      if (forms.has(form)) issues.add("duplicate-cli-form");
      forms.add(form);
    }
    if (!row.owner || !row.reason || !row.supportedNextStep || row.requiredContext.length === 0) issues.add("missing-owner-guidance");
    if (row.nativeBinding && (!row.requestSchemaRef || !row.resultSchemaRef)) issues.add("unbound-schema");
    if (mustNotRead.has(row.operationId) && row.effectClass === "read") issues.add("effect-regression");
    if (Object.hasOwn(finiteEffects, row.operationId)) {
      if (row.effectClass !== finiteEffects[row.operationId]) issues.add("effect-regression");
      if (row.nativeBinding !== null || row.delegationBinding !== null || row.requestSchemaRef !== null || row.resultSchemaRef !== null) issues.add("source-binding-regression");
    }
    if ((operatorFamilies.has(row.family) || operatorOperations.has(row.operationId)) && row.targetDisposition !== "operator-only") issues.add("operator-boundary");
    if (row.targetDisposition === "deprecated" && !row.replacementId) issues.add("missing-replacement");
  }
  for (const id of [...mustNotRead, ...Object.keys(finiteEffects)]) if (!ids.has(id)) issues.add("missing-effect-variant");
  for (const row of rows) {
    if (row.replacementId) {
      const target = rows.find(candidate => candidate.operationId === row.replacementId);
      if (!target || target.targetDisposition === "deprecated" || row.replacementId === row.operationId) issues.add("orphan-replacement");
    }
  }
  return [...issues].sort();
}
