import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "./db.js";
import type { AssociateDeploymentTicketInput, AssociateDeploymentTicketResult, DeploymentStatus, EvaluatorResult, Rating, RegistryEvent, TicketAssociatedRegistryEvent } from "../types.js";
import { parseTimestamp } from "../time.js";
import { validateDeploymentCorrelationEvidence } from "../deploy/correlation.js";
import { formatBoundedFiveFieldDiagnostic, loadReposYaml } from "../repos.js";
import { TicketStore } from "../tickets/store.js";
import { isCanonicalTicketId } from "../tickets/validate.js";

// Ported from PA registry.ts/registry-db.ts at frozen PA source on 2026-04-26; runtime/binary columns are additive for pa-platform.

export { closeDb, getDb, verifyRegistryNativeAddon, REGISTRY_NATIVE_BINDING_ENV, type RegistryNativeAddonEvidence } from "./db.js";

export const PA_PI_EXECUTION_MODE_ENV = "PA_PI_EXECUTION_MODE";
export const PI_FOREGROUND_COMPLETION_FILE = "pi-foreground-completion.json";
export const MAX_PI_FOREGROUND_COMPLETION_BYTES = 16 * 1024;
const MAX_PI_COMPLETION_SUMMARY_CHARS = 2_000;
const MAX_PI_COMPLETION_LOG_FILE_CHARS = 4_096;

export interface PiForegroundCompletion {
  type: "registry_complete";
  deploymentId: string;
  status: "success" | "partial" | "failed";
  timestamp: string;
  summary?: string;
  logFile?: string;
  rating?: Rating;
  fallback?: boolean;
}

export function piForegroundCompletionPath(deployDir: string): string {
  return resolve(deployDir, PI_FOREGROUND_COMPLETION_FILE);
}

export function clearPiForegroundCompletion(deployDir: string): void {
  try {
    unlinkSync(piForegroundCompletionPath(deployDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function writePiForegroundCompletion(deployDir: string, completion: PiForegroundCompletion): void {
  const validated = validatePiForegroundCompletion(completion);
  const body = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_PI_FOREGROUND_COMPLETION_BYTES) {
    throw new Error(`Pi foreground completion sidecar exceeds ${MAX_PI_FOREGROUND_COMPLETION_BYTES} bytes`);
  }
  mkdirSync(deployDir, { recursive: true });
  const path = piForegroundCompletionPath(deployDir);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

export function readPiForegroundCompletion(deployDir: string): PiForegroundCompletion | undefined {
  const path = piForegroundCompletionPath(deployDir);
  if (!existsSync(path)) return undefined;
  try {
    const descriptor = openSync(path, "r");
    let body: string;
    try {
      const buffer = Buffer.alloc(MAX_PI_FOREGROUND_COMPLETION_BYTES + 1);
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (bytes > MAX_PI_FOREGROUND_COMPLETION_BYTES) throw new Error("oversized");
      body = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
    return validatePiForegroundCompletion(JSON.parse(body) as unknown);
  } catch {
    throw new Error("Pi foreground completion sidecar is malformed or exceeds its size limit");
  }
}

function validatePiForegroundCompletion(value: unknown): PiForegroundCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi foreground completion must be an object");
  const input = value as Record<string, unknown>;
  if (input["type"] !== "registry_complete") throw new Error("Pi foreground completion type is invalid");
  const deploymentId = requiredBoundedString(input["deploymentId"], 128, "deploymentId");
  const status = input["status"];
  if (status !== "success" && status !== "partial" && status !== "failed") throw new Error("Pi foreground completion status is invalid");
  const timestamp = parseTimestamp(requiredBoundedString(input["timestamp"], 64, "timestamp")).toISOString();
  const summary = optionalBoundedString(input["summary"], MAX_PI_COMPLETION_SUMMARY_CHARS, "summary");
  const logFile = optionalBoundedString(input["logFile"], MAX_PI_COMPLETION_LOG_FILE_CHARS, "logFile");
  const rating = validatePiCompletionRating(input["rating"]);
  const fallback = input["fallback"];
  if (fallback !== undefined && typeof fallback !== "boolean") throw new Error("Pi foreground completion fallback is invalid");
  return { type: "registry_complete", deploymentId, status, timestamp, ...(summary ? { summary } : {}), ...(logFile ? { logFile } : {}), ...(rating ? { rating } : {}), ...(fallback === true ? { fallback: true } : {}) };
}

function requiredBoundedString(value: unknown, maxChars: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) throw new Error(`Pi foreground completion ${field} is invalid`);
  return value;
}

function optionalBoundedString(value: unknown, maxChars: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredBoundedString(value, maxChars, field);
}

function validatePiCompletionRating(value: unknown): Rating | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi foreground completion rating is invalid");
  const input = value as Record<string, unknown>;
  const source = input["source"];
  if (source !== "agent" && source !== "system" && source !== "user") throw new Error("Pi foreground completion rating source is invalid");
  const overall = ratingNumber(input["overall"], "overall");
  const productivity = optionalRatingNumber(input["productivity"], "productivity");
  const quality = optionalRatingNumber(input["quality"], "quality");
  const efficiency = optionalRatingNumber(input["efficiency"], "efficiency");
  const insight = optionalRatingNumber(input["insight"], "insight");
  return { source, overall, ...(productivity !== undefined ? { productivity } : {}), ...(quality !== undefined ? { quality } : {}), ...(efficiency !== undefined ? { efficiency } : {}), ...(insight !== undefined ? { insight } : {}) };
}

function ratingNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) throw new Error(`Pi foreground completion rating ${field} is invalid`);
  return value;
}

function optionalRatingNumber(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : ratingNumber(value, field);
}

export function validateRegistryEvent(event: RegistryEvent): void {
  for (const field of ["deployment_id", "team", "event", "timestamp"] as const) {
    if (!event[field]) throw new Error(`Registry event missing required field: ${field}`);
  }
  validateDeploymentCorrelationEvidence(correlationToValidationInput(event), {
    ticketId: event.ticket_id,
    worktreeRoot: event.worktree_root,
    requireWorktreeMatch: event.event === "started" && hasTreehouseBinding(event),
  });
}

