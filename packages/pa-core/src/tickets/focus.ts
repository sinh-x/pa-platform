import type { Ticket, TicketPriority, TicketStatus } from "./types.js";
import { TicketStore } from "./store.js";

// Ported from PA tickets/focus.ts at frozen PA source on 2026-04-26; report-cache reading omitted from core slice.

export interface FocusItem {
  id: string;
  title: string;
  project: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: string;
  staleDays: number;
  isBlocked: boolean;
  blockerIds: string[];
  updatedAt: string;
}

export interface WipSummary {
  byStatus: Record<TicketStatus, number>;
  byProject: Record<string, number>;
  total: number;
}

export interface FocusResult {
  focus: FocusItem[];
  wip: WipSummary;
}

export interface FocusFilters {
  project?: string;
  assignee?: string;
  includeAll?: boolean;
}

const FOCUS_STATUSES: TicketStatus[] = ["pending-approval", "pending-implementation", "implementing", "review-uat"];
const ALL_FOCUS_STATUSES: TicketStatus[] = ["idea", "requirement-review", ...FOCUS_STATUSES];
const STALENESS_THRESHOLDS: Record<TicketStatus, number> = { idea: 999, "requirement-review": 999, "pending-approval": 2, "pending-implementation": 3, implementing: 5, "review-uat": 3, done: 999, rejected: 999, cancelled: 999 };
const PRIORITY_ORDER: Record<TicketPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function buildFocusList(filters: FocusFilters = {}, store = new TicketStore()): FocusResult {
  const relevantStatuses = filters.includeAll ? ALL_FOCUS_STATUSES : FOCUS_STATUSES;
  const tickets = store.list({ project: filters.project, assignee: filters.assignee, excludeTags: ["backlog", "archived"], excludeTypes: ["fyi", "work-report"] }).filter((ticket) => relevantStatuses.includes(ticket.status));
  const focus = tickets.map(enrichTicket).sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.staleDays - a.staleDays);
  return { focus, wip: buildWipSummary(tickets) };
}

export function calculateStaleness(ticket: Ticket, now = new Date()): number {
  const days = Math.floor((now.getTime() - new Date(ticket.updatedAt).getTime()) / 86400000);
  return Math.max(0, days - (STALENESS_THRESHOLDS[ticket.status] ?? 999));
}

export function isTicketStale(ticket: Ticket): boolean {
  return calculateStaleness(ticket) > 0;
}

export function detectBottlenecks(focusItems: FocusItem[]): Record<string, number> {
  const late = new Set<TicketStatus>(["pending-approval", "pending-implementation", "implementing", "review-uat"]);
  const counts: Record<string, number> = {};
  for (const item of focusItems) if (late.has(item.status)) counts[item.project] = (counts[item.project] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 3));
}

function enrichTicket(ticket: Ticket): FocusItem {
  return { id: ticket.id, title: ticket.title, project: ticket.project, status: ticket.status, priority: ticket.priority, assignee: ticket.assignee, staleDays: calculateStaleness(ticket), isBlocked: ticket.tags.includes("blocked") || ticket.blockedBy.length > 0, blockerIds: ticket.blockedBy, updatedAt: ticket.updatedAt };
}

function buildWipSummary(tickets: Ticket[]): WipSummary {
  const byStatus = { idea: 0, "requirement-review": 0, "pending-approval": 0, "pending-implementation": 0, implementing: 0, "review-uat": 0, done: 0, rejected: 0, cancelled: 0 } as Record<TicketStatus, number>;
  const byProject: Record<string, number> = {};
  for (const ticket of tickets) {
    byStatus[ticket.status]++;
    byProject[ticket.project] = (byProject[ticket.project] ?? 0) + 1;
  }
  return { byStatus, byProject, total: tickets.length };
}
