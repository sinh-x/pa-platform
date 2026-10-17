import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import {
  MAX_REPOSITORY_TICKET_SLOTS, loadRepoEntry, materializeTicketBranch, parseExecutionCustody, parseIdlePreparationReservation,
  requireTicketLinkedBranch, TicketStore, withPreparedTicketCapacity, withVacantPreparationWorktree,
  PA_PI_EXECUTION_MODE_ENV, parsePreparationContract, parsePreparedReceipt, preparationIdentity,
  processIsWithinFingerprintLineage, publishNativePreparationRetry, queryDeploymentStatus,
  readProcessFingerprint, resolveRepoExecutionPath, withPreparedWorkflowLocks, workflowDigest,
  workflowError, workflowObject, workflowSha, workflowSynchronous, workflowText, workflowTimestamp,
  type ExecutionHolder, type IdlePreparationReservation, type PreparationAction, type PreparationContract,
  type PreparationHost, type PreparationOutcome, type PreparationStepContext, type PreparedReceipt,
  type PreparedTicketCapacityTransaction, type RepositoryTicketSlotDependencies, type SourceVersion,
  type PreparedWorkflowService, type PreparationStatus,
} from "@pa-platform/pa-core";
import { TreehouseClient, deriveTreehouseLeaseHolder, type TreehouseLeaseEvidence } from "../treehouse.js";
import type { PiExtensionModule, PiSessionLifecycle, PiToolDefinition, PiToolResult } from "./index.js";

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
  // Deliberately no environment enable switch or default permissive host. A future
  // native activation owner must supply a verified runtime binding, not copied JSON.
  const resolveBinding = options.resolveBinding ?? (() => null);
  const now = options.now ?? (() => new Date().toISOString());
  const createEventId = options.createEventId ?? randomUUID;
  let mutating = false;
  const resolve = (context: PiPreparationContext) => {
    if (context.mode !== "tui" || !isInteractivePreparationEnvironment(env)) throw workflowError();
    const caller = validateCaller(workflowSynchronous(authenticate(context)));
    const binding = workflowSynchronous(resolveBinding(caller));
    if (!binding) return { caller, binding: null };
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

export interface PiPreparationHostOptions {
  /** Mandatory trusted native-policy/promotion/caller authority; no default implementation. */
  readonly authorize: PreparationHost["authorize"];
  /** Revalidate exact protected source/policy bindings at every resource boundary. */
  readonly assertCurrentBindings: (contract: PreparationContract) => void;
  readonly resolveConsumer?: (source: SourceVersion) => { lineageId: string; holder: ExecutionHolder };
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
    return { lineageId: workflowText(resolved.lineageId), custody };
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
          || JSON.stringify(facts.row.custody) !== JSON.stringify(next.custody)) throw workflowError();
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
