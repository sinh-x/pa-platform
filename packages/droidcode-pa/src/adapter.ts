import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendActivityEvent, createActivityEvent, createBackgroundOwnershipConfig, formatRuntimePair, getDeployPaths, modelMatchesProvider, nowUtc, parseTimestamp, redactDiagnostic, removeOwnedBackgroundConfig, terminateBackgroundSupervisor, waitForBackgroundOwnership, type ActivityEvent, type EffectiveRuntimeConfig, type RuntimeAdapter, type SpawnOpts, type SpawnResult, type ResumeOpts, type HookConfig, type ToolReference } from "@pa-platform/pa-core";
import { createSession, resumeSession, AutonomyLevel, ToolConfirmationOutcome, type DroidSession, type DroidStreamMessage } from "@factory/droid-sdk";
import { installPaDroidHooks } from "./plugins/pa-droid-safety.js";
import { isDestructiveCommand, isBlockedFilePath } from "./safety-rules.js";
import { STDERR_TAIL_BYTES, tailString, firstLine } from "./util.js";

const STREAM_BODY_MAX_CHARS = 500;
// WARNING: these patterns carry the global flag and are shared across all masking
// calls.  They are safe when used ONLY with .replace() (which resets lastIndex),
// but .test() / .exec() will retain state and can produce intermittent misses.
// If you ever need .test() / .exec(), clone each regex (e.g. new RegExp(p)) or
// reset p.lastIndex = 0 before every call.
const STREAM_SECRET_PATTERNS = [/(?:\b|_)token(?:\b|_)/gi, /(?:\b|_)secret(?:\b|_)/gi, /(?:\b|_)password(?:\b|_)/gi, /(?:\b|_)(?:api[_-]?key|access[_-]?key|secret[_-]?key)(?:\b|_)/gi, /bearer\s+\S+/gi, /sk-ant-\S+/gi, /fk-[a-zA-Z0-9_-]{20,}/gi];

export interface DroidModelResolutionOpts {
  env?: NodeJS.ProcessEnv;
  platformDefaults?: { model?: string };
  modeRuntimes?: { model?: string };
  teamRuntimes?: { model?: string };
}

export interface DroidAutonomyResolutionOpts {
  cliFlag?: string;
  env?: NodeJS.ProcessEnv;
  modeRuntimes?: { autonomy?: string };
  teamRuntimes?: { autonomy?: string };
  platformDefaults?: { autonomy?: string };
}

export interface DroidCodeAdapterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  sessionFactory?: (opts: { modelId: string; cwd: string; env: NodeJS.ProcessEnv; apiKey: string; timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<DroidSession>;
  resumeFactory?: (sessionId: string, opts: { apiKey: string; env: NodeJS.ProcessEnv; abortSignal?: AbortSignal }) => Promise<DroidSession>;
  runBackgroundCommand?: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; logFile?: string }) => { pid?: number; sessionId?: string } | Promise<{ pid?: number; sessionId?: string }>;
}

