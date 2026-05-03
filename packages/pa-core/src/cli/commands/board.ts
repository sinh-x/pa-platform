import { listRepos, resolveProject, resolveProjectFromCwd } from "../../repos.js";
import { BOARD_COLUMNS, buildBoardView } from "../../tickets/index.js";
import { formatBoard } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

export function shouldUseBoardColors(): boolean {
  if (process.env["NO_COLOR"]) return false;
  return process.stdout.isTTY === true;
}

function parseBoardArgs(argv: string[]): { project?: string; assignee?: string; all?: boolean } | { error: string } {
  const opts: { project?: string; assignee?: string; all?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--project") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--project requires a value" };
      opts.project = value;
      i += 1;
    } else if (arg === "--assignee") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--assignee requires a value" };
      opts.assignee = value;
      i += 1;
    } else if (arg === "--all") {
      opts.all = true;
    } else return { error: `Unsupported board option: ${arg}` };
  }
  return opts;
}

function availableProjectGuidance(): string {
  const available = listRepos().filter((repo) => repo.prefix).map((repo) => repo.name).join(", ");
  return available ? ` Available projects: ${available}` : "";
}

function resolveBoardProject(opts: { project?: string; all?: boolean }): { project?: string } | { error: string } {
  if (opts.all) return { project: undefined };
  if (opts.project) return { project: resolveProject(opts.project).key };
  const cwdProject = resolveProjectFromCwd();
  if (cwdProject) return { project: cwdProject.key };
  return { error: `Not in a registered repo. Use --all or --project name.${availableProjectGuidance()}` };
}

export function runBoardCommand(argv: string[], io: Required<CliIo>): number {
  const opts = parseBoardArgs(argv);
  if ("error" in opts) {
    io.stderr(opts.error);
    return 1;
  }
  const resolved = resolveBoardProject(opts);
  if ("error" in resolved) return printError(resolved.error, io);
  const board = buildBoardView(resolved.project, { assignee: opts.assignee, excludeTags: ["backlog", "archived"], excludeTypes: ["fyi", "work-report"] });
  io.stdout(formatBoard(board, { colorEnabled: shouldUseBoardColors() }));
  return 0;
}
