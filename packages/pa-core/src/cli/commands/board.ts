import { listRepos, resolveProject, resolveProjectFromCwd } from "../../repos.js";
import { queryReadonlyDeploymentStatuses } from "../../registry/index.js";
import { ReadOnlyHelperFailure, resolveReadOnlyHelperContext, withReadOnlyHelperContext, type ReadOnlyHelperAuthentication, type ReadOnlyHelperCapability } from "../../readonly-helper-context.js";
import { buildBoardView } from "../../tickets/index.js";
import { formatBoard } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

export function printBoardHelp(io: Required<CliIo>): void {
  io.stdout("Usage: board [options]");
  io.stdout("");
  io.stdout("Display the project board with ticket columns.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --project <name>    Show board for a specific project");
  io.stdout("  --assignee <name>   Filter tickets by assignee");
  io.stdout("  --all               Show all tickets across all projects, including backlog and archived");
  io.stdout("  --include-archived  Show archived tickets alongside non-archived tickets (keeps current project scope)");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  board");
  io.stdout("  board --project pa-platform");
  io.stdout("  board --assignee sinh");
  io.stdout("  board --all");
  io.stdout("  board --include-archived");
}

export function shouldUseBoardColors(): boolean {
  if (process.env["NO_COLOR"]) return false;
  return process.stdout.isTTY === true;
}

function parseBoardArgs(argv: string[]): { project?: string; assignee?: string; all?: boolean; includeArchived?: boolean } | { error: string } {
  const opts: { project?: string; assignee?: string; all?: boolean; includeArchived?: boolean } = {};
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
    } else if (arg === "--include-archived") {
      opts.includeArchived = true;
    } else return { error: `Unsupported board option: ${arg}` };
  }
  return opts;
}

function availableProjectGuidance(): string {
  const available = listRepos().filter((repo) => repo.prefix).map((repo) => repo.name).join(", ");
  return available ? ` Available projects: ${available}` : "";
}

function resolveBoardProject(opts: { project?: string; all?: boolean }, capability?: ReadOnlyHelperCapability): { project?: string; authentication?: ReadOnlyHelperAuthentication } | { error: string } {
  if (opts.all) return { project: undefined };
  if (opts.project) return { project: resolveProject(opts.project).key };
  if (capability) {
    const authentication = resolveReadOnlyHelperContext(undefined, process.cwd(), capability);
    if (authentication.context.repo.prefix) return { project: authentication.context.repoKey, authentication };
    return { error: `Not in a registered repo. Use --all or --project name.${availableProjectGuidance()}` };
  }
  const cwdProject = resolveProjectFromCwd();
  if (cwdProject) return { project: cwdProject.key };
  return { error: `Not in a registered repo. Use --all or --project name.${availableProjectGuidance()}` };
}

function buildBoardExcludeTags(opts: { all?: boolean; includeArchived?: boolean }): string[] {
  if (opts.all) return [];
  if (opts.includeArchived) return ["backlog"];
  return ["backlog", "archived"];
}

export function runBoardCommand(argv: string[], io: Required<CliIo>, capability?: ReadOnlyHelperCapability): number {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printBoardHelp(io);
    return 0;
  }
  const opts = parseBoardArgs(argv);
  if ("error" in opts) {
    io.stderr(opts.error);
    return 1;
  }
  const resolved = resolveBoardProject(opts, capability);
  if ("error" in resolved) return printError(resolved.error, io);
  const excludeTags = buildBoardExcludeTags(opts);
  const display = () => {
    const readDeployments = resolved.authentication?.context.worktreeKind === "linked" ? () => {
      try { return queryReadonlyDeploymentStatuses(); }
      catch { throw new ReadOnlyHelperFailure("authority-rejected", "unknown", "board existing registry observation", "authenticated registry is unavailable or changed; no initialization or migration performed"); }
    } : undefined;
    const board = buildBoardView(resolved.project, { assignee: opts.assignee, excludeTags, excludeTypes: ["fyi", "work-report"] }, readDeployments);
    io.stdout(formatBoard(board, { colorEnabled: shouldUseBoardColors() }));
    return 0;
  };
  return resolved.authentication ? withReadOnlyHelperContext(resolved.authentication, display) : display();
}