export class DeploymentStartConflictError extends Error {}
export class DeploymentCorrelationConflictError extends Error {}

export type TicketAssociationErrorCode =
  | "deployment-not-found"
  | "deployment-not-running"
  | "repository-identity-missing"
  | "repository-unregistered"
  | "invalid-ticket-id"
  | "ticket-not-found"
  | "ticket-project-mismatch"
  | "stale-expectation"
  | "protected-builder-replacement"
  | "invalid-actor"
  | "invalid-reason";

export class TicketAssociationError extends Error {
  constructor(readonly code: TicketAssociationErrorCode, message: string) {
    super(message);
    this.name = "TicketAssociationError";
  }
}

/**
 * Atomically compare-and-set the current ticket projection for one running
 * deployment. Immutable start evidence is only read; association history is
 * appended as one structured event in the same immediate transaction.
 */
export function associateDeploymentTicket(input: AssociateDeploymentTicketInput): AssociateDeploymentTicketResult {
  const actor = validatedAssociationText(input.actor, 128, "actor", "invalid-actor");
  const reason = validatedAssociationText(input.reason, 1_000, "reason", "invalid-reason");
  if (!isCanonicalTicketId(input.ticketId)) {
    throw associationError("invalid-ticket-id", "deployment ticket association rejected", "canonical target ticket validation", "the requested ticket ID is not canonical", "provide an uppercase project prefix, hyphen, and numeric sequence within 64 characters", "retry with a canonical same-project ticket ID");
  }
  const requestedTicketId = input.ticketId;
  if (input.expectedTicketId !== null && !isCanonicalTicketId(input.expectedTicketId)) {
    throw associationError("invalid-ticket-id", "deployment ticket association rejected", "canonical expected ticket validation", "the expected ticket ID is not canonical", "use null for no current ticket or provide the exact canonical current ticket ID", "reread the current projection and retry with canonical compare-and-set evidence");
  }

  const db = getDb();
  return db.transaction(() => {
    const projection = db.prepare("SELECT * FROM deployments WHERE deployment_id = ?").get(input.deploymentId) as Record<string, unknown> | undefined;
    const start = db.prepare("SELECT * FROM registry_events WHERE deployment_id = ? AND event = 'started' ORDER BY id LIMIT 1").get(input.deploymentId) as Record<string, unknown> | undefined;
    if (!projection || !start) {
      throw associationError("deployment-not-found", "deployment ticket association rejected", "registry deployment lookup", "the deployment projection or immutable start event does not exist", "provide an existing deployment ID with complete registry evidence", "reread the registry and retry for that deployment");
    }
    if (projection["status"] !== "running") {
      throw associationError("deployment-not-running", "deployment ticket association rejected", "registry deployment projection", "only a running deployment can change its current ticket association", "preserve terminal deployment history and select a running deployment", "retry only while the target deployment is running");
    }

    const repoRoot = typeof start["repo_root"] === "string" && start["repo_root"].length > 0 ? start["repo_root"] : undefined;
    if (!repoRoot || projection["repo_root"] !== repoRoot) {
      throw associationError("repository-identity-missing", "deployment repository association rejected", "immutable start and current registry projection", "registered canonical repository identity is missing or inconsistent", "restore matching canonical repo_root evidence without rewriting launch history", "retry after registry identity evidence is reconciled");
    }
    let repositoryMatches: Array<[string, { path: string }]>;
    try {
      repositoryMatches = Object.entries(loadReposYaml()).filter((entry): entry is [string, { path: string }] => entry[1].path === repoRoot);
    } catch {
      repositoryMatches = [];
    }
    if (repositoryMatches.length !== 1) {
      throw associationError("repository-unregistered", "deployment repository association rejected", "canonical repository registry", "the deployment repo_root does not resolve to exactly one registered project", "register one canonical project for the immutable repo_root", "retry after canonical repository registration is unambiguous");
    }
    const projectKey = repositoryMatches[0]![0];
    let ticket: ReturnType<TicketStore["get"]>;
    try {
      ticket = new TicketStore().get(requestedTicketId);
    } catch {
      throw associationError("ticket-not-found", "deployment ticket association rejected", "ticket store lookup", "the requested ticket is unavailable or invalid", "provide an existing canonical ticket with valid store data", "retry with a ticket in the deployment project");
    }
    if (!ticket) {
      throw associationError("ticket-not-found", "deployment ticket association rejected", "ticket store lookup", "the requested ticket does not exist", "provide an existing ticket ID", "retry with a ticket in the deployment project");
    }
    if (ticket.project !== projectKey) {
      throw associationError("ticket-project-mismatch", "deployment repository association rejected", "canonical repository and ticket project validation", "the requested ticket belongs to a different canonical project", "select a ticket whose project resolves to the deployment repo_root", "retry with a same-project ticket");
    }

    const previousTicketId = typeof projection["ticket_id"] === "string" && projection["ticket_id"].length > 0 ? projection["ticket_id"] : null;
    if (input.expectedTicketId !== previousTicketId) {
      throw associationError("stale-expectation", "deployment ticket association rejected", "atomic compare-and-set validation", "the expected ticket does not equal the current projected ticket", "reread the current ticket projection", "retry with null for no current ticket or the exact current ticket ID");
    }
    if (previousTicketId === requestedTicketId) {
      return { deploymentId: input.deploymentId, previousTicketId, requestedTicketId, currentTicketId: previousTicketId, actor, reason, writeOccurred: false };
    }
    if (previousTicketId !== null && hasProtectedBuilderLaunchEvidence(start)) {
      throw associationError("protected-builder-replacement", "protected builder ticket replacement rejected", "immutable deployment start evidence", "an already-ticketed deployment has builder, Treehouse, ticket-slot, repository-permit, or parent-lineage evidence", "preserve the launch ticket and start a separately admitted builder lineage for different ticket work", "resume the existing ticket or launch a correctly ticketed deployment");
    }

    const event: TicketAssociatedRegistryEvent = {
      deployment_id: input.deploymentId,
      team: String(start["team"]),
      event: "ticket-associated",
      timestamp: input.timestamp ?? new Date().toISOString(),
      previous_ticket_id: previousTicketId,
      ticket_id: requestedTicketId,
      actor,
      reason,
    };
    validateRegistryEvent(event);
    assertEventMatchesStartedIdentity(db, event);
    insertRegistryEvent(db, event);
    const update = previousTicketId === null
      ? db.prepare("UPDATE deployments SET ticket_id = ? WHERE deployment_id = ? AND status = 'running' AND ticket_id IS NULL").run(requestedTicketId, input.deploymentId)
      : db.prepare("UPDATE deployments SET ticket_id = ? WHERE deployment_id = ? AND status = 'running' AND ticket_id = ?").run(requestedTicketId, input.deploymentId, previousTicketId);
    if (update.changes !== 1) {
      throw associationError("stale-expectation", "deployment ticket association rejected", "atomic projection compare-and-set", "the current ticket projection changed before persistence", "reread the current deployment ticket", "retry with the exact current ticket expectation");
    }
    const current = db.prepare("SELECT ticket_id FROM deployments WHERE deployment_id = ?").get(input.deploymentId) as { ticket_id?: unknown } | undefined;
    if (current?.ticket_id !== requestedTicketId) throw new Error("Ticket association projection verification failed");
    return { deploymentId: input.deploymentId, previousTicketId, requestedTicketId, currentTicketId: requestedTicketId, actor, reason, writeOccurred: true };
  }).immediate();
}

