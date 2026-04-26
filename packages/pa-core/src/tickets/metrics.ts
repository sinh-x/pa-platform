import { TicketStore } from "./store.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./types.js";
import type { AuditEntry, Estimate, Ticket } from "./types.js";

// Ported from PA tickets/metrics.ts at frozen PA source on 2026-04-26.

export const ESTIMATE_POINTS: Record<Estimate, number> = { XS: 1, S: 2, M: 3, L: 5, XL: 8 };

export interface SprintMetrics {
  startDate: string;
  endDate: string;
  throughput: number;
  avgCycleTimeHours: number;
  velocityPoints: number;
  avgBlockedTimeHours: number;
  estimationAccuracyPct: number;
  carryOverCount: number;
  carryOverPct: number;
  byTeam: Record<string, TeamSprintMetrics>;
  byEstimate: Record<Estimate, EstimateMetrics>;
}

export interface TeamSprintMetrics {
  team: string;
  throughput: number;
  velocityPoints: number;
  avgCycleTimeHours: number;
  carryOverCount: number;
}

export interface EstimateMetrics {
  estimate: Estimate;
  count: number;
  avgActualCycleTimeHours: number;
  points: number;
}

export function computeSprintMetrics(startDate: string, endDate: string, project?: string, store = new TicketStore()): SprintMetrics {
  const tickets = store.list(project ? { project } : {});
  const audit = store.readAudit();
  const start = new Date(startDate);
  const end = new Date(endDate);
  const completed = tickets.filter((ticket) => TERMINAL_STATUSES.includes(ticket.status) && ticket.resolvedAt && new Date(ticket.resolvedAt) >= start && new Date(ticket.resolvedAt) <= end);
  const activeAtEnd = tickets.filter((ticket) => ACTIVE_STATUSES.includes(ticket.status) && new Date(ticket.createdAt) <= end);
  const cycleTimes = completed.map((ticket) => cycleTimeHours(ticket, audit)).filter((value): value is number => value !== undefined);
  const avgCycleTimeHours = average(cycleTimes);
  const accurateEstimates = completed.filter((ticket) => {
    const cycle = cycleTimeHours(ticket, audit);
    if (cycle === undefined) return false;
    const [min, max] = estimateToCycleTimeBucket(ticket.estimate);
    return cycle >= min && cycle < max;
  }).length;
  return {
    startDate,
    endDate,
    throughput: completed.length,
    avgCycleTimeHours,
    velocityPoints: completed.reduce((sum, ticket) => sum + ESTIMATE_POINTS[ticket.estimate], 0),
    avgBlockedTimeHours: 0,
    estimationAccuracyPct: completed.length > 0 ? (accurateEstimates / completed.length) * 100 : 0,
    carryOverCount: activeAtEnd.length,
    carryOverPct: tickets.length > 0 ? (activeAtEnd.length / tickets.length) * 100 : 0,
    byTeam: computeByTeam(completed, activeAtEnd, audit),
    byEstimate: computeByEstimate(completed, audit),
  };
}

export function computeWeeklyThroughput(weeks: number, project?: string, store = new TicketStore()): Array<{ weekStart: string; throughput: number; velocityPoints: number }> {
  const tickets = store.list(project ? { project } : {});
  const now = new Date();
  return Array.from({ length: weeks }, (_, index) => {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - (weeks - 1 - index) * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);
    const completed = tickets.filter((ticket) => TERMINAL_STATUSES.includes(ticket.status) && ticket.resolvedAt && new Date(ticket.resolvedAt) >= weekStart && new Date(ticket.resolvedAt) <= weekEnd);
    return { weekStart: weekStart.toISOString().slice(0, 10), throughput: completed.length, velocityPoints: completed.reduce((sum, ticket) => sum + ESTIMATE_POINTS[ticket.estimate], 0) };
  });
}

function cycleTimeHours(ticket: Ticket, audit: AuditEntry[]): number | undefined {
  const start = findStatusEntryTime(ticket.id, "pending-implementation", audit);
  if (!start || !ticket.resolvedAt) return undefined;
  return (new Date(ticket.resolvedAt).getTime() - start.getTime()) / 36e5;
}

function findStatusEntryTime(ticketId: string, status: string, audit: AuditEntry[]): Date | undefined {
  const entry = audit.filter((item) => item.ticket_id === ticketId).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).find((item) => item.changes["status"]?.[1] === status);
  return entry ? new Date(entry.timestamp) : undefined;
}

function estimateToCycleTimeBucket(estimate: Estimate): [number, number] {
  return { XS: [0, 2], S: [2, 8], M: [8, 24], L: [24, 72], XL: [72, Infinity] }[estimate] as [number, number];
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function computeByTeam(completed: Ticket[], activeAtEnd: Ticket[], audit: AuditEntry[]): Record<string, TeamSprintMetrics> {
  const result: Record<string, TeamSprintMetrics> = {};
  for (const ticket of completed) {
    const team = ticket.assignee || "unassigned";
    result[team] ??= { team, throughput: 0, velocityPoints: 0, avgCycleTimeHours: 0, carryOverCount: activeAtEnd.filter((item) => item.assignee === team).length };
    result[team].throughput++;
    result[team].velocityPoints += ESTIMATE_POINTS[ticket.estimate];
  }
  for (const [team, metrics] of Object.entries(result)) {
    metrics.avgCycleTimeHours = average(completed.filter((ticket) => (ticket.assignee || "unassigned") === team).map((ticket) => cycleTimeHours(ticket, audit)).filter((value): value is number => value !== undefined));
  }
  return result;
}

function computeByEstimate(completed: Ticket[], audit: AuditEntry[]): Record<Estimate, EstimateMetrics> {
  const result = {} as Record<Estimate, EstimateMetrics>;
  for (const estimate of ["XS", "S", "M", "L", "XL"] as Estimate[]) {
    const tickets = completed.filter((ticket) => ticket.estimate === estimate);
    result[estimate] = { estimate, count: tickets.length, avgActualCycleTimeHours: average(tickets.map((ticket) => cycleTimeHours(ticket, audit)).filter((value): value is number => value !== undefined)), points: tickets.length * ESTIMATE_POINTS[estimate] };
  }
  return result;
}
