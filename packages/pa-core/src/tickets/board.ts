import { queryDeploymentStatuses } from "../registry/index.js";
import { deriveDocRefTitle } from "./doc-ref.js";
import { TicketStore } from "./store.js";
import type { Ticket, TicketListFilters, TicketStatus } from "./types.js";

// Ported from PA tickets/board.ts at frozen PA source on 2026-04-26; registry access uses pa-core query API.

export const BOARD_COLUMNS: TicketStatus[] = ["idea", "requirement-review", "pending-approval", "pending-implementation", "implementing", "review-uat", "done", "rejected", "cancelled"];

export interface BoardColumn {
  status: TicketStatus;
  tickets: Array<Ticket & { hasRunningDeployment?: boolean }>;
  count: number;
}

export interface BoardView {
  project: string;
  columns: BoardColumn[];
  total: number;
  assigneeCounts: Record<string, number>;
}

export interface TeamStatusSummary {
  assignee: string;
  counts: Record<TicketStatus, number>;
  total: number;
}

const NATURAL_TOKEN = /\d+|\D+/g;
const DECIMAL_TOKEN = /^\d+$/;

/** Compare ticket IDs without locale or numeric-range dependent behavior. */
export function compareTicketIds(left: string, right: string): number {
  if (left === right) return 0;

  // Tokenizing the full ID compares ordinary prefixes alphabetically and every
  // digit run numerically, including the terminal suffix of a standard ID.
  const leftTokens = left.match(NATURAL_TOKEN) ?? [left];
  const rightTokens = right.match(NATURAL_TOKEN) ?? [right];
  const length = Math.min(leftTokens.length, rightTokens.length);
  for (let index = 0; index < length; index++) {
    const leftToken = leftTokens[index]!;
    const rightToken = rightTokens[index]!;
    const tokenOrder = DECIMAL_TOKEN.test(leftToken) && DECIMAL_TOKEN.test(rightToken)
      ? compareDecimalStrings(leftToken, rightToken)
      : compareRawText(leftToken, rightToken);
    if (tokenOrder !== 0) return tokenOrder;
  }
  if (leftTokens.length !== rightTokens.length) return leftTokens.length < rightTokens.length ? -1 : 1;
  return compareRawText(left, right);
}

function compareDecimalStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  return compareRawText(normalizedLeft, normalizedRight);
}

function compareRawText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildBoardView(project?: string, filters: Omit<TicketListFilters, "project" | "status" | "type" | "tags" | "search"> = {}): BoardView {
  const tickets = new TicketStore().list({ project, ...filters });
  const runningTicketIds = new Set(queryDeploymentStatuses().filter((deployment) => deployment.status === "running" && deployment.ticket_id).map((deployment) => deployment.ticket_id!));
  const grouped = new Map<TicketStatus, Array<Ticket & { hasRunningDeployment?: boolean }>>(BOARD_COLUMNS.map((status) => [status, []]));
  const assigneeCounts: Record<string, number> = {};
  for (const ticket of tickets) {
    const annotated = { ...ticket, doc_refs: ticket.doc_refs.map((ref) => ({ ...ref, title: deriveDocRefTitle(ref) })), hasRunningDeployment: runningTicketIds.has(ticket.id) };
    (grouped.get(ticket.status) ?? grouped.get("idea")!).push(annotated);
    const assignee = ticket.assignee || "unassigned";
    assigneeCounts[assignee] = (assigneeCounts[assignee] ?? 0) + 1;
  }
  return {
    project: project ?? "all",
    columns: BOARD_COLUMNS.map((status) => {
      const columnTickets = grouped.get(status)!;
      columnTickets.sort((a, b) => compareTicketIds(a.id, b.id));
      return { status, tickets: columnTickets, count: columnTickets.length };
    }),
    total: tickets.length,
    assigneeCounts,
  };
}

export function getTeamStatusSummaries(project?: string, filters: { excludeTags?: string[]; excludeStatuses?: TicketStatus[] } = {}): TeamStatusSummary[] {
  const tickets = new TicketStore().list({ ...(project ? { project } : {}), ...(filters.excludeTags ? { excludeTags: filters.excludeTags } : {}) }).filter((ticket) => !filters.excludeStatuses?.includes(ticket.status));
  const byAssignee = new Map<string, Record<TicketStatus, number>>();
  for (const ticket of tickets) {
    const assignee = ticket.assignee || "unassigned";
    if (!byAssignee.has(assignee)) byAssignee.set(assignee, Object.fromEntries(BOARD_COLUMNS.map((status) => [status, 0])) as Record<TicketStatus, number>);
    byAssignee.get(assignee)![ticket.status]++;
  }
  return [...byAssignee.entries()].map(([assignee, counts]) => ({ assignee, counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) }));
}

export function getTeamBoard(team: string, filters: { project?: string; excludeTags?: string[]; excludeTypes?: TicketListFilters["excludeTypes"] } = {}): BoardView & { team: string } {
  return { ...buildBoardView(filters.project, { assignee: team, excludeTags: filters.excludeTags, excludeTypes: filters.excludeTypes }), team };
}
