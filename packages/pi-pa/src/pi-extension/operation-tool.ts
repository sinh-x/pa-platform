import { Type } from "typebox";
import { boundOperationOutput, executeOperation, operationFailure, operationNativeIsError, OPERATION_TOOL_DESCRIPTION, type AdvisoryOperationHost } from "@pa-platform/pa-core";
import type { PiExtensionModule } from "./index.js";

/** Thin adapter. Domain failure is data; it never returns terminate or changes
 * the session tool loadout. Native host authentication is separate from JSON. */
export function createOperationModule(resolve: (context: unknown) => AdvisoryOperationHost | null = () => null): PiExtensionModule {
  return (pi, lifecycle) => {
    pi.registerTool?.({ name: "pa_operation", label: "PA Operation", description: OPERATION_TOOL_DESCRIPTION,
      parameters: Type.Object({ request: Type.String({ maxLength: 16384, description: 'One strict JSON request: {"action":"capabilities"} or {"action":"run","command":"…","timeoutSeconds":1200}. No result/approval fields.' }) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, input, signal, _update, context) => {
        const run = async () => {
          let result;
          try { result = await executeOperation(input.request as string, "pi", resolve(context), signal); }
          catch { result = operationFailure("OPERATION_INVOCATION_ERROR"); }
          const summary = JSON.stringify({ operationId: result.operationId, completion: result.completion, outcome: result.outcome, enforcement: result.enforcement, capability: result.capability, process: result.process, findings: result.findings });
          return { content: [{ type: "text" as const, text: boundOperationOutput(summary + (result.output.text ? `\n${result.output.text}` : ""), result.output.fullEvidenceRef).text }], details: { operation: result }, isError: operationNativeIsError(result) };
        };
        return lifecycle ? lifecycle.trackRegistryAccess(run) : run();
      },
    });
  };
}
export const registerOperationModule = createOperationModule();
