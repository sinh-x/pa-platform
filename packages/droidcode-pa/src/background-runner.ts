import { createWriteStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSession, resumeSession, AutonomyLevel, ToolConfirmationOutcome } from "@factory/droid-sdk";
import { appendActivityEvent, createActivityEvent, emitCompletedEvent, emitCrashedEvent, ensureTerminalRegistryMarker, finalizeRepositoryLifecycle, getDeployPaths, transferRepositoryLeaseByDeployment, queryDeploymentStatus, type ActivityEvent } from "@pa-platform/pa-core";
import { resolveDefaultDroidModel } from "./adapter.js";
import { STDERR_TAIL_BYTES, firstLine, tailString } from "./util.js";

function toEnvRecord(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

interface BackgroundConfig {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logFile: string;
  deploymentId: string;
  team: string;
  sessionFileName: string;
}

const STREAM_BODY_MAX_CHARS = 500;
const STREAM_SECRET_PATTERNS = [/(?:\b|_)token(?:\b|_)/i, /(?:\b|_)secret(?:\b|_)/i, /(?:\b|_)(?:api[_-]?key|access[_-]?key)(?:\b|_)/i, /bearer\s+\S+/i, /sk-ant-\S+/i];

if (isEntrypoint()) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Missing background config path");
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as BackgroundConfig;
  try { unlinkSync(configPath); } catch { /* preserve launch behavior if already consumed */ }
  let fatalError: unknown;

  try {
    transferRepositoryLeaseByDeployment(dirname(config.logFile), process.pid);
    const result = await runDroidBackground(config);

    if (result.sessionId) {
      writeFileSync(resolve(dirname(config.logFile), config.sessionFileName), result.sessionId, "utf-8");
    }
    const activityLogPath = getDeployPaths(config.deploymentId).activityLogPath;
    const lifecycle = finalizeRepositoryLifecycle(dirname(config.logFile));
    if (!lifecycle.ok) {
      result.exitCode = 1;
      result.stderrTail = lifecycle.diagnostic ?? "repository lifecycle finalization failed";
    }
    const currentStatus = queryDeploymentStatus(config.deploymentId);
    if (currentStatus?.status !== "running") {
      appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "droid", body: `dpa background deploy exited after terminal status (${currentStatus?.status ?? "unknown"})` }), activityLogPath);
    } else if (result.exitCode === 0) {
      appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "droid", body: "dpa background deploy completed" }), activityLogPath);
      emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "success", summary: "dpa background deploy completed", logFile: config.logFile, exitCode: 0 });
    } else {
      const errorBody = result.stderrTail || (result.spawnError ? result.spawnError.message : `droid exited with code ${result.exitCode}`);
      appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "error", source: "droid", body: errorBody }), activityLogPath);
      appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "text", source: "droid", body: `dpa background deploy failed with exit code ${result.exitCode}` }), activityLogPath);
      const summaryError = firstLine(result.spawnError?.message ?? result.stderrTail);
      const summary = summaryError
        ? `dpa background deploy failed (exit ${result.exitCode}): ${summaryError}`
        : `dpa background deploy failed (exit ${result.exitCode})`;
      emitCompletedEvent({ deploymentId: config.deploymentId, team: config.team, status: "failed", summary, logFile: config.logFile, exitCode: result.exitCode });
    }
  } catch (error) {
    const lifecycle = finalizeRepositoryLifecycle(dirname(config.logFile));
    const baseError = error instanceof Error ? error.message : String(error);
    const finalError = boundedLifecycleDiagnostic(lifecycle.ok ? baseError : `${baseError}; ${lifecycle.diagnostic}`);
    emitCrashedEvent({ deploymentId: config.deploymentId, team: config.team, error: finalError, exitCode: 1 });
    fatalError = new Error(finalError);
  } finally {
    ensureTerminalRegistryMarker({ deploymentId: config.deploymentId, team: config.team });
  }

  if (fatalError) throw fatalError;
}

