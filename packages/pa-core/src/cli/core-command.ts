import { basename } from "node:path";
import type { CoreExecutionHooks } from "../deploy/index.js";
import { runCodeCtxCommand } from "./commands/codectx.js";
import { runRegistryCommand } from "./commands/registry.js";
import { runBoardCommand } from "./commands/board.js";
import { runTeamsCommand } from "./commands/teams.js";
import { runReposCommand } from "./commands/repos.js";
import { runDeployCommand, STATUS_WAIT_OVERRIDE_ENV } from "./commands/deploy.js";
import { runTicketCommand } from "./commands/ticket.js";
import { runBulletinCommand } from "./commands/bulletin.js";
import { runHealthCommand } from "./commands/health.js";
import { runTrashCommand } from "./commands/trash.js";
import { runTimersCommand } from "./commands/timers.js";
import { runSignalCommand } from "./commands/signal.js";
import { runScheduleCommand, runRemoveTimerCommand } from "./commands/schedule.js";
import { runServeCommand } from "./commands/serve.js";
import { runStatusCommand } from "./commands/status.js";
import type { CliIo } from "./utils.js";
import { normalizeIo } from "./utils.js";

export type { CliIo } from "./utils.js";

export { STATUS_WAIT_OVERRIDE_ENV };

export interface RunCoreCommandOptions {
  hooks?: CoreExecutionHooks;
  io?: CliIo;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  binaryName?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function runCoreCommand(argv: string[], opts: RunCoreCommandOptions = {}): Promise<number> {
  const io = normalizeIo(opts.io);
  const [command, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      printHelp(io, opts.binaryName ?? defaultBinaryName());
      return 0;
    }
    if (command === "repos") return runReposCommand(rest, io);
    if (command === "status") return runStatusCommand(rest, io, opts.now ?? new Date(), { sleep: opts.sleep ?? defaultSleep, clock: opts.clock ?? Date.now });
    if (command === "deploy") return runDeployCommand(rest, io, opts.hooks ?? {});
    if (command === "serve" || command === "stop" || command === "restart" || command === "serve-status") return runServeCommand(command, rest, io, opts.hooks ?? {});
    if (command === "schedule") return runScheduleCommand(rest, io);
    if (command === "remove-timer") return runRemoveTimerCommand(rest, io);
    if (command === "board") return runBoardCommand(rest, io);
    if (command === "teams") return runTeamsCommand(rest, io);
    if (command === "registry") return runRegistryCommand(rest, io);
    if (command === "ticket") return runTicketCommand(rest, io);
    if (command === "bulletin") return runBulletinCommand(rest, io);
    if (command === "health") return runHealthCommand(rest, io);
    if (command === "trash") return runTrashCommand(rest, io);
    if (command === "codectx") return runCodeCtxCommand(rest, io);
    if (command === "timers") return runTimersCommand(rest, io);
    if (command === "signal") return runSignalCommand(rest, io);
    io.stderr(`Unknown command: ${command}`);
    printHelp(io, opts.binaryName ?? defaultBinaryName());
    return 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printHelp(io: Required<CliIo>, binaryName: string): void {
  io.stdout(`Usage: ${binaryName} <command> [options]`);
  io.stdout("Commands: repos list, status, deploy, serve, stop, restart, serve-status, schedule, remove-timer, board, teams, registry, ticket, bulletin, health, trash, codectx, timers, signal");
  io.stdout(`Status wait: ${binaryName} status <deploy-id> --wait polls until terminal status; override wait seconds with ${STATUS_WAIT_OVERRIDE_ENV}.`);
}

function defaultBinaryName(): string {
  return basename(process.argv[1] ?? "") || "pa-core";
}
