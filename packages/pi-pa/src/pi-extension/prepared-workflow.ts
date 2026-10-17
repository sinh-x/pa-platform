import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import {
  MAX_REPOSITORY_TICKET_SLOTS, ExecutionCustodyService, PhaseReportService, parsePhaseReport, parseExecutionPlan, projectExecution, updateFeatureWithExpectedHead,
  loadRepoEntry, materializeTicketBranch, parseExecutionCustody, parseIdlePreparationReservation,
  requireTicketLinkedBranch, TicketStore, withPreparedTicketCapacity, withVacantPreparationWorktree,
  PA_PI_EXECUTION_MODE_ENV, parsePreparationContract, parsePreparedReceipt, preparationIdentity,
  processIsWithinFingerprintLineage, publishNativePreparationRetry, queryDeploymentStatus,
  readProcessFingerprint, resolveRepoExecutionPath, withPreparedWorkflowLocks, workflowDigest,
  workflowError, workflowObject, workflowSha, workflowSynchronous, workflowText, workflowTimestamp,
  type ExecutionHolder, type ExecutionState, type ExecutionCommand, type ExecutionOperationKind, type ExecutionFailure,
  type ExecutionRecovery, type ExecutionRecoveryInventory, type PhaseReport, type PhaseReportReceipt,
  type IdlePreparationReservation, type PreparedReservationLaunch, type PreparationAction, type PreparationContract,
  type PreparationHost, type PreparationOutcome, type PreparationStepContext, type PreparedReceipt,
  type PreparedTicketCapacityTransaction, type RepositoryTicketSlotDependencies, type SourceVersion,
  PreparedWorkflowService, type PreparationStatus,
} from "@pa-platform/pa-core";
import { TreehouseClient, deriveTreehouseLeaseHolder, type TreehouseLeaseEvidence } from "../treehouse.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import type { PiExtensionModule, PiSessionLifecycle, PiToolCall, PiToolDefinition, PiToolResult } from "./index.js";

const APPROVE_RETRY = "Retry this unchanged preparation once";
const REJECT_RETRY = "Do not retry";
const MAX_STATUS_BYTES = 50 * 1024;
const STATES = ["not-requested", "preparing", "ready", "consumed", "not-ready-capacity", "not-ready-failed", "uncertain-blocked"] as const;
const ACTIONS = ["reservation", "allocation", "branch", "ticket-reread", "ready", "consume"] as const;

export interface PiPreparationCaller {
  readonly deploymentId: string;
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly ticket: string;
  /** Digest only: process incarnation/session identity is never a tool projection. */
  readonly callerIdentity: string;
}
/** Runtime-supplied binding. No model input, environment or public receipt creates it. */
export interface PiPreparationBinding {
  readonly bindingIdentity: string;
  readonly contract: PreparationContract;
  readonly service: PreparedWorkflowService;
}
export interface PiPreparationContext {
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly cwd: string;
  readonly sessionManager?: { getSessionId(): string };
  readonly ui?: { select(title: string, choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined> };
}
export interface PiPreparedWorkflowOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Trusted-runtime dependencies only; these are not tool/CLI options. */
  readonly authenticateCaller?: (context: PiPreparationContext) => PiPreparationCaller;
  readonly resolveBinding?: (caller: PiPreparationCaller) => PiPreparationBinding | null;
  readonly nativeAuthority?: PiPreparedNativeAuthority;
  readonly now?: () => string;
  readonly createEventId?: () => string;
}
export interface PiPreparationInput extends Record<string, unknown> { action: "request" | "status" | "retry" }
export interface PiPreparationDetails extends Record<string, unknown> {
  schemaVersion: "pi-preparation-status/v1";
  state: PreparationStatus["state"] | "inactive" | "cancelled";
  automationAvailable: boolean;
  operationId?: string;
  attempt?: number;
  completedActions?: readonly string[];
  receipt?: PreparationStatus["receipt"];
  failureRecorded?: boolean;
}

export const PiPreparationParams = Type.Object({
  action: Type.Union([Type.Literal("request"), Type.Literal("status"), Type.Literal("retry")]),
}, { additionalProperties: false });

export function isInteractivePreparationEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PA_PI_EXECUTION_MODE_ENV] === "foreground" && env.PA_TEAM === "requirements" && env.PA_MODE === "analyze";
}