function validatedAssociationText(value: string, maxChars: number, field: "actor" | "reason", code: "invalid-actor" | "invalid-reason"): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 1 || normalized.length > maxChars) {
    throw associationError(code, "deployment ticket association rejected", `${field} validation`, `${field} must contain 1-${maxChars} UTF-16 code units after trimming and is never truncated`, `provide a bounded non-empty ${field}`, `retry with a valid ${field}`);
  }
  return normalized;
}

function hasProtectedBuilderLaunchEvidence(start: Record<string, unknown>): boolean {
  return (start["team"] === "builder" && (start["mode"] === "orchestrator" || start["mode"] === "implement"))
    || start["repository_slot"] === "orchestrator" || start["repository_slot"] === "implement"
    || start["builder_authority"] != null || start["parent_deployment_id"] != null
    || start["treehouse_path"] != null || start["treehouse_lease_id"] != null || start["treehouse_lease_holder"] != null
    || start["ticket_slot_id"] != null || start["repository_permit"] != null;
}

function associationError(code: TicketAssociationErrorCode, condition: string, source: string, reason: string, correction: string, resumeAction: string): TicketAssociationError {
  return new TicketAssociationError(code, formatBoundedFiveFieldDiagnostic({ condition, source, reason, correction, resumeAction }));
}

export interface AdvanceParentAuthoritySnapshotOptions {
  parentDeploymentId: string;
  childDeploymentId: string;
  expectedBranchHeadSha: string;
  branchState: "materialized";
  branchHeadSha: string;
  timestamp?: string;
}

/**
 * Advances only the mutable branch snapshot projected for one running
 * orchestrator after its exact direct child finalizes repository authority.
 * The parent's started event remains immutable audit evidence.
 */
export function advanceParentAuthoritySnapshot(options: AdvanceParentAuthoritySnapshotOptions): void {
  const db = getDb();
  db.transaction(() => {
    const parent = db.prepare("SELECT * FROM deployments WHERE deployment_id = ?").get(options.parentDeploymentId) as Record<string, unknown> | undefined;
    const parentStart = db.prepare("SELECT * FROM registry_events WHERE deployment_id = ? AND event = 'started' ORDER BY id LIMIT 1").get(options.parentDeploymentId) as Record<string, unknown> | undefined;
    const childStart = db.prepare("SELECT * FROM registry_events WHERE deployment_id = ? AND event = 'started' ORDER BY id LIMIT 1").get(options.childDeploymentId) as Record<string, unknown> | undefined;
    const fail = (reason: string): never => {
      throw new DeploymentCorrelationConflictError(correlationConflictDiagnostic(`parent authority snapshot advance rejected: ${reason}`));
    };
    if (!parent || !parentStart || !childStart) fail("parent projection, immutable parent start, or immutable child start is absent");
    const exactParent = parent as Record<string, unknown>;
    const exactParentStart = parentStart as Record<string, unknown>;
    const exactChildStart = childStart as Record<string, unknown>;
    if (exactParent["status"] !== "running"
      || exactParentStart["team"] !== "builder" || exactParentStart["mode"] !== "orchestrator"
      || exactParentStart["runtime"] !== "pi" || exactParentStart["binary"] !== "ppa"
      || exactParentStart["builder_authority"] !== "orchestrator") {
      fail("the parent is not the exact live PPA builder/orchestrator authority");
    }
    const matchingFields = [
      "ticket_id", "repo", "repo_root", "worktree_root", "treehouse_path", "treehouse_lease_id", "treehouse_lease_holder",
      "branch_state", "branch_base_sha", "ticket_slot_id", "repository_permit",
    ] as const;
    if (exactChildStart["team"] !== "builder" || exactChildStart["mode"] !== "implement"
      || exactChildStart["runtime"] !== "pi" || exactChildStart["binary"] !== "ppa"
      || exactChildStart["parent_deployment_id"] !== options.parentDeploymentId
      || exactChildStart["builder_authority"] !== "parented-implement"
      || exactChildStart["branch_head_sha"] !== options.expectedBranchHeadSha
      || matchingFields.some((field) => exactChildStart[field] !== exactParent[field])) {
      fail("the child immutable start is not the exact direct child of the current parent authority snapshot");
    }
    if (exactParent["branch_state"] !== "materialized"
      || exactParent["branch_head_sha"] !== options.expectedBranchHeadSha) {
      const existing = db.prepare("SELECT id FROM registry_events WHERE deployment_id = ? AND event = 'updated' AND note = ? AND branch_head_sha = ? ORDER BY id LIMIT 1")
        .get(options.parentDeploymentId, `direct-child-authority:${options.childDeploymentId}`, options.branchHeadSha);
      if (exactParent["branch_state"] === "materialized" && exactParent["branch_head_sha"] === options.branchHeadSha && existing) return;
      const priorAuthorityUpdate = db.prepare("SELECT id FROM registry_events WHERE deployment_id = ? AND event = 'updated' AND note LIKE 'direct-child-authority:%' ORDER BY id LIMIT 1")
        .get(options.parentDeploymentId);
      const reconcilesInitialBranchTransition = exactParent["branch_state"] === "materialized"
        && exactParent["branch_head_sha"] === exactParentStart["branch_head_sha"]
        && priorAuthorityUpdate === undefined;
      if (!reconcilesInitialBranchTransition) fail("the parent's current projected branch snapshot does not match the mutex-protected expected predecessor");
    }
    const event: RegistryEvent = {
      deployment_id: options.parentDeploymentId,
      team: "builder",
      event: "updated",
      timestamp: options.timestamp ?? new Date().toISOString(),
      note: `direct-child-authority:${options.childDeploymentId}`,
      branch_state: options.branchState,
      branch_base_sha: typeof exactParent["branch_base_sha"] === "string" ? exactParent["branch_base_sha"] : undefined,
      branch_head_sha: options.branchHeadSha,
    };
    validateRegistryEvent(event);
    assertEventMatchesStartedIdentity(db, event);
    insertRegistryEvent(db, event);
    upsertDeployment(db, event);
  }).immediate();
}

