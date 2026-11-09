import { Type } from "typebox";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoSensitiveMatch, DocumentPackageError, getAiUsageDir, getConfigDir, getDeploymentEvents, readArtifactFile } from "@pa-platform/pa-core";
import { mutatePiDocument } from "../document-native.js";
import { createWorkspaceTool } from "./workspace-tool.js";
import { DOCUMENT_SESSION_VERSION, DOCUMENT_WORKSPACE_SESSION_VERSION, authenticatePiDocumentCaller } from "../document-session.js";
import type { PiWorkflowContext } from "../workflow-native.js";
import type { PiExtensionModule, PiToolCall, PiToolDefinition } from "./index.js";

/** New requirements capability tools, never arbitrary subprocess/RPC execution. */
export function createDocumentTool(mutate = mutatePiDocument, workspaceProfile = false): PiToolDefinition {
  const workspaceDescription = "Requirements package operations for native workspace-v2. Use capabilities for exact availability. Same strict package/check/freeze/show/read/compare/publish/queue grammar as document-v1; present(sha256) generates full immutable Markdown links, safe static HTML companions and a source/renderer hash manifest. It does not open or observe a viewer. Okular export is unavailable: use an explicit Markdown/browser fallback. capture/revoke are unavailable until the host provides attested human-event provenance; no select-dialog fallback or model-supplied approval. Publication/queue still require existing native-issued authority, exact source checks and owning services. pa_workspace provides separate unsigned investigation tools. No source/Git/builder authority.";
  return { name: "pa_document", label: "PA Document Package", executionMode: "sequential",
    description: workspaceProfile ? workspaceDescription : "Requirements supporting operations, not a workflow controller. One strict raw JSON request: capabilities; status(ticket) to recover snapshot/effect identities; ticket-create(title,content,intakeId) for ticketless intake with same-ID retry; discover(path='.' or relative directory); context(path); draft(path under artifacts/drafts/<native deployment ID>/,content,expectedSha256=null or prior hash); check(package); freeze(package,expectedRevision); show(sha256); read(sha256,path=member ID,offset=0 then nextOffset); compare(sha256,previousSha256); capture(sha256,expectedRevision); revoke/publish/queue(sha256,expectedRevision,decisionId). Native foreground capture only; no caller actor/outcome/grant. Snapshots are immutable, all members required. Checks assess structure only; preview unavailable, full Markdown remains readable. Protected effects use owning services and same-intent reconciliation. No builder/source/resource authority.",
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
        output = JSON.stringify({ schemaVersion: "pa-document-result/v1", ok: result.ok, action: result.action, output: "bounded-summary-use-show-and-paged-read", sha256: data?.sha256, expectedRevision: data?.expectedRevision, operationId: data?.operationId, outcome: data?.outcome, executionAdmitted: false });
      }
      return { content: [{ type: "text", text: output }], details: {}, ...(result.ok === true ? {} : { isError: true }) };
    },
  };
}
export function documentSessionToolAllowed(call: PiToolCall, repoRoot?: string): boolean {
  const name = call.toolName ?? call.name ?? "";
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
    const tools = [createDocumentTool(mutatePiDocument, caller.profile === DOCUMENT_WORKSPACE_SESSION_VERSION), ...(caller.profile === DOCUMENT_WORKSPACE_SESSION_VERSION ? [createWorkspaceTool()] : [])];
    for (const tool of tools) pi.registerTool?.({ ...tool, execute: (...args) => lifecycle ? lifecycle.trackRegistryAccess(() => tool.execute(...args)) : tool.execute(...args) });
  });
  pi.on?.("tool_call", (event: unknown, rawContext: unknown) => {
    const id = process.env.PA_DEPLOYMENT_ID;
    if (!id || process.env.PA_TEAM !== "requirements" || process.env.PA_MODE !== "analyze") return;
    const starts = getDeploymentEvents(id).filter(e => e.event === "started");
    if (!starts.some(e => [DOCUMENT_SESSION_VERSION, DOCUMENT_WORKSPACE_SESSION_VERSION].includes(e.note ?? ""))) return; // retained route, never silently upgraded
    let caller;
    try { caller = authenticatePiDocumentCaller(rawContext as PiWorkflowContext); }
    catch { return { block: true, reason: "Native document-session identity is unproven; no source/resource capability is granted." }; }
    const name = (event as PiToolCall).toolName ?? (event as PiToolCall).name;
    if (caller.profile === DOCUMENT_WORKSPACE_SESSION_VERSION && name === "pa_workspace") return;
    return documentSessionToolAllowed(event as PiToolCall, (rawContext as PiWorkflowContext).cwd) ? undefined : { block: true, reason: "This requirements route supports artifact drafting/context and ticket tools, not shell/source/Git/builder/resource operations. Use pa_document for local supporting operations." };
  });
};
