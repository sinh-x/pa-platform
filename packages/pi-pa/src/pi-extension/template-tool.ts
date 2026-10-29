import { Type } from "typebox";
import { MAX_TEMPLATE_REQUEST_BYTES, TemplateError, templateFailure, templateService, type TemplateHost } from "@pa-platform/pa-core";
import type { PiExtensionModule, PiToolDefinition } from "./index.js";

/** Raw request documents preserve decoded-key duplicates and exact UTF-8 bounds
 * across Pi's already-parsed tool framing. No subprocess wrapper or truncation. */
export function createPaTemplateTool(host: TemplateHost = {}): PiToolDefinition {
  return {
    name: "pa_template", label: "PA Templates",
    description: "List/show/render/validate selected canonical templates. request contains a raw JSON document, e.g. {\"action\":\"list\"}. show/render/validate require id and exact version; render requires bindings; validate also requires the exact candidate. Outputs are unsigned structural drafts, never approvals, native facts or readiness. No writes. Pi/PPA only.",
    promptSnippet: "Canonical template retrieval and unsigned structural drafts; exact versions, no authority or writes.",
    parameters: Type.Object({
      request: Type.String({ maxLength: MAX_TEMPLATE_REQUEST_BYTES, description: "One exact UTF-8 JSON request object with action list/show/render/validate. Keep bindings and candidate inside this document; duplicate keys and byte limits are validated before interpretation. Example: {\"action\":\"list\"}." }),
    }, { additionalProperties: false }),
    execute: async (_id, input) => {
      const valid = input !== null && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 1 && Object.hasOwn(input, "request") && typeof input.request === "string";
      const result = valid
        ? templateService(input.request as string, { ...host, team: host.team ?? process.env.PA_TEAM, mode: host.mode ?? process.env.PA_MODE })
        : templateFailure(new TemplateError("TEMPLATE_FIELD", "native-request", "one raw request document string is required; structured or unknown framing fields are unsupported"));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {}, isError: !result.ok };
    },
  };
}
export function createTemplateModule(host: TemplateHost = {}): PiExtensionModule {
  return (pi) => { pi.registerTool?.(createPaTemplateTool(host)); };
}
export const registerTemplateModule = createTemplateModule();
