import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendActivityEvent, appendRegistryEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, ensureTerminalRegistryMarker, getDeployPaths, getDeploymentEvents, queryDeploymentStatus, runCoreCommand, nowUtc } from "@pa-platform/pa-core";
import { createOpencodeActivityWriter, createOpencodeSessionIdParser } from "./adapter.js";
import { createDefaultOpencodeHooks } from "./deploy.js";
import { compactReason, extractEvaluatorDeploymentId, resolveBuilderCompletionPath } from "./post-deploy-evaluator.js";

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

let fatalError: unknown;

try {
  const result = await runOpencode(config);

  // Only persist a session file when the runner observed a real session token.
  // Falling back to deployment id silently broke `opa deploy --resume`.
  if (result.sessionId) {
    writeFileSync(resolve(dirname(config.logFile), config.sessionFileName), result.sessionId, "utf-8");
  }
  const activityLogPath = getDeployPaths(config.deploymentId).activityLogPath;
  if (result.exitCode === 0) {
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "opencode", body: "opa background deploy completed" }), activityLogPath);
    emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "success", summary: "opa background deploy completed", logFile: config.logFile, exitCode: 0 });
    await maybeLaunchPostDeployEvaluation(config);
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
  fatalError = error;
} finally {
  ensureTerminalRegistryMarker({ deploymentId: config.deploymentId, team: config.team });
}

if (fatalError) throw fatalError;

interface BackgroundRunResult {
  exitCode: number;
  sessionId?: string;
  stderrTail: string;
  spawnError?: Error;
}

async function maybeLaunchPostDeployEvaluation(config: BackgroundConfig): Promise<void> {
  const completionPath = resolveBuilderCompletionPath(config.team, config.env["PA_MODE"]);
  if (!completionPath) return;
  const status = queryDeploymentStatus(config.deploymentId);
  if (!status || status.status !== "success") return;
  if (getDeploymentEvents(config.deploymentId).some((event) => event.event === "updated" && event.note?.includes(`[evaluator-launch path=${completionPath}]`))) return;

  const command = ["evaluate", "--evaluate-deployment", config.deploymentId, "--background"];
  const ticket = config.env["PA_TICKET_ID"];
  const repo = config.env["PA_REPO"];
  const provider = config.env["PA_PROVIDER"];
  const model = config.env["PA_MODEL"];
  const teamModel = config.env["PA_TEAM_MODEL"];
  const agentModel = config.env["PA_AGENT_MODEL"];
  if (ticket) command.push("--ticket", ticket);
  if (repo) command.push("--repo", repo);
  if (provider) command.push("--provider", provider);
  if (model) command.push("--model", model);
  if (teamModel) command.push("--team-model", teamModel);
  if (agentModel) command.push("--agent-model", agentModel);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCoreCommand(command, { hooks: createDefaultOpencodeHooks(), io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, binaryName: "opa" });
  const evaluatorDeploymentId = extractEvaluatorDeploymentId(stdout.join("\n"));

  appendRegistryEvent({
    deployment_id: config.deploymentId,
    team: config.team,
    event: "updated",
    timestamp: nowUtc(),
    note: code === 0
      ? `[evaluator-launch path=${completionPath}] target=${config.deploymentId} status=launched evaluator_deployment_id=${evaluatorDeploymentId ?? "unknown"}`
      : `[evaluator-launch path=${completionPath}] target=${config.deploymentId} status=failed reason=${compactReason(stderr.join("\n") || stdout.join("\n") || `evaluate exited ${code}`)}`,
  });
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
  const sessionParser = createOpencodeSessionIdParser();
  const child = spawn("opencode", config.args, { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";

  const collectStdout = (chunk: Buffer): void => {
    const text = chunk.toString("utf-8");
    // Line-buffered parsing — a JSON line containing sessionID may straddle two
    // chunks, so per-chunk parseSessionId(text) was unsafe (review d-f412e8 Sec-3).
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