export class DroidCodeAdapter implements RuntimeAdapter {
  readonly name = "droid" as const;
  readonly defaultModel: string;
  readonly sessionFileName = "session-id-droid.txt";

  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionFactory?: (opts: { modelId: string; cwd: string; env: NodeJS.ProcessEnv; apiKey: string; timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<DroidSession>;
  private readonly resumeFactory?: (sessionId: string, opts: { apiKey: string; env: NodeJS.ProcessEnv; abortSignal?: AbortSignal }) => Promise<DroidSession>;
  private readonly runBackgroundCommand: (args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; logFile?: string }) => { pid?: number; sessionId?: string } | Promise<{ pid?: number; sessionId?: string }>;

  constructor(options: DroidCodeAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.sessionFactory = options.sessionFactory;
    this.resumeFactory = options.resumeFactory;
    this.defaultModel = resolveDefaultDroidModel(this.env);
    this.runBackgroundCommand = options.runBackgroundCommand ?? (async (args, opts) => {
      const logFile = opts.logFile ?? resolve(opts.cwd, "droid-background.log");
      mkdirSync(dirname(logFile), { recursive: true });
      const configPath = resolve(dirname(logFile), "droid-background.json");
      const deploymentId = opts.env["PA_DEPLOYMENT_ID"];
      if (!deploymentId) throw new Error("runner-readiness: Droid background deployment identity is missing");
      const ownership = createBackgroundOwnershipConfig(dirname(logFile));
      writeFileSync(configPath, JSON.stringify({
        args,
        cwd: opts.cwd,
        env: pickBackgroundEnv(opts.env),
        logFile,
        deploymentId,
        team: opts.env["PA_TEAM"],
        sessionFileName: this.sessionFileName,
        ...ownership,
      }, null, 2), { mode: 0o600 });
      const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "background-runner.js");
      const child = spawn(process.execPath, [runnerPath, configPath], {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      if (!child.pid) throw new Error("runner-readiness: Droid background supervisor did not expose a PID");
      try {
        await waitForBackgroundOwnership({ ...ownership, deploymentId, supervisorPid: child.pid });
      } catch (error) {
        await terminateBackgroundSupervisor(child.pid);
        removeOwnedBackgroundConfig(configPath, ownership.ownershipToken);
        throw error;
      }
      return { pid: child.pid };
    });
  }

  spawn(opts: SpawnOpts): Promise<SpawnResult> {
    return this.runDroid(opts);
  }

  resume(opts: ResumeOpts): Promise<SpawnResult> {
    return this.runDroid(opts, opts.sessionId);
  }

  extractActivity(deployDir: string): ActivityEvent[] {
    const logPath = resolve(deployDir, "droid-output.jsonl");
    if (!existsSync(logPath)) return [];
    const events: ActivityEvent[] = [];
    for (const line of readFileSync(logPath, "utf-8").split("\n").filter(Boolean)) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        events.push(createActivityEvent({
          deployId: String(raw["deployId"] ?? basenameDeployId(deployDir)),
          timestamp: normalizeTimestamp(raw["timestamp"]),
          kind: normalizeKind(raw),
          source: extractSource(raw),
          body: extractBody(raw),
          partType: extractPartType(raw),
          metadata: raw,
        }));
      } catch {
        events.push(createActivityEvent({ deployId: basenameDeployId(deployDir), kind: "text", source: "droid", body: line }));
      }
    }
    return events;
  }

  installHooks(_targetDir: string, _config: HookConfig): void {
    installPaDroidHooks(this.env);
  }

  describeTools(): ToolReference {
    return {
      runtime: this.name,
      markdown: [
        "Runtime: Droid via `dpa`.",
        "Use `dpa` for PA platform deployment and workflow commands; it invokes the same pa-core command set that `opa` and `cpa` use.",
        "Use `pa-core serve` for Agent API server lifecycle; `dpa` is a deployment adapter, not the server owner.",
        "Droid deployments use the full Droid tool set: Read, Edit, Create, Execute, Grep, Glob, LS, Task (sub-agent spawning), AskUser, Skill, WebSearch, FetchUrl, and TodoWrite.",
        "All dpa runs (foreground and background) capture a session id and are resumable.",
        `Default model: \`${this.defaultModel}\` (override via --model, team-mode YAML, or PA_DPA_DEFAULT_MODEL).`,
      ].join("\n"),
    };
  }

  getCwd(): string {
    return this.cwd;
  }

  getEnv(): NodeJS.ProcessEnv {
    return this.env;
  }

