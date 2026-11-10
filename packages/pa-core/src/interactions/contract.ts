import { parseReviewEvidenceJson } from "../validation/review-contract.js";

/** Data-only discovery contract. Neither parsing nor a descriptor authorizes effects. */
export const INTERACTIONS_VERSION = "pa-interactions/v1" as const;
export const MAX_INTERACTION_REQUEST_BYTES = 65_536;
export const MAX_INTERACTION_PAGE_BYTES = 51_200;
export const MAX_INTERACTION_PAGE_LINES = 2_000;
export const INTERACTION_EFFECTS = ["read", "write", "launch", "resource", "sensitive", "destructive"] as const;
export const INTERACTION_DISPOSITIONS = Object.freeze([
  "native-supported", "approved-cli-delegation", "operator-only", "intentionally-unsupported", "deprecated",
] as const);
export type InteractionEffect = typeof INTERACTION_EFFECTS[number];
export type InteractionDisposition = typeof INTERACTION_DISPOSITIONS[number];

const identifier = { type: "string", pattern: "^[a-z][a-z0-9.-]{0,127}(?![\\s\\S])", maxLength: 128 } as const;
const schemaVersion = { const: INTERACTIONS_VERSION } as const;
function freezeSchema<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}
/** This JSON Schema is also the parser's field grammar; adapters can wrap it, not fork it. */
export const capabilityRequestSchema = freezeSchema({
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["schemaVersion", "action"],
      properties: {
        schemaVersion, action: { const: "list" }, family: identifier,
        effect: { type: "string", enum: INTERACTION_EFFECTS },
        cursor: { type: "string", pattern: "^[A-Za-z0-9_-]{1,2048}(?![\\s\\S])", maxLength: 2048 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["schemaVersion", "action", "operationId"],
      properties: { schemaVersion, action: { const: "describe" }, operationId: identifier },
    },
  ],
} as const);

export type CapabilityRequest =
  | { schemaVersion: typeof INTERACTIONS_VERSION; action: "list"; family?: string; effect?: InteractionEffect; cursor?: string; limit: number }
  | { schemaVersion: typeof INTERACTIONS_VERSION; action: "describe"; operationId: string };

export type InteractionInputCode = "INTERACTION_SIZE" | "INTERACTION_JSON" | "INTERACTION_FIELD";
const reasons: Record<InteractionInputCode, string> = {
  INTERACTION_SIZE: "The request exceeds the 65536-byte UTF-8 limit.",
  INTERACTION_JSON: "One valid UTF-8 JSON object is required, without duplicate fields, a byte-order mark or excessive nesting.",
  INTERACTION_FIELD: "The request does not match the supported discovery action and field grammar; no execution or authority fields are accepted.",
};
export class InteractionInputError extends Error {
  constructor(readonly code: InteractionInputCode) {
    super([
      "Capability discovery did not start: the request is invalid.",
      "Condition: The discovery request was rejected before dispatch.",
      "Source: Native interaction input validation.",
      `Reason: ${reasons[code]}`,
      "Correction: Use the published discovery request schema. Impact: none. Actor: agent. New approval: not required. Prerequisite: preserve the intended query; do not include credentials or authority claims.",
      "Resume Action: Submit the corrected read-only query. Discovery does not grant permission to execute an operation.",
    ].join("\n"));
    this.name = "InteractionInputError";
  }
}
function reject(code: InteractionInputCode): never { throw new InteractionInputError(code); }

type Field = { readonly const?: string; readonly type?: string; readonly pattern?: string; readonly maxLength?: number; readonly enum?: readonly string[]; readonly minimum?: number; readonly maximum?: number };
function validField(value: unknown, field: Field): boolean {
  if (field.const !== undefined) return value === field.const;
  if (field.type === "integer") return typeof value === "number" && Number.isSafeInteger(value) && value >= field.minimum! && value <= field.maximum!;
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= (field.maxLength ?? 32768)
    && (!field.pattern || new RegExp(field.pattern).test(value))
    && (!field.enum || field.enum.includes(value));
}

/** Raw framing retains duplicate-key evidence. Never accept an already parsed caller object. */
export function parseCapabilityRequest(raw: string | Uint8Array): CapabilityRequest {
  if (typeof raw !== "string" && !(raw instanceof Uint8Array)) return reject("INTERACTION_JSON");
  const size = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (size > MAX_INTERACTION_REQUEST_BYTES) return reject("INTERACTION_SIZE");
  if (typeof raw === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(raw)) return reject("INTERACTION_JSON");
  let value: unknown;
  try { value = parseReviewEvidenceJson(typeof raw === "string" ? Buffer.from(raw) : raw, "interaction-request"); }
  catch { return reject("INTERACTION_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("INTERACTION_FIELD");
  const row = value as Record<string, unknown>;
  const schema = capabilityRequestSchema.oneOf.find(entry => entry.properties.action.const === row.action);
  if (!schema) return reject("INTERACTION_FIELD");
  const fields: Readonly<Record<string, Field>> = schema.properties;
  if (schema.required.some(key => !Object.hasOwn(row, key))
    || Object.entries(row).some(([key, field]) => !Object.hasOwn(fields, key) || !validField(field, fields[key]!))) return reject("INTERACTION_FIELD");
  // Reconstruct a plain typed record; no unvalidated fields or prototype survive.
  if (row.action === "describe") return { schemaVersion: INTERACTIONS_VERSION, action: "describe", operationId: row.operationId as string };
  return {
    schemaVersion: INTERACTIONS_VERSION, action: "list", limit: row.limit as number | undefined ?? capabilityRequestSchema.oneOf[0].properties.limit.default,
    ...(row.family !== undefined ? { family: row.family as string } : {}),
    ...(row.effect !== undefined ? { effect: row.effect as InteractionEffect } : {}),
    ...(row.cursor !== undefined ? { cursor: row.cursor as string } : {}),
  };
}

/** Source inventory, not installed/session facts. Unbound schemas must remain null. */
export interface InteractionDescriptor {
  readonly operationId: string;
  readonly version: typeof INTERACTIONS_VERSION;
  readonly family: string;
  readonly cliForms: readonly string[];
  readonly aliases: readonly string[];
  readonly sourceHandler: string;
  readonly effectClass: InteractionEffect;
  readonly targetDisposition: InteractionDisposition;
  readonly owner: string;
  readonly reason: string;
  readonly supportedNextStep: string;
  readonly requiredContext: readonly string[];
  readonly nativeBinding: { readonly tool: string; readonly action: string } | null;
  readonly delegationBinding: { readonly owner: string; readonly channel: string } | null;
  readonly requestSchemaRef: string | null;
  readonly resultSchemaRef: string | null;
}

/** A static descriptor or source fixture can never establish these runtime facts. */
export interface InteractionAvailability {
  readonly configured: boolean | "unproven";
  readonly installed: boolean | "unproven";
  readonly registeredInSession: boolean | "unproven";
  readonly available: boolean | "unproven";
  readonly admitted: boolean | "not-checked";
}
export const SOURCE_ONLY_AVAILABILITY: InteractionAvailability = Object.freeze({
  configured: "unproven", installed: "unproven", registeredInSession: "unproven", available: "unproven", admitted: "not-checked",
});
