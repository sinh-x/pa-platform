import { Hono, type Context } from "hono";
import { isAbsolute, resolve } from "node:path";
import { getDeploymentEvents, queryDeploymentStatus, DeploymentCorrelationConflictError, DeploymentStartConflictError } from "../../registry/index.js";
import {
  DeploymentCorrelationValidationError,
  emitAmendedEvent,
  emitCompletedEvent,
  emitCrashedEvent,
  emitPidEvent,
  emitStartedEvent,
  validateCanonicalDeploymentId,
  validateDeploymentCorrelationEvidence,
  type DeploymentCorrelationEvidence,
} from "../../deploy/index.js";
import type { RuntimeName } from "../../types.js";

export const MAX_DEPLOYMENT_EVENT_BODY_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 4_096;
const MAX_TEXT_CHARS = 2_000;
const MAX_OBJECTIVE_CHARS = 256 * 1024;
const MAX_SHORT_CHARS = 256;

export interface DeploymentEventMutationPrincipal {
  deploymentId?: string;
  operator?: boolean;
}

export type DeploymentEventPrincipalResolver = (context: Context) => DeploymentEventMutationPrincipal;

export interface StartDeployBody extends DeploymentCorrelationEvidence {
  deploymentId: string;
  team: string;
  primer?: string;
  agents?: string[];
  models?: Record<string, string>;
  ticketId?: string;
  objective?: string;
  provider?: string;
  repo?: string;
  repoRoot?: string;
  worktreeRoot?: string;
  repositorySlot?: "orchestrator" | "implement";
  mode?: string;
  runtime?: RuntimeName;
  binary?: string;
  resumedFromDeploymentId?: string;
}

export interface PidBody {
  deploymentId: string;
  team: string;
  pid: number;
}

export interface CompleteBody extends Pick<StartDeployBody, "branchState" | "branchBaseSha" | "branchHeadSha"> {
  deploymentId: string;
  team: string;
  status?: "success" | "partial" | "failed";
  summary?: string;
  logFile?: string;
  exitCode?: number;
  fallback?: boolean;
}

export interface CrashBody extends Pick<StartDeployBody, "branchState" | "branchBaseSha" | "branchHeadSha"> {
  deploymentId: string;
  team: string;
  error?: string;
  exitCode?: number;
}

export interface AmendedBody {
  deploymentId: string;
  team: string;
  note?: string;
  status?: "success" | "partial" | "failed";
  summary?: string;
}

