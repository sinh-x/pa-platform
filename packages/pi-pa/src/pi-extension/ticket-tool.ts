import { Type } from "typebox";
import { TicketStore, parseTicketAdminRequest, normalizeTicketAdminRequest, assertTicketAdminPreflight, resolveTrustedTicketMutationContext, ticketAdminService, TicketAdminError, TicketCreateIntentError, TicketStatusError, TicketHandoffError, TicketPlanningIntentError, ticketAdminFail, workflowObject, workflowError, workflowDigest, workflowSha } from "@pa-platform/pa-core";
import { authenticatePiTicketCaller, type PiTicketContext } from "../ticket-session.js";
import type { PiToolDefinition, PiTicketAction } from "./index.js";
import { boundJson, MAX_TOOL_BYTES, MAX_TOOL_LINES } from "./tool-result.js";
import { bindingForPlan, projectPlannedActual, type PlannedActualProjection, type PlannedActualHost } from "@pa-platform/pa-core/tickets/planned-actual";
import { nativePlannedActualHost } from "../phase-report-native.js";

const project = Type.String({ pattern: "^[a-z][a-z0-9._-]{0,127}$", maxLength: 128 });
const id = Type.String({ pattern: "^[A-Z][A-Z0-9]*-[0-9]+$", maxLength: 64 });
const requestId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", maxLength: 128 });
const expectedVersion = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const fields = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })), summary: Type.Optional(Type.String({ maxLength: 8192 })),
  description: Type.Optional(Type.String({ maxLength: 32768 })),
  priority: Type.Optional(Type.String({ enum: ["critical", "high", "medium", "low"] })),
  estimate: Type.Optional(Type.String({ enum: ["XS", "S", "M", "L", "XL"] })),
  type: Type.Optional(Type.String({ enum: ["feature", "bug", "task", "review-request", "work-report", "fyi", "idea", "question"] })),
  assignee: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64, uniqueItems: true })),
  blockedBy: Type.Optional(Type.Array(id, { maxItems: 64, uniqueItems: true })),
  from: Type.Optional(Type.String({ maxLength: 128 })), to: Type.Optional(Type.String({ maxLength: 128 })),
}, { additionalProperties: false, minProperties: 1 });
const administrativeActions = ["inspect", "create", "update", "set-status", "comment"];
/** Shared ticket port without importing the composed extension/editor graph. */
export function createPaTicketTool(options: { store?: TicketStore; plannedActualHost?: PlannedActualHost } = {}): PiToolDefinition {
  return {
    name: "pa_ticket", label: "PA Ticket", executionMode: "sequential", description: "Read/list and native typed administration for any registered project, independent of team/mode or document capability selection. inspect(project,id) returns snapshot metadata/version and the ticket when within 50 KiB/2000 lines; larger replies retain complete metadata and explicitly omit the body. create(project,requestId,fields) creates an idea using a stable original intent. update(project,id,expectedVersion,fields) applies only supplied administrative fields under full-snapshot CAS. After response loss inspect before another update. set-status(project,id,requestId,expectedVersion,status) uses the original durable status intent; preserve original coordinates on retry. comment(project,id,content) derives its author from the native caller. Legacy comment(id,author,content) resolves the project from the ticket; author may only name this caller or a configured agent in its team and never supplies identity or permission. No identity, privilege, source/Git fields, workflow or execution grant. Direct calls authenticate process/session and recheck custody under the ticket mutex. " + "Read, show, or list a PA ticket. With read/show, plannedActual=true discovers exact accessible Planned choices, including drafts and plans without Actual. reference reads Planned alone; add candidate for an exact comparison. Large projections return complete JSON fragments: concatenate content.text in page order, then parse JSON. Repeat the same selectors with page=pagination.next until next=null. A changed snapshot rejects continuation; restart the read, not the producer. No latest selection or acceptance authority is inferred.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("inspect"), project, id }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("create"), project, requestId, fields }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("update"), project, id, expectedVersion, fields }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("set-status"), project, id, requestId, expectedVersion,
        status: Type.String({ enum: ["idea", "requirement-review", "pending-approval", "pending-implementation", "implementing", "review-uat", "done", "rejected", "cancelled"] }) }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("comment"), project, id, content: Type.String({ minLength: 1, maxLength: 32768 }) }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("comment"), id, author: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}/[a-z][a-z0-9_-]{0,63}$", maxLength: 128 }), content: Type.String({ minLength: 1, maxLength: 32768 }) }, { additionalProperties: false }),
      Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("show"), Type.Literal("list")]),
      id: Type.Optional(id),
      search: Type.Optional(Type.String({ maxLength: 8192 })),
      plannedActual: Type.Optional(Type.Boolean()),
      reference: Type.Optional(Type.String()),
      candidate: Type.Optional(Type.String()),
      page: Type.Optional(Type.Object({ snapshot: Type.String({ pattern: "^[a-f0-9]{64}$" }), offset: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })),
    }, { additionalProperties: false })]),
    execute: async (_toolCallId, input, signal, _update, context) => {
      if (!administrativeActions.includes(String(input.action))) return { content: [{ type: "text", text: boundJson(await ticketTool(input, options)) }], details: {} };
      try {
        // Strict request validation must precede context resolution or any store
        // constructor that can initialize the tickets directory.
        const parsed = parseTicketAdminRequest(JSON.stringify(input));
        if (signal?.aborted) ticketAdminFail("TICKET_ADMIN_SESSION");
        const authenticate = () => {
          if (signal?.aborted) ticketAdminFail("TICKET_ADMIN_SESSION");
          return authenticatePiTicketCaller(context as PiTicketContext);
        };
        const caller = authenticate();
        const observation = options.store ?? new TicketStore(undefined, {}, false);
        const request = normalizeTicketAdminRequest(parsed, caller, observation);
        assertTicketAdminPreflight(request, observation);
        const store = options.store ?? new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: caller.deploymentId }, false));
        const result = ticketAdminService(JSON.stringify(request), { store, authenticate });
        const output = fitsTool(result) ? result : { action: result.action, id: result.id, project: result.project, status: result.status,
          version: result.version, requestId: result.requestId, reusedIntent: result.reusedIntent, appliedVersion: result.appliedVersion,
          executionAdmitted: false, output: "bounded-summary-body-omitted",
          notice: "The body exceeds 50 KiB or 2000 lines; result metadata is complete. Read ticket content separately. Do not repeat a mutation solely for a larger reply." };
        return { content: [{ type: "text", text: boundJson(output) }], details: {} };
      } catch (error) {
        const failure = error instanceof TicketAdminError || error instanceof TicketCreateIntentError || error instanceof TicketStatusError || error instanceof TicketHandoffError || error instanceof TicketPlanningIntentError ? error : new TicketAdminError("TICKET_ADMIN_UNAVAILABLE");
        return { content: [{ type: "text", text: failure.message }], details: { code: failure.code }, isError: true };
      }
    },
  };
}

