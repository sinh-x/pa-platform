import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  assessTestWorkflow, captureRepositoryGitSnapshot, executionBoundStop, loadRepoEntry,
  materializeTicketBranch, parseIdlePreparationReservation, parseTestAuthorization,
  ProtectedWorkflowStore, readProcessFingerprint, requireTicketLinkedBranch,
  parseSourceVersion, parseTestWorkflowEvent, readReviewEvidenceFile, refreshTicketLinkedBranchHead, requirementsTestCapability, resolveRepoExecutionPath, withExecutionWorktreeAdmission,
  withPreparedTicketCapacity, withPreparedWorkflowLocks, withVacantPreparationWorktree,
  testWorkflowInvalidation, workflowDigest, workflowError, workflowObject, workflowSha, workflowSynchronous,
  type ExecutionHolder, type IdlePreparationReservation, type PreparedLockScope,
  type PreparedTicketCapacityTransaction, type RepositoryGitSnapshot, type SourceVersion,
  type TestAuthorization, type TestGitEvidence, type TestResource, type TestWorkflowAssessment,
  type TicketStore,
} from "@pa-platform/pa-core";
import { authenticatePiPreparationCaller, type PiPreparationContext } from "./pi-extension/prepared-workflow.js";
import { PiPreparedNativeAuthority } from "./prepared-native.js";
import { TreehouseClient, type TreehouseLeaseEvidence } from "./treehouse.js";

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
type Step = "reservation" | "allocation" | "branch" | "test-process" | "test-start" | "test-settlement" | "product-process" | "product-transfer" | "product-start";
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
const STEPS: readonly Step[] = ["reservation", "allocation", "branch", "test-process", "test-start", "test-settlement", "product-process", "product-transfer", "product-start"];
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
    const id = identity(auth.operationId); const names = this.options.store.records().filter((name) => name.startsWith(`${id}.`));
    if (!names.length) return [];
    if (!names.includes(`${id}.intent.json`) || names.length > 128) throw workflowError();
    const records: NativeRecord[] = []; let previous = digest;
    for (let sequence = 0; sequence < names.length; sequence++) {
      const name = sequence === 0 ? `${id}.intent.json` : `${id}.transaction-${sequence}.json`;
      if (!names.includes(name)) throw workflowError();
      const row = workflowObject(this.options.store.read(name), ["schemaVersion", "operationId", "authorizationSha256", "sequence", "previousSha256", "step", "state", "value"]);
      if (row.schemaVersion !== VERSION || row.operationId !== auth.operationId || row.authorizationSha256 !== digest || row.sequence !== sequence || row.previousSha256 !== previous
        || !["request", "cancel", "capacity-retry", ...STEPS].includes(String(row.step)) || !["intent", "observed", "failed", "unknown", "cancelled"].includes(String(row.state))) throw workflowError();
      const record = row as unknown as NativeRecord;
      if (sequence === 0 && (record.step !== "request" || record.state !== "intent")) throw workflowError();
      records.push(record); previous = workflowDigest(JSON.stringify(record));
    }
    return records;
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
    if (!row.lineageId) throw workflowError();
    return { repository: auth.repository, worktreeRoot: lease.path, leaseId: lease.leaseId, leaseHolder: lease.leaseHolder,
      reservationId: row.reservationId, repositoryPermit: row.repositoryPermit, lineageId: row.lineageId };
  }
  #runStep<T>(auth: TestAuthorization, digest: string, capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope, step: Step,
    perform: () => T, reconcile: () => T, validate: (value: T) => void): T {
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
  #request(operationId: string): Readonly<{ state: "test-active"; resource: TestResource }> {
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
  #launch(auth: TestAuthorization, digest: string, capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope, role: "test" | "product", resource: TestResource): RequirementsTestLaunch {
    const intentId = workflowDigest(JSON.stringify([auth.operationId, `${role}-process`]));
    return this.#runStep(auth, digest, capacity, scope, `${role}-process`, () => this.options.executor.prepare(role, intentId, resource), () => this.options.executor.inspect(role, intentId, resource), (launch) => {
      parseSourceVersion(launch.registry);
      if (launch.holder.deploymentId === auth.parent.holder.deploymentId || !same(readProcessFingerprint(launch.holder.process.pid), launch.holder.process)) throw workflowError();
      if (realpathSync(launch.deploymentDirectory) !== launch.deploymentDirectory || !lstatSync(launch.deploymentDirectory).isDirectory()) throw workflowError();
      const started = this.#load(auth, digest).some((row) => row.step === `${role}-start`);
      if (started) synchronous(() => this.options.executor.assertStarted(launch, workflowDigest(JSON.stringify([auth.operationId, `${role}-start`]))));
      else synchronous(() => this.options.executor.assertParked(launch, resource, role));
    });
  }
  #start(auth: TestAuthorization, digest: string, capacity: PreparedTicketCapacityTransaction, scope: PreparedLockScope, role: "test" | "product", launch: RequirementsTestLaunch, resource: TestResource): void {
    const records = this.#load(auth, digest); const step = `${role}-start` as const;
    // Never reissue a release after a lost response. Independently prove the
    // original release before closing its barrier, or remain blocked.
    if (records.some((record) => record.step === step)) {
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
      this.#append(scope, auth, sha256, this.#load(auth, sha256), "test-settlement", "observed", value);
    });
  }
  #final(auth: TestAuthorization, records: readonly NativeRecord[], capacity: PreparedTicketCapacityTransaction): { assessment: TestWorkflowAssessment; resource: TestResource } {
    if (records.some((record) => record.step === "cancel" || record.state === "cancelled")) throw workflowError();
    const raw = this.options.authority.readAuthorization(auth.operationId);
    if (workflowDigest(raw) !== records[0]?.authorizationSha256) throw workflowError();
    const history = workflowSynchronous(this.options.authority.readFinalHistory(auth));
    const assessment = assessTestWorkflow(raw, history);
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
    return { assessment, resource };
  }
  /** Same resource/reservation/lineage, exact approved test HEAD; no allocation,
   * reservation call, branch construction, legacy preparation or fallback. */
  continueProduct(operationId: string): Readonly<{ state: "product-active"; resource: TestResource; initialHeadSha: string }> { return nativeGuard(() => this.#continueProduct(operationId)); }
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
  /** Native operator-only manual retry of proven full-capacity/zero-resource
   * failure. Unknown allocation/process/branch failures are never cleared here. */
  retryCapacity(operationId: string, decisionInput: SourceVersion): void { nativeGuard(() => this.#retryCapacity(operationId, decisionInput)); }
  #retryCapacity(operationId: string, decisionInput: SourceVersion): void {
    const { auth, sha256 } = this.#authorization(operationId); const decision = parseSourceVersion(decisionInput);
    this.#locked(auth, (capacity, scope) => {
      const records = this.#load(auth, sha256);
      const failures = records.filter((row) => row.step === "reservation" && row.state === "failed");
      const last = records.at(-1);
      if (!last || last !== failures.at(-1) || !same(last.value, { reason: "not-ready-capacity", operatorNotificationRequired: true, retry: "operator-manual-only" })
        || records.some((row) => row.state === "observed" && row.step !== "capacity-retry") || capacity.inventory().some((row) => row.ticket === auth.repository.ticket)) throw workflowError();
      const retriesUsed = auth.retriesUsed + records.filter((row) => row.step === "capacity-retry").length + 1;
      if (retriesUsed > auth.retryLimit) throw workflowError();
      const failure = reference("capacity-failure", last);
      synchronous(() => this.options.authority.assertCapacityRetry(auth, decision, failure, retriesUsed));
      this.#append(scope, auth, sha256, records, "capacity-retry", "observed", { decision, failure, retriesUsed, bounds: auth.bounds });
    });
  }
  cancel(operationId: string): void { nativeGuard(() => this.#cancel(operationId)); }
  #cancel(operationId: string): void {
    const { auth, sha256 } = this.#authorization(operationId, false);
    this.#locked(auth, (_capacity, scope) => {
      const records = this.#load(auth, sha256);
      if (!records.length) throw workflowError();
      if (!records.some((record) => record.step === "cancel")) this.#append(scope, auth, sha256, records, "cancel", "cancelled", { retained: true, evidence: reference("cancellation", auth.operationId) });
    });
  }
  status(operationId: string): Readonly<{ schemaVersion: typeof VERSION; state: "unrequested" | "retained" | "blocked"; effects: number; activation: false }> { return nativeGuard(() => this.#status(operationId)); }
  #status(operationId: string): Readonly<{ schemaVersion: typeof VERSION; state: "unrequested" | "retained" | "blocked"; effects: number; activation: false }> {
    const { auth, sha256 } = this.#authorization(operationId, false);
    const records = this.#load(auth, sha256);
    return Object.freeze({ schemaVersion: VERSION, state: !records.length ? "unrequested" : records.some((row) => ["unknown", "failed", "cancelled"].includes(row.state)) ? "blocked" : "retained",
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