export function deployStatusRoutes(resolvePrincipal?: DeploymentEventPrincipalResolver): Hono {
  const app = new Hono();

  app.get("/api/deploy/status/:id", (c) => {
    const id = c.req.param("id");
    const status = queryDeploymentStatus(id);
    if (!status) return c.json({ error: "Deployment not found", code: "NOT_FOUND" }, 404);
    return c.json({ status });
  });

  app.get("/api/deploy/events/:id", (c) => {
    const id = c.req.param("id");
    return c.json({ events: getDeploymentEvents(id) });
  });

  app.post("/api/deploy/start", (c) => handleMutation(c, resolvePrincipal, START_FIELDS, (input, deploymentId) => {
    const team = requiredTeam(input["team"]);
    const ticketId = optionalTicketId(input["ticketId"]);
    const worktreeRoot = optionalCanonicalPath(input["worktreeRoot"], "worktreeRoot");
    const correlation = validateCorrelation(input, { ticketId, worktreeRoot, requireWorktreeMatch: hasBindingInput(input) });
    emitStartedEvent({
      deploymentId,
      team,
      primer: optionalString(input["primer"], MAX_PATH_CHARS, "primer"),
      agents: optionalStringArray(input["agents"], "agents"),
      models: optionalStringRecord(input["models"], "models"),
      ticketId,
      objective: optionalString(input["objective"], MAX_OBJECTIVE_CHARS, "objective"),
      provider: optionalIdentifier(input["provider"], "provider"),
      repo: optionalCanonicalPath(input["repo"], "repo"),
      repoRoot: optionalCanonicalPath(input["repoRoot"], "repoRoot"),
      worktreeRoot,
      repositorySlot: optionalEnum(input["repositorySlot"], ["orchestrator", "implement"] as const, "repositorySlot"),
      ...correlation,
      mode: optionalIdentifier(input["mode"], "mode"),
      runtime: optionalEnum(input["runtime"], ["claude", "opencode", "droid", "pi"] as const, "runtime"),
      binary: optionalIdentifier(input["binary"], "binary"),
      resumedFromDeploymentId: optionalCanonicalDeploymentId(input["resumedFromDeploymentId"], "resumedFromDeploymentId"),
    });
    return { ok: true, event: "started" };
  }));

  app.post("/api/deploy/pid", (c) => handleMutation(c, resolvePrincipal, PID_FIELDS, (input, deploymentId) => {
    const team = requiredTeam(input["team"]);
    assertExistingDeployment(deploymentId, team);
    emitPidEvent({ deploymentId, team, pid: requiredInteger(input["pid"], "pid", 1, 2_147_483_647) });
    return { ok: true, event: "pid" };
  }));

  app.post("/api/deploy/complete", (c) => handleMutation(c, resolvePrincipal, COMPLETE_FIELDS, (input, deploymentId) => {
    const team = requiredTeam(input["team"]);
    assertExistingDeployment(deploymentId, team);
    const correlation = validateCorrelation(input);
    emitCompletedEvent({
      deploymentId,
      team,
      status: optionalEnum(input["status"], ["success", "partial", "failed"] as const, "status"),
      summary: optionalString(input["summary"], MAX_TEXT_CHARS, "summary"),
      logFile: optionalString(input["logFile"], MAX_PATH_CHARS, "logFile"),
      exitCode: optionalInteger(input["exitCode"], "exitCode", -2_147_483_648, 2_147_483_647),
      fallback: optionalBoolean(input["fallback"], "fallback"),
      ...correlation,
    });
    return { ok: true, event: "completed" };
  }));

  app.post("/api/deploy/crash", (c) => handleMutation(c, resolvePrincipal, CRASH_FIELDS, (input, deploymentId) => {
    const team = requiredTeam(input["team"]);
    assertExistingDeployment(deploymentId, team);
    const correlation = validateCorrelation(input);
    emitCrashedEvent({
      deploymentId,
      team,
      error: optionalString(input["error"], MAX_TEXT_CHARS, "error"),
      exitCode: optionalInteger(input["exitCode"], "exitCode", -2_147_483_648, 2_147_483_647),
      ...correlation,
    });
    return { ok: true, event: "crashed" };
  }));

  app.post("/api/deploy/amend", (c) => handleMutation(c, resolvePrincipal, AMEND_FIELDS, (input, deploymentId) => {
    const team = requiredTeam(input["team"]);
    assertExistingDeployment(deploymentId, team);
    emitAmendedEvent({
      deploymentId,
      team,
      note: optionalString(input["note"], MAX_TEXT_CHARS, "note"),
      status: optionalEnum(input["status"], ["success", "partial", "failed"] as const, "status"),
      summary: optionalString(input["summary"], MAX_TEXT_CHARS, "summary"),
    });
    return { ok: true, event: "amended" };
  }));

  return app;
}

const CORRELATION_FIELDS = ["parentDeploymentId", "builderAuthority", "treehousePath", "treehouseLeaseId", "treehouseLeaseHolder", "branchState", "branchBaseSha", "branchHeadSha", "ticketSlotId", "repositoryPermit"] as const;
const START_FIELDS = new Set(["deploymentId", "team", "primer", "agents", "models", "ticketId", "objective", "provider", "repo", "repoRoot", "worktreeRoot", "repositorySlot", ...CORRELATION_FIELDS, "mode", "runtime", "binary", "resumedFromDeploymentId"]);
const PID_FIELDS = new Set(["deploymentId", "team", "pid"]);
const COMPLETE_FIELDS = new Set(["deploymentId", "team", "status", "summary", "logFile", "exitCode", "fallback", "branchState", "branchBaseSha", "branchHeadSha"]);
const CRASH_FIELDS = new Set(["deploymentId", "team", "error", "exitCode", "branchState", "branchBaseSha", "branchHeadSha"]);
const AMEND_FIELDS = new Set(["deploymentId", "team", "note", "status", "summary"]);

class DeploymentEventInputError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) { super(message); }
}