function boundedLifecycleDiagnostic(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 1_997)}...`;
}

interface BackgroundRunResult {
  exitCode: number;
  sessionId?: string;
  stderrTail: string;
  spawnError?: Error;
}

async function runDroidBackground(config: BackgroundConfig): Promise<BackgroundRunResult> {
  mkdirSync(dirname(config.logFile), { recursive: true });
  const log = createWriteStream(config.logFile, { flags: "a" });
  const outputPath = resolve(dirname(config.logFile), "droid-output.jsonl");
  const jsonl = createWriteStream(outputPath, { flags: "a" });
  const activityLogPath = getDeployPaths(config.deploymentId).activityLogPath;
  const apiKey = config.env["FACTORY_API_KEY"];
  let stderrTail = "";

  if (!apiKey) {
    const msg = "FACTORY_API_KEY is required for dpa background deploys";
    const raw = JSON.stringify({ type: "error", timestamp: Date.now(), message: msg }) + "\n";
    log.write(raw);
    jsonl.write(raw);
    log.end();
    jsonl.end();
    appendActivityEvent(createActivityEvent({ deployId: config.deploymentId, kind: "error", source: "droid", body: msg }), activityLogPath);
    return { exitCode: 1, stderrTail: msg };
  }

  const model = resolveDefaultDroidModel(process.env);

  try {
    const existingSessionId = readSessionId(config);
    const session = existingSessionId
      ? await resumeSession(existingSessionId, {
          env: toEnvRecord({ ...process.env, ...config.env }),
          apiKey,
          permissionHandler: () => ToolConfirmationOutcome.ProceedOnce,
        })
      : await createSession({
          cwd: config.cwd,
          env: toEnvRecord({ ...process.env, ...config.env }),
          apiKey,
          modelId: model,
          autonomyLevel: AutonomyLevel.High,
          permissionHandler: () => ToolConfirmationOutcome.ProceedOnce,
        });

    let exitCode = 0;
    let spawnError: Error | undefined;
    const captured = session.sessionId;

    try {
      const primerPath = resolve(dirname(config.logFile), "primer.md");
      const primer = readFileSync(primerPath, "utf-8");
      const stream = session.stream(primer);

      for await (const msg of stream) {
        const raw = JSON.stringify(msg);
        jsonl.write(raw + "\n");
        log.write(raw + "\n");
        const event = droidMsgToActivity(msg as unknown as { type: string; [key: string]: unknown }, config.deploymentId);
        if (event) appendActivityEvent(event, activityLogPath);
      }
    } catch (error) {
      exitCode = 1;
      spawnError = error instanceof Error ? error : new Error(String(error));
      stderrTail = tailString(spawnError.message, STDERR_TAIL_BYTES);
      const raw = JSON.stringify({ type: "error", timestamp: Date.now(), message: spawnError.message }) + "\n";
      log.write(raw);
      jsonl.write(raw);
    }

    log.end();
    jsonl.end();
    return { exitCode, ...(captured ? { sessionId: captured } : {}), stderrTail, ...(spawnError ? { spawnError } : {}) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const raw = JSON.stringify({ type: "error", timestamp: Date.now(), message: msg }) + "\n";
    log.write(raw);
    jsonl.write(raw);
    log.end();
    jsonl.end();
    return { exitCode: 1, stderrTail: tailString(msg, STDERR_TAIL_BYTES), spawnError: error instanceof Error ? error : new Error(msg) };
  }
}

function readSessionId(config: BackgroundConfig): string | undefined {
  try {
    const value = readFileSync(resolve(dirname(config.logFile), config.sessionFileName), "utf-8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function droidMsgToActivity(msg: { type: string; [key: string]: unknown }, deployId: string): ActivityEvent | null {
  const type = String(msg.type ?? "");
  const raw = msg as Record<string, unknown>;
  switch (type) {
    case "assistant_text_delta":
    case "thinking_text_delta":
      return null;
    case "assistant_text_complete":
      return createActivityEvent({ deployId, kind: "text", source: "droid", body: sanitizeBody(String(raw["text"] ?? "")), partType: "text", metadata: raw });
    case "thinking_text_complete":
      return createActivityEvent({ deployId, kind: "thinking", source: "droid", body: sanitizeBody(String(raw["text"] ?? "")), partType: "thinking", metadata: raw });
    case "tool_call": {
      const name = String(raw["name"] ?? "tool");
      const input = (raw["input"] ?? {}) as Record<string, unknown>;
      const desc = stringValue(input["description"] ?? input["command"] ?? input["filePath"] ?? input["prompt"]);
      return createActivityEvent({ deployId, kind: "tool_use", source: "droid", body: sanitizeBody([name, desc].filter(Boolean).join(" ")), partType: "tool_use", metadata: raw });
    }
    case "tool_result":
      return createActivityEvent({ deployId, kind: "tool_result", source: "droid", body: sanitizeBody("tool_result"), partType: "tool_result", metadata: raw });
    case "error":
      return createActivityEvent({ deployId, kind: "error", source: "droid", body: sanitizeBody(String(raw["message"] ?? "error")), partType: "error", metadata: raw });
    default:
      return null;
  }
}

function sanitizeBody(value: string): string {
  let result = value;
  for (const pattern of STREAM_SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result.length > STREAM_BODY_MAX_CHARS ? `${result.slice(0, STREAM_BODY_MAX_CHARS - 3)}...` : result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}
