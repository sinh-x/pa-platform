import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, getDeployPaths } from "@pa-platform/pa-core";
import { createOpencodeActivityWriter } from "./adapter.js";

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

const STDERR_TAIL_BYTES = 2000;

try {
  const result = await runOpencode(config);

  const sessionId = result.sessionId ?? config.deploymentId;
  writeFileSync(resolve(dirname(config.logFile), config.sessionFileName), sessionId, "utf-8");
  const activityLogPath = getDeployPaths(config.deploymentId).activityLogPath;
  if (result.exitCode === 0) {
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "opencode", body: "opa background deploy completed" }), activityLogPath);
    emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "success", summary: "opa background deploy completed", logFile: config.logFile, exitCode: 0 });
  } else {
    const errorBody = result.stderrTail || (result.spawnError ? result.spawnError.message : `opencode exited with code ${result.exitCode}`);
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "error", source: "opencode", body: errorBody }), activityLogPath);
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "opencode", body: `opa background deploy failed with exit code ${result.exitCode}` }), activityLogPath);
    const summaryError = firstLine(result.spawnError?.message ?? result.stderrTail);
    const summary = summaryError
      ? `opa background deploy failed (exit ${result.exitCode}): ${summaryError}`
      : `opa background deploy failed (exit ${result.exitCode})`;
    emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "failed", summary, logFile: config.logFile, exitCode: result.exitCode });
  }
} catch (error) {
  emitCrashedEvent({ deploymentId: config.deploymentId, team: config.team, error: error instanceof Error ? error.message : String(error), exitCode: 1 });
  throw error;
}

interface BackgroundRunResult {
  exitCode: number;
  sessionId?: string;
  stderrTail: string;
  spawnError?: Error;
}

function runOpencode(config: BackgroundConfig): Promise<BackgroundRunResult> {
  mkdirSync(dirname(config.logFile), { recursive: true });
  const log = createWriteStream(config.logFile, { flags: "a" });
  const jsonl = createWriteStream(resolve(dirname(config.logFile), "opencode-output.jsonl"), { flags: "a" });
  // Both this writer and the opencode plugin (~/.config/opencode/plugins/pa-safety-activity.js)
  // append to activity.jsonl concurrently. Intentional per requirements §6 — appendFileSync({flag:"a"})
  // line-flushed writes are atomic for sub-PIPE_BUF (4096-byte) lines; STDERR_TAIL_BYTES = 2000 guarantees that.
  // Out-of-order timestamps are acceptable per §9 R2 — consumers sort by timestamp.
  const activity = createOpencodeActivityWriter(config.deploymentId, getDeployPaths(config.deploymentId).activityLogPath);
  const child = spawn("opencode", config.args, { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ["ignore", "pipe", "pipe"] });
  let sessionId: string | undefined;
  let stderrTail = "";

  const collectStdout = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    sessionId ??= parseSessionId(text);
    log.write(text);
    jsonl.write(text);
    activity.write(text);
  };
  const collectStderr = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    stderrTail = tailString(stderrTail + text, STDERR_TAIL_BYTES);
    log.write(text);
    jsonl.write(text);
    activity.write(text);
  };

  child.stdout.on("data", collectStdout);
  child.stderr.on("data", collectStderr);

  return new Promise((resolvePromise) => {
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
      stderrTail = tailString(stderrTail + error.message, STDERR_TAIL_BYTES);
    });
    child.on("close", (code) => {
      activity.flush();
      log.end();
      jsonl.end();
      resolvePromise({ exitCode: code ?? 1, sessionId, stderrTail, ...(spawnError ? { spawnError } : {}) });
    });
  });
}

// Truncates from the end by UTF-16 code units, not Unicode codepoints.
// For typical opencode stderr (ASCII + UTF-8) this is exact; multi-byte
// characters near the 2000-char boundary may be approximated. Acceptable
// for diagnostic logs — see review d-6be10b finding Sec-2.
function tailString(text: string, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(text.length - max);
}

function firstLine(text: string): string {
  if (!text) return "";
  return text.split("\n", 1)[0] ?? "";
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