async function ticketTool(input: Record<string, unknown>, options: { store?: TicketStore; plannedActualHost?: PlannedActualHost }): Promise<unknown> {
  const action = ticketActionInput(input);
  const store = options.store ?? new TicketStore(undefined, {}, false);
  if (Object.hasOwn(input, "page") && action !== "read" && action !== "show") throw workflowError();
  if ((action === "read" || action === "show") && (input.plannedActual === true || Object.hasOwn(input, "reference") || Object.hasOwn(input, "candidate") || Object.hasOwn(input, "page"))) {
    workflowObject(input, ["action", "id", ...["plannedActual", "reference", "candidate", "page"].filter(key => Object.hasOwn(input, key))]);
    if (Object.hasOwn(input, "plannedActual") && typeof input.plannedActual !== "boolean") throw workflowError();
    if (Object.hasOwn(input, "reference") && (typeof input.reference !== "string" || !input.reference.length)) throw workflowError();
    if (Object.hasOwn(input, "candidate") && (typeof input.candidate !== "string" || typeof input.reference !== "string")) throw workflowError();
    const page = parsePage(input.page);
    const ticket = store.get(stringInput(input, "id"));
    const candidate = typeof input.candidate === "string" ? workflowSha(input.candidate, 40) : undefined;
    const projection: PlannedActualProjection = ticket
      ? await projectPlannedActual(ticket, typeof input.reference === "string" ? input.reference : undefined, candidate, options.plannedActualHost ?? nativePlannedActualHost())
      : { state: "missing", actuals: [], unmatched: [], issues: [] };
    return projectionPage(projection, candidate, page);
  }
  if (action === "read" || action === "show") {
    workflowObject(input, ["action", "id"]);
    return store.get(stringInput(input, "id")) ?? { error: "Ticket not found" };
  }
  workflowObject(input, ["action", ...(Object.hasOwn(input, "search") ? ["search"] : [])]);
  return store.list({ search: typeof input.search === "string" ? input.search : undefined });
}

