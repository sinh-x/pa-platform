import { Type } from "typebox";
import {
  createSourceCatalogueReader, InteractionInputError, InteractionDiscoveryError, MAX_INTERACTION_REQUEST_BYTES,
} from "@pa-platform/pa-core";
import type { PiToolDefinition } from "./index.js";

const sessionDiagnostic = [
  "Source capability discovery did not start: the native session is unavailable.",
  "Condition: The source inventory cannot be queried through this session binding.",
  "Source: Current native advisory owner check.",
  "Reason: The current native owner could not be established; another approval or a caller-supplied marker cannot repair the binding.",
  "Correction: Ask the runtime owner to inspect the existing session binding. Impact: none. Actor: agent. New approval: not required to ask. Prerequisite: preserve the existing deployment and source state; repairs need their own authority.",
  "Resume Action: Reobserve the same session after owner reconciliation. Discovery is read-only and does not grant execution authority.",
].join("\n");

/** Source-only discovery for a separately native-proven advisory registration.
 * The closure is trusted adapter code, never model-supplied permission. This is
 * deliberately NOT a writer-profile selection, CLI proxy or installed qualifier. */
export function createPaCapabilitiesTool(currentNativeOwner: (context: unknown) => boolean = () => false): PiToolDefinition {
  let reader: ReturnType<typeof createSourceCatalogueReader> | undefined;
  return {
    name: "pa_capabilities", label: "PA Source Capabilities", executionMode: "sequential",
    description: "Read a bounded source-only PA interaction inventory. request is one raw pa-interactions/v1 JSON object: schemaVersion, action list or describe; list optionally takes family/effect/cursor/limit, describe requires operationId. Use returned continuations unchanged. Target dispositions are not installed or registered tool availability, not permission, and not executable CLI grammar. No execution, writes, credentials or authority fields.",
    promptSnippet: "Source-only PA interaction list/describe; target dispositions are not live availability or authority.",
    parameters: Type.Object({ request: Type.String({ maxLength: MAX_INTERACTION_REQUEST_BYTES }) }, { additionalProperties: false }),
    execute: async (_id, input, _signal, _update, context) => {
      let current = false;
      try { current = currentNativeOwner(context); } catch { /* No raw owner error is public context. */ }
      if (!current) return { content: [{ type: "text", text: sessionDiagnostic }], details: { code: "INTERACTION_SESSION" }, isError: true };
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new InteractionInputError("INTERACTION_FIELD");
        const fields = Object.getOwnPropertyDescriptors(input);
        if (Object.keys(fields).length !== 1 || !fields.request || !("value" in fields.request) || typeof fields.request.value !== "string") throw new InteractionInputError("INTERACTION_FIELD");
        reader ??= createSourceCatalogueReader();
        const text = reader(fields.request.value);
        return { content: [{ type: "text", text }], details: { scope: "source-only" }, isError: false };
      } catch (error) {
        const failure = error instanceof InteractionInputError || error instanceof InteractionDiscoveryError
          ? error : new InteractionDiscoveryError("INTERACTION_CATALOGUE");
        return { content: [{ type: "text", text: failure.message }], details: { code: failure.code }, isError: true };
      }
    },
  };
}
