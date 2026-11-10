import { createHash } from "node:crypto";

/** Selection data, never a permission grant. The adapter still authenticates each effect. */
export const MODE_CAPABILITY_POLICY_VERSION = "pa-mode-capabilities/v1" as const;
export const MODE_CAPABILITY_PROFILE = "pa-document-policy/v1" as const;
export const MODE_CAPABILITY_SESSION = "requirements-document-policy/v1" as const;
export const MODE_CAPABILITY_MAX_BYTES = 64 * 1024;

// This is the inventory of trusted implementations, NOT a role's default selection.
// Existing tool schemas/action parsers remain authoritative; config cannot replace them.
export const MODE_CAPABILITIES = Object.freeze([
  { id: "document.package", tool: "pa_document", owner: "document-native", actions: "native document package grammar; v4-compatible confirmation owner" },
  { id: "document.workspace", tool: "pa_workspace", owner: "document-workspace", actions: "native bounded workspace grammar" },
  { id: "ticket.read-comment", tool: "pa_ticket", owner: "ticket-tool", actions: "read,show,list,comment" },
  { id: "ticket.intake", tool: "pa_ticket_intake", owner: "ticket-intake-tool", actions: "capabilities,inspect,reuse,create,patch-planning; native ticket intent/CAS owners" },
  { id: "capability.discover", tool: "pa_capabilities", owner: "capability-tool", actions: "source-only list,describe; no live availability or authority" },
  { id: "bulletin.read", tool: "pa_bulletin", owner: "pa-tools", actions: "list" },
  { id: "registry.read", tool: "pa_registry", owner: "pa-tools", actions: "show,list" },
  { id: "status.read", tool: "pa_status", owner: "pa-tools", actions: "read deployment status" },
  { id: "template.draft", tool: "pa_template", owner: "template-native", actions: "list,show,render,validate; unsigned only" },
  { id: "human.question", tool: "question", owner: "question", actions: "ask; never native approval" },
  { id: "session.todo", tool: "todo", owner: "todo", actions: "session-local task grammar" },
  { id: "context.read", tool: "read", owner: "document-tool", actions: "guarded project/artifact/config file read" },
  { id: "web.public-read", tool: "pa_web_read", owner: "public-web-reader", actions: "one supplied public HTTPS URL; no search/crawl" },
].map(entry => Object.freeze({ ...entry, profile: MODE_CAPABILITY_PROFILE })));
export type ModeCapabilityId = typeof MODE_CAPABILITIES[number]["id"];
export interface ModeCapabilityPolicy { readonly version: typeof MODE_CAPABILITY_POLICY_VERSION; readonly allow: readonly string[] }
export type ModeCapabilityErrorCode = "CAPABILITY_POLICY_INVALID" | "CAPABILITY_UNKNOWN" | "CAPABILITY_PROFILE" | "CAPABILITY_UNAVAILABLE" | "CAPABILITY_BINDING" | "CAPABILITY_OMITTED";
export class ModeCapabilityError extends Error {
  constructor(readonly code: ModeCapabilityErrorCode) { super(modeCapabilityDiagnostic(code)); }
}
/** Pure, fixed-text guidance: never echo arbitrary config, URLs, exceptions or credentials. */
export function modeCapabilityDiagnostic(code: ModeCapabilityErrorCode): string {
  const reasons: Record<ModeCapabilityErrorCode, string> = {
    CAPABILITY_POLICY_INVALID: "The selected policy is malformed or exceeds its supported limits.",
    CAPABILITY_UNKNOWN: "The policy names a capability this runtime does not provide.",
    CAPABILITY_PROFILE: "This route does not support the selected capability-policy contract.",
    CAPABILITY_UNAVAILABLE: "The selected capability's required implementation or environment is unavailable.",
    CAPABILITY_BINDING: "The immutable native selection cannot be authenticated; no additional access is granted.",
    CAPABILITY_OMITTED: "The immutable selection omits this operation; the current session cannot widen its access.",
  };
  return `Operation not started: capability selection does not admit it.\nCondition: The requested capability is blocked before execution.\nSource: Native capability-policy validation (${code}).\nReason: ${reasons[code]}\nCorrection: Ask the runtime/configuration owner to inspect the selection. Impact: none. Actor: agent or operator. New approval: not required to ask; changes need their owner. Prerequisite: preserve current runtime, policy and session identities.\nResume Action: After owner correction, recheck the supported route; effect requests authenticate admission again. Existing sessions never gain access from a config edit.`;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ModeCapabilityError("CAPABILITY_POLICY_INVALID");
  return value as Record<string, unknown>;
}
export function parseModeCapabilityPolicy(value: unknown): ModeCapabilityPolicy {
  const raw = record(value), keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes("version") || !keys.includes("allow") || raw.version !== MODE_CAPABILITY_POLICY_VERSION || !Array.isArray(raw.allow) || raw.allow.length > 64) throw new ModeCapabilityError("CAPABILITY_POLICY_INVALID");
  const ids: string[] = [];
  for (const id of raw.allow) {
    if (typeof id !== "string" || id.length < 1 || id.length > 128 || !/^[a-z][a-z0-9.-]*$/.test(id) || ids.includes(id)) throw new ModeCapabilityError("CAPABILITY_POLICY_INVALID");
    if (!MODE_CAPABILITIES.some(entry => entry.id === id)) throw new ModeCapabilityError("CAPABILITY_UNKNOWN");
    ids.push(id);
  }
  // Stable set semantics; never mutate the caller's array or inherit defaults.
  return Object.freeze({ version: MODE_CAPABILITY_POLICY_VERSION, allow: Object.freeze(ids.sort()) });
}
export function selectedCapabilityTools(policy: ModeCapabilityPolicy): readonly string[] {
  const checked = parseModeCapabilityPolicy(policy);
  return Object.freeze(checked.allow.map(id => MODE_CAPABILITIES.find(entry => entry.id === id)!.tool));
}
export function capabilityToolSelected(policy: ModeCapabilityPolicy, tool: string): boolean {
  // Exact canonical tool names only. No namespace, alias, prefix or wildcard matching.
  return selectedCapabilityTools(policy).includes(tool);
}
export interface ModeCapabilityBinding {
  readonly schemaVersion: "pa-mode-capability-binding/v1";
  readonly configRevision: string;
  readonly resourcePath: "teams/requirements.yaml";
  readonly resourceSha256: string;
  readonly profile: typeof MODE_CAPABILITY_PROFILE;
  readonly policy: ModeCapabilityPolicy;
}
export function createModeCapabilityBinding(configRevision: string, raw: Uint8Array, policy: ModeCapabilityPolicy): ModeCapabilityBinding {
  if (!/^[a-f0-9]{40}$/.test(configRevision) || raw.byteLength > MODE_CAPABILITY_MAX_BYTES) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return Object.freeze({ schemaVersion: "pa-mode-capability-binding/v1", configRevision, resourcePath: "teams/requirements.yaml", resourceSha256: createHash("sha256").update(raw).digest("hex"), profile: MODE_CAPABILITY_PROFILE, policy: parseModeCapabilityPolicy(policy) });
}
export function parseModeCapabilityBinding(value: unknown): ModeCapabilityBinding {
  const raw = record(value);
  if (Object.keys(raw).sort().join(",") !== "configRevision,policy,profile,resourcePath,resourceSha256,schemaVersion" || raw.schemaVersion !== "pa-mode-capability-binding/v1" || raw.profile !== MODE_CAPABILITY_PROFILE || raw.resourcePath !== "teams/requirements.yaml" || typeof raw.configRevision !== "string" || !/^[a-f0-9]{40}$/.test(raw.configRevision) || typeof raw.resourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.resourceSha256)) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return Object.freeze({ schemaVersion: "pa-mode-capability-binding/v1", configRevision: raw.configRevision, resourcePath: "teams/requirements.yaml", resourceSha256: raw.resourceSha256, profile: MODE_CAPABILITY_PROFILE, policy: parseModeCapabilityPolicy(raw.policy) });
}
