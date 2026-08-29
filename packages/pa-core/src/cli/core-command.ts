import { basename } from "node:path";
import type { CoreExecutionHooks } from "../deploy/index.js";
import { runBranchCommand } from "./commands/branch.js";
import { runCodeCtxCommand } from "./commands/codectx.js";
import { runRegistryCommand } from "./commands/registry.js";
import { runBoardCommand } from "./commands/board.js";
import { runTeamsCommand } from "./commands/teams.js";
import { runReposCommand } from "./commands/repos.js";
import { runDeployCommand, STATUS_WAIT_OVERRIDE_ENV } from "./commands/deploy.js";
import { runEvaluateCommand } from "./commands/evaluate.js";
import { runTicketCommand } from "./commands/ticket.js";
import { runBulletinCommand } from "./commands/bulletin.js";
import { runHealthCommand } from "./commands/health.js";
import { runTrashCommand } from "./commands/trash.js";
import { runTimersCommand } from "./commands/timers.js";
import { runSignalCommand } from "./commands/signal.js";
import { runScheduleCommand, runRemoveTimerCommand } from "./commands/schedule.js";
import { runServeCommand } from "./commands/serve.js";
import { runStatusCommand, compactActivityTail, isProcessGroupAlive, sendProcessGroupSignal } from "./commands/status.js";
import { runSemanticCommand } from "./commands/semantic.js";
import type { CliIo } from "./utils.js";
import { isProcessAlive, normalizeIo } from "./utils.js";

export type { CliIo } from "./utils.js";

export { STATUS_WAIT_OVERRIDE_ENV };

export { compactActivityTail };

export interface RunCoreCommandOptions {
  hooks?: CoreExecutionHooks;
  io?: CliIo;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  processAlive?: (pid: number) => boolean;
  processGroupAlive?: (pid: number) => boolean;
  sendProcessSignal?: (pid: number, signal: NodeJS.Signals) => void;
  beforePiSupervisorLivenessCheck?: (evidence: { supervisorPid: number }) => void | Promise<void>;
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
    if (command === "status") return runStatusCommand(rest, io, opts.now ?? new Date(), {
      sleep: opts.sleep ?? defaultSleep,
      clock: opts.clock ?? Date.now,
      processAlive: opts.processAlive ?? isProcessAlive,
      processGroupAlive: opts.processGroupAlive ?? opts.processAlive ?? isProcessGroupAlive,
      sendProcessSignal: opts.sendProcessSignal ?? sendProcessGroupSignal,
      ...(opts.beforePiSupervisorLivenessCheck ? { beforePiSupervisorLivenessCheck: opts.beforePiSupervisorLivenessCheck } : {}),
    });
    if (command === "deploy") return runDeployCommand(rest, io, opts.hooks ?? {}, opts.binaryName ?? defaultBinaryName());
    if (command === "evaluate") return runEvaluateCommand(rest, io, opts.hooks ?? {});
    if (command === "serve" || command === "stop" || command === "restart" || command === "serve-status") return runServeCommand(command, rest, io, opts.hooks ?? {});
    if (command === "schedule") return runScheduleCommand(rest, io);
    if (command === "remove-timer") return runRemoveTimerCommand(rest, io);
    if (command === "board") return runBoardCommand(rest, io);
    if (command === "branch") return runBranchCommand(rest, io);
    if (command === "teams") return runTeamsCommand(rest, io);
    if (command === "registry") return runRegistryCommand(rest, io);
    if (command === "ticket") return runTicketCommand(rest, io);
    if (command === "bulletin") return runBulletinCommand(rest, io);
    if (command === "health") return runHealthCommand(rest, io);
    if (command === "trash") return runTrashCommand(rest, io);
    if (command === "codectx") return runCodeCtxCommand(rest, io);
    if (command === "timers") return runTimersCommand(rest, io);
    if (command === "signal") return runSignalCommand(rest, io);
    if (command === "semantic") return runSemanticCommand(rest, io);
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
  io.stdout("");
  io.stdout("Commands:");
  io.stdout("  status              Show deployment status and activity");
  io.stdout("  deploy              Deploy a team configuration");
  io.stdout("  evaluate            Evaluate a deployment");
  io.stdout("  serve               Start the Agent API server");
  io.stdout("  stop                Stop the Agent API server");
  io.stdout("  restart             Restart the Agent API server");
  io.stdout("  serve-status        Show server status");
  io.stdout("  schedule            Schedule a recurring deployment timer");
  io.stdout("  remove-timer        Remove a scheduled timer");
  io.stdout("  board               Display the project board");
  io.stdout("  branch              Manage feature branches");
  io.stdout("  teams               List teams or show team details");
  io.stdout("  registry            Manage the deployment registry");
  io.stdout("  ticket              Manage tickets");
  io.stdout("  bulletin            Manage bulletins");
  io.stdout("  health              Show system health report");
  io.stdout("  trash               Manage trash");
  io.stdout("  codectx             Manage code context");
  io.stdout("  timers              List active systemd timers");
  io.stdout("  signal              Manage signals");
  io.stdout("  semantic            Semantic briefing");
  io.stdout("  repos               List registered repositories");
  io.stdout("");
  io.stdout("Run '<command> --help' for detailed usage of a specific command.");
}

function defaultBinaryName(): string {
  return basename(process.argv[1] ?? "") || "pa-core";
}
