import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assessTestWorkflow, captureRepositoryGitSnapshot, executionBoundStop, loadRepoEntry,
  materializeTicketBranch, parseIdlePreparationReservation, parseTestAuthorization,
  ProtectedWorkflowStore, readProcessFingerprint, requireTicketLinkedBranch,
  parseReviewEvidenceJson, parseSourceVersion, parseTestWorkflowEvent, readReviewEvidenceFile, refreshTicketLinkedBranchHead, requirementsTestCapability, resolveRepoExecutionPath, withExecutionWorktreeAdmission,
  withPreparedTicketCapacity, withPreparedWorkflowLocks, withVacantPreparationWorktree,
  testWorkflowInvalidation, workflowDigest, workflowError, workflowObject, workflowSha, workflowSynchronous,
  type ExecutionHolder, type IdlePreparationReservation, type PreparedLockScope,
  type PreparedTicketCapacityTransaction, type RepositoryGitSnapshot, type SourceVersion,
  type TestAuthorization, type TestGitEvidence, type TestResource, type TestWorkflowAssessment, type TestEventData, type TestProcessResult,
  queryDeploymentStatus, processIsWithinFingerprintLineage, workflowTimestamp, type TicketStore,
} from "@pa-platform/pa-core";
import { authenticatePiPreparationCaller, type PiPreparationCaller, type PiPreparationContext } from "./pi-extension/prepared-workflow.js";
import { PiPreparedNativeAuthority, currentPreparedNativeRuntime, type PreparedNativeRuntime } from "./prepared-native.js";
import { TreehouseClient, type TreehouseLeaseEvidence } from "./treehouse.js";
import { NativeExecutionEvidence, type NativeProcessResult } from "./native-execution-evidence.js";

const VERSION = "requirements-test-native/v1";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (operationId: string) => workflowDigest(JSON.stringify([VERSION, workflowSha(operationId)]));
function synchronous(action: () => void): void { if (workflowSynchronous(action()) !== undefined) throw workflowError(); }
function nativeGuard<T>(action: () => T): T { try { return workflowSynchronous(action()); } catch { throw workflowError(); } }
function git(args: readonly string[], cwd: string): Buffer {
  // Never inherit Git ref/index/identity/alternate-object overrides. Normal hooks
  // and trust policy are left intact; this is NOT arbitrary-code confinement.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["--no-optional-locks", ...args], { cwd, env, timeout: 15_000, maxBuffer: 16_777_216, stdio: ["ignore", "pipe", "pipe"] });
}
function snapshot(root: string): RepositoryGitSnapshot { return captureRepositoryGitSnapshot(root, git); }
function clean(root: string, branch: string, head: string): RepositoryGitSnapshot {
  const value = snapshot(root);
  if (value.branch !== branch || value.head !== head || value.dirty || value.statusPorcelainV2Base64 !== "") throw workflowError();
  return value;
}
function reference(kind: string, value: unknown): SourceVersion {
  return Object.freeze({ ref: `requirements-test-native:${kind}`, version: VERSION, sha256: workflowDigest(JSON.stringify(value)) });
}

/** Trusted native producer ports, NOT model/tool/CLI options. A parser, callback
 * result, public JSON or this constructor does not grant production admission.
 * Phase 3 supplies native operator/tool/result producers; phase 4 qualifies them.
 * No default success implementation, fake executor or activation is provided. */
export interface RequirementsTestNativeAuthority {
  recordEvent?(scope: PreparedLockScope, authorization: TestAuthorization, data: TestEventData): void;
  recordTestSettlement?(scope: PreparedLockScope, authorization: TestAuthorization, resource: TestResource, launch: RequirementsTestLaunch): void;
  /** Return original approved bytes from the existing protected store. */
  readAuthorization(operationId: string): string;
  authorizationDecision(authorization: TestAuthorization): SourceVersion;
  /** Independently authenticate live caller, exact native test-only decision,
   * registered canonical root, installed pair and unchanged source bytes. */
  assertAuthorization(authorization: TestAuthorization, rawSha256: string): void;
  /** Retained settlement is permitted after deadline/caller exit, never new work. */
  assertRetainedAuthorization(authorization: TestAuthorization, rawSha256: string): void;
  /** Read the COMPLETE service-owned phase-3 event chain, not a caller prefix. */
  readFinalHistory(authorization: TestAuthorization): readonly string[];
  /** Independently resolve final pair, non-author review, all original results,
   * settlement and operator capture. Model replay alone never satisfies this. */
  assertFinalApproval(authorization: TestAuthorization, assessment: TestWorkflowAssessment): void;
  readPreviousAuthorization(authorization: TestAuthorization): string;
  assertAmendment(previous: TestAuthorization, next: TestAuthorization): void;
  assertCapacityRetry(authorization: TestAuthorization, decision: SourceVersion, failure: SourceVersion, retriesUsed: number): void;
}
export interface RequirementsTestLaunch {
  readonly holder: ExecutionHolder;
  readonly deploymentDirectory: string;
  readonly registry: SourceVersion;
}
export interface RequirementsTestNativeExecutor {
  /** Production parked lifecycle. No lock scope/capacity handle crosses await. */
  prepareAsync?(role: "test" | "product", intentId: string, resource: TestResource, signal?: AbortSignal): Promise<RequirementsTestLaunch>;
  startAsync?(launch: RequirementsTestLaunch, intentId: string, signal?: AbortSignal): Promise<void>;
  /** Create a parked native process/registry anchor; no test/product code yet.
   * Called only after durable spawn intent. Missing capability MUST throw. */
  prepare(role: "test" | "product", intentId: string, resource: TestResource): RequirementsTestLaunch;
  /** Inspect same intent after any interruption; never blindly spawn again. */
  inspect(role: "test" | "product", intentId: string, resource: TestResource): RequirementsTestLaunch;
  /** Authenticate actual process incarnation + registry correlation (not passed flags). */
  assertParked(launch: RequirementsTestLaunch, resource: TestResource, role: "test" | "product"): void;
  /** Release only the already-correlated parked process after launch publication. */
  start(launch: RequirementsTestLaunch, intentId: string): void;
  /** Reconcile a lost release response from native process/service evidence. */
  assertStarted(launch: RequirementsTestLaunch, intentId: string): void;
  /** Actual process absence AND terminal registry, retaining original failures. */
  assertSettled(launch: RequirementsTestLaunch): void;
  cancel?(launch: RequirementsTestLaunch): void;
}
export interface RequirementsTestNativeOptions {
  readonly store: ProtectedWorkflowStore;
  readonly authority: RequirementsTestNativeAuthority;
  readonly executor: RequirementsTestNativeExecutor;
  readonly tickets: TicketStore;
  readonly treehouse?: TreehouseClient;
  readonly now?: () => string;
  /** Isolated fault tests only; throwing preserves intent/effects/resources. */
  readonly boundary?: (point: string) => void;
}
type Step = "reservation" | "allocation" | "branch" | "test-process" | "test-start" | "test-settlement" | "product-process" | "product-transfer" | "product-start" | "product-settlement";
interface NativeRecord {
  readonly schemaVersion: typeof VERSION;
  readonly operationId: string;
  readonly authorizationSha256: string;
  readonly sequence: number;
  readonly previousSha256: string;
  readonly step: Step | "request" | "cancel" | "capacity-retry";
  readonly state: "intent" | "observed" | "failed" | "unknown" | "cancelled";
  readonly value: unknown;
}
const STEPS: readonly Step[] = ["reservation", "allocation", "branch", "test-process", "test-start", "test-settlement", "product-process", "product-transfer", "product-start", "product-settlement"];
const CAPACITY_RETRY_VERSION = "requirements-test-native-capacity-retry/v1";
function loadNativeRecords(store: ProtectedWorkflowStore, auth: TestAuthorization, digest: string): readonly NativeRecord[] {
  const id = identity(auth.operationId); const names = store.records().filter((name) => name.startsWith(`${id}.`));
  if (!names.length) return [];
  if (!names.includes(`${id}.intent.json`) || names.length > 128) throw workflowError();
  const records: NativeRecord[] = []; let previous = digest;
  for (let sequence = 0; sequence < names.length; sequence++) {
    const name = sequence === 0 ? `${id}.intent.json` : `${id}.transaction-${sequence}.json`;
    if (!names.includes(name)) throw workflowError();
    const row = workflowObject(store.read(name), ["schemaVersion", "operationId", "authorizationSha256", "sequence", "previousSha256", "step", "state", "value"]);
    if (row.schemaVersion !== VERSION || row.operationId !== auth.operationId || row.authorizationSha256 !== digest || row.sequence !== sequence || row.previousSha256 !== previous
      || !["request", "cancel", "capacity-retry", ...STEPS].includes(String(row.step)) || !["intent", "observed", "failed", "unknown", "cancelled"].includes(String(row.state))) throw workflowError();
    const record = row as unknown as NativeRecord;
    if (sequence === 0 && (record.step !== "request" || record.state !== "intent")) throw workflowError();
    records.push(record); previous = workflowDigest(JSON.stringify(record));
  }
  return records;
}
function capacityRetryState(auth: TestAuthorization, records: readonly NativeRecord[], capacity: PreparedTicketCapacityTransaction) {
  const last = records.at(-1);
  const failures = records.filter((row) => row.state === "failed" || row.state === "unknown");
  const retriesUsed = auth.retriesUsed + records.filter((row) => row.step === "capacity-retry").length + 1;
  if (!last || last.step !== "reservation" || last.state !== "failed"
    || !same(last.value, { reason: "not-ready-capacity", operatorNotificationRequired: true, retry: "operator-manual-only" })
    || records.some((row) => row.state === "unknown" || row.state === "cancelled" || row.step === "cancel" || (row.state === "observed" && row.step !== "capacity-retry"))
    || capacity.inventory().some((row) => row.ticket === auth.repository.ticket)
    || retriesUsed > auth.retryLimit || auth.bounds.consecutiveNoProgress + failures.length >= 3) throw workflowError();
  return Object.freeze({ failure: reference("capacity-failure", last), retriesUsed, bounds: auth.bounds });
}
function capacityRetryId(auth: TestAuthorization, failure: SourceVersion, retriesUsed: number): string {
  return workflowDigest(JSON.stringify([CAPACITY_RETRY_VERSION, auth.operationId, failure, retriesUsed]));
}
/** Staged native transaction adapter. Uses the existing protected store and
 * shared capacity -> worktree -> publication owners, no second workflow DB.
 * Internal embedding API only; no Pi tool, generic deploy flag or core export.
 * Production selection remains disabled, including on a perfect source replay. */
