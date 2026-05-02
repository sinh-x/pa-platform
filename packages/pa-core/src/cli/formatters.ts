import type { Bulletin } from "../bulletins/index.js";
import type { RepoEntry } from "../repos.js";
import type { TeamConfigSummary } from "../teams/index.js";
import type { DeploymentStatus } from "../types.js";
import type { BoardView, Ticket } from "../tickets/index.js";
import type { TrashEntry } from "../trash/index.js";
import { formatLocal, formatLocalShort } from "../time.js";

export interface TimerRow {
  unit: string;
  team: string;
  next_in: string;
}

export interface TeamStatusRow {
  name: string;
  model: string;
  counts: string[];
  deployment: string;
}

export interface BoardFormatOptions {
  colorEnabled?: boolean;
}

const ANSI_RESET = "\u001b[0m";

const ANSI_COLORS = {
  statusHeader: "\u001b[1;36m",
  critical: "\u001b[31m",
  high: "\u001b[33m",
  medium: "\u001b[34m",
  low: "\u001b[32m",
  normal: "\u001b[90m",
  unknownPriority: "\u001b[90m",
  deploying: "\u001b[35m",
} as const;

function withAnsi(enabled: boolean, ansiCode: string, text: string): string {
  if (!enabled || text === "") return text;
  return `${ansiCode}${text}${ANSI_RESET}`;
}

function priorityColor(priority: string): string {
  switch (priority) {
    case "critical":
      return ANSI_COLORS.critical;
    case "high":
      return ANSI_COLORS.high;
    case "medium":
      return ANSI_COLORS.medium;
    case "low":
      return ANSI_COLORS.low;
    case "normal":
      return ANSI_COLORS.normal;
    default:
      return ANSI_COLORS.unknownPriority;
  }
}

export function renderLines(lines: string[]): string {
  return lines.join("\n");
}

export function formatTicketList(tickets: Ticket[]): string {
  return renderLines([...tickets.map((ticket) => `${ticket.id.padEnd(8)} ${ticket.status.padEnd(22)} ${ticket.priority.padEnd(8)} ${ticket.assignee.padEnd(22)} ${ticket.title}`), `Count: ${tickets.length}`]);
}

export function formatTicketShow(ticket: Ticket): string {
  const lines = [`${ticket.id} | ${ticket.status} | ${ticket.priority} | ${ticket.assignee}`, ticket.title];
  if (ticket.summary) lines.push(`Summary: ${ticket.summary}`);
  lines.push(`Created: ${formatLocal(ticket.createdAt)}`);
  lines.push(`Updated: ${formatLocal(ticket.updatedAt)}`);
  if (ticket.resolvedAt) lines.push(`Resolved: ${formatLocal(ticket.resolvedAt)}`);
  if (ticket.doc_refs.length > 0) lines.push(`Doc refs: ${ticket.doc_refs.map((ref) => ref.path).join(", ")}`);
  if (ticket.comments.length > 0) lines.push(`Comments: ${ticket.comments.length}`);
  return renderLines(lines);
}

export function formatBulletinList(bulletins: Bulletin[]): string {
  return renderLines([...bulletins.map((bulletin) => `${bulletin.id.padEnd(6)} ${String(bulletin.block).padEnd(16)} ${bulletin.title}`), `Count: ${bulletins.length}`]);
}

export function formatTrashList(entries: TrashEntry[]): string {
  return renderLines([...entries.map((entry) => `${entry.id.padEnd(6)} ${entry.status.padEnd(9)} ${entry.fileType.padEnd(8)} ${entry.originalPath}`), `Count: ${entries.length}`]);
}

export function formatTrashShow(entry: TrashEntry): string {
  return renderLines([`${entry.id} | ${entry.status} | ${entry.fileType}`, `Original: ${entry.originalPath}`, `Reason: ${entry.reason}`]);
}

export function formatRegistryList(deployments: DeploymentStatus[]): string {
  return renderLines([
    `${"DEPLOY-ID".padEnd(12)} ${"TEAM".padEnd(22)} ${"STATUS".padEnd(10)} ${"STARTED".padEnd(26)} ${"ENDED".padEnd(26)} SUMMARY`,
    `${"-----------".padEnd(12)} ${"---------------------".padEnd(22)} ${"---------".padEnd(10)} ${"-------------------------".padEnd(26)} ${"-------------------------".padEnd(26)} -------`,
    ...deployments.map((deployment) => `${deployment.deploy_id.padEnd(12)} ${deployment.team.padEnd(22)} ${deployment.status.padEnd(10)} ${shortTs(deployment.started_at).padEnd(26)} ${(deployment.completed_at ? shortTs(deployment.completed_at) : "-").padEnd(26)} ${truncate(deployment.summary ?? "", 50)}`),
  ]);
}