export function appendRegistryEvent(event: RegistryEvent): void {
  if (event.event === "ticket-associated") throw new Error("Use associateDeploymentTicket for ticket-associated events");
  validateRegistryEvent(event);
  const db = getDb();
  if (event.event === "started") {
    db.transaction(() => {
      const existingRow = db.prepare("SELECT * FROM registry_events WHERE deployment_id = ? AND event = 'started' ORDER BY id LIMIT 1").get(event.deployment_id) as Record<string, unknown> | undefined;
      if (existingRow) {
        assertExactStartedReplay(existingRow, event);
        return;
      }
      const projected = db.prepare("SELECT deployment_id FROM deployments WHERE deployment_id = ?").get(event.deployment_id);
      if (projected) throw new DeploymentStartConflictError(startConflictDiagnostic("a deployment projection exists without matching immutable start evidence"));
      insertRegistryEvent(db, event);
      upsertDeployment(db, event);
    }).immediate();
    return;
  }
  db.transaction(() => {
    assertEventMatchesStartedIdentity(db, event);
    insertRegistryEvent(db, event);
    upsertDeployment(db, event);
  }).immediate();
}

export interface ReconcileTerminalRegistryEventResult {
  event: RegistryEvent;
  retainedExisting: boolean;
}

/**
 * Atomically selects exactly one terminal representation. Existing failure is
 * sticky, matching success is idempotent, and later failure replaces success.
 */
export function reconcileTerminalRegistryEvent(requested: RegistryEvent): ReconcileTerminalRegistryEventResult {
  validateRegistryEvent(requested);
  if (requested.event !== "completed" && requested.event !== "crashed") throw new Error("Terminal reconciliation requires a completed or crashed event");
  const db = getDb();
  return db.transaction(() => {
    assertEventMatchesStartedIdentity(db, requested);
    const existingRows = terminalRows(db, requested.deployment_id);
    const existing = existingRows.map(fromRow).find(isFailedTerminal) ?? existingRows.map(fromRow)[0];
    if (existing && (isFailedTerminal(existing) || !isFailedTerminal(requested))) {
      const retained = withTerminalCorrelation(existing, requested);
      if (existingRows.length > 1 || retained !== existing) {
        db.prepare("DELETE FROM registry_events WHERE deployment_id = ? AND event IN ('completed', 'crashed')").run(requested.deployment_id);
        insertRegistryEvent(db, retained);
        upsertDeployment(db, retained);
      }
      return { event: retained, retainedExisting: true };
    }

    db.prepare("DELETE FROM registry_events WHERE deployment_id = ? AND event IN ('completed', 'crashed')").run(requested.deployment_id);
    insertRegistryEvent(db, requested);
    upsertDeployment(db, requested);
    return { event: requested, retainedExisting: false };
  })();
}

/**
 * Atomically inserts a synthetic terminal event only when no terminal result
 * has committed. Unlike supervisor reconciliation, this never replaces an
 * existing success or failure and is reserved for observer-owned recovery.
 */
export function reconcileTerminalRegistryEventIfAbsent(requested: RegistryEvent): ReconcileTerminalRegistryEventResult {
  validateRegistryEvent(requested);
  if (requested.event !== "completed" && requested.event !== "crashed") throw new Error("Terminal reconciliation requires a completed or crashed event");
  const db = getDb();
  const transaction = db.transaction(() => {
    assertEventMatchesStartedIdentity(db, requested);
    const existingRows = terminalRows(db, requested.deployment_id);
    const existing = existingRows.map(fromRow)[0];
    if (existing) return { event: existing, retainedExisting: true };
    insertRegistryEvent(db, requested);
    upsertDeployment(db, requested);
    return { event: requested, retainedExisting: false };
  });
  return transaction.immediate();
}

function terminalRows(db: ReturnType<typeof getDb>, deploymentId: string): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM registry_events WHERE deployment_id = ? AND event IN ('completed', 'crashed') ORDER BY id").all(deploymentId) as Record<string, unknown>[];
}

function insertRegistryEvent(db: ReturnType<typeof getDb>, event: RegistryEvent): void {
  const row = toRow(event);
  db.prepare(`
    INSERT INTO registry_events (
      deployment_id, team, event, timestamp, pid, status, summary, log_file,
      primer, agents, models, error, exit_code, ticket_id, previous_ticket_id, actor, reason, provider, rating,
      objective, repo, repo_root, worktree_root, repository_slot, parent_deployment_id, builder_authority,
      treehouse_path, treehouse_lease_id, treehouse_lease_holder, branch_state, branch_base_sha, branch_head_sha, ticket_slot_id, repository_permit,
      mode, fallback, resumed_from_deployment_id, note, runtime, binary, effective_timeout_seconds, rogue_one, invocation_channel
    ) VALUES (
      @deployment_id, @team, @event, @timestamp, @pid, @status, @summary, @log_file,
      @primer, @agents, @models, @error, @exit_code, @ticket_id, @previous_ticket_id, @actor, @reason, @provider, @rating,
      @objective, @repo, @repo_root, @worktree_root, @repository_slot, @parent_deployment_id, @builder_authority,
      @treehouse_path, @treehouse_lease_id, @treehouse_lease_holder, @branch_state, @branch_base_sha, @branch_head_sha, @ticket_slot_id, @repository_permit,
      @mode, @fallback, @resumed_from_deployment_id, @note, @runtime, @binary, @effective_timeout_seconds, @rogue_one, @invocation_channel
    )
  `).run(row);
}

