import { Type } from "typebox";
import { MAX_REPO_SETUP_REQUEST_BYTES } from "@pa-platform/pa-core";
import { mutatePiRepoSetup } from "../repo-setup-native.js";
import type { PiExtensionModule, PiToolDefinition, PiToolCall } from "./index.js";

export function createPaRepoSetupTool(): PiToolDefinition {
  return {
    name: "pa_repo_setup", label: "PA Repository Setup", executionMode: "sequential",
    description: "Inspect or stage a bounded, unapproved command catalogue at the registered primary repository's fixed .pa/project-commands.json. Raw JSON actions: inspect; stage with expected=null or the exact prior candidate reference and candidate=raw catalogue JSON string. Requires the authenticated ticketless repo-setup/setup Pi deployment. No caller roots, paths, grants, approval, credentials, ignore/Git/source edits, command execution or execution readiness.",
    parameters: Type.Object({ request: Type.String({ maxLength: MAX_REPO_SETUP_REQUEST_BYTES }) }, { additionalProperties: false }),
    execute: async (_id, input, signal, _update, context) => {
      const result = signal?.aborted ? { ok: false, error: { code: "SETUP_REQUEST" }, executionReady: false } : mutatePiRepoSetup(input, context);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {}, isError: result.ok !== true };
    },
  };
}
/** Defense in depth for the managed setup agent, not OS-user isolation. Only the
 * native writer has the fixed administrative write surface. No shell/script,
 * generic editor, child spawn, workflow mutation, credential or approval tool.
 * Unknown/nested wrapper tools also fail closed.
 */
export function repoSetupToolAllowed(call: PiToolCall): boolean {
  const name = call.name ?? call.toolName;
  if (["read", "grep", "glob", "find", "ls", "pa_repo_setup", "pa_registry", "pa_status", "pa_bulletin", "pa_template", "todo", "question"].includes(name ?? "")) return true;
  return name === "pa_ticket" && ["read", "show", "list"].includes(String(call.input?.action));
}
export const registerRepoSetupModule: PiExtensionModule = (pi, lifecycle) => {
  if (process.env.PA_TEAM !== "repo-setup") return;
  pi.registerTool?.(createPaRepoSetupTool());
  pi.on?.("tool_call", call => repoSetupToolAllowed(call) ? undefined : { block: true, reason: "repo-setup permits read-only discovery and the native fixed-path candidate writer only; no shell, generic edit, source/Git/credential/approval or child operation" });
  // Shutdown tracking is owned by the shared module lifecycle. The writer uses
  // synchronous protected owners, so no lock can outlive a completed tool call.
  void lifecycle;
};
