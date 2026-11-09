import { Type } from "typebox";
import { DocumentPackageError } from "@pa-platform/pa-core";
import { mutatePiWorkspace } from "../document-workspace.js";
import type { PiWorkflowContext } from "../workflow-native.js";
import type { PiToolDefinition } from "./index.js";

/** Fixed, bounded owner facts only; no raw exception/command/path interpolation. */
export function workspaceBlocker(code: string): string {
  const reason = code === "DOCUMENT_UNAVAILABLE" ? "The required trusted executable or confinement support is unavailable."
    : code === "DOCUMENT_CONFLICT" ? "The working file changed; the requested replacement did not match its current hash."
    : code === "DOCUMENT_AUTHORITY" ? "Native workspace identity or the requested path boundary was not proven."
    : code === "DOCUMENT_STALE" ? "The caller changed or the operation was cancelled; any helper effects must be inspected."
    : "The operation input, file safety or completion could not be proven.";
  return `Workspace operation not completed; independent safe drafting remains available.\nCondition: This workspace request did not establish completion.\nSource: Native requirements workspace boundary.\nReason: ${reason}\nCorrection: Ask the workspace/runtime owner to inspect this operation and retained helper results. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve the current workspace and operation evidence.\nResume Action: Correct the proven input or capability problem before requesting the affected operation again; native boundary checks run again. Do not repeat an uncertain helper effect blindly.`;
}
export function createWorkspaceTool(mutate = mutatePiWorkspace): PiToolDefinition {
  return { name: "pa_workspace", label: "PA Requirements Workspace", executionMode: "sequential",
    description: "Opt-in requirements workspace operations, not product execution or approval. One strict raw JSON request: capabilities; read(path); write(path,content,expectedSha256=null for absent file or current hash); import(path=explicit repository file,destination=absent workspace path); run(program=node|python3|bash,path=workspace script). Relative paths only. Helpers see only this writable workspace and immutable Nix tools; no repository, host HOME, network or foreign deployment. Actual tool availability/confinement is checked per operation; no catalogue or final package prerequisite. Time/output/process/file limits are finite; results retained privately. Generic bash/edit/write remain unavailable. Workspace files are mutable unsigned work, not frozen approval. No approval events, product edits, credentials, external effects, builder or Git rights.",
    parameters: Type.Object({ request: Type.String({ maxLength: 65536 }) }, { additionalProperties: false }),
    execute: async (_id, input, signal, _update, context) => {
      let value: Record<string, unknown>;
      try {
        if (Object.keys(input).length !== 1 || typeof input.request !== "string") throw new DocumentPackageError("DOCUMENT_INPUT");
        value = { schemaVersion: "pa-workspace-result/v1", ok: true, result: await mutate(input.request, context as PiWorkflowContext, signal) };
      } catch (error) {
        const code = error instanceof DocumentPackageError ? error.code : "DOCUMENT_INPUT";
        value = { schemaVersion: "pa-workspace-result/v1", ok: false, code, guidance: workspaceBlocker(code), scope: "this-operation-only" };
      }
      let output = JSON.stringify(value);
      if (Buffer.byteLength(output) > 50 * 1024) {
        const result = value.result as Record<string, unknown> | undefined;
        output = JSON.stringify({ schemaVersion: "pa-workspace-result/v1", ok: value.ok, result: { operationId: result?.operationId, evidence: result?.evidence, passed: result?.passed, cleanup: result?.cleanup, output: "Reply bounded; inspect the retained workspace/evidence before retry." } });
      }
      return { content: [{ type: "text", text: output }], details: {}, ...(value.ok ? {} : { isError: true }) };
    },
  };
}