export interface PiPreparationCallerDependencies {
  readonly getDeploymentStatus: typeof queryDeploymentStatus;
  readonly resolveRepository: (root: string) => { repoKey: string; repoRoot: string; worktreeRoot: string; repositoryCwd: string };
  readonly physicalRoot: (root: string) => string;
  readonly cwd: () => string;
  readonly pid: number;
  readonly fingerprint: typeof readProcessFingerprint;
  readonly inLineage: typeof processIsWithinFingerprintLineage;
}
/** Correlation guard, NOT activation/promotion authority. The bound host authenticates those independently. */
export function authenticatePiPreparationCaller(context: PiPreparationContext, env: NodeJS.ProcessEnv, overrides: Partial<PiPreparationCallerDependencies> = {}): PiPreparationCaller {
  const dependencies: PiPreparationCallerDependencies = {
    getDeploymentStatus: queryDeploymentStatus, resolveRepository: (root) => resolveRepoExecutionPath(undefined, root),
    physicalRoot: realpathSync, cwd: () => process.cwd(), pid: process.pid, fingerprint: readProcessFingerprint, inLineage: processIsWithinFingerprintLineage,
    ...overrides,
  };
  if (!isInteractivePreparationEnvironment(env) || context.mode !== "tui") throw workflowError();
  const deploymentId = workflowText(env.PA_DEPLOYMENT_ID); const ticket = workflowText(env.PA_TICKET_ID);
  if (!/^d-[0-9a-f]{6}$/.test(deploymentId) || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw workflowError();
  const status = dependencies.getDeploymentStatus(deploymentId);
  const root = workflowText(status?.repo_root);
  if (!status || status.deploy_id !== deploymentId || status.status !== "running" || status.runtime !== "pi" || status.team !== "requirements" || status.mode !== "analyze"
    || status.ticket_id !== ticket || status.repo !== root || status.worktree_root !== root
    || status.builder_authority || status.treehouse_path || status.ticket_slot_id || status.repository_permit || status.rogue_one
    || env.PA_REPO !== root || env.PA_WORKTREE_ROOT !== root || context.cwd !== root || dependencies.physicalRoot(root) !== root
    || dependencies.cwd() !== root || !status.pid) throw workflowError();
  const registered = dependencies.resolveRepository(root);
  if (registered.repoRoot !== root || registered.worktreeRoot !== root || registered.repositoryCwd !== root) throw workflowError();
  const owner = dependencies.fingerprint(status.pid); const current = dependencies.fingerprint(dependencies.pid);
  if (!owner || !current || !dependencies.inLineage(dependencies.pid, owner)) throw workflowError();
  const sessionId = workflowText(context.sessionManager?.getSessionId());
  return Object.freeze({ deploymentId, repoKey: registered.repoKey, repoRoot: root, ticket,
    callerIdentity: workflowDigest(JSON.stringify({ deploymentId, ticket, root, owner, current, sessionId, startedAt: workflowTimestamp(status.started_at) })) });
}

function validateCaller(value: PiPreparationCaller): PiPreparationCaller {
  const row = workflowObject(value, ["deploymentId", "repoKey", "repoRoot", "ticket", "callerIdentity"]);
  const deploymentId = workflowText(row.deploymentId); const ticket = workflowText(row.ticket);
  if (!/^d-[0-9a-f]{6}$/.test(deploymentId) || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw workflowError();
  return Object.freeze({ deploymentId, ticket, repoKey: workflowText(row.repoKey), repoRoot: workflowText(row.repoRoot), callerIdentity: workflowSha(row.callerIdentity) });
}

function publicResult(details: PiPreparationDetails): PiToolResult<PiPreparationDetails> {
  const text = JSON.stringify(details);
  if (Buffer.byteLength(text) > MAX_STATUS_BYTES) throw workflowError();
  return { content: [{ type: "text", text }], details };
}
function statusResult(status: PreparationStatus, contract: PreparationContract): PiToolResult<PiPreparationDetails> {
  // Rebuild from an allowlist; never spread host/authority records into the result.
  const state = status.state;
  if (!STATES.includes(state) || !Number.isSafeInteger(status.attempt) || status.attempt < 0 || status.attempt > 32
    || status.operationId !== preparationIdentity(contract) || !Array.isArray(status.completedActions)
    || status.completedActions.some((action) => !ACTIONS.includes(action))
    || new Set(status.completedActions).size !== status.completedActions.length) throw workflowError();
  const receipt = status.receipt === null ? null : parsePreparedReceipt(status.receipt);
  if (receipt && (receipt.operationId !== status.operationId || receipt.state !== state || JSON.stringify(receipt.contract) !== JSON.stringify(contract))) throw workflowError();
  if ((state === "ready" || state === "consumed") !== Boolean(receipt)) throw workflowError();
  return publicResult({ schemaVersion: "pi-preparation-status/v1", state, automationAvailable: true, operationId: status.operationId,
    attempt: status.attempt, completedActions: [...status.completedActions], receipt, failureRecorded: status.failure !== null });
}

export function createPiPreparationTool(options: PiPreparedWorkflowOptions = {}, lifecycle?: PiSessionLifecycle): PiToolDefinition<PiPreparationInput, PiPreparationDetails> {
  const env = { ...(options.env ?? process.env) };
  const authenticate = options.authenticateCaller ?? ((context: PiPreparationContext) => authenticatePiPreparationCaller(context, env));
  // Fixed native storage and installed-runtime/source proof, never an environment
  // enable switch. No active record/qualification means no resource-capable host.
  const authority = options.nativeAuthority ?? new PiPreparedNativeAuthority();
  const now = options.now ?? (() => new Date().toISOString());
  const createEventId = options.createEventId ?? randomUUID;
  let mutating = false;
  const resolve = (context: PiPreparationContext) => {
    if (context.mode !== "tui" || !isInteractivePreparationEnvironment(env)) throw workflowError();
    const caller = validateCaller(workflowSynchronous(authenticate(context)));
    const binding = options.resolveBinding
      ? workflowSynchronous(options.resolveBinding(caller))
      : resolveNativePiPreparationBinding(caller, authority, () => validateCaller(workflowSynchronous(authenticate(context))));
    if (binding === null) return { caller, binding: null };
    const contract = parsePreparationContract(binding.contract);
    if (contract.ticket !== caller.ticket || contract.repoKey !== caller.repoKey || contract.repoRoot !== caller.repoRoot) throw workflowError();
    return { caller, binding: { contract, bindingIdentity: workflowSha(binding.bindingIdentity), service: binding.service } };
  };
  return {
    name: "pa_preparation", label: "PA Preparation",
    description: "Inspect or request approved preparation; a retry requires a fresh native foreground operator decision. Optional automation is inactive unless independently activated.",
    parameters: PiPreparationParams, executionMode: "sequential",
    execute: async (toolCallId, input, signal, _onUpdate, rawContext) => {
      const run = async (): Promise<PiToolResult<PiPreparationDetails>> => {
        const row = workflowObject(input, ["action"]);
        if (row.action !== "request" && row.action !== "status" && row.action !== "retry") throw workflowError();
        if (signal?.aborted) return publicResult({ schemaVersion: "pi-preparation-status/v1", state: "cancelled", automationAvailable: false });
        const context = rawContext as PiPreparationContext;
        const initial = resolve(context);
        if (!initial.binding) {
          if (row.action !== "status") throw workflowError();
          return publicResult({ schemaVersion: "pi-preparation-status/v1", state: "inactive", automationAvailable: false });
        }
        const { binding } = initial;
        if (row.action === "status") return statusResult(binding.service.status(binding.contract), binding.contract);
        if (mutating) throw workflowError();
        mutating = true;
        try {
          if (row.action === "request") return statusResult(binding.service.request(binding.contract), binding.contract);
          const status = binding.service.status(binding.contract);
          if (status.state !== "not-ready-capacity" && status.state !== "not-ready-failed") throw workflowError();
          if (typeof context.ui?.select !== "function") throw workflowError();
          const choice = await context.ui.select(
            `Preparation ${binding.contract.ticket}: retry the unchanged approved sources once? No queue, reclaim, return, new approval or activation is authorized.`,
            [APPROVE_RETRY, REJECT_RETRY], signal ? { signal } : undefined,
          );
          if (signal?.aborted || choice !== APPROVE_RETRY) return publicResult({ schemaVersion: "pi-preparation-status/v1", state: "cancelled", automationAvailable: false });
          // Reauthenticate AFTER native UI: activation/source/session/lineage drift
          // or shutdown cannot be hidden by a prompt opened against an older binding.
          const fresh = resolve(context);
          if (!fresh.binding || JSON.stringify(fresh.caller) !== JSON.stringify(initial.caller)
            || fresh.binding.bindingIdentity !== binding.bindingIdentity
            || preparationIdentity(fresh.binding.contract) !== preparationIdentity(binding.contract)) throw workflowError();
          const freshStatus = fresh.binding.service.status(fresh.binding.contract);
          if (freshStatus.state !== status.state || freshStatus.attempt !== status.attempt
            || !status.failure || JSON.stringify(freshStatus.failure) !== JSON.stringify(status.failure)) throw workflowError();
          const record = Object.freeze({ schemaVersion: "native-preparation-retry/v1" as const, eventId: createEventId(),
            operationId: preparationIdentity(binding.contract), bindingIdentity: binding.bindingIdentity, callerIdentity: fresh.caller.callerIdentity,
            deploymentId: fresh.caller.deploymentId, toolCallId: workflowText(toolCallId), preparationAttempt: freshStatus.attempt,
            failureSha256: status.failure.sha256, capturedAt: workflowTimestamp(now()) });
          const source = withPreparedWorkflowLocks(fresh.binding.service.host.locks, (scope) =>
            publishNativePreparationRetry(fresh.binding!.service.store, scope, record));
          return statusResult(fresh.binding.service.retry(fresh.binding.contract, source), fresh.binding.contract);
        } finally { mutating = false; }
      };
      // Database access is lifetime-tracked, not held in an SQL transaction across UI.
      // Fixed errors never expose host messages, process identity, tokens or private paths.
      try { return await (lifecycle ? lifecycle.trackRegistryAccess(run) : run()); }
      catch { throw workflowError(); }
    },
  };
}

export function createPiPreparedWorkflowModule(options: PiPreparedWorkflowOptions = {}): PiExtensionModule {
  return (pi, lifecycle) => {
    if (!isInteractivePreparationEnvironment(options.env ?? process.env)) return;
    pi.registerTool?.(createPiPreparationTool(options, lifecycle));
  };
}
export const registerPreparedWorkflowModule: PiExtensionModule = createPiPreparedWorkflowModule();

export function resolveNativePiPreparationBinding(caller: PiPreparationCaller, authority: PiPreparedNativeAuthority, reauthenticate: () => PiPreparationCaller): PiPreparationBinding | null {
  const grant = authority.resolve(caller); if (!grant) return null;
  const store = authority.operations(); if (!store) throw workflowError();
  const current = () => {
    if (JSON.stringify(validateCaller(workflowSynchronous(reauthenticate()))) !== JSON.stringify(validateCaller(caller))) throw workflowError();
    authority.assertCurrent(caller, grant);
  };
  const host = createPiPreparationHost(grant.contract, {
    authorize(operation, contract, evidence) { current(); authority.authorize(caller, grant, operation, contract, evidence); },
    assertCurrentBindings() { current(); },
  });
  return Object.freeze({ bindingIdentity: workflowDigest(JSON.stringify(grant)), contract: grant.contract, service: new PreparedWorkflowService(store, host) });
}

export const PiWorkflowPolicyParams = Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("activate"), Type.Literal("bind"), Type.Literal("deactivate")]) }, { additionalProperties: false });
/** Fixed foreground native dialogs. Qualification must already exist from its
 * separately authorized producer; this tool cannot create/qualify it or execute
 * project/resource commands to make activation pass. No root/source/author override. */