  private async runDroid(opts: SpawnOpts, sessionId?: string): Promise<SpawnResult> {
    const cwd = opts.executionPlan?.repositoryCwd ?? this.cwd;
    const primer = readFileSync(opts.primerPath, "utf-8");
    const activityLogPath = getDeployPaths(opts.deployId).activityLogPath;
    const model = opts.model ?? this.defaultModel;
    const apiKey = opts.env?.["FACTORY_API_KEY"] ?? this.env["FACTORY_API_KEY"];
    if (!apiKey) {
      const msg = "FACTORY_API_KEY is required for dpa deploys. Set it as FACTORY_API_KEY in your environment, or in ~/.config/sinh-x/pa-platform/config.yaml under provider_defaults.providers.factory.api_key.";
      appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "droid", body: msg }), activityLogPath);
      return { exitCode: 1, logFile: opts.logFile, errorMessage: msg };
    }

    const mergedEnv = { ...this.env, ...opts.env };

    // Foreground: interactive TUI mode.
    // When custom factories are set (tests), fall through to SDK streaming path below.
    if (opts.mode === "foreground" && !this.sessionFactory && !this.resumeFactory) {
      const args = ["-m", model, "-f", opts.primerPath];
      if (opts.autonomy) args.push("--auto", opts.autonomy);
      if (sessionId) args.push("-r", sessionId);
      const result = spawnSync("droid", args, {
        cwd,
        env: mergedEnv,
        stdio: ["inherit", "inherit", "pipe"],
        encoding: "utf-8",
      });
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      if (stderr.length > 0 && result.status !== 0) process.stderr.write(stderr);

      const exitCode = result.status ?? 1;
      const errorMessage = exitCode !== 0
        ? (stderr ? firstLine(stderr) : `droid exited with code ${exitCode}`)
        : undefined;
      if (errorMessage) {
        appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "droid", body: sanitizeStreamBody(errorMessage) }), activityLogPath);
      }
      const terminalBody = exitCode === 0 ? `droid exited with code ${exitCode}` : `droid exited with code ${exitCode}: ${errorMessage ?? "unknown error"}`;
      appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: exitCode === 0 ? "text" : "error", source: "droid", body: terminalBody }), activityLogPath);

      return { ...(sessionId ? { sessionId } : {}), exitCode, logFile: opts.logFile, ...(errorMessage ? { errorMessage } : {}) };
    }

    if (opts.mode === "background") {
      const result = await this.runBackgroundCommand([model, opts.primerPath], {
        cwd,
        env: toEnvRecord(mergedEnv),
        logFile: opts.logFile,
      });
      const captured = result.sessionId ?? sessionId;
      return { ...(captured ? { sessionId: captured } : {}), exitCode: 0, logFile: opts.logFile, metadata: { pid: result.pid } };
    }

    // Streaming mode (tests / explicit SDK path): use SDK session.stream()
    const deployDir = resolve(dirname(opts.primerPath));
    const outputJsonlPath = resolve(deployDir, "droid-output.jsonl");
    mkdirSync(dirname(outputJsonlPath), { recursive: true });
    if (opts.logFile) mkdirSync(dirname(opts.logFile), { recursive: true });
    const log = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : undefined;
    const jsonl = createWriteStream(outputJsonlPath, { flags: "a" });
    log?.on("error", () => {});
    jsonl.on("error", () => {});

    try {
      const session = sessionId
        ? await (this.resumeFactory ?? defaultResumeSession)(sessionId, { apiKey, env: toEnvRecord(mergedEnv) })
        : await (this.sessionFactory ?? defaultCreateSession)({ modelId: model, cwd, env: toEnvRecord(mergedEnv), apiKey });

      let exitCode = 0;
      let errorMessage: string | undefined;

      try {
        for await (const msg of session.stream(primer)) {
          const raw = serializeStreamMessage(msg);
          jsonl.write(raw + "\n");
          log?.write(raw + "\n");
          const event = droidStreamMessageToActivityEvent(msg, opts.deployId);
          if (event) appendActivityEvent(event, activityLogPath);
        }
      } catch (streamError) {
        exitCode = 1;
        errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
        appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: "error", source: "droid", body: sanitizeStreamBody(errorMessage) }), activityLogPath);
      }

      if (exitCode === 0 && errorMessage) exitCode = 1;
      const terminalBody = exitCode === 0 ? `droid exited with code ${exitCode}` : `droid exited with code ${exitCode}: ${errorMessage ?? "unknown error"}`;
      appendActivityEvent(createActivityEvent({ deployId: opts.deployId, kind: exitCode === 0 ? "text" : "error", source: "droid", body: terminalBody }), activityLogPath);

      return { sessionId: session.sessionId, exitCode, logFile: opts.logFile, ...(errorMessage ? { errorMessage } : {}) };
    } finally {
      log?.end();
      jsonl.end();
    }
  }
}

/** Map the shared provider/model result to Droid's flat model identifier. */
export function resolveDroidRuntimeConfig(config: EffectiveRuntimeConfig, opts: DroidModelResolutionOpts = {}): EffectiveRuntimeConfig {
  if (config.provider && !modelMatchesProvider(config.model, [config.provider])) {
    const model = resolveDroidModel(undefined, opts);
    const warning = redactDiagnostic(
      `dpa: incompatible provider/model ${formatRuntimePair(config.provider, config.model)}; falling back to ${formatRuntimePair(undefined, model)}.`,
    );
    return Object.freeze({ provider: "", model, source: "fallback", warning });
  }
  const model = resolveDroidModel(config.model, opts);
  return Object.freeze({
    provider: config.provider ?? "",
    model,
    source: config.source,
  });
}

export function resolveDroidModel(
  model: string | undefined,
  opts: DroidModelResolutionOpts = {},
): string {
  if (model && model.length > 0) {
    if (model.includes("/")) return model.split("/").pop()!;
    return model;
  }
  if (opts.modeRuntimes?.model) return opts.modeRuntimes.model;
  if (opts.teamRuntimes?.model) return opts.teamRuntimes.model;
  const env = opts.env ?? process.env;
  const envOverride = env["PA_DPA_DEFAULT_MODEL"];
  if (envOverride && envOverride.length > 0) return envOverride;
  if (opts.platformDefaults?.model && opts.platformDefaults.model.length > 0) return opts.platformDefaults.model;
  return "deepseek-v4-pro";
}