async function handleMutation(
  context: Context,
  resolvePrincipal: DeploymentEventPrincipalResolver | undefined,
  allowedFields: ReadonlySet<string>,
  mutate: (input: Record<string, unknown>, deploymentId: string) => Record<string, unknown>,
): Promise<Response> {
  try {
    const input = await readBoundedJsonObject(context);
    rejectUnknownFields(input, allowedFields);
    const deploymentId = validateCanonicalDeploymentId(input["deploymentId"]);
    const principal = resolvePrincipal?.(context) ?? {};
    if (!principal.operator && !principal.deploymentId) {
      return context.json({ error: "Authenticated deployment-scoped or operator principal required", code: "UNAUTHORIZED" }, 401);
    }
    if (!principal.operator && principal.deploymentId !== deploymentId) {
      return context.json({ error: "Deployment-scoped principal does not match request deploymentId", code: "FORBIDDEN" }, 403);
    }
    return context.json(mutate(input, deploymentId));
  } catch (error) {
    if (error instanceof DeploymentEventInputError) return context.json({ error: error.message, code: error.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST" }, error.status);
    if (error instanceof DeploymentStartConflictError || error instanceof DeploymentCorrelationConflictError) return context.json({ error: boundedDiagnostic(error.message), code: "CONFLICT" }, 409);
    if (error instanceof DeploymentCorrelationValidationError) return context.json({ error: boundedDiagnostic(error.message), code: "BAD_REQUEST" }, 400);
    throw error;
  }
}

async function readBoundedJsonObject(context: Context): Promise<Record<string, unknown>> {
  const declared = context.req.header("content-length");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_DEPLOYMENT_EVENT_BODY_BYTES)) {
    throw new DeploymentEventInputError(`Deployment event body must not exceed ${MAX_DEPLOYMENT_EVENT_BODY_BYTES} bytes`, 413);
  }
  const bytes = new Uint8Array(await context.req.arrayBuffer());
  if (bytes.byteLength > MAX_DEPLOYMENT_EVENT_BODY_BYTES) throw new DeploymentEventInputError(`Deployment event body must not exceed ${MAX_DEPLOYMENT_EVENT_BODY_BYTES} bytes`, 413);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DeploymentEventInputError("Deployment event body must be one valid UTF-8 JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeploymentEventInputError("Deployment event body must be a JSON object");
  return value as Record<string, unknown>;
}

function validateCorrelation(input: Record<string, unknown>, context: { ticketId?: string; worktreeRoot?: string; requireWorktreeMatch?: boolean } = {}): DeploymentCorrelationEvidence {
  return validateDeploymentCorrelationEvidence(Object.fromEntries(CORRELATION_FIELDS.map((field) => [field, input[field]])), context);
}

function hasBindingInput(input: Record<string, unknown>): boolean {
  return ["parentDeploymentId", "builderAuthority", "treehousePath", "treehouseLeaseId", "treehouseLeaseHolder", "ticketSlotId", "repositoryPermit"]
    .some((field) => input[field] !== undefined);
}

function assertExistingDeployment(deploymentId: string, team: string): void {
  const existing = queryDeploymentStatus(deploymentId);
  if (!existing) throw new DeploymentCorrelationConflictError("Condition: deployment lifecycle identity. Source: registry start projection. Reason: no started deployment exists. Correction: authenticate and persist start first. Resume Action: retry the lifecycle event only after the matching start succeeds.");
  if (existing.team !== team) throw new DeploymentCorrelationConflictError("Condition: deployment lifecycle identity. Source: registry start projection. Reason: team does not match immutable start identity. Correction: preserve the existing deployment identity. Resume Action: retry with the exact started team.");
}

function rejectUnknownFields(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(input).some((field) => !allowed.has(field))) throw new DeploymentEventInputError("Deployment event body contains an unsupported field");
}

function requiredTeam(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) throw new DeploymentEventInputError("team must be a canonical bounded identifier");
  return value;
}

function optionalTicketId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(value) || value.length > 64) throw new DeploymentEventInputError("ticketId must be canonical");
  return value;
}

function optionalCanonicalDeploymentId(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : validateCanonicalDeploymentId(value, field);
}

function optionalCanonicalPath(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    throw new DeploymentEventInputError(`${field} must be a normalized absolute path of at most ${MAX_PATH_CHARS} characters`);
  }
  return value;
}

function optionalString(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) throw new DeploymentEventInputError(`${field} must be a non-empty string of at most ${max} characters`);
  return value;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SHORT_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(value)) throw new DeploymentEventInputError(`${field} must be a canonical bounded identifier`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > MAX_SHORT_CHARS || item.includes("\0"))) throw new DeploymentEventInputError(`${field} must be an array of at most 64 bounded strings`);
  return [...value] as string[];
}

function optionalStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeploymentEventInputError(`${field} must be a bounded string map`);
  const entries = Object.entries(value);
  if (entries.length > 64 || entries.some(([key, item]) => key.length === 0 || key.length > 128 || typeof item !== "string" || item.length === 0 || item.length > MAX_SHORT_CHARS)) throw new DeploymentEventInputError(`${field} must be a bounded string map`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new DeploymentEventInputError(`${field} must be boolean`);
  return value;
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new DeploymentEventInputError(`${field} must be an integer between ${min} and ${max}`);
  return Number(value);
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, field, min, max);
}

function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new DeploymentEventInputError(`${field} has an unsupported value`);
  return value as T[number];
}

function boundedDiagnostic(value: string): string {
  return value.length <= MAX_TEXT_CHARS ? value : `${value.slice(0, MAX_TEXT_CHARS - 3)}...`;
}
