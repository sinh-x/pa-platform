import type { CoreExecutionHooks } from "../../deploy/index.js";
import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT, runServeLifecycle } from "../../serve-lifecycle.js";
import type { ServeAction } from "../../serve-lifecycle.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

interface ParsedServeArgs {
  port: number;
  host: string;
  background: boolean;
  cors: boolean;
  force: boolean;
}

function parseServeArgs(argv: string[], action: ServeAction): ParsedServeArgs | { error: string } {
  const opts: ParsedServeArgs = { port: DEFAULT_SERVE_PORT, host: DEFAULT_SERVE_HOST, background: false, cors: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--port") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--port requires a value" };
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: "--port must be an integer from 1 to 65535" };
      opts.port = port;
      i += 1;
    } else if (arg === "--host") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--host requires a value" };
      opts.host = value;
      i += 1;
    } else if (arg === "--background") opts.background = true;
    else if (arg === "--cors") opts.cors = true;
    else if (arg === "--force") opts.force = true;
    else return { error: `Unsupported serve option: ${arg}` };
  }
  if ((action === "stop" || action === "status") && (opts.background || opts.force || opts.cors)) return { error: `${action} only supports --host and --port options` };
  return opts;
}

export async function runServeCommand(command: string, argv: string[], io: Required<CliIo>, hooks: CoreExecutionHooks): Promise<number> {
  const nested = command === "serve" && ["stop", "restart", "status"].includes(argv[0] ?? "") ? argv[0] : undefined;
  const action = (nested ?? (command === "serve" ? "start" : command === "serve-status" ? "status" : command)) as ServeAction;
  const args = nested ? argv.slice(1) : argv;
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(serveUsageText(action));
    return 0;
  }
  const parsed = parseServeArgs(args, action);
  if ("error" in parsed) return printError(parsed.error, io);
  return runServeLifecycle({ ...parsed, action, io, hooks, env: process.env });
}

function serveUsageText(action: ServeAction): string {
  if (action === "start") return "Usage: serve [--port <port>] [--host <host>] [--background] [--cors] [--force]";
  if (action === "restart") return "Usage: restart [--port <port>] [--host <host>] [--background] [--cors]";
  return `Usage: ${action}`;
}
