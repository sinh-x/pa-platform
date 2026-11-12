import { Type } from "typebox";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoSensitiveMatch, DocumentPackageError, getAiUsageDir, getConfigDir, getDeploymentEvents, readArtifactFile } from "@pa-platform/pa-core";
import { mutatePiDocument } from "../document-native.js";
import { runDocumentConfirmationCommand } from "./document-confirmation-command.js";
import type { PiDocumentConfirmationContext } from "../document-confirmation-native.js";
import { createWorkspaceTool } from "./workspace-tool.js";
import { createPublicWebTool } from "./web-read-tool.js";
import { createTicketStatusTool } from "./ticket-status-tool.js";
import { confirmationDocumentCaller, DOCUMENT_INTERACTIONS_SESSION_VERSION, DOCUMENT_SESSION_VERSIONS, workspaceDocumentCaller, authenticatePiDocumentCaller } from "../document-session.js";
import { createPaTicketIntakeTool, ticketIntakeFailure } from "./ticket-intake-tool.js";
import { createPaCapabilitiesTool } from "./capability-tool.js";
import { MODE_CAPABILITY_SESSION, ModeCapabilityError, capabilityToolSelected, selectedCapabilityTools } from "@pa-platform/pa-core";
import type { PiWorkflowContext } from "../workflow-native.js";
import type { PiExtensionModule, PiToolCall, PiToolDefinition } from "./index.js";