export function createPiWorkflowPolicyModule(options: PiPreparedWorkflowOptions = {}): PiExtensionModule {
  return (pi, lifecycle) => {
    const env = { ...(options.env ?? process.env) }; if (!isInteractivePreparationEnvironment(env)) return;
    const authority = options.nativeAuthority ?? new PiPreparedNativeAuthority();
    const authenticate = options.authenticateCaller ?? ((context: PiPreparationContext) => authenticatePiPreparationCaller(context, env));
    pi.registerTool?.({ name: "pa_workflow_policy", label: "PA Workflow Policy", description: "Inspect optional automation or request a fixed native operator activation/adoption/revocation dialog. Protected exact-revision qualification is mandatory; tool text cannot grant authority.", parameters: PiWorkflowPolicyParams, executionMode: "sequential",
      execute: async (_id, input, signal, _update, rawContext) => {
        const run = async () => {
          const row = workflowObject(input, ["action"]);
          if (!["status", "activate", "bind", "deactivate"].includes(String(row.action))) throw workflowError();
          const context = rawContext as PiPreparationContext;
          if (signal?.aborted || context.mode !== "tui") throw workflowError();
          const caller = validateCaller(workflowSynchronous(authenticate(context)));
          if (row.action === "status") return executionResult({ schemaVersion: "prepared-native-policy-status/v1", ...authority.status(caller) });
          if (!context.ui?.select) throw workflowError();
          let reference: string | null = null; let preview: unknown;
          if (row.action === "activate") preview = authority.activationPreview(caller);
          else if (row.action === "bind") {
            if (!authority.status(caller).active) throw workflowError();
            const references = [...authority.sources(caller)]; if (!references.length) throw workflowError();
            const choice = await context.ui.select("Select the exact promoted requirements source for optional preparation adoption", references, signal ? { signal } : undefined);
            if (signal?.aborted || choice === undefined) return executionResult({ state: "cancelled" });
            if (!references.includes(choice)) throw workflowError(); reference = choice; preview = authority.preview(caller, reference);
          } else preview = authority.status(caller);
          const accept = row.action === "activate" ? "Activate only these exact qualified revisions" : row.action === "bind" ? "Authenticate this exact promoted pair for optional preparation" : "Deactivate new optional admissions; retain all existing work and resources";
          const choice = await context.ui.select(`Native operator decision: ${row.action}. Exact binding: ${JSON.stringify(preview)}. No checkout/resource action, cap reset or retrospective upgrade is performed by this decision.`, [accept, "Cancel"], signal ? { signal } : undefined);
          if (signal?.aborted || choice !== accept) return executionResult({ state: "cancelled" });
          const fresh = validateCaller(workflowSynchronous(authenticate(context)));
          if (JSON.stringify(fresh) !== JSON.stringify(caller)) throw workflowError();
          const reread = row.action === "activate" ? authority.activationPreview(fresh) : row.action === "bind" ? authority.preview(fresh, reference!) : authority.status(fresh);
          if (JSON.stringify(reread) !== JSON.stringify(preview)) throw workflowError();
          if (row.action === "activate") authority.activate(fresh);
          else if (row.action === "bind") authority.bind(fresh, reference!);
          else authority.deactivate(fresh);
          return executionResult({ schemaVersion: "prepared-native-policy-status/v1", ...authority.status(fresh), preparationBound: row.action === "bind" });
        };
        try { return await (lifecycle ? lifecycle.trackRegistryAccess(run) : run()); } catch { throw workflowError(); }
      },
    });
  };
}
export const registerWorkflowPolicyModule: PiExtensionModule = createPiWorkflowPolicyModule();

