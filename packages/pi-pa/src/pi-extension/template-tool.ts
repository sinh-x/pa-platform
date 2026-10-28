import { Type } from "typebox";
import { templateService, type TemplateHost } from "@pa-platform/pa-core";
import type { PiExtensionModule, PiToolDefinition } from "./index.js";

/** Thin native adapter: no subprocess wrapper, stores or output truncation. */
export function createPaTemplateTool(host: TemplateHost = {}): PiToolDefinition {
  const identity = { id: Type.String({ maxLength: 64 }), version: Type.String({ maxLength: 64 }) };
  const bindings = Type.Record(Type.String(), Type.Unknown());
  return {
    name: "pa_template", label: "PA Templates",
    description: "List/show/render/validate selected canonical templates. All outputs are unsigned structural drafts, never human approvals, native facts or readiness. No writes. Pi/PPA only.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("show"), ...identity }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("render"), ...identity, bindings }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("validate"), ...identity, bindings, candidate: Type.String() }, { additionalProperties: false }),
    ]),
    execute: async (_id, input) => {
      const result = templateService(input, { ...host, team: host.team ?? process.env.PA_TEAM, mode: host.mode ?? process.env.PA_MODE });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {}, isError: !result.ok };
    },
  };
}
export function createTemplateModule(host: TemplateHost = {}): PiExtensionModule {
  return (pi) => { pi.registerTool?.(createPaTemplateTool(host)); };
}
export const registerTemplateModule = createTemplateModule();
