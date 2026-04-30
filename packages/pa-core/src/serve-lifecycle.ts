import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { CoreExecutionHooks } from "./deploy/index.js";
import { createAgentApiApp } from "./agent-api/index.js";
import { getDataDir, getLogsDir } from "./paths.js";

export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 9848;
export const PA_CORE_SERVE_FORKED_ENV = "_PA_CORE_SERVE_FORKED";

export type ServeAction = "start" | "stop" | "restart" | "status";

export interface ServeLifecycleIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface ServeLifecycleOptions {
  action: ServeAction;
  port: number;
  host: string;
  background: boolean;
  cors: boolean;
  force: boolean;
  io: ServeLifecycleIo;
  hooks?: CoreExecutionHooks;
  executable?: string;
  script?: string;
  env?: NodeJS.ProcessEnv;
}

interface PidInfo {
  pid: number;
  port: number;
}

export function getServePidFilePath(): string {
  return resolve(getDataDir(), "pa-core-serve.pid");
}

export function getServeLogFilePath(): string {
  return resolve(getLogsDir(), "pa-core-serve.log");
}

export async function runServeLifecycle(opts: ServeLifecycleOptions): Promise<number> {
  if (opts.action === "stop") return serveStopCommand(opts.io);
  if (opts.action === "status") return serveStatusCommand(opts.io);
  if (opts.action === "restart") return serveRestartCommand(opts);
  return serveStartCommand(opts);
}

export function readServePidFile(): PidInfo | null {
  const pidFile = getServePidFilePath();
  if (!existsSync(pidFile)) return null;
  const content = readFileSync(pidFile, "utf8").trim();
  const [pidText, portText] = content.includes(":") ? content.split(":") : [content, String(DEFAULT_SERVE_PORT)];
  const pid = Number.parseInt(pidText ?? "", 10);
  const port = Number.parseInt(portText ?? "", 10);
  if (Number.isNaN(pid) || Number.isNaN(port)) return null;
  return { pid, port };
}

function writeServePidFile(pid: number, port: number): void {
  const pidFile = getServePidFilePath();
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${pid}:${port}`, "utf8");
}

function removeServePidFile(): void {
  try {
    unlinkSync(getServePidFilePath());
  } catch {
    // Already gone.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function serveStartCommand(opts: ServeLifecycleOptions): Promise<number> {
  if (opts.background && opts.env?.[PA_CORE_SERVE_FORKED_ENV] !== "1") return startBackgroundProcess(opts);

  const existingPidInfo = readServePidFile();
  if (existingPidInfo !== null) {
    if (isProcessAlive(existingPidInfo.pid)) {
      if (!opts.force) {
        opts.io.stderr(`Port ${existingPidInfo.port} already in use (PID ${existingPidInfo.pid}). Use \`pa-core serve stop\` or \`pa-core serve --force\`.`);
        return 1;
      }
      opts.io.stdout(`[pa-core serve] Killing existing instance (PID ${existingPidInfo.pid})...`);
      await killProcess(existingPidInfo.pid);
      removeServePidFile();
      opts.io.stdout("[pa-core serve] Existing instance stopped.");
    } else {
      opts.io.stdout(`[pa-core serve] Stale PID file found (PID ${existingPidInfo.pid} is dead). Cleaning up.`);
      removeServePidFile();
    }
  } else {
    const portBusy = await isPortInUse(opts.port, opts.host);
    if (portBusy) {
      const suffix = opts.force ? "Cannot --force without PID file. " : "";
      opts.io.stderr(`Port ${opts.port} in use by unknown process (no PID file). ${suffix}Check with: ss -tlnp | grep ${opts.port}`.trim());
      return 1;
    }
  }

  writeServePidFile(process.pid, opts.port);
  if (opts.background) opts.io.stdout(`[pa-core serve] Background mode - PID ${process.pid} written to ${getServePidFilePath()}`);

  const cleanupPid = () => removeServePidFile();
  process.once("SIGTERM", () => {
    cleanupPid();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    cleanupPid();
    process.exit(0);
  });
  process.once("exit", cleanupPid);

  const { app } = createAgentApiApp({ enableCors: opts.cors, hooks: opts.hooks });
  opts.io.stdout(`[pa-core serve] Starting agent API on http://${opts.host}:${opts.port}`);
  serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
    opts.io.stdout(`[pa-core serve] Listening on http://${info.address}:${info.port}`);
  });
  return 0;
}

async function startBackgroundProcess(opts: ServeLifecycleOptions): Promise<number> {
  const script = opts.script ?? process.argv[1];
  if (!script) {
    opts.io.stderr("Cannot start pa-core serve in background: executable script path is unavailable.");
    return 1;
  }
  const logFile = getServeLogFilePath();
  mkdirSync(dirname(logFile), { recursive: true });
  const out = openSync(logFile, "a");
  const args = ["serve", "--port", String(opts.port), "--host", opts.host, "--background"];
  if (opts.cors) args.push("--cors");
  if (opts.force) args.push("--force");
  const child = spawn(opts.executable ?? process.execPath, [script, ...args], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...opts.env, [PA_CORE_SERVE_FORKED_ENV]: "1" },
  });
  child.unref();
  opts.io.stdout(`[pa-core serve] Started in background (PID ${child.pid ?? "unknown"}). Log: ${logFile}`);
  return 0;
}

async function serveStopCommand(io: ServeLifecycleIo): Promise<number> {
  const pidInfo = readServePidFile();
  if (pidInfo === null) {
    io.stdout("No PID file found. Server may not be running.");
    return 0;
  }
  if (!isProcessAlive(pidInfo.pid)) {
    io.stdout(`PID ${pidInfo.pid} is not running. Cleaning up stale PID file.`);
    removeServePidFile();
    return 0;
  }
  io.stdout(`Stopping pa-core serve (PID ${pidInfo.pid})...`);
  await killProcess(pidInfo.pid);
  removeServePidFile();
  io.stdout("Server stopped.");
  return 0;
}

function serveStatusCommand(io: ServeLifecycleIo): number {
  const pidInfo = readServePidFile();
  if (pidInfo === null) {
    io.stdout("Status: stopped (no PID file)");
    return 0;
  }
  if (isProcessAlive(pidInfo.pid)) {
    io.stdout("Status: running");
    io.stdout(`PID:    ${pidInfo.pid}`);
    io.stdout(`Port:   ${pidInfo.port}`);
    return 0;
  }
  io.stdout(`Status: stopped (stale PID ${pidInfo.pid})`);
  removeServePidFile();
  return 0;
}

async function serveRestartCommand(opts: ServeLifecycleOptions): Promise<number> {
  await serveStopCommand(opts.io);
  const portFree = await waitForPortFree(opts.port, opts.host);
  if (!portFree) {
    opts.io.stderr(`Port ${opts.port} still in use after stop. Check with: ss -tlnp | grep ${opts.port}`);
    return 1;
  }
  return serveStartCommand({ ...opts, action: "start", force: false });
}

function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolvePort(error.code === "EADDRINUSE"));
    server.once("listening", () => server.close(() => resolvePort(false)));
    server.listen(port, host);
  });
}

function waitForPortFree(port: number, host: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolveWait) => {
    const start = Date.now();
    const check = async () => {
      if (!(await isPortInUse(port, host))) {
        resolveWait(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolveWait(false);
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

function killProcess(pid: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolveKill) => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      resolveKill(true);
      return;
    }
    const start = Date.now();
    const check = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(check);
        resolveKill(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already stopped.
        }
        resolveKill(true);
      }
    }, 100);
  });
}