export class RequirementsTestNativeService {
  readonly #treehouse: TreehouseClient;
  readonly #now: () => string;
  constructor(readonly options: RequirementsTestNativeOptions) {
    this.#treehouse = options.treehouse ?? new TreehouseClient({ binary: "treehouse" });
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  #authorization(operationId: string, newWork = true): { raw: string; auth: TestAuthorization; sha256: string } {
    const raw = workflowSynchronous(this.options.authority.readAuthorization(workflowSha(operationId)));
    const auth = parseTestAuthorization(raw); const sha256 = workflowDigest(raw);
    if (auth.operationId !== operationId) throw workflowError();
    synchronous(() => newWork ? this.options.authority.assertAuthorization(auth, sha256) : this.options.authority.assertRetainedAuthorization(auth, sha256));
    const registered = loadRepoEntry(auth.repository.key);
    if (!registered || registered.path !== auth.repository.root || realpathSync(auth.repository.root) !== auth.repository.root) throw workflowError();
    // Deadlines are native now, never caller timestamps/commit dates. Every
    // operation retains original accounting; no resume/replacement reset exists.
    const failures = this.#load(auth, sha256).filter((record) => record.state === "failed" || record.state === "unknown").length;
    if (newWork && (executionBoundStop(auth.bounds, this.#now()) || auth.retriesUsed >= auth.retryLimit || auth.bounds.consecutiveNoProgress + failures >= 3)) throw workflowError();
    return { raw, auth, sha256 };
  }
  #load(auth: TestAuthorization, digest: string): readonly NativeRecord[] {
    return loadNativeRecords(this.options.store, auth, digest);
  }
  #append(scope: PreparedLockScope, auth: TestAuthorization, digest: string, records: readonly NativeRecord[], step: NativeRecord["step"], state: NativeRecord["state"], value: unknown): NativeRecord {
    const sequence = records.length;
    if (sequence >= 128) throw workflowError();
    const record: NativeRecord = { schemaVersion: VERSION, operationId: auth.operationId, authorizationSha256: digest, sequence,
      previousSha256: sequence ? workflowDigest(JSON.stringify(records.at(-1))) : digest, step, state, value };
    const name = sequence ? `${identity(auth.operationId)}.transaction-${sequence}.json` : `${identity(auth.operationId)}.intent.json`;
    this.options.store.publish(scope, name, record); this.options.boundary?.(`${step}:${state}`); return record;
  }
  #locked<T>(auth: TestAuthorization, action: (capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope) => T, worktree?: string): T {
    let transaction: PreparedTicketCapacityTransaction | null = null;
    return withPreparedWorkflowLocks({
      repository: (run) => withPreparedTicketCapacity({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root }, (owner) => { transaction = owner; return run(); }),
      worktree: (run) => worktree ? withExecutionWorktreeAdmission(auth.repository.root, worktree, transaction!, () => run()) : run(),
    }, (scope) => action(transaction!, scope));
  }
  #row(auth: TestAuthorization, capacity: PreparedTicketCapacityTransaction): IdlePreparationReservation {
    const row = capacity.inventory().find((row) => row.ticket === auth.repository.ticket);
    if (!row || !("operationId" in row) || row.operationId !== auth.operationId || row.purpose !== "requirements-test-workflow/v1") throw workflowError();
    return parseIdlePreparationReservation(row);
  }
  #observed<T>(records: readonly NativeRecord[], step: Step): T {
    const result = records.filter((record) => record.step === step && record.state === "observed");
    if (result.length !== 1) throw workflowError(); return result[0]!.value as T;
  }
  #lease(auth: TestAuthorization, lease?: TreehouseLeaseEvidence): TreehouseLeaseEvidence {
    const actual = lease ? this.#treehouse.authenticatePrepared(auth.repository.root, auth.repository.key, auth.repository.ticket, lease.path)
      : this.#treehouse.selectExisting(auth.repository.root, auth.repository.key, auth.repository.ticket);
    if (lease && !same(actual, lease)) throw workflowError();
    const physical = resolveRepoExecutionPath(undefined, actual.path, { allowLinkedWorktreeCwd: true });
    if (physical.repoKey !== auth.repository.key || physical.repoRoot !== auth.repository.root || physical.worktreeRoot !== actual.path || physical.worktreeKind !== "linked") throw workflowError();
    return actual;
  }
  #resource(auth: TestAuthorization, records: readonly NativeRecord[], capacity: PreparedTicketCapacityTransaction): TestResource {
    const row = this.#row(auth, capacity); const lease = this.#lease(auth, this.#observed<TreehouseLeaseEvidence>(records, "allocation"));
    return { repository: auth.repository, worktreeRoot: lease.path, leaseId: lease.leaseId, leaseHolder: lease.leaseHolder,
      reservationId: row.reservationId, repositoryPermit: row.repositoryPermit, lineageId: row.lineageId ?? `test-${auth.operationId}` };
  }
  #runStep<T>(auth: TestAuthorization, digest: string, capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope, step: Step,
    perform: () => T, reconcile: () => T, validate: (value: T) => void, beforeEffect?: () => void): T {
    let records = this.#load(auth, digest);
    const lastRetry = records.reduce((last, record, index) => record.step === "capacity-retry" ? index : last, -1);
    if (records.some((record, index) => record.step === "cancel" || record.state === "cancelled" || (record.state === "failed" && index > lastRetry))) throw workflowError();
    const completed = records.find((record) => record.step === step && record.state === "observed");
    if (completed) { const value = completed.value as T; validate(value); return value; }
    const prior = records.filter((record, index) => record.step === step && (step !== "reservation" || index > lastRetry));
    // No automatic retries of failure/capacity/absence. A crash with pending
    // intent can ONLY inspect the SAME effect; unknown never means absent.
    const pending = prior.length > 0;
    if (!pending) {
      synchronous(() => this.options.authority.assertAuthorization(auth, digest));
      this.#append(scope, auth, digest, records, step, "intent", { intentId: workflowDigest(JSON.stringify([auth.operationId, step])) });
    }
    records = this.#load(auth, digest);
    beforeEffect?.();
    try {
      const value = workflowSynchronous(pending ? reconcile() : perform());
      validate(value);
      this.#append(scope, auth, digest, records, step, "observed", value);
      return value;
    } catch (error) {
      // Retain fixed public category plus private owning process/Treehouse/store
      // originals. Never interpolate command/error/secret text into public status.
      records = this.#load(auth, digest);
      if (!records.some((row) => row.step === step && row.state === "failed")) {
        const original = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null,
          stdout: "stdout" in error && Buffer.isBuffer(error.stdout) ? error.stdout.toString("base64") : null,
          stderr: "stderr" in error && Buffer.isBuffer(error.stderr) ? error.stderr.toString("base64") : null } : { kind: "non-error-native-failure" };
        // Private owner-only record: no raw originals enter status or reports.
        this.#append(scope, auth, digest, records, step, "unknown", { original, retained: true });
      }
      throw workflowError();
    }
  }
  /** Records request before capacity/Treehouse/branch/process effects. Does not
   * automatically retry a full-capacity request or completed release operation. */
  request(operationId: string): Readonly<{ state: "test-active"; resource: TestResource }> { return nativeGuard(() => this.#request(operationId)); }
  #request(operationId: string, deferProcess = false): Readonly<{ state: "test-active"; resource: TestResource }> {
    const { auth, sha256 } = this.#authorization(operationId);
    // Validate immutable source and branch-plan bindings BEFORE reserving or
    // asking Treehouse for anything. Rejections here have zero resource effects.
    const prior = this.#load(auth, sha256);
    const ticket = this.options.tickets.get(auth.repository.ticket); if (!ticket) throw workflowError();
    const linked = requireTicketLinkedBranch(ticket, auth.repository.key);
    if (linked.branch !== auth.repository.branch || (!prior.length && !auth.amendment && linked.state !== "planned")
      || (linked.state === "materialized" && (linked.baseSha !== auth.repository.baseSha || linked.headSha !== auth.repository.selectedHeadSha))) throw workflowError();
    if (git(["rev-parse", "--verify", `${auth.repository.selectedHeadSha}^{commit}`], auth.repository.root).toString("utf8").trim() !== auth.repository.selectedHeadSha) throw workflowError();
    for (const path of auth.paths) {
      const entry = git(["ls-tree", "-z", auth.repository.selectedHeadSha, "--", path.path], auth.repository.root).toString("utf8");
      if (path.beforeSha256 === null ? entry !== "" : !/^100(?:644|755) blob /.test(entry) || workflowDigest(git(["show", `${auth.repository.selectedHeadSha}:${path.path}`], auth.repository.root)) !== path.beforeSha256) throw workflowError();
    }
    return this.#locked(auth, (capacity, scope) => {
      let records = this.#load(auth, sha256);
      if (!records.length) this.#append(scope, auth, sha256, records, "request", "intent", { repository: auth.repository, approval: parseSourceVersion(this.options.authority.authorizationDecision(auth)), bounds: auth.bounds, retriesUsed: auth.retriesUsed, elapsedMs: auth.elapsedMs });
      records = this.#load(auth, sha256);
      this.options.authority.recordEvent?.(scope, auth, { action: "authorized", owner: "sinh", decision: this.options.authority.authorizationDecision(auth) });
      this.options.authority.recordEvent?.(scope, auth, { action: "intent-recorded", intentId: workflowDigest(JSON.stringify([auth.operationId, "reservation"])) });
      const amend = (): IdlePreparationReservation => {
        const previousRaw = workflowSynchronous(this.options.authority.readPreviousAuthorization(auth));
        const previous = parseTestAuthorization(previousRaw);
        const history = workflowSynchronous(this.options.authority.readFinalHistory(previous));
        testWorkflowInvalidation(previousRaw, this.options.authority.readAuthorization(auth.operationId), history);
        synchronous(() => this.options.authority.assertAmendment(previous, auth));
        const oldRecords = this.#load(previous, workflowDigest(previousRaw));
        const settled = this.#observed<{ resource: TestResource; launch: RequirementsTestLaunch }>(oldRecords, "test-settlement");
        synchronous(() => this.options.executor.assertSettled(settled.launch));
        const lease = this.#lease(auth); if (lease.path !== settled.resource.worktreeRoot || lease.leaseId !== settled.resource.leaseId || lease.leaseHolder !== settled.resource.leaseHolder) throw workflowError();
        clean(lease.path, auth.repository.branch, auth.repository.selectedHeadSha);
        const oldGit = history.map((raw) => parseTestWorkflowEvent(raw).data).find((event) => event.action === "test-settled");
        if (!oldGit || oldGit.action !== "test-settled") throw workflowError();
        verifyRequirementsTestGit(previous, settled.resource, oldGit.git);
        const row = capacity.inventory().find((row) => row.ticket === auth.repository.ticket);
        if (!row || !("operationId" in row) || row.purpose !== "requirements-test-workflow/v1" || row.occupancy !== "settled-retained"
          || row.reservationId !== settled.resource.reservationId || row.repositoryPermit !== settled.resource.repositoryPermit || row.lineageId !== settled.resource.lineageId) throw workflowError();
        if (row.operationId === auth.operationId) return row; // reconcile SAME migration
        if (row.operationId !== previous.operationId) throw workflowError();
        return capacity.amendTestOperation(row, auth.operationId);
      };
      const reserved = this.#runStep(auth, sha256, capacity, scope, "reservation", () => {
        if (auth.amendment) return amend();
        const outcome = capacity.reserve({ ticket: auth.repository.ticket, operationId: auth.operationId, reservationId: workflowDigest(JSON.stringify([VERSION, auth.operationId, "reservation"])), retainedAt: this.#now(), purpose: "requirements-test-workflow/v1" });
        if (outcome.status === "capacity") {
          this.#append(scope, auth, sha256, this.#load(auth, sha256), "reservation", "failed", { reason: "not-ready-capacity", operatorNotificationRequired: true, retry: "operator-manual-only" });
          throw workflowError();
        }
        return outcome.reservation;
      }, () => auth.amendment ? amend() : this.#row(auth, capacity), (row) => { if (row.reservationId !== this.#row(auth, capacity).reservationId) throw workflowError(); });
      const lease = this.#runStep(auth, sha256, capacity, scope, "allocation", () => auth.amendment ? this.#lease(auth) : this.#treehouse.acquireOrReuse(auth.repository.root, auth.repository.key, auth.repository.ticket),
        () => this.#lease(auth), (value) => { this.#lease(auth, value); });
      this.#runStep(auth, sha256, capacity, scope, "branch", () => withVacantPreparationWorktree(auth.repository.root, lease.path, capacity, () => {
        const before = snapshot(lease.path); if (before.dirty || before.statusPorcelainV2Base64 !== "") throw workflowError();
        const ticket = this.options.tickets.get(auth.repository.ticket); if (!ticket) throw workflowError();
        const linked = requireTicketLinkedBranch(ticket, auth.repository.key);
        if (linked.branch !== auth.repository.branch || (auth.amendment ? linked.state !== "materialized" || linked.baseSha !== auth.repository.baseSha || linked.headSha !== auth.repository.selectedHeadSha : linked.state !== "planned")) throw workflowError();
        if (auth.amendment) return clean(lease.path, auth.repository.branch, auth.repository.selectedHeadSha);
        const branch = materializeTicketBranch({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root, worktreeRoot: lease.path, ticketId: auth.repository.ticket,
          approvedPreparationBaseSha: auth.repository.baseSha, preparationOperationId: auth.operationId, preparedCapacityOwner: capacity, ticketStore: this.options.tickets, runGit: git });
        if (branch.headSha !== auth.repository.selectedHeadSha) throw workflowError();
        return clean(lease.path, auth.repository.branch, auth.repository.selectedHeadSha);
      }), () => withVacantPreparationWorktree(auth.repository.root, lease.path, capacity, () => {
        const current = clean(lease.path, auth.repository.branch, auth.repository.selectedHeadSha);
        const ticket = this.options.tickets.get(auth.repository.ticket); if (!ticket) throw workflowError();
        const linked = requireTicketLinkedBranch(ticket, auth.repository.key);
        if (linked.state === "planned" && !auth.amendment) {
          // Existing owner recognizes only this intent's already-created exact
          // branch at the approved base. Completes ticket publication, no checkout.
          materializeTicketBranch({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root, worktreeRoot: lease.path, ticketId: auth.repository.ticket,
            approvedPreparationBaseSha: auth.repository.baseSha, preparationOperationId: auth.operationId, preparedCapacityOwner: capacity, ticketStore: this.options.tickets, runGit: git });
        }
        return current;
      }), (value) => {
        if (!same(value, clean(lease.path, auth.repository.branch, auth.repository.selectedHeadSha))) throw workflowError();
        const ticket = this.options.tickets.get(auth.repository.ticket); if (!ticket) throw workflowError();
        const linked = requireTicketLinkedBranch(ticket, auth.repository.key);
        if (linked.state !== "materialized" || linked.branch !== auth.repository.branch || linked.baseSha !== auth.repository.baseSha || linked.headSha !== auth.repository.selectedHeadSha) throw workflowError();
      });
      return withVacantPreparationWorktree(auth.repository.root, lease.path, capacity, () => {
      records = this.#load(auth, sha256);
      let row = this.#row(auth, capacity);
      if (row.occupancy === "preparing") row = capacity.update(row, parseIdlePreparationReservation({ ...row, occupancy: "idle-ready", receiptId: workflowDigest(JSON.stringify([auth.operationId, lease])) }));
      const resource: TestResource = { repository: auth.repository, worktreeRoot: lease.path, leaseId: lease.leaseId, leaseHolder: lease.leaseHolder,
        reservationId: reserved.reservationId, repositoryPermit: reserved.repositoryPermit, lineageId: reserved.lineageId ?? `test-${auth.operationId}` };
      // Async composition stops here with durable exclusive reservation. The
      // internal marker is never returned as test-active to a native caller.
      if (deferProcess) return Object.freeze({ state: "test-active" as const, resource });
      const launch = this.#launch(auth, sha256, capacity, scope, "test", resource);
      row = this.#row(auth, capacity);
      if (row.occupancy === "idle-ready" || (auth.amendment && row.occupancy === "settled-retained")) capacity.update(row, parseIdlePreparationReservation({ ...row, occupancy: "active", lineageId: resource.lineageId,
        custody: { state: "implement-child", holder: launch.holder, inFlightOperation: null }, launch: { slotToken: randomUUID(), deploymentDirectory: launch.deploymentDirectory, acquiredAt: this.#now() } }));
      else if (row.occupancy !== "active" || !same(row.custody.holder, launch.holder)) throw workflowError();
      this.#start(auth, sha256, capacity, scope, "test", launch, resource);
      return Object.freeze({ state: "test-active" as const, resource });
      });
    });
  }
  /** Native request uses short synchronous transactions around bounded async
   * parked actions. A pending intent is inspect-only across service instances. */
  async requestAsync(operationId: string, signal?: AbortSignal): Promise<Readonly<{ state: "test-active"; resource: TestResource }>> {
    try {
      if (signal?.aborted || !this.options.executor.prepareAsync || !this.options.executor.startAsync) throw workflowError();
      const { resource } = this.#request(operationId, true);
      await this.#asyncLifecycle(operationId, "test", resource, signal);
      const { auth, sha256 } = this.#authorization(operationId);
      const launch = this.#observed<RequirementsTestLaunch>(this.#load(auth, sha256), "test-process");
      if (!same(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) throw workflowError();
      return Object.freeze({ state: "test-active", resource });
    } catch {
      if (signal?.aborted) { try { this.cancel(operationId); } catch { /* cancellation/unknown effects remain retained */ } }
      throw workflowError();
    }
  }
  async #asyncLifecycle(operationId: string, role: "test" | "product", resource: TestResource, signal?: AbortSignal): Promise<void> {
    const { auth, sha256 } = this.#authorization(operationId);
    const processStep = `${role}-process` as const, startStep = `${role}-start` as const;
    const processIntent = workflowDigest(JSON.stringify([auth.operationId, processStep]));
    const startIntent = workflowDigest(JSON.stringify([auth.operationId, startStep]));
    const retained = () => {
      if (signal?.aborted) throw workflowError();
      synchronous(() => this.options.authority.assertAuthorization(auth, sha256));
      if (executionBoundStop(auth.bounds, this.#now())) throw workflowError();
      const records = this.#load(auth, sha256);
      const lastRetry = records.reduce((last, row, index) => row.step === "capacity-retry" ? index : last, -1);
      if (records.some((row, index) => row.step === "cancel" || row.state === "cancelled" || (row.state === "failed" && index > lastRetry))) throw workflowError();
      return records;
    };
    const preparing = this.#locked(auth, (capacity, scope) => {
      const records = retained();
      if (!same(this.#resource(auth, records, capacity), resource)) throw workflowError();
      if (role === "product") this.#final(auth, records, capacity);
      const observed = records.find((row) => row.step === processStep && row.state === "observed");
      if (observed) return { kind: "observed" as const, launch: observed.value as RequirementsTestLaunch };
      const pending = records.some((row) => row.step === processStep);
      if (!pending) this.#append(scope, auth, sha256, records, processStep, "intent", { intentId: processIntent, resource });
      if (role === "product") this.#productIntent(auth, sha256, capacity, scope, resource);
      return { kind: pending ? "inspect" as const : "prepare" as const };
    }, resource.worktreeRoot);
    let launch: RequirementsTestLaunch;
    try {
      launch = preparing.kind === "observed" ? preparing.launch : preparing.kind === "inspect"
        ? this.options.executor.inspect(role, processIntent, resource)
        : await this.options.executor.prepareAsync!(role, processIntent, resource, signal);
      this.#locked(auth, (capacity, scope) => {
        const records = retained();
        parseSourceVersion(launch.registry);
        if (!same(this.#resource(auth, records, capacity), resource) || launch.holder.deploymentId === auth.parent.holder.deploymentId
          || !same(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)
          || realpathSync(launch.deploymentDirectory) !== launch.deploymentDirectory) throw workflowError();
        if (records.some((row) => row.step === startStep)) synchronous(() => this.options.executor.assertStarted(launch, startIntent));
        else synchronous(() => this.options.executor.assertParked(launch, resource, role));
        const old = records.find((row) => row.step === processStep && row.state === "observed");
        if (old && !same(old.value, launch)) throw workflowError();
        if (!old) this.#append(scope, auth, sha256, records, processStep, "observed", launch);
      }, resource.worktreeRoot);
    } catch {
      this.#locked(auth, (_capacity, scope) => {
        const records = this.#load(auth, sha256);
        if (!records.some((row) => row.step === processStep && row.state === "unknown")) this.#append(scope, auth, sha256, records, processStep, "unknown", { retained: true });
      }, resource.worktreeRoot);
      throw workflowError();
    }
    const release = this.#locked(auth, (capacity, scope) => {
      const records = retained(); const row = this.#row(auth, capacity);
      if (!same(this.#resource(auth, records, capacity), resource)) throw workflowError();
      if (records.some((entry) => entry.step === startStep)) {
        if (role === "product") this.#assertProductConsumed(auth, records, capacity);
        synchronous(() => this.options.executor.assertStarted(launch, startIntent));
        const pending = records.find((entry) => entry.step === startStep && entry.state === "intent");
        if (!pending || !same(row.custody.holder, launch.holder) || row.occupancy !== "active") throw workflowError();
        if (!records.some((entry) => entry.step === startStep && entry.state === "observed")) this.#append(scope, auth, sha256, records, startStep, "observed", pending.value);
        return false;
      }
      const initialHead = role === "test" ? auth.repository.selectedHeadSha : this.#final(auth, records, capacity).assessment.oracle!.testHeadSha;
      const initial = clean(resource.worktreeRoot, auth.repository.branch, initialHead);
      synchronous(() => this.options.executor.assertParked(launch, resource, role));
      if (role === "test") {
        if (!["idle-ready", ...(auth.amendment ? ["settled-retained"] : [])].includes(row.occupancy)) throw workflowError();
        capacity.update(row, parseIdlePreparationReservation({ ...row, occupancy: "active", lineageId: resource.lineageId,
          custody: { state: "implement-child", holder: launch.holder, inFlightOperation: null }, launch: { slotToken: randomUUID(), deploymentDirectory: launch.deploymentDirectory, acquiredAt: this.#now() } }));
      } else {
        const { assessment } = this.#final(auth, records, capacity);
        const author = this.#observed<RequirementsTestLaunch>(records, "test-process");
        if (author.holder.deploymentId === launch.holder.deploymentId || !row.launch) throw workflowError();
        const transfer = { resource, previousHolder: author.holder, holder: launch.holder, finalApprovalSha256: assessment.historySha256.at(-1), initialHeadSha: initialHead };
        const pending = records.find((entry) => entry.step === "product-transfer" && entry.state === "intent");
        if (pending && !same(pending.value, transfer)) throw workflowError();
        if (!pending) this.#append(scope, auth, sha256, this.#load(auth, sha256), "product-transfer", "intent", transfer);
        if (row.occupancy === "settled-retained") capacity.update(row, parseIdlePreparationReservation({ ...row, occupancy: "active", custody: { state: "orchestrator-direct", holder: launch.holder, inFlightOperation: null },
          launch: { ...row.launch, deploymentDirectory: launch.deploymentDirectory } }));
        else if (!pending || row.occupancy !== "active" || !same(row.custody.holder, launch.holder)) throw workflowError();
        this.options.boundary?.("product-transfer:capacity-updated");
        if (!records.some((entry) => entry.step === "product-transfer" && entry.state === "observed")) this.#append(scope, auth, sha256, this.#load(auth, sha256), "product-transfer", "observed", transfer);
      }
      this.#append(scope, auth, sha256, this.#load(auth, sha256), startStep, "intent", { resource, launch, launchSnapshot: initial });
      if (role === "test") this.options.authority.recordEvent?.(scope, auth, { action: "test-holder-active", intentId: workflowDigest(JSON.stringify([auth.operationId, "reservation"])), resource, holder: launch.holder,
        inventory: capacity.inventory(), registry: launch.registry, launchSnapshot: reference("launch-snapshot", initial) });
      else this.#productConsumed(auth, sha256, capacity, scope, resource, launch, initial);
      return true;
    }, resource.worktreeRoot);
    if (!release) return;
    try {
      await this.options.executor.startAsync!(launch, startIntent, signal);
      this.#locked(auth, (capacity, scope) => {
        const records = retained(); const row = this.#row(auth, capacity);
        if (!same(this.#resource(auth, records, capacity), resource) || row.occupancy !== "active" || !same(row.custody.holder, launch.holder)) throw workflowError();
        synchronous(() => this.options.executor.assertStarted(launch, startIntent));
        const pending = records.find((entry) => entry.step === startStep && entry.state === "intent"); if (!pending) throw workflowError();
        this.#append(scope, auth, sha256, records, startStep, "observed", pending.value);
      }, resource.worktreeRoot);
    } catch {
      this.#locked(auth, (_capacity, scope) => {
        const records = this.#load(auth, sha256);
        if (!records.some((row) => row.step === startStep && row.state === "unknown")) this.#append(scope, auth, sha256, records, startStep, "unknown", { retained: true });
      }, resource.worktreeRoot);
      throw workflowError();
    }
  }
  #launch(auth: TestAuthorization, digest: string, capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope, role: "test" | "product", resource: TestResource): RequirementsTestLaunch {
    const intentId = workflowDigest(JSON.stringify([auth.operationId, `${role}-process`]));
    return this.#runStep(auth, digest, capacity, scope, `${role}-process`, () => this.options.executor.prepare(role, intentId, resource), () => this.options.executor.inspect(role, intentId, resource), (launch) => {
      parseSourceVersion(launch.registry);
      if (launch.holder.deploymentId === auth.parent.holder.deploymentId || !same(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) throw workflowError();
      if (realpathSync(launch.deploymentDirectory) !== launch.deploymentDirectory || !lstatSync(launch.deploymentDirectory).isDirectory()) throw workflowError();
      const started = this.#load(auth, digest).some((row) => row.step === `${role}-start`);
      if (started) synchronous(() => this.options.executor.assertStarted(launch, workflowDigest(JSON.stringify([auth.operationId, `${role}-start`]))));
      else synchronous(() => this.options.executor.assertParked(launch, resource, role));
    }, role === "product" ? () => this.#productIntent(auth, digest, capacity, scope, resource) : undefined);
  }
  #start(auth: TestAuthorization, digest: string, capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope, role: "test" | "product", launch: RequirementsTestLaunch, resource: TestResource): void {
    const records = this.#load(auth, digest); const step = `${role}-start` as const;
    // Never reissue a release after a lost response. Independently prove the
    // original release before closing its barrier, or remain blocked.
    if (records.some((record) => record.step === step)) {
      if (role === "product") this.#assertProductConsumed(auth, records, capacity);
      synchronous(() => this.options.executor.assertStarted(launch, workflowDigest(JSON.stringify([auth.operationId, step]))));
      if (!records.some((record) => record.step === step && record.state === "observed")) {
        const intent = records.find((record) => record.step === step && record.state === "intent");
        if (!intent) throw workflowError();
        this.#append(scope, auth, digest, records, step, "observed", intent.value);
      }
      return;
    }
    const initialHead = role === "test" ? auth.repository.selectedHeadSha : this.#final(auth, records, capacity).assessment.oracle!.testHeadSha;
    const initial = clean(resource.worktreeRoot, auth.repository.branch, initialHead);
    synchronous(() => this.options.authority.assertAuthorization(auth, digest));
    synchronous(() => this.options.executor.assertParked(launch, resource, role));
    this.#append(scope, auth, digest, records, step, "intent", { resource, launch, launchSnapshot: initial });
    if (role === "product") this.#productConsumed(auth, digest, capacity, scope, resource, launch, initial);
    try {
      synchronous(() => this.options.executor.start(launch, workflowDigest(JSON.stringify([auth.operationId, step]))));
      this.#append(scope, auth, digest, this.#load(auth, digest), step, "observed", { resource, launch, launchSnapshot: initial });
    } catch {
      this.#append(scope, auth, digest, this.#load(auth, digest), step, "unknown", { evidence: reference("start-unproven", step), retained: true }); throw workflowError();
    }
  }
  settleTest(operationId: string): void { nativeGuard(() => this.#settleTest(operationId)); }
  #settleTest(operationId: string): void {
    const { auth, sha256 } = this.#authorization(operationId, false);
    const lease = this.#observed<TreehouseLeaseEvidence>(this.#load(auth, sha256), "allocation");
    this.#locked(auth, (capacity, scope) => {
      const records = this.#load(auth, sha256); const resource = this.#resource(auth, records, capacity);
      const launch = this.#observed<RequirementsTestLaunch>(records, "test-process");
      // Settlement is factual only: failures/cancel still retain original launch,
      // no result/readiness or oracle approval is manufactured here.
      synchronous(() => this.options.executor.assertSettled(launch));
      if (same(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) throw workflowError();
      const row = this.#row(auth, capacity);
      const completed = records.find((record) => record.step === "test-settlement" && record.state === "observed");
      if (completed) {
        const product = records.find((record) => record.step === "product-process" && record.state === "observed")?.value as RequirementsTestLaunch | undefined;
        if (row.occupancy !== "settled-retained" && !(row.occupancy === "active" && product && same(row.custody.holder, product.holder)
          && records.some((record) => record.step === "product-transfer" && record.state === "intent"))) throw workflowError();
        return;
      }
      const value = { launch, resource, snapshot: snapshot(resource.worktreeRoot) };
      const pending = records.find((record) => record.step === "test-settlement" && record.state === "intent");
      if (pending && !same(pending.value, value)) throw workflowError();
      if (!pending) this.#append(scope, auth, sha256, records, "test-settlement", "intent", value);
      if (row.occupancy === "active") {
        if (!same(row.custody.holder, launch.holder) || row.custody.inFlightOperation !== null) throw workflowError();
        capacity.update(row, parseIdlePreparationReservation({ ...row, occupancy: "settled-retained", custody: { state: "idle", holder: null, inFlightOperation: null } }));
      } else if (row.occupancy !== "settled-retained" || !pending) throw workflowError();
      this.options.boundary?.("test-settlement:capacity-updated");
      refreshTicketLinkedBranchHead({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root, worktreeRoot: resource.worktreeRoot, ticketId: auth.repository.ticket,
        ticketStore: this.options.tickets, preparedCapacityOwner: capacity, runGit: git, settlement: { branch: auth.repository.branch, baseSha: auth.repository.baseSha, expectedHeadSha: auth.repository.selectedHeadSha, headSha: value.snapshot.head } });
      this.options.authority.recordTestSettlement?.(scope, auth, resource, launch);
      this.#append(scope, auth, sha256, this.#load(auth, sha256), "test-settlement", "observed", value);
    }, lease.path);
  }
  #final(auth: TestAuthorization, records: readonly NativeRecord[], capacity: PreparedTicketCapacityTransaction): { assessment: TestWorkflowAssessment; resource: TestResource } {
    if (records.some((record) => record.step === "cancel" || record.state === "cancelled")) throw workflowError();
    const raw = this.options.authority.readAuthorization(auth.operationId);
    if (workflowDigest(raw) !== records[0]?.authorizationSha256) throw workflowError();
    const history = workflowSynchronous(this.options.authority.readFinalHistory(auth));
    const complete = assessTestWorkflow(raw, history);
    if (!["final-approved", "product-intent", "product-consumed"].includes(complete.state)) throw workflowError();
    // Authenticate the exact final-approved prefix of the COMPLETE native chain.
    // Later product events cannot become a new final approval or an arbitrary
    // caller-selected prefix. Their own process/transfer publications are checked
    // below before any dependent action.
    const finalIndex = history.findIndex((entry) => parseTestWorkflowEvent(entry).data.action === "final-approved");
    const assessment = assessTestWorkflow(raw, history.slice(0, finalIndex + 1));
    if (assessment.state !== "final-approved" || !assessment.resource || !assessment.oracle) throw workflowError();
    synchronous(() => this.options.authority.assertFinalApproval(auth, assessment));
    const resource = this.#resource(auth, records, capacity);
    if (!same(assessment.resource, resource)) throw workflowError();
    const launch = this.#observed<RequirementsTestLaunch>(records, "test-process");
    synchronous(() => this.options.executor.assertSettled(launch));
    const settled = this.#observed<{ launch: RequirementsTestLaunch; resource: TestResource }>(records, "test-settlement");
    if (!same(settled.launch, launch) || !same(settled.resource, resource)) throw workflowError();
    const events = history.map((raw) => parseTestWorkflowEvent(raw).data);
    const authorized = events.find((event) => event.action === "authorized");
    const intent = events.find((event) => event.action === "intent-recorded");
    const active = events.find((event) => event.action === "test-holder-active");
    const event = events.find((event) => event.action === "test-settled");
    const start = this.#observed<{ launchSnapshot: RepositoryGitSnapshot }>(records, "test-start");
    if (!authorized || authorized.action !== "authorized" || !same(authorized.decision, this.options.authority.authorizationDecision(auth))
      || !intent || intent.action !== "intent-recorded" || intent.intentId !== workflowDigest(JSON.stringify([auth.operationId, "reservation"]))
      || !active || active.action !== "test-holder-active" || !same(active.holder, launch.holder) || !same(active.registry, launch.registry)
      || !same(active.launchSnapshot, reference("launch-snapshot", start.launchSnapshot))
      || !event || event.action !== "test-settled" || !same(event.holder, launch.holder)) throw workflowError();
    verifyRequirementsTestGit(auth, resource, event.git);
    const ticket = this.options.tickets.get(auth.repository.ticket); if (!ticket) throw workflowError();
    const linked = requireTicketLinkedBranch(ticket, auth.repository.key);
    if (linked.state !== "materialized" || linked.baseSha !== auth.repository.baseSha || linked.branch !== auth.repository.branch || linked.headSha !== event.git.testHeadSha) throw workflowError();
    const current = this.#row(auth, capacity);
    if (current.occupancy !== "settled-retained") {
      const product = this.#observed<RequirementsTestLaunch>(records, "product-process");
      if (current.occupancy !== "active" || current.custody.state !== "orchestrator-direct" || current.custody.inFlightOperation !== null
        || !same(current.custody.holder, product.holder) || !records.some((row) => row.step === "product-transfer" && row.state === "intent")) throw workflowError();
    } else if (current.custody.state !== "idle") throw workflowError();
    const productIntent = events.find((value) => value.action === "product-intent");
    const productConsumed = events.find((value) => value.action === "product-consumed");
    if ((!productIntent && records.some((row) => row.step === "product-process" && row.state === "observed"))
      || (!productConsumed && records.some((row) => row.step === "product-start" && row.state === "observed"))) throw workflowError();
    if (productIntent?.action === "product-intent") {
      const intentId = workflowDigest(JSON.stringify([auth.operationId, "product-process"]));
      const intents = records.filter((row) => row.step === "product-process" && row.state === "intent");
      if (intents.length !== 1 || (intents[0]!.value as { intentId?: unknown }).intentId !== intentId
        || productIntent.intentId !== intentId || !same(productIntent.resource, resource)
        || productIntent.initialHeadSha !== assessment.oracle.testHeadSha || productIntent.finalApprovalSha256 !== assessment.historySha256.at(-1)) throw workflowError();
    }
    if (productConsumed?.action === "product-consumed") {
      const product = this.#observed<RequirementsTestLaunch>(records, "product-process");
      const transfer = this.#observed<unknown>(records, "product-transfer");
      const start = records.find((row) => row.step === "product-start" && row.state === "intent")?.value as { resource: TestResource; launch: RequirementsTestLaunch; launchSnapshot: RepositoryGitSnapshot } | undefined;
      const row = this.#row(auth, capacity);
      if (!productIntent || !start || !same(start.resource, resource) || !same(start.launch, product)
        || start.launchSnapshot.head !== assessment.oracle.testHeadSha || start.launchSnapshot.statusPorcelainV2Base64 !== ""
        || !same(transfer, { resource, previousHolder: launch.holder, holder: product.holder, finalApprovalSha256: assessment.historySha256.at(-1), initialHeadSha: assessment.oracle.testHeadSha })
        || !same(productConsumed.holder, product.holder) || !same(productConsumed.previousHolder, launch.holder)
        || !same(productConsumed.registry, product.registry) || !same(productConsumed.launchSnapshot, reference("launch-snapshot", start.launchSnapshot))
        || row.occupancy !== "active" || row.custody.state !== "orchestrator-direct" || row.custody.inFlightOperation !== null || !same(row.custody.holder, product.holder)
        || !same(productConsumed.inventory.find((entry) => entry.ticket === auth.repository.ticket), row)) throw workflowError();
    }
    return { assessment, resource };
  }
  #productIntent(auth: TestAuthorization, digest: string, capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope, resource: TestResource): void {
    const { assessment } = this.#final(auth, this.#load(auth, digest), capacity);
    if (!this.options.authority.recordEvent) throw workflowError();
    synchronous(() => this.options.authority.recordEvent!(scope, auth, { action: "product-intent", resource, initialHeadSha: assessment.oracle!.testHeadSha,
      finalApprovalSha256: assessment.historySha256.at(-1)!, intentId: workflowDigest(JSON.stringify([auth.operationId, "product-process"])) }));
    this.#final(auth, this.#load(auth, digest), capacity);
    if (!["product-intent", "product-consumed"].includes(assessTestWorkflow(this.options.authority.readAuthorization(auth.operationId), this.options.authority.readFinalHistory(auth)).state)) throw workflowError();
    this.options.boundary?.("product-intent:published");
  }
  #productConsumed(auth: TestAuthorization, digest: string, capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope, resource: TestResource, launch: RequirementsTestLaunch, initial: RepositoryGitSnapshot): void {
    const { assessment } = this.#final(auth, this.#load(auth, digest), capacity);
    const author = this.#observed<RequirementsTestLaunch>(this.#load(auth, digest), "test-process");
    if (!this.options.authority.recordEvent) throw workflowError();
    synchronous(() => this.options.authority.recordEvent!(scope, auth, { action: "product-consumed", resource, initialHeadSha: assessment.oracle!.testHeadSha,
      intentId: workflowDigest(JSON.stringify([auth.operationId, "product-process"])), holder: launch.holder, previousHolder: author.holder,
      inventory: capacity.inventory(), launchSnapshot: reference("launch-snapshot", initial), registry: launch.registry }));
    this.#assertProductConsumed(auth, this.#load(auth, digest), capacity);
    this.options.boundary?.("product-consumed:published");
  }
  #assertProductConsumed(auth: TestAuthorization, records: readonly NativeRecord[], capacity: PreparedTicketCapacityTransaction): void {
    this.#final(auth, records, capacity);
    if (assessTestWorkflow(this.options.authority.readAuthorization(auth.operationId), this.options.authority.readFinalHistory(auth)).state !== "product-consumed") throw workflowError();
  }
  /** Same resource/reservation/lineage, exact approved test HEAD; no allocation,
   * reservation call, branch construction, legacy preparation or fallback. */
  continueProduct(operationId: string): Readonly<{ state: "product-active"; resource: TestResource; initialHeadSha: string }> { return nativeGuard(() => this.#continueProduct(operationId)); }
  async continueProductAsync(operationId: string, signal?: AbortSignal): Promise<Readonly<{ state: "product-active"; resource: TestResource; initialHeadSha: string }>> {
    try {
      if (signal?.aborted || !this.options.executor.prepareAsync || !this.options.executor.startAsync) throw workflowError();
      const { auth, sha256 } = this.#authorization(operationId);
      const lease = this.#observed<TreehouseLeaseEvidence>(this.#load(auth, sha256), "allocation");
      const final = this.#locked(auth, (capacity) => {
        const records = this.#load(auth, sha256); const result = this.#final(auth, records, capacity); const row = this.#row(auth, capacity);
        if (row.occupancy !== "settled-retained" && !(row.occupancy === "active" && records.some((entry) => entry.step === "product-transfer" && entry.state === "intent"))) throw workflowError();
        return result;
      }, lease.path);
      await this.#asyncLifecycle(operationId, "product", final.resource, signal);
      return Object.freeze({ state: "product-active", resource: final.resource, initialHeadSha: final.assessment.oracle!.testHeadSha });
    } catch {
      if (signal?.aborted) { try { this.cancel(operationId); } catch { /* retain unknown product/process effects */ } }
      throw workflowError();
    }
  }
  #continueProduct(operationId: string): Readonly<{ state: "product-active"; resource: TestResource; initialHeadSha: string }> {
    const { auth, sha256 } = this.#authorization(operationId);
    const initialRecords = this.#load(auth, sha256); const lease = this.#observed<TreehouseLeaseEvidence>(initialRecords, "allocation");
    return this.#locked(auth, (capacity, scope) => {
      const records = this.#load(auth, sha256); const { assessment, resource } = this.#final(auth, records, capacity);
      let row = this.#row(auth, capacity);
      const transferring = records.some((record) => record.step === "product-transfer" && record.state === "intent");
      if (row.occupancy !== "settled-retained" && !(transferring && row.occupancy === "active")) throw workflowError();
      const launch = this.#launch(auth, sha256, capacity, scope, "product", resource);
      const author = this.#observed<RequirementsTestLaunch>(records, "test-process");
      if (launch.holder.deploymentId === author.holder.deploymentId) throw workflowError();
      this.#final(auth, this.#load(auth, sha256), capacity); // immediate exact reread under both owners
      const transfer = { resource, previousHolder: author.holder, holder: launch.holder, finalApprovalSha256: assessment.historySha256.at(-1), initialHeadSha: assessment.oracle!.testHeadSha };
      const pending = records.find((record) => record.step === "product-transfer" && record.state === "intent");
      if (pending && !same(pending.value, transfer)) throw workflowError();
      if (!pending) this.#append(scope, auth, sha256, this.#load(auth, sha256), "product-transfer", "intent", transfer);
      if (row.occupancy === "settled-retained") row = capacity.update(row, parseIdlePreparationReservation({ ...row, occupancy: "active", custody: { state: "orchestrator-direct", holder: launch.holder, inFlightOperation: null },
        launch: { slotToken: row.launch!.slotToken, deploymentDirectory: launch.deploymentDirectory, acquiredAt: row.launch!.acquiredAt } }));
      else if (!pending || !same(row.custody.holder, launch.holder) || row.custody.inFlightOperation !== null) throw workflowError();
      this.options.boundary?.("product-transfer:capacity-updated");
      if (!records.some((record) => record.step === "product-transfer" && record.state === "observed")) this.#append(scope, auth, sha256, this.#load(auth, sha256), "product-transfer", "observed", transfer);
      this.#start(auth, sha256, capacity, scope, "product", launch, resource);
      return Object.freeze({ state: "product-active" as const, resource, initialHeadSha: assessment.oracle!.testHeadSha });
    }, lease.path);
  }
  /** Factual terminal closure only, including after cancellation/deadline/source
   * drift. It does not bless product changes, renew approval, refresh a linked
   * HEAD, release a permit or return resources. The execution owner audits them.
   * Actual terminal registry AND original process absence remain mandatory. */
  settleProduct(operationId: string): void { nativeGuard(() => {
    const { auth, sha256 } = this.#authorization(operationId, false);
    const lease = this.#observed<TreehouseLeaseEvidence>(this.#load(auth, sha256), "allocation");
    this.#locked(auth, (capacity, scope) => {
      let records = this.#load(auth, sha256); const resource = this.#resource(auth, records, capacity);
      const history = this.options.authority.readFinalHistory(auth), complete = assessTestWorkflow(this.options.authority.readAuthorization(auth.operationId), history);
      const consumed = history.map((entry) => parseTestWorkflowEvent(entry).data).find((value) => value.action === "product-consumed");
      const launch = this.#observed<RequirementsTestLaunch>(records, "product-process");
      const intent = records.find((record) => record.step === "product-start" && record.state === "intent");
      const start = intent?.value as { launch: RequirementsTestLaunch; resource: TestResource; launchSnapshot: RepositoryGitSnapshot } | undefined;
      const observed = records.find((record) => record.step === "product-start" && record.state === "observed");
      if (complete.state !== "product-consumed" || consumed?.action !== "product-consumed" || !same(consumed.resource, resource) || !start
        || !same(consumed.holder, launch.holder) || !same(consumed.registry, launch.registry) || !same(start.launch, launch) || !same(start.resource, resource)
        || start.launchSnapshot.head !== consumed.initialHeadSha || !same(consumed.launchSnapshot, reference("launch-snapshot", start.launchSnapshot))
        || (observed && !same(observed.value, start))) throw workflowError();
      synchronous(() => this.options.executor.assertSettled(launch));
      if (same(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) throw workflowError();
      // A released holder may finish (and advance product HEAD) before its
      // acknowledgement is observed. Close that original barrier only through
      // retained native start proof + actual terminal settlement, never by
      // reissuing release or reapplying the initial test-HEAD admission gate.
      if (!observed) {
        synchronous(() => this.options.executor.assertStarted(launch, workflowDigest(JSON.stringify([auth.operationId, "product-start"]))));
        this.#append(scope, auth, sha256, records, "product-start", "observed", start);
        records = this.#load(auth, sha256);
      }
      const row = this.#row(auth, capacity), completed = records.find((record) => record.step === "product-settlement" && record.state === "observed");
      if (completed) { if (row.occupancy !== "settled-retained" || row.custody.state !== "idle") throw workflowError(); return; }
      const value = { launch, resource, snapshot: snapshot(resource.worktreeRoot) };
      const pending = records.find((record) => record.step === "product-settlement" && record.state === "intent");
      if (pending && !same(pending.value, value)) throw workflowError();
      if (!pending) this.#append(scope, auth, sha256, records, "product-settlement", "intent", value);
      if (row.occupancy === "active") {
        if (row.custody.state !== "orchestrator-direct" || !same(row.custody.holder, launch.holder) || row.custody.inFlightOperation !== null) throw workflowError();
        capacity.update(row, parseIdlePreparationReservation({ ...row, occupancy: "settled-retained", custody: { state: "idle", holder: null, inFlightOperation: null } }));
      } else if (row.occupancy !== "settled-retained" || row.custody.state !== "idle" || !pending) throw workflowError();
      this.options.boundary?.("product-settlement:capacity-updated");
      this.#append(scope, auth, sha256, this.#load(auth, sha256), "product-settlement", "observed", value);
    }, lease.path);
  }); }
  /** Native operator-only manual retry of proven full-capacity/zero-resource
   * failure. Unknown allocation/process/branch failures are never cleared here. */
  retryCapacity(operationId: string, decisionInput: SourceVersion): void { nativeGuard(() => this.#retryCapacity(operationId, decisionInput)); }
  #retryCapacity(operationId: string, decisionInput: SourceVersion): void {
    const { auth, sha256 } = this.#authorization(operationId); const decision = parseSourceVersion(decisionInput);
    this.#locked(auth, (capacity, scope) => {
      const records = this.#load(auth, sha256);
      const { failure, retriesUsed } = capacityRetryState(auth, records, capacity);
      synchronous(() => this.options.authority.assertCapacityRetry(auth, decision, failure, retriesUsed));
      this.#append(scope, auth, sha256, records, "capacity-retry", "observed", { decision, failure, retriesUsed, bounds: auth.bounds });
    });
  }
  cancel(operationId: string): void { nativeGuard(() => this.#cancel(operationId)); }
  #cancel(operationId: string): void {
    const { auth, sha256 } = this.#authorization(operationId, false);
    this.#locked(auth, (capacity, scope) => {
      const records = this.#load(auth, sha256);
      if (!records.length) throw workflowError();
      if (!records.some((record) => record.step === "cancel")) this.#append(scope, auth, sha256, records, "cancel", "cancelled", { retained: true, evidence: reference("cancellation", auth.operationId) });
      // A final-approved product holder supersedes the already-settled author.
      // Never leave it running by sending cancellation only to the old test PID.
      const role = records.some((record) => record.step === "product-process") ? "product" : "test";
      const launched = records.find((record) => record.step === `${role}-process` && record.state === "observed");
      if (launched) this.options.executor.cancel?.(launched.value as RequirementsTestLaunch);
      else if (records.some((record) => record.step === `${role}-process` && record.state === "intent") && this.options.executor.cancel) {
        const resource = this.#resource(auth, records, capacity);
        this.options.executor.cancel(this.options.executor.inspect(role, workflowDigest(JSON.stringify([auth.operationId, `${role}-process`])), resource));
      }
    });
  }
  status(operationId: string): Readonly<{ schemaVersion: typeof VERSION; state: "unrequested" | "retained" | "blocked"; effects: number; activation: false }> { return nativeGuard(() => this.#status(operationId)); }
  #status(operationId: string): Readonly<{ schemaVersion: typeof VERSION; state: "unrequested" | "retained" | "blocked"; effects: number; activation: false }> {
    const { auth, sha256 } = this.#authorization(operationId, false);
    const records = this.#load(auth, sha256);
    const lastRetry = records.reduce((last, row, index) => row.step === "capacity-retry" ? index : last, -1);
    return Object.freeze({ schemaVersion: VERSION, state: !records.length ? "unrequested" : records.some((row, index) => ["unknown", "cancelled"].includes(row.state) || (row.state === "failed" && index > lastRetry)
        || (row.state === "intent" && row.step !== "request" && !(row.step === "reservation" && index < lastRetry) && !records.some((other) => other.step === row.step && other.state === "observed"))) ? "blocked" : "retained",
      effects: records.filter((row) => row.state === "observed").length, activation: false });
  }
}

