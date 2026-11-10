import { isDeepStrictEqual } from "node:util";
import { loadReposYaml } from "../repos.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";
import { sanitizeTextInput } from "../deploy/control.js";
import { creationDigest } from "../tickets/create-intent.js";
import { assertPlanningScope, ticketPlanningVersion, validatePlanningPatch, type TicketPlanningPatch } from "../tickets/planning-intent.js";
import { getValidTeamNames, isCanonicalTicketId, validateAssignee } from "../tickets/validate.js";
import type { TicketStore } from "../tickets/store.js";
import type { CreateTicketInput, Estimate, TicketPriority, TicketType, Ticket } from "../tickets/types.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { MAX_INTERACTION_REQUEST_BYTES, SOURCE_ONLY_AVAILABILITY } from "./contract.js";

/** Opt-in NEW native start only. This token does not upgrade retained document profiles. */
export const TICKET_INTERACTIONS_PROFILE = "requirements-document-interactions/v4" as const;
export const TICKET_INTAKE_VERSION = "pa-ticket-intake/v1" as const;
export interface TicketInteractionCaller {
  profile: string; deploymentId: string; repoKey: string; ticket: string | null; identitySha256: string;
}
export type TicketInteractionCode = "TICKET_INTERACTION_INPUT" | "TICKET_INTERACTION_SESSION" | "TICKET_INTERACTION_PROJECT" | "TICKET_INTERACTION_SENSITIVE" | "TICKET_INTERACTION_UNCERTAIN" | "TICKET_INTERACTION_SELECTION" | "TICKET_INTERACTION_STALE" | "TICKET_INTERACTION_OWNER";
const reasons: Record<TicketInteractionCode, string> = {
  TICKET_INTERACTION_OWNER: "Another current or historical deployment is associated with this ticket, or its ownership evidence is unavailable. This narrow planning port cannot settle or take over retained ownership.",
  TICKET_INTERACTION_SELECTION: "The exact selected ticket is missing, moved, outside the requested project or not safely representable. No replacement or fuzzy match was selected.",
  TICKET_INTERACTION_STALE: "The selected ticket does not match the caller-bound inspected version or expected selection data. Reinspect the existing ticket before deciding whether to reuse or plan it.",
  TICKET_INTERACTION_INPUT: "The raw request does not match the bounded intake schema. Ordinary intake requires explicit type, priority, estimate and assignee; no actor, lifecycle, root, approval or execution fields are accepted.",
  TICKET_INTERACTION_SESSION: "The new native requirements interaction profile or unchanged current caller could not be established. Retained profiles do not gain this port's write rights.",
  TICKET_INTERACTION_PROJECT: "The exact registered destination or primary ticket scope is invalid. Cross-project work requires an explicit companion request and a valid bound primary ticket.",
  TICKET_INTERACTION_SENSITIVE: "The sensitive-input owner did not admit the requested or selected metadata. Its content is not included in this diagnostic.",
  TICKET_INTERACTION_UNCERTAIN: "The effect owner did not establish the final result. Creation may be partial; preserve the original request identity and owner records.",
};
export class TicketInteractionError extends Error {
  constructor(readonly code: TicketInteractionCode) {
    super([
      code === "TICKET_INTERACTION_UNCERTAIN" ? "Ticket intake outcome is unproven; do not create a replacement request." : "Ticket intake request was not admitted; the original selection or request is retained.",
      "Condition: The requested intake operation has no proven successful result.",
      "Source: Native ticket intake validation and existing ticket owner.",
      `Reason: ${reasons[code]} (${code})`,
      code === "TICKET_INTERACTION_STALE"
        ? "Correction: Reinspect the same exact ticket with action=inspect and compare its current title/type with the requested work. Impact: read-only. Actor: agent. New approval: not required for inspection. Prerequisite: supported native session and exact registered project/ticket; do not guess a replacement."
        : "Correction: Inspect the supported intake schema and original native caller/effect binding with the ticket runtime owner. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: preserve the primary ticket and original request/intent; do not bypass uncertainty with a fresh ID or shell fallback.",
      code === "TICKET_INTERACTION_STALE"
        ? "Resume Action: For reuse, use newly inspected version/title/type only if still aligned. For planning, reconcile any original intent first; a proven no-intent stale request needs a new planning decision and both inspected versions. Every call rechecks current admission; inspection alone grants no mutation rights."
        : "Resume Action: Correct invalid input or reconcile the original owner result, then submit the same intended request. Current admission is checked again; this interface grants no source, Git, resource or lifecycle authority.",
    ].join("\n")); this.name = "TicketInteractionError";
  }
}
const fail = (code: TicketInteractionCode): never => { throw new TicketInteractionError(code); };
const text = (maxLength: number, minLength = 0) => Object.freeze({ type: "string", maxLength, minLength });
const identifier = (pattern: string, maxLength: number) => Object.freeze({ type: "string", pattern, maxLength, minLength: 1 });
const exactEnd = "(?![\\s\\S])";
export const ticketIntakeRequestSchema = Object.freeze({
  type: "object", additionalProperties: false,
  required: Object.freeze(["schemaVersion", "action", "requestId", "kind", "project", "title"]),
  properties: Object.freeze({
    schemaVersion: Object.freeze({ const: TICKET_INTAKE_VERSION }), action: Object.freeze({ const: "create" }),
    requestId: identifier(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}${exactEnd}`, 128),
    kind: Object.freeze({ enum: Object.freeze(["intake", "companion"]) }),
    project: identifier(`^[a-z][a-z0-9-]{0,127}${exactEnd}`, 128),
    title: text(1024, 1), summary: text(8192), description: text(32768),
    type: Object.freeze({ enum: Object.freeze(["feature", "bug", "task", "review-request", "work-report", "fyi", "idea", "question"]) }),
    priority: Object.freeze({ enum: Object.freeze(["critical", "high", "medium", "low"]) }),
    estimate: Object.freeze({ enum: Object.freeze(["XS", "S", "M", "L", "XL"]) }),
    assignee: identifier(`^[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)?${exactEnd}`, 128),
  }),
  allOf: Object.freeze([Object.freeze({ if: Object.freeze({ properties: Object.freeze({ kind: Object.freeze({ const: "intake" }) }) }), then: Object.freeze({ required: Object.freeze(["type", "priority", "estimate", "assignee"]) }) })]),
});
export interface TicketIntakeRequest {
  schemaVersion: typeof TICKET_INTAKE_VERSION; action: "create"; requestId: string; kind: "intake" | "companion"; project: string; title: string;
  summary?: string; description?: string; type?: TicketType; priority?: TicketPriority; estimate?: Estimate; assignee?: string;
}
/** The schema is the field grammar. UTF-8 byte bounds are intentionally stricter than JSON Schema character bounds. */
function readTicketIntakeObject(raw: string | Uint8Array): Record<string, unknown> {
  if ((typeof raw !== "string" && !(raw instanceof Uint8Array)) || (typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength) > MAX_INTERACTION_REQUEST_BYTES) return fail("TICKET_INTERACTION_INPUT");
  if (typeof raw === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(raw)) return fail("TICKET_INTERACTION_INPUT");
  let value: unknown;
  try { value = parseReviewEvidenceJson(typeof raw === "string" ? Buffer.from(raw) : raw, "ticket-intake"); } catch { return fail("TICKET_INTERACTION_INPUT"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("TICKET_INTERACTION_INPUT");
  return value as Record<string, unknown>;
}
function validateFields(row: Record<string, unknown>, schema: { required: readonly string[]; properties: Readonly<Record<string, unknown>> }): void {
  type Field = { const?: string; enum?: readonly string[]; pattern?: string; maxLength?: number; minLength?: number };
  const fields = schema.properties as Readonly<Record<string, Field>>;
  if (schema.required.some(key => !Object.hasOwn(row, key)) || Object.entries(row).some(([key, value]) => {
    if (!Object.hasOwn(fields, key) || typeof value !== "string") return true;
    const field = fields[key]!;
    return (field.const !== undefined && field.const !== value) || (field.enum !== undefined && !field.enum.includes(value))
      || (field.maxLength !== undefined && Buffer.byteLength(value) > field.maxLength) || value.length < (field.minLength ?? 0)
      || (field.pattern !== undefined && !new RegExp(field.pattern).test(value));
  })) fail("TICKET_INTERACTION_INPUT");
}
export function parseTicketIntakeRequest(raw: string | Uint8Array): TicketIntakeRequest {
  const row = readTicketIntakeObject(raw);
  validateFields(row, ticketIntakeRequestSchema);
  if (row.kind === "intake" && ["type", "priority", "estimate", "assignee"].some(key => !Object.hasOwn(row, key))) return fail("TICKET_INTERACTION_INPUT");
  return { ...row } as unknown as TicketIntakeRequest;
}
const selectionProperties = Object.freeze({ schemaVersion: ticketIntakeRequestSchema.properties.schemaVersion,
  kind: ticketIntakeRequestSchema.properties.kind, project: ticketIntakeRequestSchema.properties.project,
  ticket: identifier(`^[A-Z][A-Z0-9]*-[0-9]{3,}${exactEnd}`, 128),
});
export const ticketIntakeInspectSchema = Object.freeze({ type: "object", additionalProperties: false,
  required: Object.freeze(["schemaVersion", "action", "kind", "project", "ticket"]),
  properties: Object.freeze({ ...selectionProperties, action: Object.freeze({ const: "inspect" }) }),
});
export const ticketIntakeReuseSchema = Object.freeze({ type: "object", additionalProperties: false,
  required: Object.freeze([...ticketIntakeInspectSchema.required, "expectedVersion", "expectedTitle", "expectedType"]),
  properties: Object.freeze({ ...selectionProperties, action: Object.freeze({ const: "reuse" }),
    expectedVersion: identifier(`^[a-f0-9]{64}${exactEnd}`, 64), expectedTitle: text(1024, 1), expectedType: ticketIntakeRequestSchema.properties.type }),
});
export interface TicketSelectionRequest {
  schemaVersion: typeof TICKET_INTAKE_VERSION; action: "inspect" | "reuse"; kind: "intake" | "companion"; project: string; ticket: string;
  expectedVersion?: string; expectedTitle?: string; expectedType?: TicketType;
}
export const ticketPlanningRequestSchema = Object.freeze({ type: "object", additionalProperties: false,
  required: Object.freeze([...ticketIntakeInspectSchema.required, "requestId", "expectedVersion", "expectedSnapshotVersion", "patch"]),
  properties: Object.freeze({ ...selectionProperties, action: Object.freeze({ const: "patch-planning" }),
    requestId: ticketIntakeRequestSchema.properties.requestId, expectedVersion: ticketIntakeReuseSchema.properties.expectedVersion,
    expectedSnapshotVersion: ticketIntakeReuseSchema.properties.expectedVersion,
    patch: Object.freeze({ type: "object", additionalProperties: false, minProperties: 1, maxProperties: 5,
      properties: Object.freeze({ title: text(1024, 1), summary: text(8192), description: text(32768),
        priority: ticketIntakeRequestSchema.properties.priority, estimate: ticketIntakeRequestSchema.properties.estimate }) }),
  }),
});
export interface TicketPlanningRequest {
  schemaVersion: typeof TICKET_INTAKE_VERSION; action: "patch-planning"; requestId: string; kind: "intake" | "companion";
  project: string; ticket: string; expectedVersion: string; expectedSnapshotVersion: string; patch: TicketPlanningPatch;
}
export const ticketIntakeCapabilitiesRequestSchema = Object.freeze({
  type: "object", additionalProperties: false, required: Object.freeze(["schemaVersion", "action"]),
  properties: Object.freeze({ schemaVersion: Object.freeze({ const: TICKET_INTAKE_VERSION }), action: Object.freeze({ const: "capabilities" }) }),
});
export function parseTicketIntakeOperation(raw: string | Uint8Array): TicketIntakeRequest | TicketSelectionRequest | TicketPlanningRequest | { schemaVersion: typeof TICKET_INTAKE_VERSION; action: "capabilities" } {
  const row = readTicketIntakeObject(raw);
  if (row.action === "patch-planning") {
    const { patch, ...scalars } = row;
    const { patch: _patchSchema, ...properties } = ticketPlanningRequestSchema.properties;
    validateFields(scalars, { required: ticketPlanningRequestSchema.required.filter(key => key !== "patch"), properties });
    if (!isCanonicalTicketId(row.ticket)) return fail("TICKET_INTERACTION_INPUT");
    try { validatePlanningPatch(patch); } catch { return fail("TICKET_INTERACTION_INPUT"); }
    return { ...scalars, patch: validatePlanningPatch(patch) } as unknown as TicketPlanningRequest;
  }
  if (row.action === "inspect" || row.action === "reuse") {
    validateFields(row, row.action === "inspect" ? ticketIntakeInspectSchema : ticketIntakeReuseSchema);
    if (!isCanonicalTicketId(row.ticket)) return fail("TICKET_INTERACTION_INPUT");
    return { ...row } as unknown as TicketSelectionRequest;
  }
  if (row.action !== "capabilities") return parseTicketIntakeRequest(raw);
  if (Object.keys(row).length !== 2 || row.schemaVersion !== TICKET_INTAKE_VERSION) return fail("TICKET_INTERACTION_INPUT");
  return { schemaVersion: TICKET_INTAKE_VERSION, action: "capabilities" };
}
/** Pure metadata: no store construction, probing, configuration/registry access,
 * effects, or installed/permission claims. The native adapter separately checks
 * its current caller before returning this interface description. */
export function ticketIntakeInterface() {
  return Object.freeze({
    schemaVersion: "pa-ticket-intake-capabilities/v1", scope: "intake-interface-only",
    supportedActions: Object.freeze(["capabilities", "inspect", "reuse", "create", "patch-planning"] as const),
    requiredNativeProfile: TICKET_INTERACTIONS_PROFILE,
    schemas: Object.freeze({ capabilities: ticketIntakeCapabilitiesRequestSchema, inspect: ticketIntakeInspectSchema, reuse: ticketIntakeReuseSchema, create: ticketIntakeRequestSchema, "patch-planning": ticketPlanningRequestSchema }),
    selection: Object.freeze({ effect: "read-only", version: "complete ticket snapshot bound to current native caller; not permission",
      reuse: "Exact selected ID/project plus inspected expectedVersion/title/type; no fuzzy matching, mutation, claim or primary reassociation.",
      freshness: "As-of this read only; changes invalidate the version. Reuse grants no planning, lifecycle, resource or execution authority." }),
    planning: Object.freeze({ fields: Object.freeze(["title", "summary", "description", "priority", "estimate"]),
      preconditions: "Both inspected version and snapshotVersion, exact project/ticket, eligible unclaimed idea/requirement-review without primary/Git evidence, and no other current/historical deployment association.",
      recovery: "Original request ID, both versions and exact patch only. Completed replay preserves later work; retained ownership needs its original owner, not this port.",
      result: "pa-ticket-planning-result/v1: ticket ID/project, primaryTicket, appliedVersion, reusedIntent; no hidden ticket body or authority claim" }),
    limits: Object.freeze({ requestUtf8Bytes: MAX_INTERACTION_REQUEST_BYTES, resultUtf8Bytes: 51200, resultLines: 2000 }),
    creation: Object.freeze({ status: "idea", derivedActor: "requirements/analyze", primaryAssociation: "unchanged", project: "exact-registered-key-only",
      intake: "same-project; explicit type, priority, estimate and assignee required",
      companion: "explicit requested destination and valid bound primary required; defaults feature/medium/M/sinh",
      recovery: "Original request ID and content only; changed payload conflicts. An existing intent may still finish interrupted steps.",
      result: "pa-ticket-intake-result/v1: action, requestId, primaryTicket, ticket{id,project}, reusedIntent, sanitizedFields",
    }),
    availability: SOURCE_ONLY_AVAILABILITY, authorityGranted: false,
    limitations: Object.freeze(["This grammar description is not creation admission or installed qualification.",
      "Only scalar planning is supported here; arrays/tags/blockers, lifecycle/Git/resource operations and other-role ports remain unimplemented.",
      "No shell, root/provider/model reassociation or external-file access follows from this port."]),
  });
}
export interface TicketIntakeResult {
  schemaVersion: "pa-ticket-intake-result/v1"; action: "create"; requestId: string; primaryTicket: string | null;
  ticket: { id: string; project: string }; reusedIntent: boolean; sanitizedFields: string[];
}
export interface TicketSelectionResult {
  schemaVersion: "pa-ticket-selection-result/v1"; action: "inspect" | "reuse"; primaryTicket: string | null; version: string; snapshotVersion: string;
  ticket: Pick<Ticket, "id" | "project" | "title" | "type" | "status" | "priority" | "estimate" | "assignee" | "updatedAt">;
  authorityGranted: false;
}
/** Read-only selection, not a durable claim or permission. A complete snapshot
 * version makes concurrent edits (including hidden history) stale for reuse. */
export function readTicketInteraction(raw: string | Uint8Array, owner: { store: Pick<TicketStore, "get">; authenticate(): TicketInteractionCaller }): TicketSelectionResult {
  const request = parseTicketIntakeOperation(raw);
  if (request.action !== "inspect" && request.action !== "reuse") return fail("TICKET_INTERACTION_INPUT");
  const caller = Object.freeze({ ...owner.authenticate() });
  const validate = () => validateTicketScope(request, owner.authenticate(), caller, owner.store);
  validateTicketScope(request, caller, caller, owner.store);
  const ticket = owner.store.get(request.ticket);
  if (!ticket || ticket.id !== request.ticket || ticket.project !== request.project) return fail("TICKET_INTERACTION_SELECTION");
  const version = creationDigest({ ticket, caller });
  if (request.action === "reuse" && (request.expectedVersion !== version || request.expectedTitle !== ticket.title || request.expectedType !== ticket.type)) return fail("TICKET_INTERACTION_STALE");
  const selected = { id: ticket.id, project: ticket.project, title: ticket.title, type: ticket.type, status: ticket.status,
    priority: ticket.priority, estimate: ticket.estimate, assignee: ticket.assignee, updatedAt: ticket.updatedAt };
  // Legacy data may exceed the new port's bounds or sensitivity policy. Do not
  // truncate it into a misleading aligned-work preview or echo unsafe content.
  if (typeof ticket.title !== "string" || !ticket.title.trim() || Buffer.byteLength(ticket.title) > 1024
    || !ticketIntakeRequestSchema.properties.type.enum.includes(ticket.type)
    || Buffer.byteLength(JSON.stringify(selected)) > 8192) return fail("TICKET_INTERACTION_SELECTION");
  try { assertNoSensitiveMatch("content", JSON.stringify(selected)); } catch { return fail("TICKET_INTERACTION_SENSITIVE"); }
  validate();
  const current = owner.store.get(request.ticket);
  if (!current || creationDigest({ ticket: current, caller }) !== version) return fail("TICKET_INTERACTION_STALE");
  return { schemaVersion: "pa-ticket-selection-result/v1", action: request.action, primaryTicket: caller.ticket, version, snapshotVersion: ticketPlanningVersion(ticket), ticket: selected, authorityGranted: false };
}
export interface TicketPlanningResult {
  schemaVersion: "pa-ticket-planning-result/v1"; action: "patch-planning"; requestId: string; primaryTicket: string | null;
  ticket: { id: string; project: string }; appliedVersion: string; reusedIntent: boolean;
}
/** Finite service, not a raw-update proxy. The native adapter MUST provide actual
 * retained-owner observation; caller/version data alone never proves admission. */
export function patchTicketPlanningInteraction(raw: string | Uint8Array, owner: {
  store: TicketStore; authenticate(): TicketInteractionCaller; assertPlanningOwner(ticket: string, caller: TicketInteractionCaller): void;
}): TicketPlanningResult {
  const request = parseTicketIntakeOperation(raw);
  if (request.action !== "patch-planning") return fail("TICKET_INTERACTION_INPUT");
  const caller = Object.freeze({ ...owner.authenticate() });
  const assertCurrent = () => {
    validateTicketScope(request, owner.authenticate(), caller, owner.store);
    const current = owner.store.get(request.ticket);
    if (!current || current.id !== request.ticket || current.project !== request.project) return fail("TICKET_INTERACTION_SELECTION");
    assertPlanningScope(current, request.ticket);
    if (typeof owner.assertPlanningOwner !== "function") return fail("TICKET_INTERACTION_OWNER");
    const checked: unknown = owner.assertPlanningOwner(request.ticket, caller);
    if (checked instanceof Promise) void checked.catch(() => {});
    if (checked !== undefined) return fail("TICKET_INTERACTION_OWNER");
    validatePlanningPatch(request.patch);
  };
  validateTicketScope(request, caller, caller, owner.store);
  const scope = creationDigest({ domain: "native-ticket-planning/v1", profile: caller.profile,
    deploymentId: caller.deploymentId, repoKey: caller.repoKey, ticket: caller.ticket });
  const result = owner.store.patchPlanningWithIntent(request.ticket, request.expectedSnapshotVersion, request.patch, "requirements/analyze",
    { scope, requestId: request.requestId }, { requestBinding: creationDigest(request), assertCurrent,
      assertSnapshot: ticket => {
        if (ticket.id !== request.ticket || ticket.project !== request.project || creationDigest({ ticket, caller }) !== request.expectedVersion) fail("TICKET_INTERACTION_STALE");
      },
    });
  return { schemaVersion: "pa-ticket-planning-result/v1", action: "patch-planning", requestId: request.requestId, primaryTicket: caller.ticket,
    ticket: { id: result.ticket.id, project: result.ticket.project }, appliedVersion: result.appliedVersion, reusedIntent: result.reused };
}
function validateTicketScope(request: { project: string; kind: "intake" | "companion" }, current: TicketInteractionCaller, caller: TicketInteractionCaller, store: Pick<TicketStore, "get">): void {
  if (!current || current.profile !== TICKET_INTERACTIONS_PROFILE || !/^d-[a-f0-9]{6}$/.test(current.deploymentId)
    || !/^[a-f0-9]{64}$/.test(current.identitySha256) || current.identitySha256.length !== 64 || !isDeepStrictEqual(current, caller)) fail("TICKET_INTERACTION_SESSION");
  const repos = loadReposYaml(), destination = repos[request.project];
  if (!Object.hasOwn(repos, current.repoKey) || !Object.hasOwn(repos, request.project) || !destination?.prefix || !/^[A-Z][A-Z0-9]*$/.test(destination.prefix)
    || Object.values(repos).filter(repo => repo.prefix?.toUpperCase() === destination.prefix!.toUpperCase()).length !== 1) fail("TICKET_INTERACTION_PROJECT");
  if (current.ticket !== null) {
    if (!isCanonicalTicketId(current.ticket)) fail("TICKET_INTERACTION_SESSION");
    const primary = store.get(current.ticket);
    if (!primary || primary.id !== current.ticket || primary.project !== current.repoKey) fail("TICKET_INTERACTION_PROJECT");
  }
  if ((request.kind === "companion" && current.ticket === null) || (request.kind === "intake" && request.project !== current.repoKey)) fail("TICKET_INTERACTION_PROJECT");
}
/** Trusted adapter seam, NOT model parameters. Authentication is synchronous and repeated under the SAME owner mutex. */
export function createTicketInteraction(raw: string | Uint8Array, owner: { store: TicketStore; authenticate(): TicketInteractionCaller }): TicketIntakeResult {
  const request = parseTicketIntakeRequest(raw), caller = Object.freeze({ ...owner.authenticate() });
  const validate = (current: TicketInteractionCaller): void => validateTicketScope(request, current, caller, owner.store);
  validate(caller);
  const sanitizedFields: string[] = [];
  const sanitize = (field: "title" | "summary" | "description"): string => {
    const value = request[field] ?? "";
    try { assertNoSensitiveMatch("content", value); } catch { return fail("TICKET_INTERACTION_SENSITIVE"); }
    const cleaned = sanitizeTextInput(value); if (cleaned.removed) sanitizedFields.push(field);
    try { assertNoSensitiveMatch("content", cleaned.sanitized); } catch { return fail("TICKET_INTERACTION_SENSITIVE"); }
    if (field === "title" && !cleaned.sanitized.trim()) return fail("TICKET_INTERACTION_INPUT");
    return cleaned.sanitized;
  };
  const assignee = request.assignee ?? "sinh", teams = getValidTeamNames();
  if (assignee !== "sinh" && !teams.has(assignee.split("/")[0]!)) return fail("TICKET_INTERACTION_INPUT");
  try { validateAssignee(assignee, teams); } catch { return fail("TICKET_INTERACTION_INPUT"); }
  const input: CreateTicketInput = { project: request.project, title: sanitize("title"), summary: sanitize("summary"), description: sanitize("description"),
    type: request.type ?? "feature", priority: request.priority ?? "medium", estimate: request.estimate ?? "M", assignee,
    status: "idea", from: "", to: "", tags: [], blockedBy: [], comments: [], doc_refs: [] };
  // Do not include payload in the intent key: changed payload MUST conflict at the original identity.
  const scope = creationDigest({ profile: caller.profile, deploymentId: caller.deploymentId, repoKey: caller.repoKey, ticket: caller.ticket });
  const result = owner.store.createWithIntent(input, "requirements/analyze", { scope, requestId: request.requestId }, {
    requestBinding: creationDigest(request), assertCurrent: () => {
      validate(owner.authenticate());
      // Configuration and sensitive-input owners may change while waiting for
      // the ticket lock. Recheck both raw and persisted text at the effect boundary.
      const currentTeams = getValidTeamNames();
      if (assignee !== "sinh" && !currentTeams.has(assignee.split("/")[0]!)) fail("TICKET_INTERACTION_INPUT");
      for (const field of ["title", "summary", "description"] as const) {
        try { assertNoSensitiveMatch("content", request[field] ?? ""); assertNoSensitiveMatch("content", input[field]); }
        catch { fail("TICKET_INTERACTION_SENSITIVE"); }
      }
    },
  });
  return { schemaVersion: "pa-ticket-intake-result/v1", action: "create", requestId: request.requestId, primaryTicket: caller.ticket,
    ticket: { id: result.ticket.id, project: result.ticket.project }, reusedIntent: result.reused, sanitizedFields };
}