export function readRegistry(): RegistryEvent[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM registry_events ORDER BY id").all() as Record<string, unknown>[]).map(fromRow);
}

export function getDeploymentEvents(deployId: string): RegistryEvent[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM registry_events WHERE deployment_id = ? ORDER BY id").all(deployId) as Record<string, unknown>[]).map(fromRow);
}

export function queryDeploymentStatuses(): DeploymentStatus[] {
  const db = getDb();
  return sortDeploymentsByStartedAt((db.prepare("SELECT * FROM deployments").all() as Record<string, unknown>[]).map(deploymentFromRow));
}

export function queryDeploymentStatus(deployId: string): DeploymentStatus | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM deployments WHERE deployment_id = ?").get(deployId) as Record<string, unknown> | undefined;
  return row ? deploymentFromRow(row) : null;
}

export function appendEvaluatorResult(input: Omit<EvaluatorResult, "created_at"> & { created_at?: string }): EvaluatorResult {
  const db = getDb();
  const createdAt = normalizeTimestamp(input.created_at ?? new Date().toISOString());
  const row = {
    target_deployment_id: input.target_deployment_id,
    evaluator_deployment_id: input.evaluator_deployment_id,
    created_at: createdAt,
    rating: JSON.stringify(input.rating),
    summary: input.summary ?? null,
    report_path: input.report_path ?? null,
    evidence_refs: JSON.stringify(input.evidence_refs),
    findings: input.findings ?? null,
  };
  db.prepare(`
    INSERT INTO evaluator_ratings (
      target_deployment_id, evaluator_deployment_id, created_at, rating,
      summary, report_path, evidence_refs, findings
    ) VALUES (
      @target_deployment_id, @evaluator_deployment_id, @created_at, @rating,
      @summary, @report_path, @evidence_refs, @findings
    ) ON CONFLICT(target_deployment_id, evaluator_deployment_id) DO UPDATE SET
      created_at = excluded.created_at,
      rating = excluded.rating,
      summary = excluded.summary,
      report_path = excluded.report_path,
      evidence_refs = excluded.evidence_refs,
      findings = excluded.findings
  `).run(row);
  return { ...input, created_at: createdAt };
}

export function queryEvaluatorResultsByTargetDeployment(targetDeploymentId: string): EvaluatorResult[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM evaluator_ratings WHERE target_deployment_id = ? ORDER BY created_at DESC").all(targetDeploymentId) as Record<string, unknown>[]).map(evaluatorResultFromRow);
}

export function queryEvaluatorResults(): EvaluatorResult[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM evaluator_ratings ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(evaluatorResultFromRow);
}

export function getDeploymentsByTicketId(ticketId: string): DeploymentStatus[] {
  const db = getDb();
  return sortDeploymentsByStartedAt((db.prepare("SELECT * FROM deployments WHERE ticket_id = ?").all(ticketId) as Record<string, unknown>[]).map(deploymentFromRow));
}

export function computeDeploymentStatuses(events: RegistryEvent[]): DeploymentStatus[] {
  const grouped = new Map<string, RegistryEvent[]>();
  for (const event of events) grouped.set(event.deployment_id, [...(grouped.get(event.deployment_id) ?? []), event]);
  return sortDeploymentsByStartedAt([...grouped.entries()].map(([deployId, deploymentEvents]) => {
    const started = deploymentEvents.find((event) => event.event === "started");
    const completed = deploymentEvents.find((event) => event.event === "completed");
    const crashed = deploymentEvents.find((event) => event.event === "crashed");
    const pid = deploymentEvents.find((event) => event.event === "pid");
    const currentBranch = [...deploymentEvents].reverse().find((event) => event.branch_state !== undefined || event.branch_base_sha !== undefined || event.branch_head_sha !== undefined);
    const currentTicket = [...deploymentEvents].reverse().find((event) => event.event === "ticket-associated");
    return {
      deploy_id: deployId,
      team: started?.team ?? deploymentEvents[0]?.team ?? "",
      status: (completed?.status ?? (crashed ? "crashed" : started ? "running" : "unknown")) as DeploymentStatus["status"],
      started_at: started?.timestamp ?? deploymentEvents[0]?.timestamp ?? "",
      completed_at: completed?.timestamp ?? crashed?.timestamp,
      pid: pid?.pid,
      agents: started?.agents ?? [],
      summary: completed?.summary,
      log_file: completed?.log_file ?? started?.log_file,
      primer: started?.primer,
      ticket_id: currentTicket?.ticket_id ?? started?.ticket_id,
      objective: started?.objective,
      models: started?.models,
      provider: started?.provider,
      repo: started?.repo,
      repo_root: started?.repo_root,
      worktree_root: started?.worktree_root,
      repository_slot: started?.repository_slot,
      parent_deployment_id: started?.parent_deployment_id,
      builder_authority: started?.builder_authority,
      treehouse_path: started?.treehouse_path,
      treehouse_lease_id: started?.treehouse_lease_id,
      treehouse_lease_holder: started?.treehouse_lease_holder,
      branch_state: currentBranch?.branch_state ?? started?.branch_state,
      branch_base_sha: currentBranch?.branch_base_sha ?? started?.branch_base_sha,
      branch_head_sha: currentBranch?.branch_head_sha ?? started?.branch_head_sha,
      ticket_slot_id: started?.ticket_slot_id,
      repository_permit: started?.repository_permit,
      mode: started?.mode,
      fallback: completed?.fallback,
      resumed_from_deployment_id: started?.resumed_from_deployment_id,
      runtime: started?.runtime,
      binary: started?.binary,
      effective_timeout_seconds: started?.effective_timeout_seconds,
      rogue_one: started?.rogue_one,
      invocation_channel: started?.invocation_channel,
    };
  }));
}