export interface PiPreparationHostOptions {
  /** Mandatory trusted native-policy/promotion/caller authority; no default implementation. */
  readonly authorize: PreparationHost["authorize"];
  /** Revalidate exact protected source/policy bindings at every resource boundary. */
  readonly assertCurrentBindings: (contract: PreparationContract) => void;
  readonly resolveConsumer?: (source: SourceVersion) => { lineageId: string; holder: ExecutionHolder; launch?: PreparedReservationLaunch };
  readonly treehouse?: TreehouseClient;
  readonly ticketStore?: TicketStore;
  readonly runGit?: (args: readonly string[], cwd: string) => Buffer;
  readonly capacityDependencies?: Partial<RepositoryTicketSlotDependencies>;
  readonly now?: () => string;
}
function preparationGit(args: readonly string[], cwd: string): Buffer {
  // Never borrow Git identity/ref/index/alternate-object overrides from a caller.
  // Normal configured hooks and security assertions remain effective.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1_048_576 });
}

/**
 * Fixed resource adapter. Approval/activation resolution is a required native
 * authority port, NOT a Boolean or environment override. No production activation
 * binding is installed merely by constructing/exporting this adapter.
 *
 * Repository capacity is held for the transaction; checkout-specific operations
 * then nest the existing vacant worktree mutex. Before allocation there is no
 * checkout to lock. Every journal successor follows durable external resource
 * results; no parallel preparation controller/database is introduced.
 */
