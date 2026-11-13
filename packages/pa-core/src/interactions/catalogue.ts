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

function nativeEntry(id: string, tool: string, action: string, effect: InteractionEffect, source: string, owner: string): CatalogueEntry {
  return Object.freeze({ ...entry(id, [], effect, "owner", source, owner),
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
    ["launch", ["deploy <team>", "deploy --background"], "launch", "owner"],
    ["resume", ["deploy --resume"], "launch", "owner"],
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
    ["status", ["serve status"], "write", "owner", { aliases: ["serve-status"], reason: "The existing CLI status wrapper removes stale PID state. A future native observational reader must use a separate safe read port, never this lifecycle wrapper." }],
    ["start", ["serve", "serve --background", "serve --force", "serve --dev", "serve --host", "serve --cors"], "resource", "operator"],
    ["stop", ["serve stop"], "resource", "operator", { aliases: ["stop"] }],
    ["restart", ["serve restart", "serve restart --dev", "serve restart --force", "serve restart --cors"], "resource", "operator", { aliases: ["restart"] }],
  ]),
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
    ["lifecycle", ["ticket update --status", "ticket update --assignee", "ticket update --force"], "write", "owner"],
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
  ...(["inspect", "set"] as const).map(action => Object.freeze({
    ...entry(`ticket.status.${action}`, [`ticket-status --request {action:${action}}`, ...(action === "inspect" ? ["ticket-status --help"] : [])], action === "inspect" ? "read" : "write", "owner", `${pi}ticket-status.ts`, "ticket status intent/CAS owner", {
      reason: "Additive selected Pi requirements status-only port; native and CLI share process authentication, lifecycle/owner checks and original intent. This source description is not installed availability, publication, queue or acceptance authority.",
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
  entry("auto.help", ["auto --help"], "read", "native", `${pi}auto-cli.ts`, "PPA auto inspection metadata"),
  entry("auto.list", ["auto list", "auto list --section", "auto list --page"], "read", "native", `${pi}auto-cli.ts`, "PPA auto retained unsigned waitlist", { reason: "Reads only a retained snapshot; no initialization, selection, approval, drafting or worker launch is supported." }),
  entry("auto.status", ["auto status"], "read", "native", `${pi}auto-cli.ts`, "PPA auto observation freshness", { reason: "Reads snapshot freshness and inspection-only availability; no timer, active item or execution grant is inferred." }),
  entry("auto.scan", ["auto scan", "auto --json"], "write", "owner", `${pi}auto-cli.ts`, "PPA auto unsigned coordination snapshot", { reason: "Read-only product observations run in a fixed bounded scanner child, but refresh writes an external coordination snapshot and scanner lock. It is not a pure read, Pi agent launch, human decision, selection or execution grant." }),
  entry("auto.foreground", ["auto"], "launch", "owner", `${pi}auto-foreground.ts`, "PPA auto native human foreground controller", { reason: "Interactive opening can explicitly select one global item, request bounded unsigned drafting, capture a new exact native start decision and automatically request one ordinary Pi launch. Document, ticket, capacity, checkout, source/check and pause owners still admit each effect; retained receipts grant no launch authority. Noninteractive opening only scans; no native tool or imported approval binding is exposed." }),
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
  ...["capabilities", "status", "discover", "context", "show", "read", "compare", "branch-inspect", "check"].map(action => nativeEntry(`document.native.${action}`, "pa_document", action, "read", `${pi}pi-extension/document-tool.ts`, "versioned document session")),
  ...["ticket-create", "draft", "freeze", "present", "capture", "revoke", "confirm", "confirm-revoke", "publish", "queue"].map(action => nativeEntry(`document.native.${action}`, "pa_document", action, "write", `${pi}pi-extension/document-tool.ts`, "versioned document package and decision")),
  nativeEntry("document.native.publication-diagnose", "pa_document", "publication-diagnose", "read", `${pi}pi-extension/document-tool.ts`, "qualified policy-profile document.package; exact retained publication intent; read-only"),
  nativeEntry("document.native.publication-retire", "pa_document", "publication-retire", "write", `${pi}pi-extension/document-tool.ts`, "qualified policy-profile document.package; eligible fresh unpublished intent and exact native retirement consent; no publication or queue"),
  ...["capabilities", "read"].map(action => nativeEntry(`workspace.${action}`, "pa_workspace", action, "read", `${pi}pi-extension/workspace-tool.ts`, "versioned document workspace")),
  ...["write", "import", "run"].map(action => nativeEntry(`workspace.${action}`, "pa_workspace", action, "write", `${pi}pi-extension/workspace-tool.ts`, "confined document workspace")),
  ...["request", "status", "retry"].map(action => nativeEntry(`preparation.${action}`, "pa_preparation", action, action === "status" ? "read" : "write", `${pi}pi-extension/prepared-workflow.ts`, "retained preparation owner")),
  ...["status", "activate", "bind", "deactivate"].map(action => nativeEntry(`workflow-policy.${action}`, "pa_workflow_policy", action, action === "status" ? "read" : "write", `${pi}pi-extension/prepared-workflow.ts`, "native optional workflow policy")),
  ...["status", "report", "observe", "plan", "advance", "select", "settle", "attempt", "resolve", "candidate", "accept"].map(action => nativeEntry(`execution.${action}`, "pa_execution", action, action === "status" ? "read" : "write", `${pi}pi-extension/prepared-workflow.ts`, "retained execution custody")),
  ...["capture", "observe-delivery", "publish", "status", "settle"].map(action => nativeEntry(`phase-report.${action}`, "pa_phase_report", action, action === "status" ? "read" : "write", `${pi}pi-extension/prepared-workflow.ts`, "native phase report")),
  nativeEntry("feature.update", "pa_feature_update", "update", "write", `${pi}pi-extension/prepared-workflow.ts`, "expected-remote feature update"),
  nativeEntry("borrow.approval", "pa_dirty_borrow_approval", "request", "write", `${pi}pi-extension/dirty-borrow-approval.ts`, "native foreground dirty borrow decision"),
]);

/** Independent high-risk invariants complement (not replace) semantic source review. */
const mustNotRead = new Set(["health.save", "status.wait", "deploy.preview", "evaluate.preview", "pi.reconcile-child.apply", "pi.ticket-worktree.refresh-head", "operation.run", "serve.status", "auto.scan", "auto.foreground"]);
const operatorFamilies = new Set(["signal", "repo-setup", "schedule"]);
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
    if (operatorFamilies.has(row.family) && row.targetDisposition !== "operator-only") issues.add("operator-boundary");
    if (row.targetDisposition === "deprecated" && !row.replacementId) issues.add("missing-replacement");
  }
  for (const id of mustNotRead) if (!ids.has(id)) issues.add("missing-effect-variant");
  for (const row of rows) {
    if (row.replacementId) {
      const target = rows.find(candidate => candidate.operationId === row.replacementId);
      if (!target || target.targetDisposition === "deprecated" || row.replacementId === row.operationId) issues.add("orphan-replacement");
    }
  }
  return [...issues].sort();
}