function sortDeploymentsByStartedAt(deployments: DeploymentStatus[]): DeploymentStatus[] {
  return deployments.sort((a, b) => parseTimestamp(b.started_at).getTime() - parseTimestamp(a.started_at).getTime());
}

function upsertDeployment(db: ReturnType<typeof getDb>, event: RegistryEvent): void {
  const row = toRow(event);
  if (event.event === "started") {
    db.prepare(`
      INSERT INTO deployments (
        deployment_id, team, status, started_at, pid, primer, agents, models,
        ticket_id, objective, repo, repo_root, worktree_root, repository_slot, parent_deployment_id, builder_authority,
        treehouse_path, treehouse_lease_id, treehouse_lease_holder, branch_state, branch_base_sha, branch_head_sha, ticket_slot_id, repository_permit,
        mode, provider, resumed_from_deployment_id, runtime, binary, effective_timeout_seconds, rogue_one, invocation_channel
      ) VALUES (
        @deployment_id, @team, 'running', @timestamp, @pid, @primer, @agents, @models,
        @ticket_id, @objective, @repo, @repo_root, @worktree_root, @repository_slot, @parent_deployment_id, @builder_authority,
        @treehouse_path, @treehouse_lease_id, @treehouse_lease_holder, @branch_state, @branch_base_sha, @branch_head_sha, @ticket_slot_id, @repository_permit,
        @mode, @provider, @resumed_from_deployment_id, @runtime, @binary, @effective_timeout_seconds, @rogue_one, @invocation_channel
      ) ON CONFLICT(deployment_id) DO UPDATE SET
        status = excluded.status,
        started_at = excluded.started_at,
        pid = excluded.pid,
        primer = excluded.primer,
        agents = excluded.agents,
        models = excluded.models,
        ticket_id = excluded.ticket_id,
        objective = excluded.objective,
        repo = excluded.repo,
        repo_root = excluded.repo_root,
        worktree_root = excluded.worktree_root,
        repository_slot = excluded.repository_slot,
        parent_deployment_id = excluded.parent_deployment_id,
        builder_authority = excluded.builder_authority,
        treehouse_path = excluded.treehouse_path,
        treehouse_lease_id = excluded.treehouse_lease_id,
        treehouse_lease_holder = excluded.treehouse_lease_holder,
        branch_state = excluded.branch_state,
        branch_base_sha = excluded.branch_base_sha,
        branch_head_sha = excluded.branch_head_sha,
        ticket_slot_id = excluded.ticket_slot_id,
        repository_permit = excluded.repository_permit,
        mode = excluded.mode,
        provider = excluded.provider,
        resumed_from_deployment_id = excluded.resumed_from_deployment_id,
        runtime = excluded.runtime,
        binary = excluded.binary,
        effective_timeout_seconds = excluded.effective_timeout_seconds,
        rogue_one = excluded.rogue_one,
        invocation_channel = excluded.invocation_channel
    `).run(row);
  } else if (event.event === "pid") {
    db.prepare("UPDATE deployments SET pid = ? WHERE deployment_id = ?").run(event.pid ?? null, event.deployment_id);
  } else if (event.event === "updated") {
    db.prepare(`
      UPDATE deployments SET branch_state = COALESCE(@branch_state, branch_state),
        branch_base_sha = COALESCE(@branch_base_sha, branch_base_sha),
        branch_head_sha = COALESCE(@branch_head_sha, branch_head_sha)
      WHERE deployment_id = @deployment_id
    `).run(row);
  } else if (event.event === "completed") {
    db.prepare(`
      UPDATE deployments SET status = @status, completed_at = @timestamp, summary = @summary,
        log_file = @log_file, rating = @rating, error = NULL, exit_code = @exit_code, fallback = @fallback,
        branch_state = COALESCE(@branch_state, branch_state), branch_base_sha = COALESCE(@branch_base_sha, branch_base_sha),
        branch_head_sha = COALESCE(@branch_head_sha, branch_head_sha)
      WHERE deployment_id = @deployment_id
    `).run({ ...row, status: event.status ?? "success" });
  } else if (event.event === "crashed") {
    db.prepare("UPDATE deployments SET status = 'crashed', completed_at = @timestamp, summary = NULL, log_file = NULL, rating = NULL, error = @error, exit_code = @exit_code, fallback = 0, branch_state = COALESCE(@branch_state, branch_state), branch_base_sha = COALESCE(@branch_base_sha, branch_base_sha), branch_head_sha = COALESCE(@branch_head_sha, branch_head_sha) WHERE deployment_id = @deployment_id").run(row);
  }
}

function withTerminalCorrelation(existing: RegistryEvent, requested: RegistryEvent): RegistryEvent {
  const fields = ["parent_deployment_id", "builder_authority", "treehouse_path", "treehouse_lease_id", "treehouse_lease_holder", "branch_state", "branch_base_sha", "branch_head_sha", "ticket_slot_id", "repository_permit"] as const;
  if (!fields.some((field) => requested[field] !== undefined && requested[field] !== existing[field])) return existing;
  const merged: RegistryEvent = { ...existing };
  for (const field of fields) {
    const value = requested[field];
    if (value !== undefined) Object.assign(merged, { [field]: value });
  }
  return merged;
}

function isFailedTerminal(event: RegistryEvent): boolean {
  return event.event === "crashed" || event.status !== "success" || (event.exit_code ?? 0) !== 0;
}

const START_IDENTITY_COLUMNS = [
  "team", "pid", "status", "summary", "log_file", "primer", "agents", "models", "error", "exit_code", "ticket_id", "provider", "rating",
  "objective", "repo", "repo_root", "worktree_root", "repository_slot", "parent_deployment_id", "builder_authority", "treehouse_path",
  "treehouse_lease_id", "treehouse_lease_holder", "branch_state", "branch_base_sha", "branch_head_sha", "ticket_slot_id", "repository_permit",
  "mode", "fallback", "resumed_from_deployment_id", "note", "runtime", "binary", "effective_timeout_seconds", "rogue_one", "invocation_channel",
] as const;

const IMMUTABLE_CORRELATION_FIELDS = [
  "parent_deployment_id", "builder_authority", "treehouse_path", "treehouse_lease_id", "treehouse_lease_holder",
  "branch_state", "branch_base_sha", "ticket_slot_id", "repository_permit",
] as const;