export function createPiPreparationHost(contractInput: PreparationContract, options: PiPreparationHostOptions): PreparationHost {
  const contract = parsePreparationContract(contractInput); const operationId = preparationIdentity(contract);
  if (typeof options.authorize !== "function" || typeof options.assertCurrentBindings !== "function") throw workflowError();
  const treehouse = options.treehouse ?? new TreehouseClient(); const tickets = options.ticketStore ?? new TicketStore();
  const git = options.runGit ?? preparationGit; const now = options.now ?? (() => new Date().toISOString());
  let transaction: PreparedTicketCapacityTransaction | null = null;
  const owner = (): PreparedTicketCapacityTransaction => { if (!transaction) throw workflowError(); return transaction; };
  const assertContext = (context: PreparationStepContext): void => {
    if (context.operationId !== operationId || JSON.stringify(parsePreparationContract(context.contract)) !== JSON.stringify(contract)) throw workflowError();
    if (workflowSynchronous(options.assertCurrentBindings(contract)) !== undefined) throw workflowError();
  };
  const resource = (step: PreparationAction, value: unknown): SourceVersion => Object.freeze({
    ref: `prepared-resource:${operationId}:${step}`, version: "prepared-resource/v1", sha256: workflowDigest(JSON.stringify(value)),
  });
  const observed = (step: PreparationAction, value: unknown): Exclude<PreparationOutcome, { state: "absent" }> => ({ state: "observed", evidence: resource(step, value) });
  const capacity = (step: "reservation" | "allocation"): Exclude<PreparationOutcome, { state: "absent" }> => ({ state: "capacity", evidence: resource(step, { reason: step === "reservation" ? "repository-capacity" : "treehouse-capacity" }) });
  const reservation = (): IdlePreparationReservation | null => {
    const row = owner().inventory().find((item) => item.ticket === contract.ticket);
    if (!row) return null;
    if (!("operationId" in row) || row.operationId !== operationId) throw workflowError();
    return parseIdlePreparationReservation(row);
  };
  const capacityFacts = (row: IdlePreparationReservation) => ({ repoKey: row.repoKey, repoRoot: row.repoRoot, ticket: row.ticket,
    operationId: row.operationId, reservationId: row.reservationId, repositoryPermit: row.repositoryPermit, retainedAt: row.retainedAt });
  const pool = () => {
    const entries = treehouse.status(contract.repoRoot); const holder = deriveTreehouseLeaseHolder(contract.repoKey, contract.ticket);
    const matches = entries.filter((entry) => entry.leased && entry.leaseHolder === holder);
    if (matches.length > 1) throw workflowError();
    return { entries, match: matches[0] };
  };
  const authenticatedLease = (required = true): TreehouseLeaseEvidence | null => {
    const { match } = pool();
    if (!match) { if (required) throw workflowError(); return null; }
    const lease = treehouse.authenticatePrepared(contract.repoRoot, contract.repoKey, contract.ticket, match.path);
    const physical = resolveRepoExecutionPath(undefined, lease.path, { allowLinkedWorktreeCwd: true });
    if (physical.repoKey !== contract.repoKey || physical.repoRoot !== contract.repoRoot || physical.worktreeRoot !== lease.path
      || physical.repositoryCwd !== lease.path || physical.worktreeKind !== "linked") throw workflowError();
    return lease;
  };
  const clean = (root: string): void => {
    if (git(["status", "--porcelain=v2", "--untracked-files=all", "-z"], root).length !== 0) throw workflowError();
  };
  const tuple = (lease: TreehouseLeaseEvidence) => {
    const ticket = tickets.get(contract.ticket); if (!ticket) throw workflowError();
    const linked = requireTicketLinkedBranch(ticket, contract.repoKey);
    if (linked.branch !== contract.branch || linked.state !== "materialized" || linked.baseSha !== contract.approvalBaseSha
      || !linked.headSha || git(["branch", "--show-current"], lease.path).toString("utf8").trim() !== contract.branch
      || git(["rev-parse", "--verify", "HEAD^{commit}"], lease.path).toString("utf8").trim() !== linked.headSha) throw workflowError();
    return { ticket: contract.ticket, repo: contract.repoKey, branch: linked.branch, state: "materialized", baseSha: linked.baseSha, headSha: linked.headSha } as const;
  };
  const leaseFacts = (lease: TreehouseLeaseEvidence) => ({ path: lease.path, leaseId: lease.leaseId, leaseHolder: lease.leaseHolder });
  const inWorktree = <T>(lease: TreehouseLeaseEvidence, action: () => T): T => withVacantPreparationWorktree(contract.repoRoot, lease.path, owner(), () => { clean(lease.path); return action(); });
  const currentFacts = (lease: TreehouseLeaseEvidence) => {
    const row = reservation(); if (!row || row.occupancy === "uncertain-retained") throw workflowError();
    return { row, tuple: tuple(lease), lease: leaseFacts(lease) };
  };
  const verifyCompletedResources = (context: PreparationStepContext, lease: TreehouseLeaseEvidence) => {
    const facts = currentFacts(lease);
    const expected = { reservation: resource("reservation", capacityFacts(facts.row)), allocation: resource("allocation", facts.lease),
      branch: resource("branch", facts.tuple), "ticket-reread": resource("ticket-reread", facts.tuple) };
    for (const step of ["reservation", "allocation", "branch", "ticket-reread"] as const) if (JSON.stringify(context.results[step]) !== JSON.stringify(expected[step])) throw workflowError();
    return facts;
  };
  const consumer = (context: PreparationStepContext) => {
    if (!context.consumer || !options.resolveConsumer) throw workflowError();
    const resolved = workflowSynchronous(options.resolveConsumer(context.consumer));
    const custody = parseExecutionCustody({ state: "orchestrator-direct", holder: resolved.holder, inFlightOperation: null });
    if (!custody.holder) throw workflowError();
    const current = (options.capacityDependencies?.getProcessFingerprint ?? readProcessFingerprint)(custody.holder.process.pid);
    if (JSON.stringify(current) !== JSON.stringify(custody.holder.process)) throw workflowError();
    return { lineageId: workflowText(resolved.lineageId), custody, ...(resolved.launch ? { launch: resolved.launch } : {}) };
  };
  const inspect = (step: PreparationAction, context: PreparationStepContext): PreparationOutcome => {
    assertContext(context);
    if (step === "reservation") {
      const row = reservation();
      if (!row) return owner().inventory().length >= MAX_REPOSITORY_TICKET_SLOTS ? capacity("reservation") : { state: "absent" };
      if (row.occupancy !== "preparing") return { state: "uncertain", evidence: resource(step, { retained: true }) };
      return observed(step, capacityFacts(row));
    }
    if (step === "allocation") {
      const state = pool();
      if (!state.match) return state.entries.some((entry) => !entry.leased) ? { state: "absent" } : capacity("allocation");
      return observed(step, leaseFacts(authenticatedLease()!));
    }
    const lease = authenticatedLease()!;
    return inWorktree(lease, () => {
      if (step === "branch") {
        const ticket = tickets.get(contract.ticket); if (!ticket) throw workflowError();
        const linked = requireTicketLinkedBranch(ticket, contract.repoKey);
        if (linked.branch !== contract.branch) throw workflowError();
        if (linked.state === "planned" || git(["branch", "--show-current"], lease.path).toString("utf8").trim() !== contract.branch) return { state: "absent" };
        return observed(step, tuple(lease));
      }
      if (step === "ticket-reread") return observed(step, tuple(lease));
      const facts = verifyCompletedResources(context, lease); const receipt = context.receipt;
      if (!receipt || receipt.operationId !== operationId || receipt.worktreeRoot !== lease.path || receipt.preparedHeadSha !== facts.tuple.headSha
        || receipt.preparationBaseSha !== facts.tuple.baseSha || receipt.capacityRef !== context.results.reservation?.ref
        || receipt.leaseRef !== context.results.allocation?.ref) throw workflowError();
      if (step === "ready") {
        if (facts.row.occupancy === "preparing") return { state: "absent" };
        if (facts.row.occupancy !== "idle-ready" || facts.row.receiptId !== receipt.receiptId) throw workflowError();
        return observed(step, receipt);
      }
      if (step === "consume") {
        const next = consumer(context);
        if (facts.row.occupancy === "idle-ready" && facts.row.receiptId === receipt.receiptId) return { state: "absent" };
        if (facts.row.occupancy !== "active" || facts.row.receiptId !== receipt.receiptId || facts.row.lineageId !== next.lineageId
          || JSON.stringify(facts.row.custody) !== JSON.stringify(next.custody) || JSON.stringify(facts.row.launch) !== JSON.stringify(next.launch)) throw workflowError();
        return observed(step, { receiptId: receipt.receiptId, consumer: context.consumer });
      }
      throw workflowError();
    });
  };
  return {
    locks: {
      repository: (action) => withPreparedTicketCapacity({ canonicalRepoKey: contract.repoKey, canonicalRepoRoot: contract.repoRoot, dependencies: options.capacityDependencies }, (tx) => {
        if (transaction) throw workflowError(); transaction = tx; try { return action(); } finally { transaction = null; }
      }),
      // The allocated worktree isn't known at entry. Checkout operations acquire
      // the existing worktree mutex action-by-action inside the repository owner.
      worktree: (action) => action(),
    },
    authorize(operation, input, evidence) {
      if (preparationIdentity(input) !== operationId) throw workflowError();
      if (workflowSynchronous(options.authorize(operation, input, evidence)) !== undefined) throw workflowError();
    }, now, inspect,
    perform(step, context) {
      assertContext(context);
      if (step === "reservation") {
        const result = owner().reserve({ ticket: contract.ticket, operationId, reservationId: workflowDigest(`prepared-reservation/v1:${operationId}`), retainedAt: workflowTimestamp(now()) });
        return result.status === "capacity" ? capacity(step) : observed(step, capacityFacts(result.reservation));
      }
      if (step === "allocation") {
        const row = reservation(); if (!row || row.occupancy !== "preparing") throw workflowError();
        treehouse.acquireOrReuse(contract.repoRoot, contract.repoKey, contract.ticket);
        return observed(step, leaseFacts(authenticatedLease()!));
      }
      const lease = authenticatedLease()!;
      return inWorktree(lease, () => {
        if (step === "branch") {
          const repo = loadRepoEntry(contract.repoKey); const develop = workflowText(repo?.developBranch ?? "develop");
          if (!repo || repo.path !== contract.repoRoot || contract.integrationTarget !== `origin/${develop}`
            || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(develop) || /\.\.|\/\/|\.lock$|\/$/.test(develop)) throw workflowError();
          git(["fetch", "--", "origin", `refs/heads/${develop}:refs/remotes/origin/${develop}`], contract.repoRoot);
          materializeTicketBranch({ canonicalRepoKey: contract.repoKey, canonicalRepoRoot: contract.repoRoot, worktreeRoot: lease.path, ticketId: contract.ticket,
            ticketStore: tickets, runGit: git, actor: "ppa/preparation", approvedPreparationBaseSha: contract.approvalBaseSha,
            preparedCapacityOwner: owner(), preparationOperationId: operationId });
          return observed(step, tuple(lease));
        }
        const facts = verifyCompletedResources(context, lease); const receipt = context.receipt;
        if (!receipt) throw workflowError();
        if (step === "ready") {
          owner().update(facts.row, parseIdlePreparationReservation({ ...facts.row, occupancy: "idle-ready", receiptId: receipt.receiptId }));
          return observed(step, receipt);
        }
        if (step === "consume") {
          const next = consumer(context);
          owner().update(facts.row, parseIdlePreparationReservation({ ...facts.row, occupancy: "active", receiptId: receipt.receiptId, ...next }));
          return observed(step, { receiptId: receipt.receiptId, consumer: context.consumer });
        }
        throw workflowError();
      });
    },
    resolveReceipt(context): PreparedReceipt {
      assertContext(context); const lease = authenticatedLease()!;
      return inWorktree(lease, () => {
        const facts = verifyCompletedResources(context, lease);
        return parsePreparedReceipt({ schemaVersion: "prepared-receipt/v1", operationId,
          receiptId: workflowDigest(JSON.stringify({ operationId, capacity: capacityFacts(facts.row), lease: facts.lease, tuple: facts.tuple })), state: "ready", contract,
          preparationBaseSha: facts.tuple.baseSha, preparedHeadSha: facts.tuple.headSha, worktreeRoot: lease.path,
          leaseRef: context.results.allocation!.ref, capacityRef: context.results.reservation!.ref, custodyRef: `prepared-custody:${operationId}`,
          ticketReread: context.results["ticket-reread"], observedAt: workflowTimestamp(now()), nextOwner: "builder" });
      });
    },
  };
}