export function resolveDefaultDroidModel(env: NodeJS.ProcessEnv, platformDefaults?: { model?: string }): string {
  return env["PA_DPA_DEFAULT_MODEL"] ?? platformDefaults?.model ?? "deepseek-v4-pro";
}

const VALID_AUTONOMY_LEVELS = new Set<string>(["low", "medium", "high"]);

export function resolveDroidAutonomy(opts: DroidAutonomyResolutionOpts = {}): string {
  if (opts.cliFlag && opts.cliFlag.length > 0) {
    const normalized = opts.cliFlag.toLowerCase();
    if (VALID_AUTONOMY_LEVELS.has(normalized)) return normalized;
  }
  const env = opts.env ?? process.env;
    const envVal = env["PA_DPA_AUTONOMY"];
    if (envVal && envVal.length > 0) {
      const normalized = envVal.toLowerCase();
      if (VALID_AUTONOMY_LEVELS.has(normalized)) return normalized;
    }
  if (opts.modeRuntimes?.autonomy) return opts.modeRuntimes.autonomy;
  if (opts.teamRuntimes?.autonomy) return opts.teamRuntimes.autonomy;
  if (opts.platformDefaults?.autonomy && opts.platformDefaults.autonomy.length > 0) return opts.platformDefaults.autonomy;
  return "medium";
}

function createSafetyPermissionHandler() {
  return (params: Record<string, unknown>): ToolConfirmationOutcome => {
    const toolUses = (params["toolUses"] ?? []) as Array<Record<string, unknown>>;
    for (const toolUse of toolUses) {
      const toolName = String(toolUse["toolName"] ?? toolUse["name"] ?? "");
      const details = (toolUse["details"] ?? {}) as Record<string, unknown>;

      if (toolName === "Execute") {
        const command = String(details["command"] ?? details["fullCommand"] ?? "");
        if (isDestructiveCommand(command)) return ToolConfirmationOutcome.Cancel;
      }

      if (toolName === "Edit" || toolName === "Create") {
        const filePath = String(details["filePath"] ?? details["file_path"] ?? "");
        if (isBlockedFilePath(filePath)) return ToolConfirmationOutcome.Cancel;
      }
    }
    return ToolConfirmationOutcome.ProceedOnce;
  };
}

function resolveAutonomy(env: NodeJS.ProcessEnv): AutonomyLevel {
  const raw = (env["PA_DPA_AUTONOMY"] ?? "medium").toLowerCase();
  switch (raw) {
    case "low": return AutonomyLevel.Low;
    case "medium": return AutonomyLevel.Medium;
    case "high": return AutonomyLevel.High;
    default: return AutonomyLevel.Medium;
  }
}

async function defaultCreateSession(opts: {
  modelId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  apiKey: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<DroidSession> {
  return createSession({
    cwd: opts.cwd,
    env: toEnvRecord(opts.env),
    apiKey: opts.apiKey,
    modelId: opts.modelId,
    autonomyLevel: resolveAutonomy(opts.env),
    permissionHandler: createSafetyPermissionHandler(),
    abortSignal: opts.abortSignal,
  });
}

async function defaultResumeSession(
  sessionId: string,
  opts: {
    apiKey: string;
    env: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
  },
): Promise<DroidSession> {
  return resumeSession(sessionId, {
    env: toEnvRecord(opts.env),
    apiKey: opts.apiKey,
    permissionHandler: createSafetyPermissionHandler(),
    abortSignal: opts.abortSignal,
  });
}

function serializeStreamMessage(msg: DroidStreamMessage): string {
  try {
    return JSON.stringify(msg);
  } catch {
    return JSON.stringify({ type: String(msg.type), error: "unserializable" });
  }
}

function droidStreamMessageToActivityEvent(msg: DroidStreamMessage, deployId: string): ActivityEvent | null {
  const raw = msg as unknown as Record<string, unknown>;
  const type = String(raw["type"] ?? "");
  switch (type) {
    case "assistant_text_delta":
      return null;
    case "assistant_text_complete":
      return createActivityEvent({
        deployId,
        kind: "text",
        source: "droid",
        body: sanitizeStreamBody(stringValue(raw["text"]) ?? ""),
        partType: "text",
        metadata: raw,
      });
    case "thinking_text_delta":
      return null;
    case "thinking_text_complete":
      return createActivityEvent({
        deployId,
        kind: "thinking",
        source: "droid",
        body: sanitizeStreamBody(stringValue(raw["text"]) ?? ""),
        partType: "thinking",
        metadata: raw,
      });
    case "tool_call": {
      const name = stringValue(raw["name"]) ?? "tool";
      const input = (raw["input"] ?? {}) as Record<string, unknown>;
      return createActivityEvent({
        deployId,
        kind: "tool_use",
        source: "droid",
        body: sanitizeStreamBody([name, extractToolDescription(input)].filter(Boolean).join(" ")),
        partType: "tool_use",
        metadata: raw,
      });
    }
    case "tool_result": {
      const content = raw["content"];
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content) && content.length > 0) {
        const first = content[0] as Record<string, unknown> | undefined;
        text = stringValue(first?.text) ?? "";
      }
      return createActivityEvent({
        deployId,
        kind: "tool_result",
        source: "droid",
        body: sanitizeStreamBody(`tool_result ${text}`.trim()),
        partType: "tool_result",
        metadata: raw,
      });
    }
    case "error":
      return createActivityEvent({
        deployId,
        kind: "error",
        source: "droid",
        body: sanitizeStreamBody(stringValue(raw["message"]) ?? "error"),
        partType: "error",
        metadata: raw,
      });
    case "result":
      return createActivityEvent({
        deployId,
        kind: "text",
        source: "droid",
        body: sanitizeStreamBody(stringValue(raw["result"]) ?? stringValue(raw["subtype"]) ?? "completed"),
        partType: "result",
        metadata: raw,
      });
    default:
      return null;
  }
}