interface ProjectionPageCoordinate { snapshot: string; offset: number }
function parsePage(value: unknown): ProjectionPageCoordinate | undefined {
  if (value === undefined) return undefined;
  const page = workflowObject(value, ["snapshot", "offset"]);
  if (!Number.isSafeInteger(page.offset) || Number(page.offset) < 0) throw workflowError();
  return { snapshot: workflowSha(page.snapshot), offset: Number(page.offset) };
}
function fitsTool(value: unknown): boolean {
  const encoded = JSON.stringify(value, null, 2);
  return Buffer.byteLength(encoded, "utf8") <= MAX_TOOL_BYTES && encoded.split("\n").length <= MAX_TOOL_LINES;
}
/** Normal ticket dispatch owns continuation, before the unchanged global limiter.
 * Fragments encode the ENTIRE projection, not a preview or protected-store path.
 * The digest detects changed bindings, attachments, issues or evidence between reads. */
function projectionPage(projection: PlannedActualProjection, candidate: string | undefined, page: ProjectionPageCoordinate | undefined): unknown {
  const issues: Partial<Record<PlannedActualProjection["issues"][number]["state"], number>> = {};
  for (const issue of projection.issues) issues[issue.state] = (issues[issue.state] ?? 0) + 1;
  const evidence: { class: string; state: string; applicability: string; count: number }[] = [];
  for (const actual of projection.actuals) for (const fact of actual.evidence) {
    const applicability = fact.applicability ?? "current";
    const group = evidence.find(e => e.class === fact.class && e.state === fact.state && e.applicability === applicability);
    if (group) group.count++; else evidence.push({ class: fact.class, state: fact.state, applicability, count: 1 });
  }
  const plan = projection.planned;
  const selection = plan ? { reference: plan.reference, deliverySha256: plan.deliverySha256,
    binding: candidate ? bindingForPlan(plan, candidate) : { repository: plan.repository, ticket: plan.ticket, subjectSha256: plan.subjectSha256, revision: plan.revision, manifestSha256: plan.manifestSha256 } } : null;
  // Include the selected binding even when no Actual is present, so changing
  // candidates cannot reuse continuation for the same empty comparison.
  const json = JSON.stringify({ ...projection, selection }), snapshot = workflowDigest(json), offset = page?.offset ?? 0;
  if ((page && page.snapshot !== snapshot) || offset >= json.length || (offset > 0 && /[\uD800-\uDBFF]/.test(json[offset - 1]!))) throw workflowError();
  const header = { state: projection.state, selection,
    summary: { choices: projection.choices?.length ?? 0, actuals: projection.actuals.length, unmatched: projection.unmatched.length, issues, evidence } };
  const pagination = (end: number) => ({ snapshot, offset, total: json.length, next: end < json.length ? { snapshot, offset: end } : null });
  const structured = { ...projection, ...header, pagination: pagination(json.length) };
  if (offset === 0 && fitsTool(structured)) return structured;
  const fragment = (end: number) => ({ ...header, pagination: pagination(end), content: { encoding: "json-fragment", text: json.slice(offset, end) } });
  let low = offset + 1, high = json.length, end = offset;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const safeEnd = /[\uD800-\uDBFF]/.test(json[middle - 1]!) ? middle - 1 : middle;
    if (fitsTool(fragment(safeEnd))) { end = safeEnd; low = middle + 1; } else high = middle - 1;
  }
  if (end <= offset) throw workflowError();
  return fragment(end);
}

function ticketActionInput(input: Record<string, unknown>): PiTicketAction {
  const action = stringInput(input, "action");
  if (action === "read" || action === "show" || action === "list") return action;
  throw workflowError();
}

function stringInput(input: Record<string, unknown>, key: string): string { const value = input[key]; if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required.`); return value; }
