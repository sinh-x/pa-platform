import { getTeamRuntimeStatus, listTeamConfigs } from "../../teams/index.js";
import { BOARD_COLUMNS, getTeamBoard, getTeamStatusSummaries } from "../../tickets/index.js";
import { formatTeamDetail, formatTeamList, formatTeamsJson } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

function parseTeamsArgs(argv: string[]): { name?: string; all?: boolean; json?: boolean } | { error: string } {
  const opts: { name?: string; all?: boolean; json?: boolean } = {};
  for (const arg of argv) {
    if (arg === "--all") opts.all = true;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("-")) return { error: `Unsupported teams option: ${arg}` };
    else if (!opts.name) opts.name = arg;
    else return { error: `Unexpected teams argument: ${arg}` };
  }
  return opts;
}

export function runTeamsCommand(argv: string[], io: Required<CliIo>): number {
  const opts = parseTeamsArgs(argv);
  if ("error" in opts) {
    io.stderr(opts.error);
    return 1;
  }
  if (opts.name) {
    const board = getTeamBoard(opts.name, { excludeTags: opts.all ? undefined : ["backlog", "archived"] });
    const running = getTeamRuntimeStatus(opts.name).runningDeployments;
    io.stdout(opts.json ? JSON.stringify({ name: opts.name, board, runningDeployments: running }, null, 2) : formatTeamDetail(opts.name, board, running));
    return 0;
  }

  const summaries = new Map(getTeamStatusSummaries(undefined, opts.all ? {} : { excludeTags: ["backlog", "archived"] }).map((summary) => [summary.assignee, summary]));
  const teams = listTeamConfigs();
  const statuses = [];
  const rows = [];
  for (const team of teams) {
    const status = getTeamRuntimeStatus(team.name);
    statuses.push({ name: team.name, model: status.model, runningDeployments: status.runningDeployments });
    const summary = summaries.get(team.name);
    rows.push({ name: team.name, model: status.model, counts: BOARD_COLUMNS.map((column) => String(summary?.counts[column] ?? 0).padEnd(5)), deployment: status.runningDeployments[0] ?? "-" });
  }
  io.stdout(opts.json ? JSON.stringify(formatTeamsJson(teams, statuses, rows), null, 2) : formatTeamList(rows));
  return 0;
}
