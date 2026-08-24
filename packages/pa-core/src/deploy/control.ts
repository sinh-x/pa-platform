import type { ApiRuntimeName, AutonomyLevel } from "../types.js";
import type { SessionCommandBuilder, SessionEventNormalizer } from "../agent-api/ws/session-hub.js";

export const DEFAULT_DEPLOY_TIMEOUT_SECONDS = 1800;
export const MIN_DEPLOY_TIMEOUT_SECONDS = 60;
export const MAX_DEPLOY_TIMEOUT_SECONDS = 7200;
const PA_MAX_RUNTIME_ENV = "PA_MAX_RUNTIME";

const VALID_AUTONOMY_LEVELS = new Set<string>(["low", "medium", "high"]);

export interface DeployRequest {
  team: string;
  runtime?: ApiRuntimeName;
  mode?: string;
  objective?: string;
  evaluateDeployment?: string;
  repo?: string;
  ticket?: string;
  timeout?: number;
  dryRun?: boolean;
  background?: boolean;
  provider?: string;
  model?: string;
  teamModel?: string;
  agentModel?: string;
  resume?: string;
  autonomy?: AutonomyLevel;
  listModes?: boolean;
  validate?: boolean;
  sanitizedCharsRemoved?: number;
}

export interface DeployTimeoutResolutionInput {
  timeout?: number;
  env?: Record<string, string | undefined>;
}

export interface DeployHookResult {
  status: "pending" | "success" | "failed";
  team?: string;
  mode?: string | null;
  reason?: string;
  deploymentId?: string;
}

export interface SelfUpdateStatusResult {
  status: "idle" | "building" | "success" | "error";
  startedAt: string | null;
  completedAt: string | null;
  log: string[];
}

export interface SelfUpdateStartResult extends SelfUpdateStatusResult {
  status: "building" | "success" | "error";
}

export interface CoreExecutionHooks {
  deploy?(request: DeployRequest): Promise<DeployHookResult> | DeployHookResult;
  serve?(action: "start" | "stop" | "restart" | "status"): Promise<{ status: string; message?: string }> | { status: string; message?: string };
  selfUpdate?(): Promise<SelfUpdateStartResult> | SelfUpdateStartResult;
  getSelfUpdateStatus?(): Promise<SelfUpdateStatusResult> | SelfUpdateStatusResult;
  /**
   * Optional activity-event normalizer injected by the runtime adapter
   * (e.g. opencodeJsonToActivityEvent from @pa-platform/opencode-pa).
   * When provided, the Agent API session hub uses it to normalize raw
   * opencode JSONL output into structured ActivityEvents streamed over
   * the /ws/session WebSocket endpoint.
   */
  sessionNormalizer?: SessionEventNormalizer;
  sessionCommand?: SessionCommandBuilder;
  runtimeHooks?: Partial<Record<ApiRuntimeName, CoreExecutionHooks>>;
}

export function composeRuntimeHooks(opencode: CoreExecutionHooks, pi: CoreExecutionHooks): CoreExecutionHooks {
  return { ...opencode, runtimeHooks: { opencode, pi } };
}

export interface SanitizeResult {
  sanitized: string;
  removed: number;
}

export function sanitizeTextInput(text: string): SanitizeResult {
  const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f$\\;&]/g, "");
  return { sanitized, removed: text.length - sanitized.length };
}

export interface ValidateDeployResult {
  request: DeployRequest;
  warnings?: string[];
}

