import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createActivityEvent, emitCompletedEvent, emitCrashedEvent, getDeployPaths, writeActivityEvents } from "@pa-platform/pa-core";

interface BackgroundConfig {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logFile: string;
  deploymentId: string;
  team: string;
  sessionFileName: string;
}

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing background config path");
const config = JSON.parse(readFileSync(configPath, "utf-8")) as BackgroundConfig;

try {
  const result = await runOpencode(config);

  const sessionId = result.sessionId ?? config.deploymentId;
  writeFileSync(resolve(dirname(config.logFile), config.sessionFileName), sessionId, "utf-8");
  writeActivityEvents([createActivityEvent({ deployId: config.deploymentId, kind: result.exitCode === 0 ? "text" : "error", source: "opencode", body: result.exitCode === 0 ? "opa background deploy completed" : `opa background deploy failed with exit code ${result.exitCode}` })], getDeployPaths(config.deploymentId).activityLogPath);
  emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: result.exitCode === 0 ? "success" : "failed", summary: result.exitCode === 0 ? "opa background deploy completed" : `opa background deploy failed with exit code ${result.exitCode}`, logFile: config.logFile, exitCode: result.exitCode });
} catch (error) {
  emitCrashedEvent({ deploymentId: config.deploymentId, team: config.team, error: error instanceof Error ? error.message : String(error), exitCode: 1 });
  throw error;
}

function runOpencode(config: BackgroundConfig): Promise<{ exitCode: number; sessionId?: string }> {
  mkdirSync(dirname(config.logFile), { recursive: true });
  const log = createWriteStream(config.logFile, { flags: "a" });
  const jsonl = createWriteStream(resolve(dirname(config.logFile), "opencode-output.jsonl"), { flags: "a" });
  const child = spawn("opencode", config.args, { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ["ignore", "pipe", "pipe"] });
  let sessionId: string | undefined;

  const collect = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    sessionId ??= parseSessionId(text);
    log.write(text);
    jsonl.write(text);
  };

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  return new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      log.end();
      jsonl.end();
      resolvePromise({ exitCode: code ?? 1, sessionId });
    });
  });
}

function parseSessionId(output: string): string | undefined {
  for (const line of output.split("\n").filter(Boolean)) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const session = raw["sessionID"] ?? raw["sessionId"] ?? raw["session_id"] ?? raw["id"];
      if (typeof session === "string" && session.length > 0) return session;
    } catch {
      const match = line.match(/session(?:ID|Id|_id)?["':=\s]+([a-zA-Z0-9_-]+)/);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}