/** Independent Git/content verification, not caller booleans, fixture ancestry,
 * timestamps or a clean final tree. Phase 3 owns the full working-tree audit. */
export function verifyRequirementsTestGit(auth: TestAuthorization, resource: TestResource, evidence: TestGitEvidence): void {
  clean(resource.worktreeRoot, auth.repository.branch, evidence.testHeadSha);
  if (evidence.baseSha !== auth.repository.baseSha || evidence.initialHeadSha !== auth.repository.selectedHeadSha) throw workflowError();
  git(["merge-base", "--is-ancestor", evidence.baseSha, evidence.initialHeadSha], resource.worktreeRoot);
  git(["merge-base", "--is-ancestor", evidence.initialHeadSha, evidence.testHeadSha], resource.worktreeRoot);
  const ancestors = git(["rev-list", "--reverse", "--ancestry-path", `${evidence.baseSha}..${evidence.initialHeadSha}`], resource.worktreeRoot).toString("utf8").trim().split("\n").filter(Boolean);
  if (!same(evidence.ancestry, [evidence.baseSha, ...ancestors])) throw workflowError();
  const commits = git(["rev-list", "--reverse", `${evidence.initialHeadSha}..${evidence.testHeadSha}`], resource.worktreeRoot).toString("utf8").trim().split("\n").filter(Boolean);
  if (!same(commits, evidence.commits.map((entry) => entry.sha))) throw workflowError();
  for (const commit of evidence.commits) {
    if (git(["show", "-s", "--format=%P", commit.sha], resource.worktreeRoot).toString("utf8").trim() !== commit.parentSha) throw workflowError();
    const paths = git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", commit.parentSha, commit.sha], resource.worktreeRoot).toString("utf8").split("\0").filter(Boolean).sort();
    const declared = [...new Set(commit.changes.flatMap((change) => [change.path, ...(change.previousPath ? [change.previousPath] : [])]))].sort();
    if (!same(paths, declared)) throw workflowError();
    for (const change of commit.changes) for (const [sha, path, expected] of [[commit.parentSha, change.previousPath ?? change.path, change.beforeSha256], [commit.sha, change.path, change.afterSha256]] as const) {
      const entries = git(["ls-tree", "-z", sha, "--", path], resource.worktreeRoot).toString("utf8");
      if (expected === null) { if (entries !== "") throw workflowError(); }
      else if (!/^100(?:644|755) blob /.test(entries) || workflowDigest(git(["show", `${sha}:${path}`], resource.worktreeRoot)) !== expected) throw workflowError();
    }
  }
  for (const file of evidence.files) {
    if (workflowDigest(git(["show", `${evidence.testHeadSha}:${file.path}`], resource.worktreeRoot)) !== file.sha256) throw workflowError();
    let part = resource.worktreeRoot;
    for (const segment of file.path.split("/")) {
      part = join(part, segment); const stat = lstatSync(part);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw workflowError();
    }
    if (realpathSync(part) !== part || workflowDigest(readReviewEvidenceFile(part, 16_777_216, "native test content")) !== file.sha256) throw workflowError();
  }
}