export function validateDeployRequestFields(body: Record<string, unknown>): ValidateDeployResult | { error: string } {
  const team = stringField(body, "team");
  const runtime = stringField(body, "runtime");
  const mode = stringField(body, "mode");
  const objective = stringField(body, "objective");
  const evaluateDeployment = stringField(body, "evaluateDeployment");
  const repo = stringField(body, "repo");
  const ticket = stringField(body, "ticket");
  const provider = stringField(body, "provider");
  const model = stringField(body, "model");
  const teamModel = stringField(body, "teamModel");
  const agentModel = stringField(body, "agentModel");
  const resume = stringField(body, "resume");
  const autonomy = stringField(body, "autonomy");
  const rawTimeout = body["timeout"];
  const timeout = typeof rawTimeout === "number" ? rawTimeout : undefined;
  const dryRun = booleanField(body, "dryRun");
  const background = booleanField(body, "background");
  const listModes = booleanField(body, "listModes");
  const validate = booleanField(body, "validate");

  if (!team?.trim()) return { error: "team is required" };
  if (Object.prototype.hasOwnProperty.call(body, "runtime") && (runtime === undefined || !runtime.trim() || (runtime !== "opencode" && runtime !== "pi"))) return { error: "runtime must be opencode or pi" };
  if (!isSafeIdentifier(team)) return { error: "Invalid team name" };
  if (mode && !isSafeIdentifier(mode)) return { error: "Invalid mode name" };
  if (evaluateDeployment && !/^d-[a-z0-9]{6}$/.test(evaluateDeployment)) return { error: "Invalid evaluate deployment id" };
  if (repo && !isSafeRepoSpecifier(repo)) return { error: "Invalid repo name" };
  if (ticket && !/^[A-Z][A-Z0-9]+-[0-9]+$/.test(ticket)) return { error: "Invalid ticket ID" };
  if (provider && !/^[a-zA-Z0-9_-]+$/.test(provider)) return { error: "Invalid provider name" };
  if (model && !/^[-a-zA-Z0-9_.:\/]+$/.test(model)) return { error: "Invalid model name" };
  if (teamModel && !/^[-a-zA-Z0-9_.:\/]+$/.test(teamModel)) return { error: "Invalid team model name" };
  if (agentModel && !/^[-a-zA-Z0-9_.:\/]+$/.test(agentModel)) return { error: "Invalid agent model name" };
  if (resume && !/^[a-zA-Z0-9-]+$/.test(resume)) return { error: "Invalid resume deployment id" };
  if (autonomy && !VALID_AUTONOMY_LEVELS.has(autonomy)) return { error: "Invalid autonomy level: must be low, medium, or high" };
  if (rawTimeout !== undefined && typeof rawTimeout !== "number") return { error: "timeout must be a number" };
  const timeoutValidation = validateDeployTimeoutSeconds(timeout, "timeout");
  if (timeoutValidation) return { error: timeoutValidation };
  const warnings: string[] = [];
  let sanitizedObjective: string | undefined;
  let sanitizedCharsRemoved: number | undefined;
  if (objective && objective.trim()) {
    if (objective.length > 10000) return { error: "objective exceeds max length of 10000 characters" };
    const result = sanitizeTextInput(objective);
    if (result.removed > 0) {
      warnings.push(`sanitized objective: removed ${result.removed} invalid character(s)`);
      sanitizedCharsRemoved = result.removed;
    }
    sanitizedObjective = result.sanitized.trim();
  }
  if (dryRun && background) return { error: "--background and --dry-run are mutually exclusive" };

  const request: DeployRequest = { team };
  if (runtime) request.runtime = runtime as ApiRuntimeName;
  if (mode) request.mode = mode;
  if (sanitizedObjective) request.objective = sanitizedObjective;
  if (evaluateDeployment) request.evaluateDeployment = evaluateDeployment;
  if (repo) request.repo = repo;
  if (ticket?.trim()) request.ticket = ticket.trim();
  if (timeout !== undefined) request.timeout = timeout;
  if (dryRun !== undefined) request.dryRun = dryRun;
  if (background !== undefined) request.background = background;
  if (provider) request.provider = provider;
  if (model) request.model = model;
  if (teamModel) request.teamModel = teamModel;
  if (agentModel) request.agentModel = agentModel;
  if (resume) request.resume = resume;
  if (autonomy) request.autonomy = autonomy as AutonomyLevel;
  if (listModes !== undefined) request.listModes = listModes;
  if (validate !== undefined) request.validate = validate;
  if (sanitizedCharsRemoved !== undefined) request.sanitizedCharsRemoved = sanitizedCharsRemoved;
  const result: ValidateDeployResult = { request };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

export function resolveDeployTimeoutSeconds(input: DeployTimeoutResolutionInput = {}): { timeout: number } | { error: string } {
  const explicitTimeoutError = validateDeployTimeoutSeconds(input.timeout, "timeout");
  if (explicitTimeoutError) return { error: explicitTimeoutError };
  if (input.timeout !== undefined) return { timeout: input.timeout };

  const rawEnvTimeout = (input.env ?? process.env)[PA_MAX_RUNTIME_ENV];
  if (rawEnvTimeout !== undefined && rawEnvTimeout !== "") {
    const envTimeout = Number(rawEnvTimeout);
    const envTimeoutError = validateDeployTimeoutSeconds(envTimeout, PA_MAX_RUNTIME_ENV);
    if (envTimeoutError) return { error: envTimeoutError };
    return { timeout: envTimeout };
  }

  return { timeout: DEFAULT_DEPLOY_TIMEOUT_SECONDS };
}

export function withResolvedDeployTimeout(request: DeployRequest, env: Record<string, string | undefined> = process.env): { request: DeployRequest } | { error: string } {
  const resolved = resolveDeployTimeoutSeconds({ timeout: request.timeout, env });
  if ("error" in resolved) return resolved;
  return { request: { ...request, timeout: resolved.timeout } };
}

function validateDeployTimeoutSeconds(timeout: number | undefined, label: string): string | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isInteger(timeout) || timeout < MIN_DEPLOY_TIMEOUT_SECONDS || timeout > MAX_DEPLOY_TIMEOUT_SECONDS) {
    return `${label} must be between ${MIN_DEPLOY_TIMEOUT_SECONDS} and ${MAX_DEPLOY_TIMEOUT_SECONDS} seconds`;
  }
  return undefined;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

function isSafeRepoSpecifier(value: string): boolean {
  if (isSafeIdentifier(value)) return true;
  if (value.includes("..")) return false;
  return /^(?:~\/|\/)[a-zA-Z0-9_./-]+$/.test(value);
}
