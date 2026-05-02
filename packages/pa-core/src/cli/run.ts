import { spawn } from "node:child_process";
import type { RuntimeAdapter } from "../runtime-api/types.js";
import type { RuntimeName } from "../types.js";

export interface RunCliOptions {
  adapter: RuntimeAdapter;
  binaryName: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the PA CLI with a given runtime adapter.
 * Uses the adapter's spawn method internally but provides a simpler
 * CLI-focused interface with binary name resolution.
 */
export async function runCli(options: RunCliOptions): Promise<RunCliResult> {
  const { adapter, binaryName, args = [], env = {}, cwd = process.cwd() } = options;
  const binaryPath = resolveBinary(binaryName);

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      env: { ...process.env, ...env, PA_RUNTIME: adapter.name },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    if (options.timeoutMs) {
      setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`runCli timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

function resolveBinary(binaryName: string): string {
  // Return binaryName to let it be found via PATH
  // Binary resolution can be enhanced with explicit paths later
  return binaryName;
}

export function createMockRuntimeAdapter(name: RuntimeName = "opencode"): RuntimeAdapter {
  const defaults: Record<RuntimeName, { defaultModel: string; sessionFileName: string }> = {
    opencode: { defaultModel: "sonnet", sessionFileName: "session-id-opencode.txt" },
    claude: { defaultModel: "claude-opus-4-7", sessionFileName: "session-id-claude.txt" },
  };
  const { defaultModel, sessionFileName } = defaults[name];
  return {
    name,
    defaultModel,
    sessionFileName,
    spawn: async (opts) => ({
      sessionId: opts.deployId,
      exitCode: 0,
      logFile: opts.logFile,
    }),
    resume: async (opts) => ({
      sessionId: opts.sessionId,
      exitCode: 0,
      logFile: opts.logFile,
    }),
    extractActivity: () => [],
    installHooks: async () => {},
    describeTools: () => ({ runtime: name, markdown: `Mock ${name} runtime` }),
  };
}
