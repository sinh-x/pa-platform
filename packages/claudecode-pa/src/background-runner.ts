import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, getDeployPaths } from "@pa-platform/pa-core";
import { createClaudeActivityWriter, createClaudeSessionIdParser } from "./adapter.js";

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
  const result = await runClaude(config);

  // Only persist a session file when the runner observed a real claude session token.
  // Falling back to deployment id silently broke `cpa deploy --resume`.
  if (result.sessionId) {
    writeFileSync(resolve(dirname(config.logFile), config.sessionFileName), result.sessionId, "utf-8");
  }
  const activityLogPath = getDeployPaths(config.deploymentId).activityLogPath;
  if (result.exitCode === 0) {
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "claude", body: "cpa background deploy completed" }), activityLogPath);
    emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "success", summary: "cpa background deploy completed", logFile: config.logFile, exitCode: 0 });
  } else {
    const errorBody = result.stderrTail || (result.spawnError ? result.spawnError.message : `claude exited with code ${result.exitCode}`);
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "error", source: "claude", body: errorBody }), activityLogPath);
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "claude", body: `cpa background deploy failed with exit code ${result.exitCode}` }), activityLogPath);
    const summaryError = firstLine(result.spawnError?.message ?? result.stderrTail);
    const summary = summaryError
      ? `cpa background deploy failed (exit ${result.exitCode}): ${summaryError}`
      : `cpa background deploy failed (exit ${result.exitCode})`;
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

function runClaude(config: BackgroundConfig): Promise<BackgroundRunResult> {
  mkdirSync(dirname(config.logFile), { recursive: true });
  const log = createWriteStream(config.logFile, { flags: "a" });
  const jsonl = createWriteStream(resolve(dirname(config.logFile), "claude-output.jsonl"), { flags: "a" });
  // Both this writer and the (Phase 3) claude settings.json hook will append to
  // activity.jsonl concurrently. appendFileSync({flag:"a"}) line-flushed writes are
  // atomic for sub-PIPE_BUF (4096-byte) lines; STDERR_TAIL_BYTES = 2000 guarantees that.
  const activity = createClaudeActivityWriter(config.deploymentId, getDeployPaths(config.deploymentId).activityLogPath);
  const sessionParser = createClaudeSessionIdParser();
  const child = spawn("claude", config.args, { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";

  const collectStdout = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    // Line-buffered parsing — a JSON line containing session_id may straddle two
    // chunks, so per-chunk parseSessionId(text) was unsafe (mirror of opa fix d-f412e8).
    sessionParser.write(text);
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
      const sessionId = sessionParser.flush();
      log.end();
      jsonl.end();
      resolvePromise({ exitCode: code ?? 1, ...(sessionId ? { sessionId } : {}), stderrTail, ...(spawnError ? { spawnError } : {}) });
    });
  });
}


// Truncates from the end by UTF-16 code units, not Unicode codepoints.
// For typical claude stderr (ASCII + UTF-8) this is exact; multi-byte
// characters near the 2000-char boundary may be approximated.
function tailString(text: string, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(text.length - max);
}

function firstLine(text: string): string {
  if (!text) return "";
  return text.split("\n", 1)[0] ?? "";
}