const AUTHORITY_VERSION = "requirements-test-native-authorization/v1";
const POLICY_VERSION = "requirements-test-native-selection/v1";
const QUALIFICATION_VERSION = "requirements-test-native-qualification/v2";
const MODEL_TRANSPORT_VERSION = "requirements-test-model-transport/v1";
export interface RequirementsTestModelTransport {
  readonly schemaVersion: typeof MODEL_TRANSPORT_VERSION;
  readonly runtime: PreparedNativeRuntime;
  readonly endpoint: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly process: ExecutionHolder["process"];
  readonly source: SourceVersion;
  readonly outcome: "qualified";
}
/** Fixed numeric loopback, explicit high port, fixed API path: no DNS, URL
 * credentials, interpolation, arbitrary headers, remote endpoint or redirect. */
function modelEndpoint(value: unknown): string {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/v1$/.test(value)) throw workflowError();
  const url = new URL(value);
  if (Number(url.port) < 1024 || Number(url.port) > 65535 || url.href !== value) throw workflowError();
  return value;
}
export function parseRequirementsTestModelTransport(value: unknown, runtime: PreparedNativeRuntime): RequirementsTestModelTransport {
  const row = workflowObject(value, ["schemaVersion", "runtime", "endpoint", "modelId", "contextWindow", "maxTokens", "process", "source", "outcome"]);
  if (row.schemaVersion !== MODEL_TRANSPORT_VERSION || !same(row.runtime, runtime) || row.outcome !== "qualified"
    || typeof row.modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(row.modelId)
    || !Number.isSafeInteger(row.contextWindow) || Number(row.contextWindow) < 4096 || Number(row.contextWindow) > 1_048_576
    || !Number.isSafeInteger(row.maxTokens) || Number(row.maxTokens) < 1 || Number(row.maxTokens) > 32_768 || Number(row.maxTokens) > Number(row.contextWindow)) throw workflowError();
  modelEndpoint(row.endpoint); parseSourceVersion(row.source);
  const process = workflowObject(row.process, ["pid", "startTimeTicks", "bootId"]);
  if (!Number.isSafeInteger(process.pid) || Number(process.pid) < 1 || Number(process.pid) > 2_147_483_647 || typeof process.startTimeTicks !== "string" || !/^[0-9]+$/.test(process.startTimeTicks)
    || typeof process.bootId !== "string" || !process.bootId) throw workflowError();
  // Clone nested values as well; callers cannot change a validated snapshot.
  return Object.freeze({ ...row, runtime: Object.freeze({ ...runtime }), process: Object.freeze({ ...process }), source: parseSourceVersion(row.source) }) as unknown as RequirementsTestModelTransport;
}
function assertModelListener(transport: RequirementsTestModelTransport): void {
  if (!same(readProcessFingerprint(transport.process.pid), transport.process)) throw workflowError();
  const sockets = new Set(readdirSync(`/proc/${transport.process.pid}/fd`).flatMap((name) => {
    try { const match = /^socket:\[([0-9]+)\]$/.exec(readlinkSync(`/proc/${transport.process.pid}/fd/${name}`)); return match ? [match[1]!] : []; }
    catch { return []; }
  }));
  const address = `0100007F:${Number(new URL(transport.endpoint).port).toString(16).toUpperCase().padStart(4, "0")}`;
  // Fixed kernel procfs path, bounded native read (not ordinary evidence-file
  // parsing, which intentionally rejects procfs aliases/zero-size pseudo-files).
  const fd = openSync("/proc/net/tcp", "r"), buffer = Buffer.alloc(1_048_577); let bytes = 0;
  try {
    while (bytes < buffer.length) { const count = readSync(fd, buffer, bytes, buffer.length - bytes, null); if (!count) break; bytes += count; }
  } finally { closeSync(fd); }
  if (bytes === buffer.length || !buffer.subarray(0, bytes).toString("utf8").split("\n").some((line) => {
    const fields = line.trim().split(/\s+/); return fields[1] === address && fields[3] === "0A" && sockets.has(fields[9]!);
  })) throw workflowError();
}

