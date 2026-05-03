import { listSystemdTimers } from "../../timers.js";
import { formatTimers } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { consumeJsonFlag, printError } from "../utils.js";

export function runTimersCommand(argv: string[], io: Required<CliIo>): number {
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
