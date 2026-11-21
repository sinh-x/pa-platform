import { Type } from "typebox";
import { TicketStore, workflowObject, workflowError, workflowDigest, workflowSha } from "@pa-platform/pa-core";
import type { PiToolDefinition, PiTicketAction } from "./index.js";
import { boundJson, MAX_TOOL_BYTES, MAX_TOOL_LINES } from "./tool-result.js";
import { bindingForPlan, projectPlannedActual, type PlannedActualProjection, type PlannedActualHost } from "@pa-platform/pa-core/tickets/planned-actual";
import { nativePlannedActualHost } from "../phase-report-native.js";

/** Shared ticket port without importing the composed extension/editor graph. */
export function createPaTicketTool(options: { store?: TicketStore; plannedActualHost?: PlannedActualHost } = {}): PiToolDefinition {
  return {
    name: "pa_ticket", label: "PA Ticket", description: "Read, show, list, or comment on a PA ticket. With read/show, plannedActual=true discovers exact accessible Planned choices, including drafts and plans without Actual. reference reads Planned alone; add candidate for an exact comparison. Large projections return complete JSON fragments: concatenate content.text in page order, then parse JSON. Repeat the same selectors with page=pagination.next until next=null. A changed snapshot rejects continuation; restart the read, not the producer. No latest selection or acceptance authority is inferred.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("show"), Type.Literal("list"), Type.Literal("comment")]),
      id: Type.Optional(Type.String()),
      author: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      search: Type.Optional(Type.String()),
      plannedActual: Type.Optional(Type.Boolean()),
      reference: Type.Optional(Type.String()),
      candidate: Type.Optional(Type.String()),
      page: Type.Optional(Type.Object({ snapshot: Type.String({ pattern: "^[a-f0-9]{64}$" }), offset: Type.Integer({ minimum: 0 }) })),
    }),
    execute: async (_toolCallId, input) => ({ content: [{ type: "text", text: boundJson(await ticketTool(input, options)) }], details: {} }),
  };
}

async function ticketTool(input: Record<string, unknown>, options: { store?: TicketStore; plannedActualHost?: PlannedActualHost }): Promise<unknown> {
  const store = options.store ?? new TicketStore();
  const action = ticketActionInput(input);
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
  if (action === "read" || action === "show") return store.get(stringInput(input, "id")) ?? { error: "Ticket not found" };
  if (action === "list") return store.list({ search: typeof input.search === "string" ? input.search : undefined });
  return store.comment(stringInput(input, "id"), stringInput(input, "author"), stringInput(input, "content"));
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
  if (action === "read" || action === "show" || action === "list" || action === "comment") return action;
  throw new Error(`Unsupported ticket action "${action}". Accepted actions: read, show, list, comment.`);
}

function stringInput(input: Record<string, unknown>, key: string): string { const value = input[key]; if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required.`); return value; }