function extractToolDescription(input: Record<string, unknown>): string | undefined {
  return stringValue(input["description"] ?? input["command"] ?? input["filePath"] ?? input["file_path"] ?? input["pattern"] ?? input["url"] ?? input["prompt"]);
}

function sanitizeStreamBody(value: string): string {
  let result = value;
  for (const pattern of STREAM_SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result.length > STREAM_BODY_MAX_CHARS ? `${result.slice(0, STREAM_BODY_MAX_CHARS - 3)}...` : result;
}

function createDroidActivityWriter(deployId: string, activityLogPath: string): { write(text: string): void; flush(): void } {
  let pending = "";
  const processLine = (line: string): void => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line) as ActivityEvent;
      appendActivityEvent(raw, activityLogPath);
    } catch {
      appendActivityEvent(createActivityEvent({ deployId, kind: "text", source: "droid", body: line }), activityLogPath);
    }
  };
  return {
    write(text: string): void {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    },
    flush(): void {
      processLine(pending);
      pending = "";
    },
  };
}

function normalizeKind(raw: Record<string, unknown>): ActivityEvent["kind"] {
  const type = String(raw["kind"] ?? raw["type"] ?? "text").toLowerCase();
  if (type === "error") return "error";
  if (type === "thinking" || type === "thinking_text_complete") return "thinking";
  if (type === "tool_use" || type === "tool_call") return "tool_use";
  if (type === "tool_result") return "tool_result";
  return "text";
}

function extractBody(raw: Record<string, unknown>): string {
  const body = raw["body"] ?? raw["text"] ?? raw["content"] ?? raw["message"] ?? "";
  return sanitizeStreamBody(typeof body === "string" ? body : JSON.stringify(body));
}

function extractSource(raw: Record<string, unknown>): string {
  const sessionId = stringValue(raw["sessionId"] ?? raw["session_id"]);
  return sessionId ? sessionId.slice(0, 8) : "droid";
}

function extractPartType(raw: Record<string, unknown>): string | undefined {
  return stringValue(raw["partType"] ?? raw["part_type"] ?? raw["type"]);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return parseTimestamp(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return nowUtc(new Date(value));
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basenameDeployId(deployDir: string): string {
  return deployDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}

function toEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function pickBackgroundEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FACTORY_API_KEY", "FACTORY_API_BASE_URL", "PA_AI_USAGE_HOME", "PA_REGISTRY_DB", "PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_ACTIVITY_LOG", "PA_TEAM", "PA_MODE", "PA_TICKET_ID", "PA_REPO", "PA_PROVIDER", "PA_MODEL", "PA_TEAM_MODEL", "PA_AGENT_MODEL", "PA_REPOSITORY_LEASE_OWNER", "PA_REPOSITORY_LEASE_PATH", "PA_REPOSITORY_LEASE_TOKEN", "PA_DPA_DEFAULT_MODEL", "PA_DPA_AUTONOMY"] as const) {
    if (env[key]) picked[key] = env[key]!;
  }
  return picked;
}
