import { createHash } from "node:crypto";

/** Selection data, never a permission grant. The adapter still authenticates each effect. */
export const MODE_CAPABILITY_POLICY_VERSION = "pa-mode-capabilities/v1" as const;
export const MODE_CAPABILITY_PROFILE = "pa-document-policy/v1" as const;
export const MODE_CAPABILITY_SESSION = "requirements-document-policy/v1" as const;
/** Explicit opt-in: v1/v2 bindings and their session marker never acquire these semantics. */
export const READONLY_DOCUMENT_PROFILE = "pa-readonly-document/v1" as const;
export const READONLY_DOCUMENT_SESSION = "readonly-document-policy/v1" as const;
export function isModeCapabilitySession(value: unknown): boolean { return value === MODE_CAPABILITY_SESSION || value === READONLY_DOCUMENT_SESSION; }
export const MODE_CAPABILITY_MAX_BYTES = 64 * 1024;

// This is the inventory of trusted implementations, NOT a role's default selection.
// Existing tool schemas/action parsers remain authoritative; config cannot replace them.
export const MODE_CAPABILITIES = Object.freeze([
  { id: "document.package", tool: "pa_document", owner: "document-native", actions: "native document package grammar; v4-compatible confirmation owner" },
  { id: "document.handoff", tool: "pa_handoff", owner: "handoff-native", actions: "native intake, finite stage/plan, full-reader review, publication, ref/link, optional queue and bound opening grammar" },
  { id: "document.local-review", tool: "pa_handoff", owner: "handoff-native", actions: "explicit v2 unauthenticated local confirmation; requires document.handoff and document.package; no default activation" },
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
  { id: "ticket.status", tool: "pa_ticket_status", owner: "ticket-status-owner", actions: "inspect,set; administrative status only, native/CLI shared CAS and original intent" },
  { id: "workflow.request", tool: "pa_workflow", owner: "workflow-native", actions: "existing read/admit/revise/request-step/reconcile; unchanged protected owner gates" },
  { id: "decision.request", tool: "pa_decision", owner: "workflow-native", actions: "existing show/verify/native capture/revoke/recover/adopt; genuine foreground consent only" },
  { id: "ordinary.bash", tool: "bash", owner: "local-source-tools", actions: "ordinary Pi shell with shared safety and checked local output before delivery/spill; no repository/Git mutation authority" },
  { id: "ordinary.read", tool: "read", owner: "local-source-tools", actions: "ordinary Pi read/continuation across normal ai-usage; trusted local path/content checks and redaction before pagination" },
  { id: "ordinary.edit", tool: "edit", owner: "pi-builtin", actions: "ordinary exact edit; author mutable ai-usage artifacts, not repository files" },
  { id: "ordinary.write", tool: "write", owner: "pi-builtin", actions: "ordinary file write; author mutable ai-usage artifacts, not repository files" },
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
  // Two read contracts must never depend on registration order or silently
  // widen a retained context.read selection. Choose exactly one explicitly.
  if (ids.includes("context.read") && ids.includes("ordinary.read")) throw new ModeCapabilityError("CAPABILITY_POLICY_INVALID");
  if (ids.includes("document.local-review") && !["document.handoff", "document.package"].every(id => ids.includes(id))) throw new ModeCapabilityError("CAPABILITY_POLICY_INVALID");
  // Stable set semantics; never mutate the caller's array or inherit defaults.
  return Object.freeze({ version: MODE_CAPABILITY_POLICY_VERSION, allow: Object.freeze(ids.sort()) });
}
export function selectedCapabilityTools(policy: ModeCapabilityPolicy): readonly string[] {
  const checked = parseModeCapabilityPolicy(policy);
  return Object.freeze([...new Set(checked.allow.map(id => MODE_CAPABILITIES.find(entry => entry.id === id)!.tool))]);
}
export function capabilityToolSelected(policy: ModeCapabilityPolicy, tool: string): boolean {
  // Exact canonical tool names only. No namespace, alias, prefix or wildcard matching.
  return selectedCapabilityTools(policy).includes(tool);
}
/** Fixed native mapping. Configuration cannot choose another effective role or actor. */
export const ANALYST_NATIVE_IDENTITY = Object.freeze({ publicTeam: "analyst", publicMode: "analyze", effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" } as const);
export interface AnalystModeCapabilityBinding {
  readonly schemaVersion: "pa-mode-capability-binding/v2";
  readonly configRoot: string;
  readonly configRevision: string;
  readonly resourcePath: "teams/analyst.yaml";
  readonly resourceSha256: string;
  readonly profile: typeof MODE_CAPABILITY_PROFILE;
  readonly policy: ModeCapabilityPolicy;
  readonly repoKey: string;
  readonly identity: typeof ANALYST_NATIVE_IDENTITY;
  readonly resources: readonly { readonly path: string; readonly sha256: string }[];
}
export interface ReadonlyDocumentBinding extends Omit<AnalystModeCapabilityBinding, "schemaVersion" | "resourcePath" | "profile" | "identity"> {
  readonly schemaVersion: "pa-mode-capability-binding/v3";
  readonly resourcePath: string;
  readonly profile: typeof READONLY_DOCUMENT_PROFILE;
  readonly identity: { readonly publicTeam: string; readonly publicMode: string; readonly effectiveTeam: "requirements"; readonly effectiveMode: "analyze"; readonly actor: "requirements/analyze" };
}
export type ResourceModeCapabilityBinding = AnalystModeCapabilityBinding | ReadonlyDocumentBinding;
export type ModeCapabilityBinding = HistoricalModeCapabilityBinding | ResourceModeCapabilityBinding;
export function hasModeResources(binding: ModeCapabilityBinding | undefined): binding is ResourceModeCapabilityBinding {
  return binding?.schemaVersion === "pa-mode-capability-binding/v2" || binding?.schemaVersion === "pa-mode-capability-binding/v3";
}
export function modeCapabilitySessionMatches(binding: ModeCapabilityBinding, session: unknown): boolean {
  return session === (binding.schemaVersion === "pa-mode-capability-binding/v3" ? READONLY_DOCUMENT_SESSION : MODE_CAPABILITY_SESSION);
}
export function modePublicName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return value;
}
/** Fixed v1 support inventory, never a default set. Registry additions cannot widen it. */
export const READONLY_DOCUMENT_CAPABILITIES: readonly string[] = Object.freeze([
  "document.package", "document.handoff", "document.local-review", "document.workspace",
  "ticket.read-comment", "ticket.intake", "capability.discover", "bulletin.read", "registry.read", "status.read",
  "template.draft", "human.question", "session.todo", "context.read", "web.public-read", "ticket.status",
  "ordinary.bash", "ordinary.read", "ordinary.edit", "ordinary.write",
]);
/** Only existing finite read-only-document implementations; workflow execution is not this profile. */
export function parseReadonlyDocumentPolicy(value: unknown): ModeCapabilityPolicy {
  bindingRecord(value, ["version", "allow"]);
  const policy = parseModeCapabilityPolicy(value);
  if (policy.allow.some(id => !READONLY_DOCUMENT_CAPABILITIES.includes(id))) throw new ModeCapabilityError("CAPABILITY_PROFILE");
  return policy;
}
/** Captured committed content only. The native launch owner separately rechecks freshness. */
export interface ModeResourceSnapshot { readonly binding: ResourceModeCapabilityBinding; read(path: string): string }
export function modeResourcePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_./-]+$/.test(value) || value.split("/").length > 16 || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return value;
}
function bindingRecord(value: unknown, keys: string[]): Record<string, unknown> {
  const raw = record(value), descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== keys.length || keys.some(key => !descriptors[key] || !("value" in descriptors[key]!))) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return raw;
}
function parseResourceBindingFields(raw: Record<string, unknown>) {
  if (typeof raw.configRoot !== "string" || raw.configRoot.length > 4096 || !raw.configRoot.startsWith("/") || /[\u0000-\u0020\u007f-\u009f\\\\]/.test(raw.configRoot) || raw.configRoot.split("/").slice(1).some(part => !part || part === "." || part === "..")
    || typeof raw.configRevision !== "string" || !/^[a-f0-9]{40}$/.test(raw.configRevision)
    || typeof raw.resourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.resourceSha256)
    || typeof raw.repoKey !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(raw.repoKey)
    || !Array.isArray(raw.resources) || !raw.resources.length || raw.resources.length > 128) throw new ModeCapabilityError("CAPABILITY_BINDING");
  const resources = Array.from(raw.resources, value => {
    const entry = bindingRecord(value, ["path", "sha256"]), path = modeResourcePath(entry.path);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new ModeCapabilityError("CAPABILITY_BINDING");
    return Object.freeze({ path, sha256: entry.sha256 });
  });
  if (resources.some((entry, i) => i > 0 && resources[i - 1]!.path.localeCompare(entry.path) >= 0)
    || !resources.some(entry => entry.path === raw.resourcePath && entry.sha256 === raw.resourceSha256)) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return { configRoot: raw.configRoot, configRevision: raw.configRevision, resourceSha256: raw.resourceSha256, repoKey: raw.repoKey, resources: Object.freeze(resources) };
}
function boundedBinding<T extends ModeCapabilityBinding>(binding: T): T {
  if (Buffer.byteLength(JSON.stringify(binding)) > MODE_CAPABILITY_MAX_BYTES) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return Object.freeze(binding);
}
function parseAnalystBinding(value: unknown): AnalystModeCapabilityBinding {
  const raw = bindingRecord(value, ["schemaVersion", "configRoot", "configRevision", "resourcePath", "resourceSha256", "profile", "policy", "repoKey", "identity", "resources"]);
  const identity = bindingRecord(raw.identity, Object.keys(ANALYST_NATIVE_IDENTITY));
  if (Object.entries(ANALYST_NATIVE_IDENTITY).some(([key, expected]) => identity[key] !== expected)
    || raw.profile !== MODE_CAPABILITY_PROFILE || raw.resourcePath !== "teams/analyst.yaml") throw new ModeCapabilityError("CAPABILITY_BINDING");
  const fields = parseResourceBindingFields(raw);
  return boundedBinding({ schemaVersion: "pa-mode-capability-binding/v2", configRoot: fields.configRoot, configRevision: fields.configRevision,
    resourcePath: "teams/analyst.yaml", resourceSha256: fields.resourceSha256, profile: MODE_CAPABILITY_PROFILE, policy: parseModeCapabilityPolicy(raw.policy), repoKey: fields.repoKey,
    identity: ANALYST_NATIVE_IDENTITY, resources: fields.resources });
}
function parseReadonlyBinding(value: unknown): ReadonlyDocumentBinding {
  const raw = bindingRecord(value, ["schemaVersion", "configRoot", "configRevision", "resourcePath", "resourceSha256", "profile", "policy", "repoKey", "identity", "resources"]);
  const identity = bindingRecord(raw.identity, Object.keys(ANALYST_NATIVE_IDENTITY));
  const publicTeam = modePublicName(identity.publicTeam), publicMode = modePublicName(identity.publicMode);
  if (raw.profile !== READONLY_DOCUMENT_PROFILE || raw.resourcePath !== `teams/${publicTeam}.yaml`
    || identity.effectiveTeam !== "requirements" || identity.effectiveMode !== "analyze" || identity.actor !== "requirements/analyze") throw new ModeCapabilityError("CAPABILITY_BINDING");
  const fields = parseResourceBindingFields(raw);
  return boundedBinding({ schemaVersion: "pa-mode-capability-binding/v3", configRoot: fields.configRoot, configRevision: fields.configRevision,
    resourceSha256: fields.resourceSha256, repoKey: fields.repoKey, resources: fields.resources, resourcePath: `teams/${publicTeam}.yaml`,
    profile: READONLY_DOCUMENT_PROFILE, policy: parseReadonlyDocumentPolicy(raw.policy),
    identity: Object.freeze({ publicTeam, publicMode, effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" }) });
}
/** Authenticate the public route against the binding, never against an env alias. */
export function modeCapabilityRouteMatches(binding: ModeCapabilityBinding, team: unknown, mode: unknown): boolean {
  return hasModeResources(binding) ? team === binding.identity.publicTeam && mode === binding.identity.publicMode : team === "requirements" && mode === "analyze";
}
/** Actor attribution is explicitly the effective native owner in v2; history is unchanged. */
export function modeCapabilityActor(binding: ModeCapabilityBinding): "requirements/analyze" {
  return hasModeResources(binding) ? binding.identity.actor : "requirements/analyze";
}
export interface HistoricalModeCapabilityBinding {
  readonly schemaVersion: "pa-mode-capability-binding/v1";
  readonly configRevision: string;
  readonly resourcePath: "teams/requirements.yaml";
  readonly resourceSha256: string;
  readonly profile: typeof MODE_CAPABILITY_PROFILE;
  readonly policy: ModeCapabilityPolicy;
}
export function createModeCapabilityBinding(configRevision: string, raw: Uint8Array, policy: ModeCapabilityPolicy): HistoricalModeCapabilityBinding {
  if (!/^[a-f0-9]{40}$/.test(configRevision) || raw.byteLength > MODE_CAPABILITY_MAX_BYTES) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return Object.freeze({ schemaVersion: "pa-mode-capability-binding/v1", configRevision, resourcePath: "teams/requirements.yaml", resourceSha256: createHash("sha256").update(raw).digest("hex"), profile: MODE_CAPABILITY_PROFILE, policy: parseModeCapabilityPolicy(policy) });
}
export function parseModeCapabilityBinding(value: unknown): ModeCapabilityBinding {
  const raw = record(value);
  if (raw.schemaVersion === "pa-mode-capability-binding/v3") return parseReadonlyBinding(raw);
  if (raw.schemaVersion === "pa-mode-capability-binding/v2") return parseAnalystBinding(raw);
  if (Object.keys(raw).sort().join(",") !== "configRevision,policy,profile,resourcePath,resourceSha256,schemaVersion" || raw.schemaVersion !== "pa-mode-capability-binding/v1" || raw.profile !== MODE_CAPABILITY_PROFILE || raw.resourcePath !== "teams/requirements.yaml" || typeof raw.configRevision !== "string" || !/^[a-f0-9]{40}$/.test(raw.configRevision) || typeof raw.resourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.resourceSha256)) throw new ModeCapabilityError("CAPABILITY_BINDING");
  return Object.freeze({ schemaVersion: "pa-mode-capability-binding/v1", configRevision: raw.configRevision, resourcePath: "teams/requirements.yaml", resourceSha256: raw.resourceSha256, profile: MODE_CAPABILITY_PROFILE, policy: parseModeCapabilityPolicy(raw.policy) });
}