/** Native runtime ports. Tool JSON cannot provide a binding, holder/process or evidence resolver. */
export interface PiExecutionBinding {
  readonly bindingIdentity: string;
  readonly service: ExecutionCustodyService;
  readonly actor: ExecutionHolder;
  /** Validate actual tool arguments, exact physical cwd/paths/shell scope and native correlation. */
  assertToolCall(call: PiToolCall, context: unknown, state: ExecutionState): void;
  /** Match exact approved shell check command; null for ordinary operations. */
  resolveCheck(call: PiToolCall, state: ExecutionState): string | null;
  /** Prove check/process termination and resolve private output/Git records, not tool text claims. */
  resolveToolResult(event: PiExecutionEndEvent, state: ExecutionState): { evidence: SourceVersion; failure: ExecutionFailure | null };
  resolveHolder(source: SourceVersion): ExecutionHolder;
  resolveInventory(source: SourceVersion): ExecutionRecoveryInventory;
  resolveRecovery(source: SourceVersion): ExecutionRecovery;
  resolveCandidate(source: SourceVersion): string;
  /** Authenticate configured origin (including push URL), routine scope, current candidate/custody. */
  assertFeatureUpdate(candidateSha: string, expectedRemoteSha: string, state: ExecutionState): void;
  /** Fixed Git port with private command/stdout/stderr/exit persistence. Never a tool argument. */
  runGit(args: readonly string[], cwd: string): Buffer;
  recordFeatureUpdateIntent(candidateSha: string, expectedRemoteSha: string, state: ExecutionState): SourceVersion;
  recordFeatureUpdate(state: ExecutionState): SourceVersion;
}
export interface PiExecutionEndEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
  readonly isError: boolean;
}
export interface PiExecutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** null ONLY for never-adopted legacy lineages. Retained adopted bindings must survive revocation. */
  readonly resolveBinding?: (context: unknown) => PiExecutionBinding | null;
}
const EvidenceParams = Type.Object({ ref: Type.String(), version: Type.String(), sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, { additionalProperties: false });
const PlanParams = Type.Object({ phaseId: Type.String(), scope: Type.String(), paths: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
  requirements: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }), prerequisites: Type.Array(EvidenceParams, { maxItems: 64 }),
  checks: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }), size: Type.String(), complexity: Type.String(), rationale: Type.String() }, { additionalProperties: false });
export const PiExecutionParams = Type.Union([
  Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("plan"), plan: PlanParams }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("select"), executor: Type.Union([Type.Literal("orchestrator-direct"), Type.Literal("implement-child"), Type.Literal("review-reserved")]), holder: EvidenceParams, handover: EvidenceParams }, { additionalProperties: false }),
  ...["settle", "attempt", "resolve", "candidate"].map((action) => Type.Object({ action: Type.Literal(action), evidence: EvidenceParams }, { additionalProperties: false })),
  Type.Object({ action: Type.Literal("accept"), kind: Type.Union([Type.Literal("review"), Type.Literal("ci"), Type.Literal("uat"), Type.Literal("integration")]), evidence: EvidenceParams }, { additionalProperties: false }),
]);
export const PiFeatureUpdateParams = Type.Object({ candidateSha: Type.String({ pattern: "^[0-9a-f]{40}$" }), expectedRemoteSha: Type.String({ pattern: "^[0-9a-f]{40}$" }) }, { additionalProperties: false });
function executionResult(details: Readonly<Record<string, unknown>>): PiToolResult {
  const text = JSON.stringify(details); if (Buffer.byteLength(text) > MAX_STATUS_BYTES) throw workflowError();
  return { content: [{ type: "text", text }], details: { ...details } };
}
function nativeExecutionCall<T>(action: () => T): T { return workflowSynchronous(action()); }
function assertExecutionCall(action: () => void): void { if (nativeExecutionCall(action) !== undefined) throw workflowError(); }
function executionToolName(call: PiToolCall): string {
  const name = call.toolName ?? call.name;
  if (typeof name !== "string") throw workflowError();
  // Only known runtime aliases. An arbitrary MCP tool named "read" in another namespace is NOT read-only.
  return name.startsWith("functions.") ? name.slice("functions.".length) : name;
}
function readOnlyExecutionCall(name: string, input: Record<string, unknown>): boolean {
  if (["read", "grep", "glob", "find", "ls", "pa_registry", "pa_status", "pa_bulletin", "todo", "question"].includes(name)) return true;
  return name === "pa_ticket" && ["read", "show", "list"].includes(String(input.action));
}
function operationKind(name: string): ExecutionOperationKind {
  if (["write", "write_file"].includes(name)) return "write";
  if (["edit", "edit_file", "apply_patch"].includes(name)) return "edit";
  if (["pa_deploy", "deploy"].includes(name)) return "launch";
  // Treat unknown tools as effectful, not as an implicit escape hatch.
  return "shell";
}
/**
 * Real Pi hooks, disabled until a trusted native lineage binding exists.
 * Both model and nested tools traverse tool_call. Start is persisted BEFORE
 * dispatch; only a native exact-call termination record may close the barrier.
 * Notification failures, cancellation/reload and session shutdown never clear it.
 */
