import { listSystemdTimers } from "../../timers.js";
import { formatTimers } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { consumeJsonFlag, printError } from "../utils.js";

export function printTimersHelp(io: Required<CliIo>): void {
  io.stdout("Usage: timers [options]");
  io.stdout("");
  io.stdout("List active systemd timers for scheduled deployments.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --json              Output as JSON");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  timers");
  io.stdout("  timers --json");
}

export function runTimersCommand(argv: string[], io: Required<CliIo>): number {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printTimersHelp(io);
    return 0;
  }
  const json = consumeJsonFlag(argv);
  if ("error" in json) return printError(json.error, io);
  try {
    io.stderr("Reading systemd timers...");
    const { timers } = listSystemdTimers();
    io.stdout(json.json ? JSON.stringify(timers, null, 2) : formatTimers(timers));
    return 0;
  } catch (error) {
    io.stderr(`Failed to list timers: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
