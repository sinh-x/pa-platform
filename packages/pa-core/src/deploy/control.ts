const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 7200;

export interface DeployRequest {
  team: string;
  mode?: string;
  objective?: string;
  repo?: string;
  ticket?: string;
  timeout?: number;
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
  selfUpdate?(): Promise<SelfUpdateStartResult> | SelfUpdateStartResult;
  getSelfUpdateStatus?(): Promise<SelfUpdateStatusResult> | SelfUpdateStatusResult;
}

export function validateDeployRequestFields(body: Record<string, unknown>): { request: DeployRequest } | { error: string } {
  const team = stringField(body, "team");
  const mode = stringField(body, "mode");
  const objective = stringField(body, "objective");
  const repo = stringField(body, "repo");
  const ticket = stringField(body, "ticket");
  const rawTimeout = body["timeout"];
  const timeout = typeof rawTimeout === "number" ? rawTimeout : undefined;

  if (!team?.trim()) return { error: "team is required" };
  if (!isSafeIdentifier(team)) return { error: "Invalid team name" };
  if (mode && !isSafeIdentifier(mode)) return { error: "Invalid mode name" };
  if (repo && !isSafeIdentifier(repo)) return { error: "Invalid repo name" };
  if (ticket && !/^[A-Z][A-Z0-9]+-[0-9]+$/.test(ticket)) return { error: "Invalid ticket ID" };
  if (rawTimeout !== undefined && typeof rawTimeout !== "number") return { error: "timeout must be a number" };
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_SECONDS || timeout > MAX_TIMEOUT_SECONDS)) return { error: `timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds` };
  if (objective && objective.trim()) {
    if (objective.length > 500) return { error: "objective exceeds max length of 500 characters" };
    if (/[\x00-\x1f\x7f`$\\;&|><]/.test(objective)) return { error: "objective contains invalid characters" };
  }

  return { request: { team, mode, objective: objective?.trim(), repo, ticket: ticket?.trim(), timeout } };
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}