export function createPiExecutionModule(options: PiExecutionOptions = {}): PiExtensionModule {
  return (pi, lifecycle) => {
    const env = { ...(options.env ?? process.env) };
    const resolver = options.resolveBinding ?? (() => null);
    const pending = new Map<string, { binding: PiExecutionBinding; name: string }>();
    let adopted = false; let closing = false;
    lifecycle?.addShutdownStep(() => { closing = true; });
    const resolve = (context: unknown) => {
      const binding = nativeExecutionCall(() => resolver(context));
      if (binding === null) { if (adopted) throw workflowError(); return null; }
      if (closing) throw workflowError();
      workflowSha(binding.bindingIdentity);
      if (!(binding.service instanceof ExecutionCustodyService)) throw workflowError();
      adopted = true;
      return binding;
    };
    const control = (context: unknown) => { const binding = resolve(context); if (!binding) throw workflowError(); return binding; };
    const run = async (action: () => PiToolResult): Promise<PiToolResult> => {
      try { return await (lifecycle ? lifecycle.trackRegistryAccess(action) : action()); } catch { throw workflowError(); }
    };
    if (env.PA_TEAM === "builder" && ["orchestrator", "implement"].includes(env.PA_MODE ?? "")) {
      pi.registerTool?.({
        name: "pa_execution", label: "PA Execution", description: "Record a bounded phase plan and authenticated executor/recovery evidence. Optional automation is inactive without native lineage authority.",
        parameters: PiExecutionParams, executionMode: "sequential",
        execute: async (_id, input, signal, _update, context) => run(() => {
          if (signal?.aborted) throw workflowError();
          if (!input || typeof input !== "object") throw workflowError();
          const binding = control(context); const { service, actor } = binding;
          const action = Object.getOwnPropertyDescriptor(input, "action")?.value;
          if (action === "status") { workflowObject(input, ["action"]); return executionResult(projectExecution(service.status(actor))); }
          let command: ExecutionCommand;
          if (action === "plan") { const row = workflowObject(input, ["action", "plan"]); command = { action, plan: parseExecutionPlan(row.plan) }; }
          else if (action === "select") {
            const row = workflowObject(input, ["action", "executor", "holder", "handover"]);
            if (row.executor !== "orchestrator-direct" && row.executor !== "implement-child" && row.executor !== "review-reserved") throw workflowError();
            command = { action, executor: row.executor, holder: nativeExecutionCall(() => binding.resolveHolder(parseEvidence(row.holder))), handover: parseEvidence(row.handover) };
          } else if (["settle", "attempt", "resolve", "candidate"].includes(action)) {
            const row = workflowObject(input, ["action", "evidence"]); const evidence = parseEvidence(row.evidence);
            if (action === "settle") command = { action, evidence, inventory: nativeExecutionCall(() => binding.resolveInventory(evidence)) };
            else if (action === "attempt") command = { action, recovery: nativeExecutionCall(() => binding.resolveRecovery(evidence)) };
            else if (action === "candidate") command = { action, mapping: evidence, candidateSha: nativeExecutionCall(() => binding.resolveCandidate(evidence)) };
            else command = { action: "resolve", evidence };
          } else if (action === "accept") {
            const row = workflowObject(input, ["action", "kind", "evidence"]);
            if (row.kind !== "review" && row.kind !== "ci" && row.kind !== "uat" && row.kind !== "integration") throw workflowError();
            command = { action, kind: row.kind, evidence: parseEvidence(row.evidence) };
          } else throw workflowError();
          return executionResult(projectExecution(service.apply(actor, command)));
        }),
      });
      pi.registerTool?.({
        name: "pa_feature_update", label: "PA Feature Update", description: "Update only the configured ticket feature ref using an exact expected remote HEAD. No arbitrary remote, refspec, force flag or command.",
        parameters: PiFeatureUpdateParams, executionMode: "sequential",
        execute: async (toolCallId, input, signal, _update, context) => run(() => {
          const row = workflowObject(input, ["candidateSha", "expectedRemoteSha"]);
          if (signal?.aborted) throw workflowError();
          const candidateSha = workflowSha(row.candidateSha, 40); const expectedRemoteSha = workflowSha(row.expectedRemoteSha, 40);
          const binding = control(context); const { service, actor } = binding;
          const state = service.status(actor);
          if (state.candidateSha !== candidateSha) throw workflowError();
          assertExecutionCall(() => binding.assertFeatureUpdate(candidateSha, expectedRemoteSha, state));
          const operationId = `feature-update:${workflowText(toolCallId)}`;
          const intent = parseEvidence(nativeExecutionCall(() => binding.recordFeatureUpdateIntent(candidateSha, expectedRemoteSha, state)));
          service.apply(actor, { action: "begin", operation: { id: operationId, kind: "feature-update", check: null, intent } });
          updateFeatureWithExpectedHead({ binding: service.binding, candidateSha, expectedRemoteSha }, (args, cwd) => binding.runGit(args, cwd));
          const evidence = parseEvidence(nativeExecutionCall(() => binding.recordFeatureUpdate(service.status(actor))));
          return executionResult(projectExecution(service.apply(actor, { action: "finish", operationId, evidence, failure: null })));
        }),
      });
    }
    pi.on?.("tool_call", (raw: unknown, context: unknown) => {
      try {
        const call = raw as PiToolCall & { toolCallId?: string };
        const name = executionToolName(call);
        if (name === "pa_execution" || name === "pa_feature_update" || name === "pa_phase_report" || readOnlyExecutionCall(name, call.input)) return;
        const binding = resolve(context); if (!binding) return;
        const id = workflowText(call.toolCallId); if (pending.has(id)) throw workflowError();
        const state = binding.service.status(binding.actor);
        assertExecutionCall(() => binding.assertToolCall(call, context, state));
        const resolvedCheck = nativeExecutionCall(() => binding.resolveCheck(call, state));
        const check = resolvedCheck === null ? null : workflowText(resolvedCheck);
        if (check !== null && !["bash", "shell", "execute"].includes(name)) throw workflowError();
        binding.service.apply(binding.actor, { action: "begin", operation: { id, kind: check === null ? operationKind(name) : "check", check, intent: null } });
        pending.set(id, { binding, name });
      } catch { return { block: true, reason: workflowError().message }; }
    });
    pi.on?.("tool_execution_end", (raw, context) => {
      try {
      const event = raw as PiExecutionEndEvent;
      const started = pending.get(event.toolCallId); if (!started) return;
      const fresh = resolve(context);
      if (!fresh || fresh.bindingIdentity !== started.binding.bindingIdentity || fresh.service.executionId !== started.binding.service.executionId
        || JSON.stringify(fresh.actor) !== JSON.stringify(started.binding.actor) || executionToolName({ toolName: event.toolName, input: {} }) !== started.name) throw workflowError();
      const state = fresh.service.status(fresh.actor);
      const result = nativeExecutionCall(() => fresh.resolveToolResult(event, state));
      // A native error cannot be laundered into a passing operation by tool text.
      if (typeof event.isError !== "boolean" || (event.isError && !result.failure)) throw workflowError();
      fresh.service.apply(fresh.actor, { action: "finish", operationId: event.toolCallId, evidence: parseEvidence(result.evidence), failure: result.failure });
      pending.delete(event.toolCallId);
      } catch { throw workflowError(); }
    });
    pi.on?.("user_bash", (_event, context) => {
      // The user-bash notification has no authenticated completion boundary. Do
      // not allow it to overlap delegated work or circumvent operation tracking.
      try { if (resolve(context)) throw workflowError(); } catch { throw workflowError(); }
    });
  };
}
function parseEvidence(value: unknown): SourceVersion {
  const row = workflowObject(value, ["ref", "version", "sha256"]);
  return Object.freeze({ ref: workflowText(row.ref), version: workflowText(row.version), sha256: workflowSha(row.sha256) });
}
export const registerExecutionCustodyModule: PiExtensionModule = createPiExecutionModule();