export interface PiRequirementsTestAuthorityOptions {
  /** Isolated source-test seams only; never exposed by tool/CLI/env input. */
  readonly native?: PiPreparedNativeAuthority;
  readonly runtime?: () => PreparedNativeRuntime;
  readonly authenticate?: (context: PiPreparationContext) => PiPreparationCaller;
}
/** Concrete operator capture/reader, sharing existing protected workflow storage.
 * Dedicated qualification and explicit activation are NOT legacy post-final
 * grants. Source checkout and env/public JSON cannot select production roots. */
export class PiRequirementsTestAuthority implements RequirementsTestNativeAuthority {
  readonly native: PiPreparedNativeAuthority;
  readonly #runtime: () => PreparedNativeRuntime;
  readonly #authenticate: (context: PiPreparationContext) => PiPreparationCaller;
  constructor(options: PiRequirementsTestAuthorityOptions = {}) {
    this.native = options.native ?? new PiPreparedNativeAuthority();
    this.#runtime = options.runtime ?? currentPreparedNativeRuntime;
    this.#authenticate = options.authenticate ?? ((context) => authenticatePiPreparationCaller(context, process.env));
  }
  #store(): ProtectedWorkflowStore { const store = this.native.operations(); if (!store) throw workflowError(); return store; }
  #publish(repo: { key: string; root: string }, id: string, value: unknown): void {
    withPreparedWorkflowLocks({ repository: (run) => withPreparedTicketCapacity({ canonicalRepoKey: repo.key, canonicalRepoRoot: repo.root }, () => run()), worktree: (run) => run() }, (scope) => this.#store().publish(scope, `${id}.intent.json`, value));
  }
  #facts(): PreparedNativeRuntime {
    const value = this.#runtime(); workflowSha(value.sourceSha, 40); workflowSha(value.configSha, 40);
    if (!value.packageVersion || realpathSync(value.storeRoot) !== value.storeRoot) throw workflowError(); return value;
  }
  #qualification(): SourceVersion {
    const facts = this.#facts(); const id = workflowDigest(JSON.stringify([QUALIFICATION_VERSION, facts]));
    const value = this.#store().read(`${id}.intent.json`);
    const row = workflowObject(value, ["schemaVersion", "runtime", "native", "installed", "pairing", "toolsAuditDecision", "modelTransport"]);
    if (row.schemaVersion !== QUALIFICATION_VERSION || !same(row.runtime, facts)) throw workflowError();
    this.#modelTransport(parseSourceVersion(row.modelTransport));
    for (const kind of ["native", "installed", "pairing", "toolsAuditDecision"]) {
      const ref = parseSourceVersion(row[kind]); const match = /^requirements-test-qualification-evidence:([0-9a-f]{64})$/.exec(ref.ref);
      if (!match || ref.version !== "requirements-test-qualification-evidence/v1") throw workflowError();
      const evidence = this.#store().read(`${match[1]}.intent.json`);
      const item = workflowObject(evidence, ["schemaVersion", "runtime", "kind", "source", "outcome"]);
      if (item.schemaVersion !== ref.version || !same(item.runtime, facts) || item.kind !== kind || item.outcome !== "qualified"
        || workflowDigest(JSON.stringify(evidence)) !== ref.sha256) throw workflowError();
      parseSourceVersion(item.source);
    }
    return reference("qualification", value);
  }
  #modelTransport(input: SourceVersion): RequirementsTestModelTransport {
    const ref = parseSourceVersion(input), match = /^requirements-test-model-transport:([0-9a-f]{64})$/.exec(ref.ref);
    if (!match || ref.version !== MODEL_TRANSPORT_VERSION) throw workflowError();
    const value = this.#store().read(`${match[1]}.intent.json`);
    if (ref.sha256 !== workflowDigest(JSON.stringify(value))) throw workflowError();
    const transport = parseRequirementsTestModelTransport(value, this.#facts());
    assertModelListener(transport); return transport;
  }
  /** Protected exact-pair producer only. No tool/JSON/env endpoint or credential
   * options. Revalidated before allocation, SDK construction and each request. */
  modelTransport(auth: TestAuthorization): RequirementsTestModelTransport {
    this.assertAuthorization(auth, workflowDigest(this.readAuthorization(auth.operationId)));
    const id = workflowDigest(JSON.stringify([QUALIFICATION_VERSION, this.#facts()]));
    const row = this.#store().read(`${id}.intent.json`) as { modelTransport: SourceVersion };
    return this.#modelTransport(row.modelTransport);
  }
  #policyId(repo: { key: string; root: string }): string { return workflowDigest(JSON.stringify([POLICY_VERSION, repo, this.#facts()])); }
  selection(caller: PiPreparationCaller): Readonly<{ active: boolean; runtime: PreparedNativeRuntime; qualification: SourceVersion }> {
    const runtime = this.#facts(), qualification = this.#qualification(); const id = this.#policyId({ key: caller.repoKey, root: caller.repoRoot });
    if (!this.#store().records().includes(`${id}.intent.json`)) return Object.freeze({ active: false, runtime, qualification });
    const row = workflowObject(this.#store().read(`${id}.intent.json`), ["schemaVersion", "repoKey", "repoRoot", "runtime", "qualification", "caller", "decisionId"]);
    if (row.schemaVersion !== POLICY_VERSION || row.repoKey !== caller.repoKey || row.repoRoot !== caller.repoRoot || !same(row.runtime, runtime) || !same(row.qualification, qualification)) throw workflowError();
    workflowSha(row.decisionId); return Object.freeze({ active: true, runtime, qualification });
  }
  async select(context: PiPreparationContext, signal?: AbortSignal): Promise<void> {
    const caller = this.#authenticate(context); const preview = this.selection(caller);
    if (context.mode !== "tui" || !context.ui?.select || preview.active || signal?.aborted) throw workflowError();
    const accept = "Activate only this qualified requirements-test pair";
    const answer = await context.ui.select(`Separate new-route activation, NOT test approval or product approval: ${JSON.stringify(preview)}. Tools/audit only, NOT a sandbox.`, [accept, "Cancel"], signal ? { signal } : undefined);
    if (signal?.aborted || answer !== accept) throw workflowError();
    const fresh = this.#authenticate(context);
    if (!same(fresh, caller) || !same(this.selection(fresh), preview)) throw workflowError();
    this.#publish({ key: caller.repoKey, root: caller.repoRoot }, this.#policyId({ key: caller.repoKey, root: caller.repoRoot }), { schemaVersion: POLICY_VERSION, repoKey: caller.repoKey, repoRoot: caller.repoRoot, runtime: preview.runtime,
      qualification: preview.qualification, caller, decisionId: workflowDigest(randomUUID()) });
  }
  environmentSources(): readonly { name: "CI" | "LANG" | "TZ" | "PATH"; source: SourceVersion }[] {
    return (["CI", "LANG", "TZ", "PATH"] as const).map((name) => ({ name, source: reference(`environment-${name}`, this.#environment()[name]) }));
  }
  #environment(): Record<"CI" | "LANG" | "TZ" | "PATH", string> {
    const directories = [...new Set((process.env.PATH ?? "").split(":").filter(Boolean).flatMap((path) => {
      try { const physical = realpathSync(path); const info = lstatSync(physical);
        return info.isDirectory() && info.uid === 0 && !(info.mode & 0o022) && (physical.startsWith("/nix/store/") || physical === "/usr/bin" || physical === "/bin") ? [physical] : [];
      } catch { return []; }
    }))];
    if (!directories.length) throw workflowError();
    return { CI: "1", LANG: "C.UTF-8", TZ: "UTC", PATH: directories.join(":") };
  }
  checkEnvironment(auth: TestAuthorization, checkId: string): NodeJS.ProcessEnv {
    const check = auth.checks.find((entry) => entry.id === checkId); if (!check || !check.environment.some((item) => item.name === "PATH")) throw workflowError();
    const values = this.#environment(); const result: NodeJS.ProcessEnv = {};
    for (const item of check.environment) { if (!same(item.source, reference(`environment-${item.name}`, values[item.name]))) throw workflowError(); result[item.name] = values[item.name]; }
    return result;
  }
  #sources(auth: TestAuthorization): void {
    const ticket = this.native.tickets().get(auth.repository.ticket); if (!ticket || ticket.project !== auth.repository.key) throw workflowError();
    for (const source of [auth.contract, auth.assertions, ...auth.checks.map((check) => check.input)]) {
      const path = source.ref.replace(/^(?:requirements|uat):/, "");
      if (!path.startsWith("agent-teams/requirements/artifacts/") || /[\\\\%?#\x00-\x1f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")
        || !ticket.doc_refs.some((ref) => ref.path === path)) throw workflowError();
      const actual = resolve(this.native.aiUsageRoot, path);
      if (workflowDigest(readReviewEvidenceFile(actual, 1_048_576, "native test approval source")) !== source.sha256) throw workflowError();
    }
  }
  #parent(auth: TestAuthorization): void {
    const status = queryDeploymentStatus(auth.parent.holder.deploymentId);
    const registered = loadRepoEntry(auth.repository.key);
    if (!registered || registered.path !== auth.repository.root || realpathSync(auth.repository.root) !== auth.repository.root
      || !status || status.status !== "running" || status.team !== "requirements" || status.mode !== "analyze" || status.runtime !== "pi" || status.binary !== "ppa"
      || status.rogue_one || status.builder_authority || status.repository_slot || status.requirements_test
      || status.treehouse_path || status.ticket_slot_id || status.repository_permit || status.review_checkout
      || status.ticket_id !== auth.repository.ticket || status.repo_root !== auth.repository.root || status.repo !== auth.repository.root || status.worktree_root !== auth.repository.root
      || status.pid !== auth.parent.holder.process.pid || !same(readProcessFingerprint(status.pid), auth.parent.holder.process)) throw workflowError();
  }
  #binding(auth: TestAuthorization): void {
    this.#parent(auth); this.#sources(auth);
    for (const check of auth.checks) this.checkEnvironment(auth, check.id);
    const caller = { deploymentId: auth.parent.holder.deploymentId, repoKey: auth.repository.key, repoRoot: auth.repository.root, ticket: auth.repository.ticket, callerIdentity: "0".repeat(64) };
    const selection = this.selection(caller); const facts = selection.runtime;
    if (!selection.active || auth.pair.runtimeSha !== facts.sourceSha || auth.pair.configSha !== facts.configSha || !same(auth.pair.qualification, selection.qualification)) throw workflowError();
    const qualificationId = workflowDigest(JSON.stringify([QUALIFICATION_VERSION, facts]));
    const qualification = this.#store().read(`${qualificationId}.intent.json`) as { toolsAuditDecision: SourceVersion };
    if (!same(auth.pair.toolsAuditDecision, qualification.toolsAuditDecision)) throw workflowError();
  }
  #id(operationId: string): string { return workflowDigest(JSON.stringify([AUTHORITY_VERSION, workflowSha(operationId)])); }
  async capture(context: PiPreparationContext, raw: string, toolCallId: string, signal?: AbortSignal): Promise<TestAuthorization> {
    const auth = parseTestAuthorization(raw); const caller = this.#authenticate(context);
    this.#binding(auth);
    const current = readProcessFingerprint(process.pid);
    if (context.mode !== "tui" || !context.ui?.select || signal?.aborted || !current
      || caller.deploymentId !== auth.parent.holder.deploymentId || caller.repoKey !== auth.repository.key || caller.repoRoot !== auth.repository.root || caller.ticket !== auth.repository.ticket
      || !processIsWithinFingerprintLineage(process.pid, auth.parent.holder.process) || !toolCallId || toolCallId.length > 256) throw workflowError();
    const accept = "Approve this exact test-only authorization";
    const answer = await context.ui.select(`STANDALONE TEST-ONLY decision. No product implementation, credentials, production, delegation or return. Tools/audit, NOT a sandbox. Exact raw SHA256 ${workflowDigest(raw)}; complete packet ${raw}`, [accept, "Cancel"], signal ? { signal } : undefined);
    if (signal?.aborted || answer !== accept || !same(this.#authenticate(context), caller)) throw workflowError();
    this.#binding(auth);
    if (executionBoundStop(auth.bounds, new Date().toISOString())) throw workflowError();
    this.#publish(auth.repository, this.#id(auth.operationId), { schemaVersion: AUTHORITY_VERSION, raw, authorizationSha256: workflowDigest(raw), caller, process: current, toolCallId, decisionId: workflowDigest(randomUUID()), capturedAt: new Date().toISOString() });
    this.assertAuthorization(auth, workflowDigest(raw)); return auth;
  }
  #record(operationId: string): Record<string, unknown> {
    const row = workflowObject(this.#store().read(`${this.#id(operationId)}.intent.json`), ["schemaVersion", "raw", "authorizationSha256", "caller", "process", "toolCallId", "decisionId", "capturedAt"]);
    if (row.schemaVersion !== AUTHORITY_VERSION || typeof row.raw !== "string" || workflowDigest(row.raw) !== row.authorizationSha256 || parseTestAuthorization(row.raw).operationId !== operationId) throw workflowError();
    workflowSha(row.decisionId); workflowTimestamp(row.capturedAt); return row;
  }
  readAuthorization(operationId: string): string { return this.#record(operationId).raw as string; }
  authorizationDecision(auth: TestAuthorization): SourceVersion { return reference("operator-test-only-decision", this.#record(auth.operationId)); }
  assertRetainedAuthorization(auth: TestAuthorization, rawSha256: string): void {
    const row = this.#record(auth.operationId);
    if (row.authorizationSha256 !== rawSha256 || !same(parseTestAuthorization(row.raw as string), auth)) throw workflowError();
  }
  assertAuthorization(auth: TestAuthorization, rawSha256: string): void {
    this.assertRetainedAuthorization(auth, rawSha256); this.#binding(auth);
    if (this.#store().records().some((name) => {
      const row = this.#store().read(name) as Record<string, unknown>;
      return row.schemaVersion === VERSION && row.operationId === auth.operationId && row.step === "cancel";
    })) throw workflowError();
  }
  /** History is read from the same service-owned store, never a tool prefix. */
  readFinalHistory(auth: TestAuthorization): readonly string[] {
    const id = workflowDigest(JSON.stringify(["requirements-test-native-history/v1", auth.operationId]));
    const names = this.#store().records().filter((name) => name.startsWith(`${id}.`));
    const result: string[] = [];
    for (let i = 1; i <= names.length; i++) {
      const value = this.#store().read(`${id}.transaction-${i}.json`); const row = workflowObject(value, ["raw", "sha256"]);
      if (typeof row.raw !== "string" || workflowDigest(row.raw) !== row.sha256) throw workflowError();
      const event = parseTestWorkflowEvent(row.raw); if (event.operationId !== auth.operationId || event.sequence !== i) throw workflowError(); result.push(row.raw);
    }
    assessTestWorkflow(this.readAuthorization(auth.operationId), result); return Object.freeze(result);
  }
  recordEvent(scope: PreparedLockScope, auth: TestAuthorization, data: TestEventData): void {
    const raw = this.readAuthorization(auth.operationId); this.assertRetainedAuthorization(auth, workflowDigest(raw));
    const history = this.readFinalHistory(auth); const prior = history.map((entry) => parseTestWorkflowEvent(entry)).find((entry) => entry.data.action === data.action);
    if (prior) { if (!same(prior.data, data)) throw workflowError(); return; }
    const recorded = Math.max(auth.elapsedMs, Date.now() - Date.parse(auth.bounds.startedAt), history.length ? parseTestWorkflowEvent(history.at(-1)!).elapsedMs : 0);
    const entry = { schemaVersion: "requirements-test-workflow/v1", kind: "event", operationId: auth.operationId, authorizationSha256: workflowDigest(raw), sequence: history.length + 1,
      previousSha256: workflowDigest(history.at(-1) ?? raw), bounds: auth.bounds, retriesUsed: auth.retriesUsed, elapsedMs: recorded,
      evidence: reference("native-sequence", { operationId: auth.operationId, sequence: history.length + 1, data }), data };
    const next = JSON.stringify(entry); assessTestWorkflow(raw, [...history, next]);
    const id = workflowDigest(JSON.stringify(["requirements-test-native-history/v1", auth.operationId]));
    this.#store().publish(scope, `${id}.transaction-${history.length + 1}.json`, { raw: next, sha256: workflowDigest(next) });
  }
  recordTestSettlement(scope: PreparedLockScope, auth: TestAuthorization, resource: TestResource, launch: RequirementsTestLaunch): void {
    const history = this.readFinalHistory(auth);
    if (history.some((raw) => parseTestWorkflowEvent(raw).data.action === "test-settled")) return;
    const status = queryDeploymentStatus(launch.holder.deploymentId);
    if (readProcessFingerprint(launch.holder.process.pid) || !status || !["success", "partial"].includes(status.status)
      || status.pid !== launch.holder.process.pid || status.requirements_test?.operationId !== auth.operationId || status.requirements_test.authorizationSha256 !== workflowDigest(this.readAuthorization(auth.operationId))) throw workflowError();
    const head = snapshot(resource.worktreeRoot); if (head.dirty || head.branch !== auth.repository.branch) throw workflowError();
    const commits = git(["rev-list", "--reverse", `${auth.repository.selectedHeadSha}..${head.head}`], resource.worktreeRoot).toString("utf8").trim().split("\n").filter(Boolean);
    const evidence: TestGitEvidence = { baseSha: auth.repository.baseSha, initialHeadSha: auth.repository.selectedHeadSha, testHeadSha: head.head,
      ancestry: [auth.repository.baseSha, ...git(["rev-list", "--reverse", "--ancestry-path", `${auth.repository.baseSha}..${auth.repository.selectedHeadSha}`], resource.worktreeRoot).toString("utf8").trim().split("\n").filter(Boolean)],
      commits: commits.map((sha) => {
        const parentSha = git(["show", "-s", "--format=%P", sha], resource.worktreeRoot).toString("utf8").trim();
        const paths = git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", parentSha, sha], resource.worktreeRoot).toString("utf8").split("\0").filter(Boolean);
        const content = (at: string, path: string): string | null => git(["ls-tree", "-z", at, "--", path], resource.worktreeRoot).length ? workflowDigest(git(["show", `${at}:${path}`], resource.worktreeRoot)) : null;
        return { sha, parentSha, changes: paths.map((path) => ({ path, previousPath: null, beforeSha256: content(parentSha, path), afterSha256: content(sha, path) })) };
      }), files: auth.paths.map((entry) => ({ path: entry.path, sha256: workflowDigest(git(["show", `${head.head}:${entry.path}`], resource.worktreeRoot)) })), porcelainV2Base64: head.statusPorcelainV2Base64!, inventory: reference("native-git-inventory", head) };
    verifyRequirementsTestGit(auth, resource, evidence);
    const native = new NativeExecutionEvidence(this.#store(), join(this.native.root, "operations"), { repository: (run) => run(), worktree: (run) => run() });
    const checks = this.#store().records().map((name) => this.#store().read(name) as { kind?: string; payload?: { authorizationSha256: string; check: unknown; candidate: string; result: NativeProcessResult; startedAt: string; finishedAt: string } })
      .filter((row) => row.kind === "requirements-test-check" && row.payload?.authorizationSha256 === workflowDigest(this.readAuthorization(auth.operationId))).map((row) => row.payload!);
    if (checks.length !== auth.checks.length) throw workflowError();
    const results: TestProcessResult[] = auth.checks.map((check) => {
      const matches = checks.filter((row) => same(row.check, check)); if (matches.length !== 1) throw workflowError(); const found = matches[0]!; const process = found.result;
      const frame = workflowObject(native.read(process.frame, "process-frame"), ["intent", "process", "groupId", "sessionId", "executable"]);
      const stdout = native.blob(process.stdout); const stderr = native.blob(process.stderr);
      // Native harness protocol reserves 42 for a completed intended assertion
      // rejection. Ordinary import/runner exits (normally 1) and stderr faults
      // cannot be relabelled RED by an earlier stdout marker.
      if (process.exitCode !== (check.kind === "baseline" ? 0 : 42) || stderr.length !== 0) throw workflowError();
      const observation = workflowObject(parseReviewEvidenceJson(stdout, "native test assertion frame"), ["schemaVersion", "assertion", "outcome", "reason"]);
      if (observation.schemaVersion !== "requirements-test-assertion/v1" || !process.groupSettled || found.candidate !== head.head) throw workflowError();
      const started = Date.parse(found.startedAt) - Date.parse(auth.bounds.startedAt), finished = Date.parse(found.finishedAt) - Date.parse(auth.bounds.startedAt);
      return { checkId: check.id, command: check.command, cwd: check.cwd, environment: check.environment, candidateSha: found.candidate, input: check.input,
        process: { deploymentId: launch.holder.deploymentId, process: frame.process as ExecutionHolder["process"] }, stdout: reference("native-stdout", process.stdout), stderr: reference("native-stderr", process.stderr), assertionEvidence: reference("native-assertion", observation),
        exitCode: process.exitCode, signal: process.signal, disposition: process.timedOut ? "timeout" : process.aborted ? "cancelled" : "exited", startedElapsedMs: started, finishedElapsedMs: finished, durationMs: finished - started,
        outputBytes: process.stdout.bytes + process.stderr.bytes, truncated: process.outputLimitExceeded, observations: [{ assertion: String(observation.assertion), outcome: observation.outcome as TestProcessResult["observations"][number]["outcome"], reason: String(observation.reason) }] };
    });
    this.recordEvent(scope, auth, { action: "test-settled", holder: launch.holder, settlement: reference("actual-process-and-registry-terminal", { launch, status: status.status }), git: evidence, results });
  }
  async captureReview(context: PiPreparationContext, operationId: string, finalRequirements?: string, signal?: AbortSignal): Promise<void> {
    const caller = this.#authenticate(context); const auth = parseTestAuthorization(this.readAuthorization(operationId));
    this.#binding(auth); const history = this.readFinalHistory(auth), assessment = assessTestWorkflow(this.readAuthorization(operationId), history);
    const settled = history.map((raw) => parseTestWorkflowEvent(raw).data).find((data) => data.action === "test-settled");
    if (!assessment.resource || !settled || settled.action !== "test-settled") throw workflowError();
    verifyRequirementsTestGit(auth, assessment.resource, settled.git);
    if (context.mode !== "tui" || !context.ui?.select || signal?.aborted || caller.deploymentId !== auth.parent.holder.deploymentId || !assessment.oracle) throw workflowError();
    let data: TestEventData;
    if (finalRequirements === undefined) {
      if (assessment.state !== "test-settled") throw workflowError();
      const accept = "Sinh independently approves this exact oracle and wrong-output control";
      const answer = await context.ui.select(`Independent non-author oracle review, not child self-approval or product UAT. Inspect original outcome, exact test bytes and plausible intact wrong-output control: ${JSON.stringify(assessment.oracle)}. Complete private history: ${JSON.stringify(history)}.`, [accept, "Cancel"], signal ? { signal } : undefined);
      if (answer !== accept || !context.ui.input) throw workflowError();
      const outcomeRationale = await context.ui.input("Sinh: why do these exact tests express the original recipient outcome?", undefined, signal ? { signal } : undefined);
      const wrongOutputRationale = await context.ui.input("Sinh: why is the intact wrong-output control plausible and effectively rejected?", undefined, signal ? { signal } : undefined);
      if (!outcomeRationale?.trim() || !wrongOutputRationale?.trim() || outcomeRationale.length > 2000 || wrongOutputRationale.length > 2000) throw workflowError();
      data = { action: "oracle-reviewed", oracle: assessment.oracle, reviewer: "sinh", delegation: null, decision: reference("native-oracle-decision", { caller, id: randomUUID(), oracle: assessment.oracle }), outcomeRationale, wrongOutputRationale };
    } else {
      if (assessment.state !== "oracle-reviewed") throw workflowError();
      const pair = this.native.preview(caller, finalRequirements);
      const accept = "Approve this exact final pair, matrix and reviewed oracle for product continuation";
      const answer = await context.ui.select(`Separate final whole-document decision, NOT test authorization. Exact final pair ${JSON.stringify(pair)}; exact reviewed oracle ${JSON.stringify(assessment.oracle)}.`, [accept, "Cancel"], signal ? { signal } : undefined);
      if (answer !== accept || !same(this.native.preview(caller, finalRequirements), pair)) throw workflowError();
      data = { action: "final-approved", owner: "sinh", oracle: assessment.oracle, reviewSha256: workflowDigest(history.at(-1)!), pair: { requirements: pair.requirements, uat: pair.uat, matrix: pair.matrix,
        matrixApproval: reference("native-matrix-approval", pair.matrixApprovalEvidence), finalChecks: pair.finalChecks, finalCheckCount: 13 }, decision: reference("native-final-pair-decision", { caller, id: randomUUID(), pair, oracle: assessment.oracle }) };
    }
    if (signal?.aborted || !same(this.#authenticate(context), caller) || !same(this.readFinalHistory(auth), history)) throw workflowError(); this.#binding(auth);
    withPreparedWorkflowLocks({ repository: (run) => withPreparedTicketCapacity({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root }, () => run()), worktree: (run) => run() }, (scope) => {
      if (!same(this.readFinalHistory(auth), history)) throw workflowError(); this.recordEvent(scope, auth, data);
    });
  }
  assertFinalApproval(auth: TestAuthorization, assessment: TestWorkflowAssessment): void {
    const history = this.readFinalHistory(auth);
    const complete = assessTestWorkflow(this.readAuthorization(auth.operationId), history);
    const finalIndex = history.findIndex((entry) => parseTestWorkflowEvent(entry).data.action === "final-approved");
    if (!["final-approved", "product-intent", "product-consumed"].includes(complete.state) || assessment.state !== "final-approved"
      || !same(assessTestWorkflow(this.readAuthorization(auth.operationId), history.slice(0, finalIndex + 1)), assessment)) throw workflowError();
    const final = parseTestWorkflowEvent(history[finalIndex]!).data;
    if (final.action !== "final-approved") throw workflowError();
    const caller = { deploymentId: auth.parent.holder.deploymentId, repoKey: auth.repository.key, repoRoot: auth.repository.root, ticket: auth.repository.ticket, callerIdentity: "0".repeat(64) };
    const pair = this.native.preview(caller, final.pair.requirements.ref);
    if (!same(final.pair.requirements, pair.requirements) || !same(final.pair.uat, pair.uat) || !same(final.pair.matrix, pair.matrix) || !same(final.pair.finalChecks, pair.finalChecks)
      || !same(final.pair.matrixApproval, reference("native-matrix-approval", pair.matrixApprovalEvidence))) throw workflowError();
  }
  readPreviousAuthorization(auth: TestAuthorization): string {
    if (!auth.amendment) throw workflowError();
    const rows = this.#store().records().map((name) => this.#store().read(name) as Record<string, unknown>).filter((row) => row.schemaVersion === AUTHORITY_VERSION && row.authorizationSha256 === auth.amendment!.previousAuthorizationSha256);
    if (rows.length !== 1 || typeof rows[0]!.raw !== "string") throw workflowError(); return rows[0]!.raw;
  }
  assertAmendment(previous: TestAuthorization, next: TestAuthorization): void {
    this.assertAuthorization(next, workflowDigest(this.readAuthorization(next.operationId)));
    if (!same(parseTestAuthorization(this.readPreviousAuthorization(next)), previous)) throw workflowError();
    testWorkflowInvalidation(this.readAuthorization(previous.operationId), this.readAuthorization(next.operationId), this.readFinalHistory(previous));
  }
  /** Only a fresh foreground decision may permit another zero-effect capacity
   * attempt. UI is outside locks; the complete failure chain is reread under the
   * shared owner before publication. This never retries or clears effects itself. */
  async captureCapacityRetry(context: PiPreparationContext, operationId: string, toolCallId: string, signal?: AbortSignal): Promise<SourceVersion> {
    const caller = this.#authenticate(context), raw = this.readAuthorization(operationId), auth = parseTestAuthorization(raw);
    const current = () => {
      this.assertAuthorization(auth, workflowDigest(raw));
      if (signal?.aborted || context.mode !== "tui" || !context.ui?.select || !toolCallId || toolCallId.length > 256
        || caller.deploymentId !== auth.parent.holder.deploymentId || caller.repoKey !== auth.repository.key || caller.repoRoot !== auth.repository.root || caller.ticket !== auth.repository.ticket
        || !same(this.#authenticate(context), caller) || !processIsWithinFingerprintLineage(process.pid, auth.parent.holder.process)
        || executionBoundStop(auth.bounds, new Date().toISOString())) throw workflowError();
    };
    const preview = () => withPreparedTicketCapacity({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root }, (capacity) => {
      current(); return capacityRetryState(auth, loadNativeRecords(this.#store(), auth, workflowDigest(raw)), capacity);
    });
    const initial = preview();
    const accept = "Retry this unchanged zero-effect capacity failure once";
    const answer = await context.ui!.select(`Manual capacity retry only; no queue, resource reclaim, new authorization, counter reset or product authority. Exact authorization ${workflowDigest(raw)}; failure and retained bounds ${JSON.stringify(initial)}`, [accept, "Cancel"], signal ? { signal } : undefined);
    if (answer !== accept) throw workflowError();
    current();
    return withPreparedWorkflowLocks({ repository: (run) => withPreparedTicketCapacity({ canonicalRepoKey: auth.repository.key, canonicalRepoRoot: auth.repository.root }, (capacity) => {
      current();
      if (!same(capacityRetryState(auth, loadNativeRecords(this.#store(), auth, workflowDigest(raw)), capacity), initial)) throw workflowError();
      return run();
    }), worktree: (run) => run() }, (scope) => {
      const id = capacityRetryId(auth, initial.failure, initial.retriesUsed);
      const value = { schemaVersion: CAPACITY_RETRY_VERSION, operationId, authorizationSha256: workflowDigest(raw), ...initial, caller,
        toolCallId, decisionId: workflowDigest(randomUUID()), capturedAt: new Date().toISOString() };
      this.#store().publish(scope, `${id}.intent.json`, value);
      return Object.freeze({ ref: `requirements-test-capacity-retry:${id}`, version: CAPACITY_RETRY_VERSION, sha256: workflowDigest(JSON.stringify(value)) });
    });
  }
  assertCapacityRetry(auth: TestAuthorization, decisionInput: SourceVersion, failureInput: SourceVersion, retriesUsed: number): void {
    const decision = parseSourceVersion(decisionInput), failure = parseSourceVersion(failureInput);
    const id = capacityRetryId(auth, failure, retriesUsed);
    const value = this.#store().read(`${id}.intent.json`);
    const row = workflowObject(value, ["schemaVersion", "operationId", "authorizationSha256", "failure", "retriesUsed", "bounds", "caller", "toolCallId", "decisionId", "capturedAt"]);
    const raw = this.readAuthorization(auth.operationId); this.assertAuthorization(auth, workflowDigest(raw));
    const caller = workflowObject(row.caller, ["deploymentId", "repoKey", "repoRoot", "ticket", "callerIdentity"]);
    if (row.schemaVersion !== CAPACITY_RETRY_VERSION || decision.ref !== `requirements-test-capacity-retry:${id}` || decision.version !== CAPACITY_RETRY_VERSION
      || decision.sha256 !== workflowDigest(JSON.stringify(value)) || row.operationId !== auth.operationId || row.authorizationSha256 !== workflowDigest(raw)
      || !same(row.failure, failure) || row.retriesUsed !== retriesUsed || !same(row.bounds, auth.bounds)
      || caller.deploymentId !== auth.parent.holder.deploymentId || caller.repoKey !== auth.repository.key || caller.repoRoot !== auth.repository.root || caller.ticket !== auth.repository.ticket
      || typeof row.toolCallId !== "string" || !row.toolCallId || row.toolCallId.length > 256
      || executionBoundStop(auth.bounds, new Date().toISOString())) throw workflowError();
    workflowSha(caller.callerIdentity); workflowSha(row.decisionId); workflowTimestamp(row.capturedAt);
  }
}

/** Actual foreground caller authentication is reused, not an env route selector.
 * The staged entry intentionally exposes no effectful service/activation until
 * the independent installed/pair/native-producer qualification phases finish. */
export function requestPiRequirementsTestNative(context: PiPreparationContext): never {
  authenticatePiPreparationCaller(context, process.env);
  if (!requirementsTestCapability().enabled) throw workflowError();
  throw workflowError();
}
/** Presence of ANY retained new-route intent prevents ordinary builder fallback,
 * even when malformed, cancelled, idle, resource-missing or not yet final-approved.
 * This guard never translates test evidence into legacy preparation approval. */
export function assertNoRequirementsTestLegacyFallback(input: { repoKey: string; repoRoot: string; ticket: string }, authority = new PiPreparedNativeAuthority()): void {
  const store = authority.operations();
  for (const name of store?.records().filter((name) => name.endsWith(".intent.json")) ?? []) {
    const value = store!.read(name);
    if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === VERSION) {
      // The native request identity intentionally omits public paths; retained
      // shared capacity is the cross-route authority for the exact ticket below.
      const row = workflowObject(value, ["schemaVersion", "operationId", "authorizationSha256", "sequence", "previousSha256", "step", "state", "value"]);
      workflowSha(row.operationId); workflowSha(row.authorizationSha256);
      const request = workflowObject(row.value, ["repository", "approval", "bounds", "retriesUsed", "elapsedMs"]);
      const repository = workflowObject(request.repository, ["key", "root", "ticket", "baseSha", "branch", "selectedHeadSha"]);
      if (repository.key === input.repoKey && repository.root === input.repoRoot && repository.ticket === input.ticket) throw workflowError();
    }
  }
  // Read only: absence must not create/repair capacity storage on old routes.
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], input.repoRoot).toString("utf8").trim();
  const path = join(common, "pa-ticket-builder-slots", `${workflowDigest(input.ticket)}.prepared.json`);
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw workflowError(); }
  const row = parseIdlePreparationReservation(JSON.parse(Buffer.from(readReviewEvidenceFile(path, 65_536, "native retained capacity")).toString("utf8")));
  if (row.purpose === "requirements-test-workflow/v1") throw workflowError();
}
