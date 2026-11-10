import { Type } from "typebox";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoSensitiveMatch, DocumentPackageError, getAiUsageDir, getConfigDir, getDeploymentEvents, readArtifactFile } from "@pa-platform/pa-core";
import { mutatePiDocument } from "../document-native.js";
import { runDocumentConfirmationCommand } from "./document-confirmation-command.js";
import type { PiDocumentConfirmationContext } from "../document-confirmation-native.js";
import { createWorkspaceTool } from "./workspace-tool.js";
import { DOCUMENT_CONFIRMATION_SESSION_VERSION, DOCUMENT_SESSION_VERSIONS, workspaceDocumentCaller, authenticatePiDocumentCaller } from "../document-session.js";
import type { PiWorkflowContext } from "../workflow-native.js";
import type { PiExtensionModule, PiToolCall, PiToolDefinition } from "./index.js";

/** New requirements capability tools, never arbitrary subprocess/RPC execution. */
export function createDocumentTool(mutate = mutatePiDocument, workspaceProfile = false, confirmationProfile = false): PiToolDefinition {
  const workspaceDescription = "Requirements package operations for native workspace-v2. Use capabilities for exact availability. Same strict package/check/freeze/show/read/compare/publish/queue grammar as document-v1; present(sha256) generates full immutable Markdown links, safe static HTML companions and a source/renderer hash manifest. It does not open or observe a viewer. Okular export is unavailable: use an explicit Markdown/browser fallback. capture/revoke are unavailable until the host provides attested human-event provenance; no select-dialog fallback or model-supplied approval. Publication/queue still require existing native-issued authority, exact source checks and owning services. pa_workspace provides separate unsigned investigation tools. No source/Git/builder authority.";
  const confirmationDescription = "Native pa-document-confirmation/v3 supporting operations. Same strict document package/status/read/check/freeze/present/publication tools as workspace-v2. confirm(sha256,expectedRevision,scope=content|publish|publish-and-queue) requests ONE native TUI decision with full immutable document/technical tabs; no page acknowledgements or second final approval. confirm-revoke(sha256,expectedRevision,decisionId) requests append-only revocation. Native UI derives outcome/principal/interaction; no chat attestation, caller outcomes, identities, paths or receipt imports. Exact unchanged retries MUST reuse the ORIGINAL request revision/scope/target: issued decisions reconcile immutable JSON and ticket tracking without a new prompt. Use status/show to recover request coordinates. JSON tracking is not authority; publication/queue verify native scope, source, lifecycle and owners. capture/revoke remain the retained interface, not a fallback here. Operator /pa-approve accepts the same strict confirm/confirm-revoke JSON. pa_workspace remains separately bounded. No builder/source/Git authority.";
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
export function documentSessionToolAllowed(call: PiToolCall, repoRoot?: string, workspaceProfile = false): boolean {
  const name = call.toolName ?? call.name ?? "";
  if (workspaceProfile && name === "pa_workspace") return true;
  if (name === "read" && repoRoot && typeof call.input.path === "string") {
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
  return ["pa_document", "pa_ticket", "pa_bulletin", "pa_registry", "pa_status", "pa_template", "question", "todo"].includes(name);
}
export const registerDocumentModule: PiExtensionModule = (pi, lifecycle) => {
  pi.on?.("session_start", (_event: unknown, rawContext: unknown) => {
    // Retained/OPA-equivalent managed loadouts must not advertise a capability
    // they cannot authenticate. Register only in a genuine new document route.
    let caller;
    try { caller = authenticatePiDocumentCaller(rawContext as PiWorkflowContext); } catch { return; }
    const confirmationProfile = caller.profile === DOCUMENT_CONFIRMATION_SESSION_VERSION;
    const tools = [createDocumentTool(mutatePiDocument, workspaceDocumentCaller(caller), confirmationProfile), ...(workspaceDocumentCaller(caller) ? [createWorkspaceTool()] : [])];
    if (confirmationProfile) pi.registerCommand?.("pa-approve", { description: "Request/reconcile one native package decision. Arguments: strict confirm or confirm-revoke JSON (same pa_document grammar).", handler: (args, context) => lifecycle ? lifecycle.trackRegistryAccess(() => runDocumentConfirmationCommand(args, context as PiDocumentConfirmationContext)) : runDocumentConfirmationCommand(args, context as PiDocumentConfirmationContext) });
    for (const tool of tools) pi.registerTool?.({ ...tool, execute: (...args) => lifecycle ? lifecycle.trackRegistryAccess(() => tool.execute(...args)) : tool.execute(...args) });
  });
  pi.on?.("tool_call", (event: unknown, rawContext: unknown) => {
    const id = process.env.PA_DEPLOYMENT_ID;
    if (!id || process.env.PA_TEAM !== "requirements" || process.env.PA_MODE !== "analyze") return;
    const starts = getDeploymentEvents(id).filter(e => e.event === "started");
    if (!starts.some(e => DOCUMENT_SESSION_VERSIONS.some(version => version === e.note))) return; // retained route, never silently upgraded
    let caller;
    try { caller = authenticatePiDocumentCaller(rawContext as PiWorkflowContext); }
    catch { return { block: true, reason: "Native document-session identity is unproven; no source/resource capability is granted." }; }
    return documentSessionToolAllowed(event as PiToolCall, (rawContext as PiWorkflowContext).cwd, workspaceDocumentCaller(caller)) ? undefined : { block: true, reason: "This requirements route supports artifact drafting/context and ticket tools, not shell/source/Git/builder/resource operations. Use pa_document for local supporting operations." };
  });
};