function assertExactStartedReplay(existingRow: Record<string, unknown>, requested: RegistryEvent): void {
  const requestedRow = toRow(requested);
  if (START_IDENTITY_COLUMNS.some((field) => existingRow[field] !== requestedRow[field])) {
    throw new DeploymentStartConflictError(startConflictDiagnostic("the deployment ID already has different immutable start identity or correlation bindings"));
  }
}

function assertEventMatchesStartedIdentity(db: ReturnType<typeof getDb>, requested: RegistryEvent): void {
  const existingRow = db.prepare("SELECT * FROM registry_events WHERE deployment_id = ? AND event = 'started' ORDER BY id LIMIT 1").get(requested.deployment_id) as Record<string, unknown> | undefined;
  if (!existingRow) {
    if (hasAnyCorrelation(requested)) throw new DeploymentCorrelationConflictError(correlationConflictDiagnostic("correlation evidence cannot be added without immutable start evidence"));
    return;
  }
  if (existingRow["team"] !== requested.team) {
    throw new DeploymentCorrelationConflictError(correlationConflictDiagnostic("the lifecycle event team does not match immutable start identity"));
  }
  const requestedRow = toRow(requested);
  for (const field of IMMUTABLE_CORRELATION_FIELDS) {
    if (requestedRow[field] !== null && requestedRow[field] !== existingRow[field]) {
      throw new DeploymentCorrelationConflictError(correlationConflictDiagnostic(`terminal ${field} does not match immutable start evidence`));
    }
  }
  if (requested.branch_head_sha !== undefined && existingRow["branch_state"] == null) {
    throw new DeploymentCorrelationConflictError(correlationConflictDiagnostic("terminal branch head cannot invent correlation absent from start evidence"));
  }
}

function correlationToValidationInput(event: RegistryEvent): Record<string, unknown> {
  return {
    parentDeploymentId: event.parent_deployment_id,
    builderAuthority: event.builder_authority,
    treehousePath: event.treehouse_path,
    treehouseLeaseId: event.treehouse_lease_id,
    treehouseLeaseHolder: event.treehouse_lease_holder,
    branchState: event.branch_state,
    branchBaseSha: event.branch_base_sha,
    branchHeadSha: event.branch_head_sha,
    ticketSlotId: event.ticket_slot_id,
    repositoryPermit: event.repository_permit,
  };
}

function hasTreehouseBinding(event: RegistryEvent): boolean {
  return event.builder_authority !== undefined || event.parent_deployment_id !== undefined || event.treehouse_path !== undefined
    || event.treehouse_lease_id !== undefined || event.treehouse_lease_holder !== undefined || event.ticket_slot_id !== undefined
    || event.repository_permit !== undefined;
}

function hasAnyCorrelation(event: RegistryEvent): boolean {
  return hasTreehouseBinding(event) || event.branch_state !== undefined || event.branch_base_sha !== undefined || event.branch_head_sha !== undefined;
}

function startConflictDiagnostic(reason: string): string {
  return `Condition: deployment start replay conflict. Source: atomic registry start identity check. Reason: ${reason}. Correction: preserve the existing deployment row and use a new canonical deployment ID for a distinct launch. Resume Action: replay only the exact original immutable identity and correlation bindings.`;
}

function correlationConflictDiagnostic(reason: string): string {
  return `Condition: deployment lifecycle correlation conflict. Source: atomic registry event identity check. Reason: ${reason}. Correction: preserve immutable start correlation and submit only an authenticated branch-head advance. Resume Action: reread deployment status and retry with matching evidence.`;
}

function nullableValue(value: unknown): unknown {
  return value === null ? undefined : value;
}

function toRow(event: RegistryEvent): Record<string, unknown> {
  return {
    deployment_id: event.deployment_id,
    team: event.team,
    event: event.event,
    timestamp: normalizeTimestamp(event.timestamp),
    pid: event.pid ?? null,
    status: event.status ?? null,
    summary: event.summary ?? null,
    log_file: event.log_file ?? null,
    primer: event.primer ?? null,
    agents: event.agents ? JSON.stringify(event.agents) : null,
    models: event.models ? JSON.stringify(event.models) : null,
    error: event.error ?? null,
    exit_code: event.exit_code ?? null,
    ticket_id: event.ticket_id ?? null,
    previous_ticket_id: event.previous_ticket_id ?? null,
    actor: event.actor ?? null,
    reason: event.reason ?? null,
    provider: event.provider ?? null,
    rating: event.rating ? JSON.stringify(event.rating) : null,
    objective: event.objective ?? null,
    repo: event.repo ?? null,
    repo_root: event.repo_root ?? null,
    worktree_root: event.worktree_root ?? null,
    repository_slot: event.repository_slot ?? null,
    parent_deployment_id: event.parent_deployment_id ?? null,
    builder_authority: event.builder_authority ?? null,
    treehouse_path: event.treehouse_path ?? null,
    treehouse_lease_id: event.treehouse_lease_id ?? null,
    treehouse_lease_holder: event.treehouse_lease_holder ?? null,
    branch_state: event.branch_state ?? null,
    branch_base_sha: event.branch_base_sha ?? null,
    branch_head_sha: event.branch_head_sha ?? null,
    ticket_slot_id: event.ticket_slot_id ?? null,
    repository_permit: event.repository_permit ?? null,
    mode: event.mode ?? null,
    fallback: event.fallback ? 1 : 0,
    resumed_from_deployment_id: event.resumed_from_deployment_id ?? null,
    note: event.note ?? null,
    runtime: event.runtime ?? null,
    binary: event.binary ?? null,
    effective_timeout_seconds: event.effective_timeout_seconds ?? null,
    rogue_one: event.rogue_one ? 1 : 0,
    invocation_channel: event.invocation_channel ?? null,
  };
}