export interface PiPhaseReportBinding {
  readonly service: PhaseReportService;
  resolveReport(source: SourceVersion): PhaseReport;
  resolveReceipt(source: SourceVersion): PhaseReportReceipt;
}
export interface PiPhaseReportOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Native artifact/caller authority, including ticketless rogue-one. No builder admission is added. */
  readonly resolveBinding?: (context: unknown) => PiPhaseReportBinding | null;
}
export const PiPhaseReportParams = Type.Union([
  Type.Object({ action: Type.Literal("publish"), source: EvidenceParams }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("status"), report: Type.Optional(EvidenceParams) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("settle"), report: EvidenceParams, deliveries: Type.Array(EvidenceParams, { maxItems: 2 }) }, { additionalProperties: false }),
]);
export function createPiPhaseReportModule(options: PiPhaseReportOptions = {}): PiExtensionModule {
  return (pi, lifecycle) => {
    const env = options.env ?? process.env;
    if (env.PA_TEAM !== "rogue-one" && !(env.PA_TEAM === "builder" && ["implement", "orchestrator"].includes(env.PA_MODE ?? ""))) return;
    const resolve = options.resolveBinding ?? (() => null);
    pi.registerTool?.({ name: "pa_phase_report", label: "PA Phase Report", description: "Publish or settle immutable source-bound phase evidence; HTML generation is not browser/Obsidian delivery or human UAT. Requires native artifact authority.", parameters: PiPhaseReportParams, executionMode: "sequential",
      execute: async (_id, input, signal, _update, context) => {
        const run = () => {
          if (signal?.aborted) throw workflowError();
          const action = Object.getOwnPropertyDescriptor(input, "action")?.value;
          const keys = action === "publish" ? ["action", "source"] : action === "settle" ? ["action", "report", "deliveries"] : action === "status" ? ["action", ...(Object.hasOwn(input, "report") ? ["report"] : [])] : [];
          const row = workflowObject(input, keys); if (!keys.length) throw workflowError();
          const binding = nativeExecutionCall(() => resolve(context));
          if (binding === null) {
            if (action !== "status" || row.report !== undefined) throw workflowError();
            return executionResult({ schemaVersion: "phase-report-tool-status/v1", state: "inactive", artifactAuthorityAvailable: false });
          }
          if (!(binding.service instanceof PhaseReportService)) throw workflowError();
          if (action === "publish") {
            const report = parsePhaseReport(nativeExecutionCall(() => binding.resolveReport(parseEvidence(row.source))));
            const receipt = binding.service.publish(report);
            return executionResult(binding.service.settle(receipt));
          }
          if (action === "status" && row.report === undefined) return executionResult({ schemaVersion: "phase-report-tool-status/v1", artifactAuthorityAvailable: true });
          const receipt = nativeExecutionCall(() => binding.resolveReceipt(parseEvidence(row.report)));
          if (action === "settle" && (!Array.isArray(row.deliveries) || row.deliveries.length > 2)) throw workflowError();
          return executionResult(binding.service.settle(receipt, action === "settle" ? (row.deliveries as unknown[]).map(parseEvidence) : []));
        };
        try { return await (lifecycle ? lifecycle.trackRegistryAccess(run) : run()); } catch { throw workflowError(); }
      },
    });
  };
}
export const registerPhaseReportModule: PiExtensionModule = createPiPhaseReportModule();
