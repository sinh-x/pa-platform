import { JsonWorkflowError, type WorkflowTemplateCause } from "./contracts.js";

/** Preserve finite native causes, never underlying paths, bindings or exception text. */
export function workflowTemplateError(code: unknown): JsonWorkflowError {
  const causes: Record<WorkflowTemplateCause, [string, string]> = {
    TEMPLATE_PAIR: ["selected-template-pair", "config-runtime-owner"],
    TEMPLATE_CAPABILITY: ["shared-producer-capability", "producer-owner"],
    TEMPLATE_CONSUMER_REQUIRED: ["shared-producer-consumer", "runtime-owner"],
    TEMPLATE_CONTEXT: ["shared-producer-context", "workflow-owner"],
    TEMPLATE_VERSION: ["shared-producer-version", "config-runtime-owner"],
    TEMPLATE_DIGEST: ["selected-template-resource", "config-runtime-owner"],
    TEMPLATE_IO: ["selected-template-resource", "config-runtime-owner"],
    TEMPLATE_PATH: ["selected-template-resource", "config-runtime-owner"],
    TEMPLATE_INVENTORY: ["selected-template-inventory", "config-runtime-owner"],
    TEMPLATE_SELECTOR: ["selected-template-resource", "config-runtime-owner"],
    TEMPLATE_REJECTED: ["shared-producer-contract", "producer-owner"],
  };
  const cause = typeof code === "string" && Object.hasOwn(causes, code) ? code as WorkflowTemplateCause : "TEMPLATE_REJECTED";
  return new JsonWorkflowError(cause, ...causes[cause]);
}
