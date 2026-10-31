import { Type } from "typebox";
import { workflowReadService, workflowFailure, MAX_WORKFLOW_RECORD_BYTES, JsonWorkflowError, parseWorkflowRequest, type WorkflowReadHost } from "@pa-platform/pa-core";
import { mutatePiWorkflow, piWorkflowReadHost, type PiWorkflowMutation } from "../workflow-host.js";
import type { PiWorkflowContext } from "../workflow-native.js";
import type { PiExtensionModule, PiSessionLifecycle, PiToolDefinition, PiToolResult } from "./index.js";

export interface PiJsonWorkflowOptions { readHost?: WorkflowReadHost; mutate?: typeof mutatePiWorkflow }
const denied = () => { throw new JsonWorkflowError("WORKFLOW_CONTRACT"); };
function mutation(input: unknown, tool: "workflow" | "decision"): PiWorkflowMutation | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return denied();
  const r = input as Record<string, unknown>, action = r.action;
  if (typeof action !== "string") return denied();
  const fields: Record<string, string[]> = tool === "workflow" ? { admit: ["producer"], revise: ["revision", "producer"], "request-step": ["revision", "stepId"], reconcile: ["revision", "intentId"] } : { capture: ["revision", "stepId"], revoke: ["revision", "decisionId"] };
  if (!Object.hasOwn(fields, action)) {
    if (tool === "workflow" ? ["list", "show", "validate", "preflight", "status", "next"].includes(action) : ["show", "verify"].includes(action)) return null;
    return denied();
  }
  const allowed = ["action", ...fields[action]!];
  if (Object.keys(r).length !== allowed.length || Object.keys(r).some(k => !allowed.includes(k))) return denied();
  if (action !== "admit" && (!Number.isSafeInteger(r.revision) || Number(r.revision) < 1)) return denied();
  if (action === "admit" || action === "revise") { if (typeof r.producer !== "string" || !r.producer.length) return denied(); }
  else for (const field of fields[action]!.filter(f => f !== "revision")) if (typeof r[field] !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(r[field] as string)) return denied();
  return r as unknown as PiWorkflowMutation;
}
function tool(name: "workflow" | "decision", options: PiJsonWorkflowOptions, lifecycle?: PiSessionLifecycle): PiToolDefinition {
  return {
    name: `pa_${name}`, label: `PA ${name}`, executionMode: "sequential",
    description: name === "workflow" ? "Read selected/pinned JSON workflows; request admission, an exact-revision linked subject attempt, or an eligible registered step/reconciliation. No completion, capability or arbitrary command override." : "Read/verify issued decisions or request exact-subject native foreground capture/revocation. Never accepts actor, outcome or permission grants.",
    parameters: Type.Object({ request: Type.String({ maxLength: MAX_WORKFLOW_RECORD_BYTES, description: "One strict JSON request document; duplicate keys, unknown fields and byte limits reject." }) }, { additionalProperties: false }),
    execute: async (_id, input, _signal, _update, context) => {
      const run = async (): Promise<PiToolResult> => {
        let result: Record<string, unknown>;
        try {
          if (Object.keys(input).length !== 1 || typeof input.request !== "string" || Buffer.byteLength(input.request) > MAX_WORKFLOW_RECORD_BYTES) return denied();
          const parsed = parseWorkflowRequest(input.request), request = mutation(parsed, name);
          if (request) result = await (options.mutate ?? mutatePiWorkflow)(request, context as PiWorkflowContext);
          else {
            const row = parsed as Record<string, unknown>;
            if (name === "decision") row.action = `decision-${row.action as string}`;
            result = workflowReadService(JSON.stringify(row), options.readHost ?? piWorkflowReadHost());
          }
        } catch (error) { result = workflowFailure(error); }
        if (Buffer.byteLength(JSON.stringify(result)) > 50 * 1024) result = workflowFailure(new JsonWorkflowError("WORKFLOW_CONTRACT"));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {}, ...(result.ok === true ? {} : { isError: true }) };
      };
      return lifecycle ? lifecycle.trackRegistryAccess(run) : run();
    },
  };
}
export function createJsonWorkflowModule(options: PiJsonWorkflowOptions = {}): PiExtensionModule {
  return (pi, lifecycle) => { pi.registerTool?.(tool("workflow", options, lifecycle)); pi.registerTool?.(tool("decision", options, lifecycle)); };
}
export const registerJsonWorkflowModule = createJsonWorkflowModule();