function fromRow(row: Record<string, unknown>): RegistryEvent {
  return {
    deployment_id: String(row["deployment_id"]),
    team: String(row["team"]),
    event: row["event"] as RegistryEvent["event"],
    timestamp: normalizeTimestamp(row["timestamp"]),
    pid: optionalNumber(row["pid"]),
    status: row["status"] as RegistryEvent["status"],
    summary: optionalString(row["summary"]),
    log_file: optionalString(row["log_file"]),
    primer: optionalString(row["primer"]),
    agents: parseJson<string[]>(row["agents"]),
    models: parseJson<Record<string, string>>(row["models"]),
    error: optionalString(row["error"]),
    exit_code: optionalNumber(row["exit_code"]),
    ticket_id: optionalString(row["ticket_id"]),
    ...(row["event"] === "ticket-associated" ? {
      previous_ticket_id: optionalString(row["previous_ticket_id"]) ?? null,
      actor: optionalString(row["actor"]),
      reason: optionalString(row["reason"]),
    } : {}),
    provider: optionalString(row["provider"]),
    rating: parseJson<RegistryEvent["rating"]>(row["rating"]),
    objective: optionalString(row["objective"]),
    repo: optionalString(row["repo"]),
    repo_root: optionalString(row["repo_root"]),
    worktree_root: optionalString(row["worktree_root"]),
    repository_slot: repositorySlot(row["repository_slot"]),
    mode: optionalString(row["mode"]),
    fallback: Boolean(row["fallback"]),
    resumed_from_deployment_id: optionalString(row["resumed_from_deployment_id"]),
    note: optionalString(row["note"]),
    runtime: row["runtime"] as RegistryEvent["runtime"],
    binary: optionalString(row["binary"]),
    effective_timeout_seconds: optionalNumber(row["effective_timeout_seconds"]),
    rogue_one: Boolean(row["rogue_one"]),
    invocation_channel: row["invocation_channel"] as RegistryEvent["invocation_channel"],
    ...correlationFromRow(row),
  };
}

function deploymentFromRow(row: Record<string, unknown>): DeploymentStatus {
  return {
    deploy_id: String(row["deployment_id"]),
    team: String(row["team"]),
    status: row["status"] as DeploymentStatus["status"],
    started_at: normalizeTimestamp(row["started_at"]),
    completed_at: optionalTimestamp(row["completed_at"]),
    pid: optionalNumber(row["pid"]),
    agents: parseJson<string[]>(row["agents"]) ?? [],
    summary: optionalString(row["summary"]),
    log_file: optionalString(row["log_file"]),
    primer: optionalString(row["primer"]),
    ticket_id: optionalString(row["ticket_id"]),
    objective: optionalString(row["objective"]),
    models: parseJson<Record<string, string>>(row["models"]),
    provider: optionalString(row["provider"]),
    repo: optionalString(row["repo"]),
    repo_root: optionalString(row["repo_root"]),
    worktree_root: optionalString(row["worktree_root"]),
    repository_slot: repositorySlot(row["repository_slot"]),
    mode: optionalString(row["mode"]),
    fallback: Boolean(row["fallback"]),
    resumed_from_deployment_id: optionalString(row["resumed_from_deployment_id"]),
    runtime: row["runtime"] as DeploymentStatus["runtime"],
    binary: optionalString(row["binary"]),
    effective_timeout_seconds: optionalNumber(row["effective_timeout_seconds"]),
    rogue_one: Boolean(row["rogue_one"]),
    invocation_channel: row["invocation_channel"] as DeploymentStatus["invocation_channel"],
    ...correlationFromRow(row),
  };
}

function correlationFromRow(row: Record<string, unknown>): Pick<DeploymentStatus,
  "parent_deployment_id" | "builder_authority" | "treehouse_path" | "treehouse_lease_id" | "treehouse_lease_holder" |
  "branch_state" | "branch_base_sha" | "branch_head_sha" | "ticket_slot_id" | "repository_permit"
> {
  try {
    const evidence = validateDeploymentCorrelationEvidence({
      parentDeploymentId: nullableValue(row["parent_deployment_id"]),
      builderAuthority: nullableValue(row["builder_authority"]),
      treehousePath: nullableValue(row["treehouse_path"]),
      treehouseLeaseId: nullableValue(row["treehouse_lease_id"]),
      treehouseLeaseHolder: nullableValue(row["treehouse_lease_holder"]),
      branchState: nullableValue(row["branch_state"]),
      branchBaseSha: nullableValue(row["branch_base_sha"]),
      branchHeadSha: nullableValue(row["branch_head_sha"]),
      ticketSlotId: nullableValue(row["ticket_slot_id"]),
      repositoryPermit: nullableValue(row["repository_permit"]),
    }, { ticketId: nullableValue(row["ticket_id"]), worktreeRoot: nullableValue(row["worktree_root"]), requireWorktreeMatch: row["treehouse_path"] != null && row["worktree_root"] != null });
    return {
      parent_deployment_id: evidence.parentDeploymentId,
      builder_authority: evidence.builderAuthority,
      treehouse_path: evidence.treehousePath,
      treehouse_lease_id: evidence.treehouseLeaseId,
      treehouse_lease_holder: evidence.treehouseLeaseHolder,
      branch_state: evidence.branchState,
      branch_base_sha: evidence.branchBaseSha,
      branch_head_sha: evidence.branchHeadSha,
      ticket_slot_id: evidence.ticketSlotId,
      repository_permit: evidence.repositoryPermit,
    };
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function repositorySlot(value: unknown): "orchestrator" | "implement" | undefined {
  return value === "orchestrator" || value === "implement" ? value : undefined;
}

function normalizeTimestamp(value: unknown): string {
  return parseTimestamp(String(value ?? "")).toISOString();
}

function optionalTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? parseTimestamp(value).toISOString() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return JSON.parse(value) as T;
}

function evaluatorResultFromRow(row: Record<string, unknown>): EvaluatorResult {
  return {
    target_deployment_id: String(row["target_deployment_id"]),
    evaluator_deployment_id: String(row["evaluator_deployment_id"]),
    created_at: normalizeTimestamp(row["created_at"]),
    rating: parseJson<EvaluatorResult["rating"]>(row["rating"]) ?? { source: "system", overall: 0, metrics: {} },
    summary: optionalString(row["summary"]),
    report_path: optionalString(row["report_path"]),
    evidence_refs: parseJson<string[]>(row["evidence_refs"]) ?? [],
    findings: optionalString(row["findings"]),
  };
}