export function formatRegistryShow(deployment: DeploymentStatus, eventCount: number): string {
  const lines = [`Deployment: ${deployment.deploy_id}`, `  Team:     ${deployment.team}`, `  Status:   ${deployment.status}`, `  Started:  ${shortTs(deployment.started_at)}`];
  if (deployment.completed_at) lines.push(`  Ended:    ${shortTs(deployment.completed_at)}`);
  if (deployment.runtime) lines.push(`  Runtime:  ${deployment.runtime}`);
  if (deployment.provider) lines.push(`  Provider: ${deployment.provider}`);
  if (deployment.models?.["team"]) lines.push(`  Model:    ${deployment.models["team"]}`);
  if (deployment.models?.["agents"]) lines.push(`  Agents Model: ${deployment.models["agents"]}`);
  if (deployment.agents.length > 0) lines.push(`  Agents:   ${deployment.agents.join(",")}`);
  if (deployment.effective_timeout_seconds !== undefined) lines.push(`  Timeout:  ${deployment.effective_timeout_seconds}s`);
  if (deployment.pid !== undefined) lines.push(`  PID:      ${deployment.pid}`);
  if (deployment.summary) lines.push(`  Summary:  ${deployment.summary}`);
  lines.push(`  Events:   ${eventCount}`);
  return renderLines(lines);
}

export function formatTeamList(rows: TeamStatusRow[]): string {
  return renderLines([`${"TEAM".padEnd(18)} ${"MODEL".padEnd(8)} ${["IDEA", "REQU", "PEND", "PEND", "IMPL", "REVI", "DONE", "REJE", "CANC"].map((status) => status.padEnd(5)).join("")} DEPLOY`, ...rows.map((row) => `${row.name.padEnd(18)} ${row.model.padEnd(8)} ${row.counts.join("")} ${row.deployment}`)]);
}

export function formatTeamDetail(name: string, board: { total: number; columns: Array<{ status: string; count: number; tickets: Ticket[] }> }, runningDeployments: string[]): string {
  const lines = [`${name} (${board.total} tickets)`];
  for (const column of board.columns) {
    if (column.count === 0) continue;
    lines.push(`\n${column.status} (${column.count})`);
    for (const ticket of column.tickets) lines.push(`  ${ticket.id.padEnd(8)} [${ticket.priority}] ${ticket.title}`);
  }
  lines.push(runningDeployments.length > 0 ? `\ndeployments: ${runningDeployments.join(", ")}` : "\ndeployments: none running");
  return renderLines(lines);
}

export function formatBoard(board: BoardView, options: BoardFormatOptions = {}): string {
  const lines: string[] = [`Board: ${board.project} (${board.total} tickets)`];
  const allTickets = board.columns.flatMap((column) => column.tickets);
  const idWidth = Math.max(8, ...allTickets.map((ticket) => ticket.id.length));
  const priorityWidth = Math.max(10, ...allTickets.map((ticket) => `[${ticket.priority}]`.length));
  const assigneeWidth = Math.max(10, ...allTickets.map((ticket) => (ticket.assignee || "unassigned").length));
  const prefix = "  ";
  const colorEnabled = options.colorEnabled ?? false;

  for (const column of board.columns) {
    lines.push(`\n${withAnsi(colorEnabled, ANSI_COLORS.statusHeader, `${column.status} (${column.count})`)}`);
    if (column.tickets.length === 0) {
      lines.push(`${prefix}(empty)`);
      continue;
    }

    for (const ticket of column.tickets) {
      const assignee = ticket.assignee || "unassigned";
      const statusLabel = ticket.hasRunningDeployment ? " [deploying]" : "";
      const priority = `[${ticket.priority}]`;
      const statusMarker = withAnsi(colorEnabled, ANSI_COLORS.deploying, statusLabel);
      lines.push(
        `${prefix}${ticket.id.padEnd(idWidth)} ${withAnsi(colorEnabled, priorityColor(ticket.priority), priority.padEnd(priorityWidth))} ${assignee.padEnd(assigneeWidth)} ${ticket.title}${statusMarker}`,
      );
    }
  }
  return renderLines(lines);
}

export function formatReposList(repos: Array<{ name: string } & RepoEntry>): string {
  if (repos.length === 0) return "No repos configured.";
  const nameW = Math.max(4, ...repos.map((repo) => repo.name.length));
  const pathW = Math.max(4, ...repos.map((repo) => repo.path.length));
  const pad = (value: string, width: number) => value.padEnd(width);
  return renderLines([`  ${pad("NAME", nameW)}  ${pad("PATH", pathW)}  DESCRIPTION`, `  ${"-".repeat(nameW)}  ${"-".repeat(pathW)}  -----------`, ...repos.map((repo) => `  ${pad(repo.name, nameW)}  ${pad(repo.path, pathW)}  ${repo.description ?? ""}`)]);
}

export function formatTimers(timers: TimerRow[]): string {
  return renderLines([...timers.map((timer) => `${timer.unit.padEnd(28)} ${timer.team.padEnd(20)} ${timer.next_in}`), `Count: ${timers.length}`]);
}

export function formatTeamsJson(teams: TeamConfigSummary[], statuses: Array<{ name: string; model: string; runningDeployments: string[] }>, rows: TeamStatusRow[]): unknown[] {
  return teams.map((team) => ({ ...team, runtime: statuses.find((status) => status.name === team.name), board: rows.find((row) => row.name === team.name) }));
}

function shortTs(timestamp: string): string {
  try {
    return formatLocalShort(timestamp);
  } catch {
    return timestamp.replace("T", " ").slice(0, 19);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