/** New requirements capability tools, never arbitrary subprocess/RPC execution. */
export function createDocumentTool(mutate = mutatePiDocument, workspaceProfile = false, confirmationProfile = false): PiToolDefinition {
  const workspaceDescription = "Requirements package operations for native workspace-v2. Use capabilities for exact availability. Same strict package/check/freeze/show/read/compare/publish/queue grammar as document-v1; present(sha256) generates full immutable Markdown links, safe static HTML companions and a source/renderer hash manifest. It does not open or observe a viewer. Okular export is unavailable: use an explicit Markdown/browser fallback. capture/revoke are unavailable until the host provides attested human-event provenance; no select-dialog fallback or model-supplied approval. Publication/queue still require existing native-issued authority, exact source checks and owning services. pa_workspace provides separate unsigned investigation tools. No source/Git/builder authority.";
  const confirmationDescription = "Native pa-document-confirmation/v3 supporting operations. Same strict document package/status/read/check/freeze/present/publication tools as workspace-v2. confirm(sha256,expectedRevision,scope=content|publish|publish-and-queue) requests ONE native TUI decision with full immutable document/technical tabs; no page acknowledgements or second final approval. confirm-revoke(sha256,expectedRevision,decisionId) requests append-only revocation. Native UI derives outcome/principal/interaction; no chat attestation, caller outcomes, identities, paths or receipt imports. Exact unchanged retries MUST reuse the ORIGINAL request revision/scope/target: issued decisions reconcile immutable JSON and ticket tracking without a new prompt. Use status/show to recover request coordinates. JSON tracking is not authority; publication/queue verify native scope, source, lifecycle and owners. capture/revoke remain the retained interface, not a fallback here. branch-inspect(ticket) reads existing linkedBranches through native repository/worktree/lease/ownership owners, returns precise observed blockers and never prepares, relinks or launches. Repeat observations are not grants and selection/launch recheck mutable facts. Operator /pa-approve accepts the same strict confirm/confirm-revoke JSON. pa_workspace remains separately bounded. No builder/source/Git authority.";
  return { name: "pa_document", label: "PA Document Package", executionMode: "sequential",
    description: confirmationProfile ? confirmationDescription : workspaceProfile ? workspaceDescription : "Requirements supporting operations, not a workflow controller. One strict raw JSON request: capabilities; status(ticket) to recover snapshot/effect identities; ticket-create(title,content,intakeId) for ticketless intake with same-ID retry; discover(path='.' or relative directory); context(path); draft(path under artifacts/drafts/<native deployment ID>/,content,expectedSha256=null or prior hash); check(package); freeze(package,expectedRevision); show(sha256); read(sha256,path=member ID,offset=0 then nextOffset); compare(sha256,previousSha256); capture(sha256,expectedRevision); revoke/publish/queue(sha256,expectedRevision,decisionId). Native foreground capture only; no caller actor/outcome/grant. Snapshots are immutable, all members required. Checks assess structure only; preview unavailable, full Markdown remains readable. Protected effects use owning services and same-intent reconciliation. No builder/source/resource authority.",
    parameters: Type.Object({ request: Type.String({ maxLength: 65536 }) }, { additionalProperties: false }),
    execute: async (_id, input, signal, _update, context) => {
      let result: Record<string, unknown>;
      try {
        if (Object.keys(input).length !== 1 || typeof input.request !== "string" || Buffer.byteLength(input.request) > 65536) throw new DocumentPackageError("DOCUMENT_INPUT");
        result = await mutate(input.request, context as PiWorkflowContext, signal);
      } catch (error) { result = { schemaVersion: "pa-document-result/v1", ok: false, code: error instanceof DocumentPackageError ? error.code : "DOCUMENT_UNAVAILABLE", scope: "this-operation-only", executionAdmitted: false }; }
      let output = JSON.stringify(result);
      if (Buffer.byteLength(output) > 50 * 1024 || output.split("\n").length > 2000) {
        // Effects may already be durable: never turn a lost/oversized reply into an absent transaction.
        const data = result.result as Record<string, unknown> | undefined;
        output = JSON.stringify({ schemaVersion: "pa-document-result/v1", ok: result.ok, action: result.action, output: "bounded-summary-use-show-and-paged-read", sha256: data?.sha256, expectedRevision: data?.expectedRevision, operationId: data?.operationId, outcome: data?.outcome, decisionId: data?.decisionId, approval: data?.approval, executionAdmitted: false });
      }
      return { content: [{ type: "text", text: output }], details: {}, ...(result.ok === true ? {} : { isError: true }) };
    },
  };
}
export function documentSessionToolAllowed(call: PiToolCall, repoRoot?: string, workspaceProfile = false, interactionsProfile = false): boolean {
  const name = call.toolName ?? call.name ?? "";
  if (interactionsProfile && ["pa_ticket_intake", "pa_capabilities"].includes(name)) return true;
  if (workspaceProfile && name === "pa_workspace") return true;
  if (name === "read") return guardedDocumentReadAllowed(call, repoRoot);
  return ["pa_document", "pa_ticket", "pa_bulletin", "pa_registry", "pa_status", "pa_template", "question", "todo"].includes(name);
}
export function guardedDocumentReadAllowed(call: PiToolCall, repoRoot?: string): boolean {
  if (repoRoot && typeof call.input.path === "string") {
    try {
      const selected = call.input.path;
      const path = realpathSync(isAbsolute(selected) ? selected : resolve(repoRoot, selected));
      const roots = [repoRoot, join(getAiUsageDir(), "agent-teams/requirements/artifacts")];
      try { roots.push(realpathSync(getConfigDir())); } catch { /* optional instructions root absence does not deny project reads */ }
      if (!roots.some(root => path.startsWith(`${root}/`))) return false;
      assertNoSensitiveMatch("path", path); assertNoSensitiveMatch("filename", path.split("/").at(-1)!);
      const bytes = readArtifactFile(path, 8 * 1024 * 1024, "ARTIFACT_STALE");
      assertNoSensitiveMatch("content", bytes.toString("utf8"));
      return true;
    } catch { return false; }
  }
  return false;
}
/** Capture native route once; later environment edits cannot turn off the guard. */
export function policyDocumentDeployment(): string | undefined {
  const id = process.env.PA_DEPLOYMENT_ID;
  return id && getDeploymentEvents(id).some(event => event.event === "started" && event.note === MODE_CAPABILITY_SESSION) ? id : undefined;
}
export function assertPolicyDocumentTool(deploymentId: string, call: PiToolCall, context: PiWorkflowContext): void {
  const caller = authenticatePiDocumentCaller(context);
  if (caller.deploymentId !== deploymentId || !caller.capabilities) throw new ModeCapabilityError("CAPABILITY_BINDING");
  const name = call.toolName ?? call.name ?? "";
  if (!capabilityToolSelected(caller.capabilities.policy, name)) throw new ModeCapabilityError("CAPABILITY_OMITTED");
  if (name === "read" && !caller.capabilities.policy.allow.includes("ordinary.read") && !guardedDocumentReadAllowed(call, caller.repoRoot)) throw new ModeCapabilityError("CAPABILITY_BINDING");
}
export const registerDocumentModule: PiExtensionModule = (pi, lifecycle) => {
  const policyDeploymentId = policyDocumentDeployment();
  const exposePolicy = (context: unknown) => {
    if (!policyDeploymentId) return;
    try {
      const caller = authenticatePiDocumentCaller(context as PiWorkflowContext);
      if (caller.deploymentId !== policyDeploymentId || !caller.capabilities || !pi.setActiveTools) throw new ModeCapabilityError("CAPABILITY_BINDING");
      pi.setActiveTools([...selectedCapabilityTools(caller.capabilities.policy)]);
    } catch (error) { pi.setActiveTools?.([]); throw error; }
  };
  pi.on?.("before_agent_start", (_event, context) => exposePolicy(context));
  pi.on?.("session_start", (_event: unknown, rawContext: unknown) => {
    // Retained/OPA-equivalent managed loadouts must not advertise a capability
    // they cannot authenticate. Register only in a genuine new document route.
    let caller;
    try { caller = authenticatePiDocumentCaller(rawContext as PiWorkflowContext); } catch { if (policyDeploymentId) pi.setActiveTools?.([]); return; }
    const confirmationProfile = confirmationDocumentCaller(caller);
    const interactionsProfile = caller.profile === DOCUMENT_INTERACTIONS_SESSION_VERSION;
    const document = createDocumentTool(mutatePiDocument, workspaceDocumentCaller(caller), confirmationProfile);
    if (interactionsProfile) document.description = "Native document interactions-v4: retains the confirmation-v3 package/workspace behavior described below. Additional requested ticket creation is a SEPARATE pa_ticket_intake port, not an expansion of document ticket-create or retained pa_ticket. " + document.description;
    if (caller.capabilities) document.description = "Native config-selected document operations: the following package/confirmation semantics are preserved; tool access is limited to this session's immutable selection. Ticket intake and source discovery are separate selectable tools, not extra document actions. " + document.description;
    const tools = [document, ...(workspaceDocumentCaller(caller) ? [createWorkspaceTool()] : []),
      ...(caller.capabilities && capabilityToolSelected(caller.capabilities.policy, "pa_ticket_status") ? [createTicketStatusTool(caller.identitySha256)] : []),
      ...(caller.capabilities && caller.sessionId && capabilityToolSelected(caller.capabilities.policy, "pa_web_read") ? [createPublicWebTool(caller.deploymentId, caller.sessionId, lifecycle)] : [])];
    if (interactionsProfile || caller.capabilities) {
      tools.push(createPaTicketIntakeTool(caller.identitySha256));
      const identity = caller.identitySha256;
      tools.push(createPaCapabilitiesTool(context => {
        const current = authenticatePiDocumentCaller(context as PiWorkflowContext);
        return current.identitySha256 === identity && (current.profile === DOCUMENT_INTERACTIONS_SESSION_VERSION
          || (current.profile === MODE_CAPABILITY_SESSION && !!current.capabilities && capabilityToolSelected(current.capabilities.policy, "pa_capabilities")));
      }));
    }
    if (confirmationProfile) pi.registerCommand?.("pa-approve", { description: "Request/reconcile one native package decision. Arguments: strict confirm or confirm-revoke JSON (same pa_document grammar).", handler: (args, context) => lifecycle ? lifecycle.trackRegistryAccess(() => runDocumentConfirmationCommand(args, context as PiDocumentConfirmationContext)) : runDocumentConfirmationCommand(args, context as PiDocumentConfirmationContext) });
    for (const tool of tools) {
      if (caller.capabilities && !capabilityToolSelected(caller.capabilities.policy, tool.name)) continue;
      pi.registerTool?.({ ...tool, execute: async (...args) => {
        const run = () => {
          if (policyDeploymentId) assertPolicyDocumentTool(policyDeploymentId, { toolName: tool.name, input: args[1] }, args[4] as PiWorkflowContext);
          return tool.execute(...args);
        };
        try { return await (lifecycle ? lifecycle.trackRegistryAccess(run) : run()); }
        catch (error) {
          // Retain v4's bounded late-call response without opening a closed registry.
          if (tool.name === "pa_ticket_intake") return ticketIntakeFailure(error);
          throw error;
        }
      } });
    }
    exposePolicy(rawContext);
  });
  pi.on?.("tool_call", (event: unknown, rawContext: unknown) => {
    if (policyDeploymentId) {
      try { assertPolicyDocumentTool(policyDeploymentId, event as PiToolCall, rawContext as PiWorkflowContext); return; }
      catch (error) { return { block: true, reason: error instanceof ModeCapabilityError ? error.message : new ModeCapabilityError("CAPABILITY_BINDING").message }; }
    }
    const id = process.env.PA_DEPLOYMENT_ID;
    if (!id || process.env.PA_TEAM !== "requirements" || process.env.PA_MODE !== "analyze") return;
    const starts = getDeploymentEvents(id).filter(e => e.event === "started");
    if (!starts.some(e => DOCUMENT_SESSION_VERSIONS.some(version => version === e.note))) return; // retained route, never silently upgraded
    let caller;
    try { caller = authenticatePiDocumentCaller(rawContext as PiWorkflowContext); }
    catch { return { block: true, reason: "Native document-session identity is unproven; no source/resource capability is granted." }; }
    return documentSessionToolAllowed(event as PiToolCall, (rawContext as PiWorkflowContext).cwd, workspaceDocumentCaller(caller), caller.profile === DOCUMENT_INTERACTIONS_SESSION_VERSION) ? undefined : { block: true, reason: "This requirements route supports artifact drafting/context and ticket tools, not shell/source/Git/builder/resource operations. Use pa_document for local supporting operations." };
  });
};
