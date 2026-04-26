const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 7200;

export interface DeployRequest {
  team: string;
  mode?: string;
  objective?: string;
  repo?: string;
  ticket?: string;
  timeout?: number;
  dryRun?: boolean;
  background?: boolean;
  interactive?: boolean;
  direct?: boolean;
  provider?: string;
  model?: string;
  teamModel?: string;
  agentModel?: string;
  resume?: string;
  listModes?: boolean;
  validate?: boolean;
}

export interface DeployHookResult {
  status: "pending" | "failed";
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
}

export function validateDeployRequestFields(body: Record<string, unknown>): { request: DeployRequest } | { error: string } {
  const team = stringField(body, "team");
  const mode = stringField(body, "mode");
  const objective = stringField(body, "objective");
  const repo = stringField(body, "repo");
  const ticket = stringField(body, "ticket");
  const provider = stringField(body, "provider");
  const model = stringField(body, "model");
  const teamModel = stringField(body, "teamModel");
  const agentModel = stringField(body, "agentModel");
  const resume = stringField(body, "resume");
  const rawTimeout = body["timeout"];
  const timeout = typeof rawTimeout === "number" ? rawTimeout : undefined;
  const dryRun = booleanField(body, "dryRun");
  const background = booleanField(body, "background");
  const interactive = booleanField(body, "interactive");
  const direct = booleanField(body, "direct");
  const listModes = booleanField(body, "listModes");
  const validate = booleanField(body, "validate");

  if (!team?.trim()) return { error: "team is required" };
  if (!isSafeIdentifier(team)) return { error: "Invalid team name" };
  if (mode && !isSafeIdentifier(mode)) return { error: "Invalid mode name" };
  if (repo && !isSafeIdentifier(repo)) return { error: "Invalid repo name" };
  if (ticket && !/^[A-Z][A-Z0-9]+-[0-9]+$/.test(ticket)) return { error: "Invalid ticket ID" };
  if (provider && !/^[a-zA-Z0-9_-]+$/.test(provider)) return { error: "Invalid provider name" };
  if (model && !/^[a-zA-Z0-9_.\/-]+$/.test(model)) return { error: "Invalid model name" };
  if (teamModel && !/^[a-zA-Z0-9_.\/-]+$/.test(teamModel)) return { error: "Invalid team model name" };
  if (agentModel && !/^[a-zA-Z0-9_.\/-]+$/.test(agentModel)) return { error: "Invalid agent model name" };
  if (resume && !/^[a-zA-Z0-9-]+$/.test(resume)) return { error: "Invalid resume deployment id" };
  if (rawTimeout !== undefined && typeof rawTimeout !== "number") return { error: "timeout must be a number" };
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_SECONDS || timeout > MAX_TIMEOUT_SECONDS)) return { error: `timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds` };
  if (objective && objective.trim()) {
    if (objective.length > 10000) return { error: "objective exceeds max length of 10000 characters" };
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f`$\\;&|><]/.test(objective)) return { error: "objective contains invalid characters" };
  }

  const request: DeployRequest = { team };
  if (mode) request.mode = mode;
  if (objective?.trim()) request.objective = objective.trim();
  if (repo) request.repo = repo;
  if (ticket?.trim()) request.ticket = ticket.trim();
  if (timeout !== undefined) request.timeout = timeout;
  if (dryRun !== undefined) request.dryRun = dryRun;
  if (background !== undefined) request.background = background;
  if (interactive !== undefined) request.interactive = interactive;
  if (direct !== undefined) request.direct = direct;
  if (provider) request.provider = provider;
  if (model) request.model = model;
  if (teamModel) request.teamModel = teamModel;
  if (agentModel) request.agentModel = agentModel;
  if (resume) request.resume = resume;
  if (listModes !== undefined) request.listModes = listModes;
  if (validate !== undefined) request.validate = validate;
  return { request };
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
