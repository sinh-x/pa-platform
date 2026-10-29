import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  captureRepositoryGitSnapshot, ExecutionCustodyService, getDeployPaths, getRegistryDbPath, loadTeamConfig, loadRepoEntry, queryReadonlyDeploymentEvents, observeReadonlyRepositoryAuthority, observeReadonlyRepositoryTicketSlot,
  parseExecutionBinding, readExecutionState, parseExecutionCommandText, parseSourceVersion, parseReviewEvidenceJson, processIsWithinFingerprintLineage, queryReadonlyHelperRegistry, readProcessFingerprint,
  readReviewEvidenceFile, withExecutionWorktreeAdmission, withPreparedTicketCapacity, withPreparedWorkflowLocks,
  LOCAL_GIT_CONTROL_FLAGS, assertSupportedGitMetadataRead, assertSupportedLocalGitEffects, assertLocalGitIndexMatchesWorking, localGitIndexFingerprint, localGitTreeFingerprint,
  executionFailure, executionWorkflowError, workflowDigest, workflowError, workflowObject, workflowSha, workflowText, type ExecutionBinding, type ExecutionCommand,
  type ExecutionFailure, type ExecutionHolder, type ExecutionHost, type ExecutionRecovery, type ExecutionRecoveryInventory, type ExecutionState,
  type PreparedLockOwners, type PreparedTicketCapacityTransaction, type ExecutionWorktreeTransaction, type RegistryEvent, type RepositoryGitSnapshot, type SourceVersion, type PhaseReportCheck,
} from "@pa-platform/pa-core";
import { createPiReadonlyHelperCapability, type PiReadonlyHelperDependencies } from "./deploy.js";
import { readPiProcessIdentity } from "./process-identity.js";
import { PiPreparedNativeAuthority } from "./prepared-native.js";
import { NativeExecutionEvidence, NativeProcessEvidenceError, nativePublicText, runNativeExecutionProcess, trustedNativeExecutable, type NativeBlob, type NativeProcessResult } from "./native-execution-evidence.js";
import type { PiExecutionBinding, PiExecutionEndEvent } from "./pi-extension/prepared-workflow.js";
import type { PiToolCall } from "./pi-extension/index.js";
import { interceptToolCall } from "./pi-extension/safety.js";
import { environmentSecrets } from "./diagnostics.js";
import { executionAdministration, runExecutionAdministration, type ExecutionAdministration, type ExecutionAdministrationIdentity } from "./native-execution-administration.js";
import { ProjectCommandContract } from "./project-command-contract.js";
import { readPiForegroundCompletion } from "./terminal-status.js";
import { authorizePiStructuredWork, parseStructuredLaunchNote, requirePiSourceIntent, retainedPiSourceIntent } from "./workflow-consumers.js";

const CHECKS: Readonly<Record<string, string>> = Object.freeze({ typecheck: "corepack pnpm typecheck", build: "corepack pnpm build", test: "corepack pnpm test", completions: "corepack pnpm completions", "secrets-scan": "corepack pnpm secrets:scan",
  "pi-typecheck": "corepack pnpm --filter @pa-platform/pi-pa typecheck",
  "pi-direct-tests": "corepack pnpm exec tsx --test --test-concurrency=1 packages/pi-pa/src/__tests__/pi-deploy.test.ts packages/pi-pa/src/__tests__/pi-execution-custody.test.ts packages/pi-pa/src/__tests__/prepared-native.test.ts packages/pi-pa/src/__tests__/native-execution-evidence.test.ts packages/pi-pa/src/__tests__/execution-diagnostics.test.ts",
  "diff-check": "git diff --check",
});
const checkText = (name: string): string | undefined => CHECKS[name] ?? (Object.values(CHECKS).includes(name) ? name : undefined);
/** Immutable launcher correlation, not an activation marker or optional grant. */
export const ORDINARY_NATIVE_EXECUTION_START = "ordinary-native-execution/v1";
const ordinaryOperationId = (id: string) => workflowDigest(JSON.stringify([ORDINARY_NATIVE_EXECUTION_START, id]));
function ordinaryDescriptorName(id: string): string {
  const executionId = workflowDigest(JSON.stringify(["execution/v1", ordinaryOperationId(id), id]));
  return `${workflowDigest(JSON.stringify(["native-execution-descriptor/v1", executionId]))}.intent.json`;
}
function ordinaryStart(id: string): RegistryEvent | null {
  const starts = queryReadonlyDeploymentEvents(id).filter((event) => event.event === "started");
  if (!starts.some((event) => event.note?.startsWith("ordinary-native-execution/"))) return null;
  if (starts.length !== 1 || (starts[0]!.note !== ORDINARY_NATIVE_EXECUTION_START && !parseStructuredLaunchNote(starts[0]!.note))) throw executionFailure("EXECUTION_BINDING_UNCERTAIN");
  return starts[0]!;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME"]) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  return env;
}
function git(args: readonly string[], cwd: string): Buffer {
  if (args[0] === "status" || args[0] === "diff") assertSupportedGitMetadataRead(cwd, git);
  return execFileSync(trustedNativeExecutable("git"), ["--no-optional-locks", ...LOCAL_GIT_CONTROL_FLAGS, ...args], { cwd, env: gitEnvironment(), timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function gitArguments(command: string): string[] {
  const commit = /^git commit -m (?:"([^"\n]+)"|'([^'\n]+)')$/.exec(command);
  if (commit) return ["commit", "-m", commit[1] ?? commit[2]!];
  const args = command.slice(4).split(" ");
  return args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
}
function marker(directory: string, executionDiagnostic = false): Record<string, unknown> | null {
  const rejected = () => executionDiagnostic ? executionFailure("EXECUTION_STORAGE_REJECTED") : workflowError();
  const path = join(directory, "prepared-consumption.json");
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw rejected(); }
  if ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw rejected();
  let text: Uint8Array;
  try { text = readReviewEvidenceFile(path, 65_536, "native consumed lineage"); } catch { throw rejected(); }
  // Malformed serialized storage is proved by this native record reader, not by
  // parsing host exception text. Other authority/store failures remain UNKNOWN.
  let record: unknown;
  try { record = parseReviewEvidenceJson(text, "native consumed lineage"); } catch { throw rejected(); }
  try { return workflowObject(record, ["schemaVersion", "deploymentId", "repoKey", "repoRoot", "ticket", "operationId", "receiptId", "grantId", "consumer", "worktreeRoot", "branch", "baseSha", "headSha", "ticketSlotId", "repositoryPermit"]); }
  catch { throw executionDiagnostic ? executionFailure("EXECUTION_CONTRACT_INVALID") : workflowError(); }
}
/** An adopted lineage must not enter the old child admission path without the
 * native launch/settlement producer. Until that producer is qualified this is
 * a conservative stop BEFORE child capacity, branch, borrower or spawn effects. */
export function assertNativePreparedChildLaunchSupported(parentDirectory: string, parentDeploymentId: string): void {
  if (marker(parentDirectory)) throw workflowError();
  try { lstatSync(getRegistryDbPath()); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw workflowError(); }
  if (nativeStartDigest(parentDeploymentId) || ordinaryStart(parentDeploymentId)) throw workflowError();
}
function nativeStartDigest(deploymentId: string, executionDiagnostic = false): string | null {
  const starts = queryReadonlyDeploymentEvents(deploymentId).filter((event) => event.event === "started");
  if (!starts.some((event) => event.note?.startsWith("prepared-native-consumption/"))) return null;
  const match = starts.length === 1 ? /^prepared-native-consumption\/v1:([0-9a-f]{64})$/.exec(starts[0]!.note ?? "") : null;
  if (!match) throw executionDiagnostic ? executionFailure("EXECUTION_BINDING_UNCERTAIN") : workflowError(); return match[1]!;
}
interface FileVersion { path: string; kind: "file" | "missing"; sha256: string | null; bytes: number; mode: number }
export interface NativeScopeSnapshot { readonly git: RepositoryGitSnapshot; readonly files: readonly FileVersion[] }
function names(snapshot: RepositoryGitSnapshot): string[] {
  const paths = new Set<string>();
  if (!snapshot.statusEntries || snapshot.statusPorcelainV2Base64 === undefined || !snapshot.digestSha256) throw workflowError();
  for (const entry of snapshot.statusEntries) {
    if (entry.kind === "unmerged") throw workflowError();
    paths.add(entry.path); if (entry.sourcePath) paths.add(entry.sourcePath);
  }
  return [...paths].sort();
}
function scopedPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || path.startsWith("-")) throw workflowError();
  const absolute = join(root, path);
  for (let current = absolute; current !== root; current = dirname(current)) {
    try { const stat = lstatSync(current); if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw workflowError(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw workflowError(); }
  }
  if (realpathSync(root) !== root) throw workflowError();
  return absolute;
}
export function captureNativeScope(root: string): NativeScopeSnapshot {
  const snapshot = captureRepositoryGitSnapshot(root, git);
  const files = names(snapshot).map((path): FileVersion => {
    const absolute = scopedPath(root, path);
    let fd: number;
    try { fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "missing", sha256: null, bytes: 0, mode: 0 }; throw error; }
    try {
      const before = fstatSync(fd); if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024) throw workflowError();
      const hash = createHash("sha256"); const buffer = Buffer.alloc(65_536); let length = 0;
      while (true) { const count = readSync(fd, buffer); if (!count) break; length += count; if (length > 64 * 1024 * 1024) throw workflowError(); hash.update(buffer.subarray(0, count)); }
      const after = fstatSync(fd); const current = lstatSync(absolute);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || current.dev !== after.dev || current.ino !== after.ino || current.isSymbolicLink()) throw workflowError();
      return { path, kind: "file", sha256: hash.digest("hex"), bytes: length, mode: after.mode };
    } finally { closeSync(fd); }
  });
  if (!equal(captureRepositoryGitSnapshot(root, git), snapshot)) throw workflowError();
  return Object.freeze({ git: snapshot, files: Object.freeze(files) });
}
export function readNativeCommitTree(root: string, commit: string): string { return localGitTreeFingerprint(root, git, workflowSha(commit, 40)); }
export interface NativeIntent {
  executionId: string; actor: ExecutionHolder; operationId: string; toolName: string; inputSha256: string; command: string; before: NativeScopeSnapshot;
  /** Native observations only. Missing historical proof is never upgraded. */
  checkedInputsSha256?: string; commitIndexSha256?: string;
}
export interface NativeToolResult {
  intent: SourceVersion; after: NativeScopeSnapshot; process: NativeProcessResult | null; exitCode: number; scopeValid: boolean;
  /** SDK error bytes are private; not a claimed cause inferred from text. */
  error: string | null;
  settlementError: string | null;
  sdkError: NativeBlob | null;
  unprovenProcess: SourceVersion | null;
}
export interface NativeExecutionReportFacts {
  readonly state: ExecutionState;
  readonly snapshot: RepositoryGitSnapshot;
  readonly checks: readonly PhaseReportCheck[];
  readonly operations: readonly SourceVersion[];
  readonly scopeProven: boolean;
  readonly diff: Buffer;
  readonly omissions: readonly string[];
  readonly pendingResult: SourceVersion | null;
}
export interface NativeExecutionOptions {
  readonly authority?: PiPreparedNativeAuthority;
  readonly helperDependencies?: PiReadonlyHelperDependencies;
}
/** Concrete native direct-holder adapter. Ordinary launch and optional consumed
 * reservation retain distinct provenance, sharing existing admission owners.
 * No request, environment tuple, source prose or constructor is a grant. */
export class PiNativeExecutionAdapter {
  readonly authority: PiPreparedNativeAuthority;
  readonly #options: NativeExecutionOptions;
  readonly #sessions = new Map<string, NativeExecutionSession>();
  constructor(options: NativeExecutionOptions = {}) { this.#options = options; this.authority = options.authority ?? new PiPreparedNativeAuthority(); }
  resolve(context: unknown, diagnostic = false): NativeExecutionSession | null {
    const env = process.env;
    if (env.PA_TEAM !== "builder" || !["orchestrator", "implement"].includes(env.PA_MODE ?? "")) {
      if (this.#sessions.size) throw executionFailure("EXECUTION_BINDING_UNCERTAIN");
      if (diagnostic) throw executionFailure("EXECUTION_UNKNOWN");
      return null;
    }
    const id = env.PA_DEPLOYMENT_ID;
    if (!id || !/^d-[0-9a-f]{6}$/.test(id)) {
      if (this.#sessions.size) throw executionFailure("EXECUTION_BINDING_UNCERTAIN");
      if (diagnostic) throw executionFailure("EXECUTION_UNKNOWN");
      return null;
    }
    const directory = getDeployPaths(id).deployDir;
    const registry = queryReadonlyHelperRegistry(id).status;
    const parent = registry?.parent_deployment_id;
    const ownerId = parent ?? id;
    const declared = nativeStartDigest(ownerId, true);
    const consumed = marker(parent ? getDeployPaths(parent).deployDir : directory, true);
    const ordinary = ordinaryStart(ownerId);
    if (!consumed && !ordinary) {
      if (declared || this.#sessions.size || this.authority.execution()?.records().includes(ordinaryDescriptorName(ownerId))) throw executionFailure("EXECUTION_BINDING_UNCERTAIN");
      // Configuration is a requirement to fail closed, never source authority.
      // Old independently admitted bootstrap lineages keep their legacy path.
      const team = loadTeamConfig("builder");
      if (env.PA_MODE === "orchestrator" && team.deploy_modes?.some((mode) => mode.id === "orchestrator") && !team.deploy_modes.some((mode) => mode.id === "implement")) throw executionFailure("EXECUTION_CAPABILITY_UNSUPPORTED");
      return null;
    }
    if (ordinary ? consumed !== null || declared !== null : declared !== workflowDigest(JSON.stringify(consumed))) throw executionFailure("EXECUTION_BINDING_UNCERTAIN");
    if (parent || env.PA_MODE !== "orchestrator") throw executionFailure("EXECUTION_CAPABILITY_UNSUPPORTED"); // no implicit child adoption
    const cwd = (context as { cwd?: string } | null)?.cwd;
    if (cwd !== process.cwd() || env.PA_DEPLOYMENT_DIR !== directory || !registry) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    let session = this.#sessions.get(id);
    if (!session) {
      const authentication = createPiReadonlyHelperCapability(this.#options.helperDependencies).authenticate(cwd);
      authentication.reread();
      if (authentication.context.role !== "orchestrator" || authentication.context.deploymentId !== id) throw executionFailure("EXECUTION_BINDING_CONFLICT");
      session = new NativeExecutionSession(this.authority, this.#options.helperDependencies ?? {}, consumed, authentication.context, ordinary);
      this.#sessions.set(id, session);
    }
    session.assertCaller(context); return session;
  }
}
type HelperContext = ReturnType<ReturnType<typeof createPiReadonlyHelperCapability>["authenticate"]>["context"];
/** Read exclusively from native registry and protected owners AFTER physical
 * authentication. Tokens remain private and only their digests bind the journal. */
function ordinaryLineage(start: RegistryEvent, physical: HelperContext) {
  const id = start.deployment_id;
  if (!equal(ordinaryStart(id), start) || start.runtime !== "pi" || start.binary !== "ppa" || start.team !== "builder" || start.mode !== "orchestrator"
    || start.builder_authority !== "orchestrator" || start.parent_deployment_id || start.resumed_from_deployment_id
    || start.repo !== physical.worktreeRoot || start.worktree_root !== physical.worktreeRoot || start.repo_root !== physical.repoRoot || start.ticket_id !== physical.ticket
    || start.treehouse_path !== physical.worktreeRoot || start.branch_state !== "materialized") throw executionFailure("EXECUTION_BINDING_CONFLICT");
  const custody = observeReadonlyRepositoryAuthority(physical.gitDir);
  if (!custody.owner || custody.borrower || custody.implement || custody.review) throw executionFailure("EXECUTION_HOLDER_CONFLICT");
  const owner = custody.owner; const slot = observeReadonlyRepositoryTicketSlot(physical.repoRoot, physical.ticket!).slot;
  if (owner.deploymentId !== id || slot.deploymentId !== id || start.ticket_slot_id !== slot.slotId || start.repository_permit !== slot.repositoryPermit
    || owner.preLaunchGitSnapshot.head !== start.branch_head_sha || !owner.preLaunchGitSnapshot.branch || owner.preLaunchGitSnapshot.dirty) throw executionFailure("EXECUTION_BINDING_CONFLICT");
  return Object.freeze({ schemaVersion: ORDINARY_NATIVE_EXECUTION_START, deploymentId: id, repoKey: physical.repoKey, repoRoot: physical.repoRoot,
    worktreeRoot: physical.worktreeRoot, ticket: physical.ticket, branch: owner.preLaunchGitSnapshot.branch, baseSha: workflowSha(start.branch_base_sha, 40),
    headSha: workflowSha(start.branch_head_sha, 40), operationId: ordinaryOperationId(id), ticketSlotId: slot.slotId, repositoryPermit: slot.repositoryPermit,
    launchSnapshot: owner.preLaunchGitSnapshot, start, ownerSha256: workflowDigest(owner.ownershipToken), slotSha256: workflowDigest(slot.slotToken) });
}
export class NativeExecutionSession {
  readonly evidence: NativeExecutionEvidence;
  readonly service: ExecutionCustodyService;
  readonly binding: PiExecutionBinding;
  readonly actor: ExecutionHolder;
  readonly contract: ExecutionBinding;
  readonly locks: PreparedLockOwners;
  readonly #authority: PiPreparedNativeAuthority;
  readonly #helper: PiReadonlyHelperDependencies;
  readonly #consumed: Record<string, unknown> | null;
  readonly #ordinary: ReturnType<typeof ordinaryLineage> | null;
  readonly #launch: Record<string, unknown>;
  readonly #physical: HelperContext;
  readonly #physicalIdentity: string;
  readonly #initial: NativeScopeSnapshot;
  readonly #grantId: string | null;
  #commands: ProjectCommandContract | null = null;
  readonly #commandRegistration: string | null;
  readonly #resultLinks = new Map<string, SourceVersion>();
  readonly #started = new Set<string>();
  #administrationRunning = false;
  constructor(authority: PiPreparedNativeAuthority, helper: PiReadonlyHelperDependencies, consumed: Record<string, unknown> | null, physical: HelperContext, ordinary: RegistryEvent | null = null) {
    this.#authority = authority; this.#helper = helper; this.#consumed = consumed; this.#physical = physical;
    this.#physicalIdentity = this.#capturePhysicalIdentity();
    if (Boolean(consumed) === Boolean(ordinary)) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    this.#ordinary = ordinary ? ordinaryLineage(ordinary, physical) : null;
    this.#launch = consumed ?? this.#ordinary!; const launch = this.#launch;
    this.#grantId = consumed ? workflowSha(consumed.grantId) : null;
    const id = workflowText(launch.deploymentId); const status = queryReadonlyHelperRegistry(id).status;
    if (!status) throw executionFailure("EXECUTION_CALLER_STALE");
    if (consumed && consumed.schemaVersion !== "prepared-builder-consumption/v1") throw executionFailure("EXECUTION_CONTRACT_INVALID");
    if (physical.worktreeRoot !== launch.worktreeRoot || physical.repoRoot !== launch.repoRoot || physical.repoKey !== launch.repoKey
      || physical.ticket !== launch.ticket) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    if (!Number.isSafeInteger(status.effective_timeout_seconds) || status.effective_timeout_seconds! % 60 !== 0
      || (consumed && status.effective_timeout_seconds! < 3600)) throw executionFailure("EXECUTION_CONTRACT_INVALID");
    this.actor = Object.freeze({ deploymentId: id, process: readPiProcessIdentity(id, getDeployPaths(id).deployDir) });
    const native = consumed ? this.#retained() : null;
    if (consumed && native) {
      const consumer = authority.retainedConsumer(native.grant, parseSourceVersion(consumed.consumer), id);
      if (consumer.worktreeRoot !== physical.worktreeRoot || consumer.receiptId !== consumed.receiptId || consumer.operationId !== consumed.operationId || consumer.headSha !== consumed.headSha
        || native.grant.contract.branch !== consumed.branch || native.grant.contract.approvalBaseSha !== consumed.baseSha) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    }
    try { this.contract = parseExecutionBinding({ schemaVersion: "execution-binding/v1", operationId: workflowSha(launch.operationId), lineageId: id,
      repoKey: physical.repoKey, repoRoot: physical.repoRoot, worktreeRoot: physical.worktreeRoot, ticket: physical.ticket, branch: launch.branch, initialHeadSha: launch.headSha, owner: this.actor,
      bounds: { startedAt: status.started_at, deadlineAt: new Date(Date.parse(status.started_at) + status.effective_timeout_seconds! * 1000).toISOString(), runtimeMinutes: status.effective_timeout_seconds! / 60,
        consecutiveNoProgress: 0, replacementsUsed: 0, reviewCap: 3, reviewsUsed: 0, unresolvedFailureRef: null } }); }
    catch { throw executionFailure("EXECUTION_CONTRACT_INVALID"); }
    let capacity: PreparedTicketCapacityTransaction | null = null;
    let worktree: ExecutionWorktreeTransaction | null = null;
    this.locks = {
      repository: (action) => {
        // Observe securely before entering a mutation owner; its ordinary lock
        // setup must never become an unauthorized metadata-directory repair.
        this.assertCaller({ cwd: process.cwd() });
        return withPreparedTicketCapacity({ canonicalRepoKey: physical.repoKey, canonicalRepoRoot: physical.repoRoot }, (tx) => {
          if (capacity) throw workflowError(); capacity = tx; try { return action(); } finally { capacity = null; }
        });
      },
      worktree: (action) => { if (!capacity || worktree) throw workflowError(); return withExecutionWorktreeAdmission(physical.repoRoot, physical.worktreeRoot, capacity, (tx) => {
        worktree = tx; try { return action(); } finally { worktree = null; }
      }); },
    };
    // No storage creation before full live source authentication. Optional
    // qualification/activation is deliberately not consulted for ordinary work.
    this.assertCaller({ cwd: process.cwd() }); this.#authenticateSourceCustody();
    const store = authority.execution(this.#ordinary !== null || native?.active === true); if (!store) throw executionFailure("EXECUTION_STORAGE_REJECTED");
    this.evidence = new NativeExecutionEvidence(store, authority.evidenceRoot(), this.locks);
    const host: ExecutionHost = {
      locks: this.locks, now: () => new Date().toISOString(),
      authorize: (_binding, actor, command) => {
        this.assertCaller({ cwd: process.cwd() }); if (!equal(actor, this.actor)) throw workflowError();
        if (command !== "status" && !(command === "initialize" && exists) && (typeof command === "string" || !["finish", "settle"].includes(command.action)))
          this.#newWork(typeof command !== "string" && (command.action === "plan" || command.action === "advance") ? command.plan.phaseId : undefined);
        if (typeof command !== "string" && ["finish", "settle"].includes(command.action)) this.#authenticateSourceCustody();
        // Historical journals remain readable, but a fresh/adopted ordinary
        // source action cannot turn missing project registration into legacy
        // host-shell permission. Administration/finish/settlement stay separate.
        if (this.#ordinary && typeof command !== "string" && ["plan", "advance", "select", "begin", "candidate"].includes(command.action)) this.#projectCommands();
        if (typeof command !== "string" && (command.action === "plan" || command.action === "advance")) {
          authorizePiStructuredWork(this.contract.repoKey, this.contract.repoRoot, this.contract.ticket, this.contract.branch, "source.edit-scoped", command.plan, parseStructuredLaunchNote(this.#ordinary?.start.note) ?? undefined);
          if (command.plan.checks.some((name) => !this.#checkText(name)) || new Set(command.plan.checks.map((name) => this.#checkText(name))).size !== command.plan.checks.length)
            throw this.#commands ? executionFailure("EXECUTION_PROJECT_CONTRACT_INVALID") : workflowError();
          if (this.#commands && JSON.stringify(command.plan.checks.map((name) => this.#checkText(name))) !== JSON.stringify(this.#commands.checks.map((check) => check.command))) throw executionFailure("EXECUTION_PROJECT_CONTRACT_INVALID");
          for (const path of command.plan.paths) scopedPath(physical.worktreeRoot, path);
        }
      },
      assertLive: (holder) => {
        if (!equal(holder, this.actor)) throw executionFailure("EXECUTION_BINDING_CONFLICT");
        if (!equal(readProcessFingerprint(holder.process.pid), holder.process)) throw executionFailure("EXECUTION_CALLER_STALE");
      },
      verifyEvidence: (source, purpose, state, command) => this.#verify(source, purpose, state, command),
      assertHandover: (state, command) => {
        this.#soleOwner(); this.#assertKnown(state);
        if (command.action === "select" && (command.executor !== "orchestrator-direct" || !equal(command.holder, this.actor))) throw workflowError();
      },
      projectCustody: (_state, command, stage) => {
        if (!((stage === "before" && command.action === "select") || (stage === "after" && command.action === "settle"))) return;
        const owner = observeReadonlyRepositoryAuthority(physical.gitDir).owner;
        if (!worktree || !owner) throw workflowError();
        worktree.setDirectCustody({ deploymentId: this.actor.deploymentId, ownershipToken: owner.ownershipToken,
          custody: command.action === "settle" ? "idle" : "active" });
      },
    };
    this.service = new ExecutionCustodyService(store, this.contract, host);
    const descriptorId = workflowDigest(JSON.stringify(["native-execution-descriptor/v1", this.service.executionId]));
    const descriptorName = `${descriptorId}.intent.json`;
    const exists = store.records().includes(descriptorName);
    const originField = this.#ordinary ? "launchSha256" : "consumptionSha256";
    const descriptorVersion = this.#ordinary ? "native-ordinary-execution-descriptor/v1" : "native-execution-descriptor/v1";
    if (exists) {
      const rawDescriptor = store.read(descriptorName);
      const hasRegistration = rawDescriptor !== null && typeof rawDescriptor === "object" && Object.hasOwn(rawDescriptor, "projectCommandsRegistrationSha256");
      const descriptor = workflowObject(rawDescriptor, ["schemaVersion", "binding", originField, "initial", ...(hasRegistration ? ["projectCommandsRegistrationSha256"] : [])]);
      this.#commandRegistration = hasRegistration ? workflowSha(descriptor.projectCommandsRegistrationSha256) : null;
      if (descriptor.schemaVersion !== descriptorVersion || !equal(descriptor.binding, this.contract) || descriptor[originField] !== workflowDigest(JSON.stringify(launch))) throw workflowError();
      this.#initial = descriptor.initial as NativeScopeSnapshot;
    } else {
      this.#commandRegistration = this.#currentCommandRegistration();
      this.#initial = captureNativeScope(physical.worktreeRoot);
      if ((!this.#ordinary && !native?.active) || this.#initial.git.head !== launch.headSha || names(this.#initial.git).length) throw workflowError();
    }
    const state = this.service.initialize(this.actor);
    if (!exists) {
      if (state.sequence !== 0) throw workflowError();
      withPreparedWorkflowLocks(this.locks, (scope) => store.publish(scope, descriptorName, { schemaVersion: descriptorVersion, binding: this.contract, [originField]: workflowDigest(JSON.stringify(launch)), initial: this.#initial, ...(this.#commandRegistration ? { projectCommandsRegistrationSha256: this.#commandRegistration } : {}) }));
    }
    this.binding = {
      bindingIdentity: workflowDigest(JSON.stringify([this.contract, launch])), service: this.service, actor: this.actor,
      authorizeAdministration: (call, context) => this.administration(call, context) !== null,
      assertToolCall: (call, _context, current) => this.#assertCall(call, current),
      resolveCheck: (call, current) => current.plan?.checks.find((name) => this.#checkText(name) === call.input.command) ?? null,
      prepareOperation: (call, _context, current, operationId) => this.prepare(call, current, operationId),
      observe: (kind, rationale) => this.observe(kind, rationale),
      report: () => this.localReport(),
      resolveToolResult: (event, current) => this.result(event, current),
      resolveHolder: (source) => { const row = this.evidence.read(source, "holder") as { actor: ExecutionHolder }; if (!equal(row.actor, this.actor)) throw workflowError(); return this.actor; },
      resolveInventory: (source) => this.inventory(source),
      resolveRecovery: (source) => {
        const row = workflowObject(this.evidence.read(source, "recovery"), ["executionId", "recovery"]);
        if (row.executionId !== this.service.executionId) throw workflowError(); return row.recovery as ExecutionRecovery;
      },
      resolveCandidate: (source) => { const row = this.evidence.read(source, "tool-result") as NativeToolResult; return workflowSha(row.after.git.head, 40); },
      assertFeatureUpdate: () => { throw executionFailure("EXECUTION_CAPABILITY_UNSUPPORTED"); }, runGit: () => { throw executionFailure("EXECUTION_CAPABILITY_UNSUPPORTED"); },
      recordFeatureUpdateIntent: () => { throw executionFailure("EXECUTION_CAPABILITY_UNSUPPORTED"); }, recordFeatureUpdate: () => { throw executionFailure("EXECUTION_CAPABILITY_UNSUPPORTED"); },
    };
  }
  #currentCommandRegistration(): string | null {
    try {
      const repo = loadRepoEntry(this.contract.repoKey);
      if (!repo || repo.path !== this.contract.repoRoot) throw workflowError();
      return repo.projectCommands === undefined ? null : workflowDigest(JSON.stringify(repo.projectCommands));
    } catch { return workflowDigest("invalid-current-project-command-registration"); }
  }
  #projectCommands(): ProjectCommandContract | null {
    // Source prerequisites never gate authenticated startup/reporting. Retain
    // the admitted registration identity across reload, but resolve/validate the
    // actual manifest, scripts and containment only at source/check boundaries.
    if (this.#currentCommandRegistration() !== this.#commandRegistration) throw executionFailure("EXECUTION_PROJECT_CONTRACT_INVALID");
    if (this.#commandRegistration === null) {
      if (this.#ordinary) throw executionFailure("EXECUTION_PROJECT_CONTRACT_REQUIRED");
      return null; // separately admitted optional/prepared compatibility only
    }
    this.#commands ??= ProjectCommandContract.resolve(this.contract.repoKey, this.contract.repoRoot, this.contract.worktreeRoot);
    if (!this.#commands) throw executionFailure("EXECUTION_PROJECT_CONTRACT_INVALID");
    return this.#commands;
  }
  #checkText(name: string): string | undefined { const commands = this.#projectCommands(); return commands ? commands.check(name)?.command : checkText(name); }
  #retained() { if (!this.#grantId) throw executionFailure("EXECUTION_BINDING_CONFLICT"); return this.#authority.retained({ repoKey: this.#physical.repoKey, repoRoot: this.#physical.repoRoot, ticket: this.#physical.ticket! }, this.#grantId); }
  #capturePhysicalIdentity(): string {
    try {
      const p = this.#physical;
      const roots = [...new Set([p.repoRoot, p.worktreeRoot, p.gitDir, p.gitCommonDir])].map((path) => {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw workflowError();
        return { path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
      });
      const pointer = join(p.worktreeRoot, ".git"), stat = lstatSync(pointer);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw workflowError();
      const bytes = readReviewEvidenceFile(pointer, 16_384, "native physical Git pointer");
      return workflowDigest(JSON.stringify([roots, { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, sha256: workflowDigest(bytes) }]));
    } catch { throw executionFailure("EXECUTION_BINDING_UNCERTAIN"); }
  }
  /** Audit/finish authority deliberately does not require unchanged HEAD. Physical
   * roots/Git-pointer identity remains pinned even for reporting, before any Git
   * observation. Source work independently takes the strict helper reread below. */
  assertCaller(context: unknown): void {
    const p = this.#physical; const id = String(this.#launch.deploymentId); const env = process.env;
    if (this.#capturePhysicalIdentity() !== this.#physicalIdentity) throw executionFailure("EXECUTION_BINDING_UNCERTAIN");
    const status = queryReadonlyHelperRegistry(id).status;
    if ((context as { cwd?: string } | null)?.cwd !== p.worktreeRoot || process.cwd() !== p.worktreeRoot || env.PA_DEPLOYMENT_ID !== id || env.PA_DEPLOYMENT_DIR !== getDeployPaths(id).deployDir
      || env.PA_TEAM !== "builder" || env.PA_MODE !== "orchestrator" || env.PA_TICKET_ID !== p.ticket || env.PA_REPO !== p.worktreeRoot || env.PA_WORKTREE_ROOT !== p.worktreeRoot) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    if (!status || status.status !== "running") throw executionFailure("EXECUTION_CALLER_STALE");
    if (status.runtime !== "pi" || status.binary !== "ppa" || status.team !== "builder" || status.mode !== "orchestrator"
      || status.builder_authority !== "orchestrator" || status.parent_deployment_id || status.repo_root !== p.repoRoot || status.worktree_root !== p.worktreeRoot || status.ticket_id !== p.ticket) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    if (this.#ordinary) {
      if (!equal(ordinaryStart(id), this.#ordinary.start) || nativeStartDigest(id, true) || marker(getDeployPaths(id).deployDir, true)) throw executionFailure("EXECUTION_BINDING_UNCERTAIN");
      if (!equal(ordinaryLineage(this.#ordinary.start, p), this.#ordinary) || status.branch_base_sha !== this.#ordinary.baseSha
        || status.treehouse_lease_id !== this.#ordinary.start.treehouse_lease_id || status.treehouse_lease_holder !== this.#ordinary.start.treehouse_lease_holder) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    } else if (nativeStartDigest(id, true) !== workflowDigest(JSON.stringify(this.#consumed)) || !equal(marker(getDeployPaths(id).deployDir, true), this.#consumed)) throw executionFailure("EXECUTION_BINDING_UNCERTAIN");
    const anchor = readPiProcessIdentity(id, getDeployPaths(id).deployDir);
    // During initial construction actor isn't assigned until this check's first
    // caller; all service calls run after the immutable anchor is captured.
    if (this.actor && !equal(anchor, this.actor.process)) throw executionFailure("EXECUTION_CALLER_STALE");
    if (status.pid !== anchor.pid || !equal(readProcessFingerprint(anchor.pid), anchor) || !processIsWithinFingerprintLineage(process.pid, anchor)) throw executionFailure("EXECUTION_CALLER_STALE");
    const slot = observeReadonlyRepositoryTicketSlot(p.repoRoot, p.ticket!).slot;
    const authority = observeReadonlyRepositoryAuthority(p.gitDir); const owner = authority.owner;
    const consumer = this.#consumed ? this.#authority.retainedConsumer(this.#retained().grant, parseSourceVersion(this.#consumed.consumer), id) : null;
    if (!owner || owner.deploymentId !== id || owner.canonicalRepoRoot !== p.repoRoot || owner.worktreeRoot !== p.worktreeRoot || owner.repositoryGitDir !== p.gitDir || owner.repositoryGitCommonDir !== p.gitCommonDir
      || owner.ticket !== p.ticket || owner.runtime !== "pi" || owner.team !== "builder" || owner.mode !== "orchestrator"
      || slot.deploymentId !== id || (consumer && slot.slotToken !== consumer.slotToken) || slot.slotId !== this.#launch.ticketSlotId || slot.repositoryPermit !== this.#launch.repositoryPermit
      || !equal(slot.processFingerprint, owner.processFingerprint)) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    if (!equal(readProcessFingerprint(owner.processFingerprint.pid), owner.processFingerprint)
      || !processIsWithinFingerprintLineage(anchor.pid, owner.processFingerprint)) throw executionFailure("EXECUTION_CALLER_STALE");
  }
  /** Startup/reporting is not source work and needs no model phase plan. The
   * same live caller/sole holder is still required; never cross an active tool
   * barrier or let reporting manufacture a check, recovery or terminal release. */
  #administrativeIdentity(): ExecutionAdministrationIdentity {
    return { deploymentId: this.actor.deploymentId, ticket: this.contract.ticket, worktreeRoot: this.contract.worktreeRoot,
      aiUsageRoot: dirname(dirname(getDeployPaths(this.actor.deploymentId).deployDir)), sourceRoots: [this.contract.repoRoot, this.contract.worktreeRoot] };
  }
  administration(call: PiToolCall, context: unknown): ExecutionAdministration | null {
    if (!this.#ordinary) return null;
    const request = executionAdministration(call, this.#administrativeIdentity());
    if (!request) return null;
    this.assertCaller(context); this.#soleOwner();
    if (this.#administrationRunning || this.service.status(this.actor).operation !== null) throw workflowError();
    if (request.kind === "core" && request.argv[0] === "registry" && process.env.PA_PI_EXECUTION_MODE !== "foreground") throw executionFailure("EXECUTION_CAPABILITY_UNSUPPORTED");
    return request;
  }
  async executeAdministration<T>(id: string, call: PiToolCall, context: unknown, action: () => Promise<T>): Promise<T> {
    const request = this.administration(call, context); if (!request) throw workflowError();
    const before = captureNativeScope(this.contract.worktreeRoot);
    const intent = this.evidence.publish("administrative-intent", { executionId: this.service.executionId, toolCallId: id, request, inputSha256: workflowDigest(JSON.stringify(call.input)) });
    this.#administrationRunning = true;
    try {
      const result = await action(); this.assertCaller(context);
      if (!equal(before, captureNativeScope(this.contract.worktreeRoot))) throw workflowError();
      // Independent audit evidence, never a phase-check pass or operation finish.
      this.evidence.publish("administrative-result", { intent, result });
      return result;
    } catch (error) {
      this.evidence.publish("administrative-error", { intent });
      throw error;
    } finally { this.#administrationRunning = false; }
  }
  async runAdministration(id: string, input: Record<string, unknown>, context: unknown, toolName: "bash" | "write" = "bash"): Promise<{ text: string; exitCode: number }> {
    const call = { toolName, input };
    const request = this.administration(call, context);
    if (!request || request.kind === "ticket-comment") throw workflowError();
    const identity = this.#administrativeIdentity();
    return this.executeAdministration(id, call, context, () => runExecutionAdministration(request, identity));
  }
  #newWork(phaseId?: string): void {
    if (this.#consumed && !this.#retained().active) throw workflowError();
    this.#authenticateSourceCustody();
    const authority = parseStructuredLaunchNote(this.#ordinary?.start.note);
    const state = authorizePiStructuredWork(this.contract.repoKey, this.contract.repoRoot, this.contract.ticket, this.contract.branch, "source.edit-scoped", undefined, authority ?? undefined);
    if (state && authority) {
      const native = this.evidence.store.records().includes(`${this.service.executionId}.intent.json`) ? readExecutionState(this.evidence.store, this.contract) : null;
      requirePiSourceIntent(state, authority, phaseId ?? native?.plan?.phaseId);
    }
  }
  #authenticateSourceCustody(): void {
    const authentication = createPiReadonlyHelperCapability(this.#helper).authenticate(this.#physical.worktreeRoot); authentication.reread();
    if (!equal(authentication.context, this.#physical)) throw executionFailure("EXECUTION_BINDING_CONFLICT");
    this.#soleOwner();
  }
  #soleOwner(): void { const custody = observeReadonlyRepositoryAuthority(this.#physical.gitDir); if (!custody.owner || custody.borrower || custody.implement || custody.review) throw executionFailure("EXECUTION_HOLDER_CONFLICT"); }
  #known(state: ExecutionState): NativeScopeSnapshot {
    for (let sequence = state.sequence; sequence > 0; sequence -= 1) {
      const event = this.evidence.store.read(`${this.service.executionId}.transaction-${sequence}.json`) as { command: ExecutionCommand };
      if (event.command.action === "finish") return (this.evidence.read(event.command.evidence, "tool-result") as NativeToolResult).after;
    }
    return this.#initial;
  }
  #assertKnown(state: ExecutionState): NativeScopeSnapshot {
    const current = captureNativeScope(this.#physical.worktreeRoot);
    if (!equal(current, this.#known(state)) || current.git.branch !== this.contract.branch || current.git.head !== state.candidateSha) throw workflowError();
    return current;
  }
  /** Ordinary Git index/status operations are conservatively invalidating in
   * the shared journal. For the pre-commit gate, replay native exact results and
   * file bytes: index-only staging cannot erase proof or manufacture a pass. */
  #ordinaryPassedChecks(state: ExecutionState): readonly string[] {
    let passed: string[] = [];
    if (!state.plan) return passed;
    const identities = new Map<string, string>();
    for (let sequence = 1; sequence <= state.sequence; sequence += 1) {
      const event = this.evidence.store.read(`${this.service.executionId}.transaction-${sequence}.json`) as { command: ExecutionCommand };
      const command = event.command;
      if (["plan", "advance", "candidate", "attempt"].includes(command.action)) passed = [];
      if (command.action !== "finish") continue;
      const result = this.evidence.read(command.evidence, "tool-result") as NativeToolResult;
      const intent = this.evidence.read(result.intent, "tool-intent") as NativeIntent;
      if (!result.scopeValid || result.exitCode !== 0 || intent.toolName !== "bash" || !equal(intent.before.files, result.after.files) || intent.before.git.head !== result.after.git.head) { passed = []; continue; }
      const next = state.plan.checks[passed.length];
      if (next && this.#checkText(next) === intent.command && result.process?.groupSettled === true) {
        const check = this.#commands?.check(next);
        if (this.#ordinary && check) {
          if (!identities.has(next)) identities.set(next, this.#commands!.inputIdentity(check));
          if (intent.checkedInputsSha256 !== identities.get(next)) { passed = []; continue; }
        }
        passed.push(next);
      }
    }
    return passed;
  }
  #assertCall(call: PiToolCall, state: ExecutionState): void {
    this.#newWork(); if (this.#ordinary) this.#projectCommands();
    if (this.#administrationRunning || !state.plan || !interceptToolCall(call).allowed) throw workflowError(); this.#assertKnown(state);
    const name = call.toolName ?? call.name;
    if (name === "write" || name === "edit") { const path = workflowText(call.input.path); const rel = isAbsolute(path) ? relative(this.#physical.worktreeRoot, path) : path;
      if (!state.plan.paths.includes(rel)) throw workflowError(); scopedPath(this.#physical.worktreeRoot, rel); return; }
    if (name !== "bash") throw workflowError();
    const command = parseExecutionCommandText(call.input.command);
    if (call.input.timeout !== undefined && (typeof call.input.timeout !== "number" || !Number.isFinite(call.input.timeout) || call.input.timeout <= 0 || call.input.timeout > 14_400)) throw workflowError();
    const check = state.plan.checks.find((name) => this.#checkText(name) === command);
    if (Object.keys(call.input).some((key) => !["command", "timeout"].includes(key))) throw this.#commands ? executionFailure("EXECUTION_PROJECT_CONTRACT_INVALID") : workflowError();
    if (check) {
      authorizePiStructuredWork(this.contract.repoKey, this.contract.repoRoot, this.contract.ticket, this.contract.branch, "check.execute-scoped", state.plan, parseStructuredLaunchNote(this.#ordinary?.start.note) ?? undefined);
      this.#commands?.assertCurrent();
      if (this.#ordinary && state.plan.checks[this.#ordinaryPassedChecks(state).length] !== check) throw workflowError();
      return;
    }
    // Only ordinary scoped Git here. Rebase/delegation/privileged update require
    // their own evidence producers; arbitrary shell is not a fallback grant.
    if (/[\n\r$`;&|<>\\]/.test(command)) throw workflowError();
    if (["git status", "git status --short", "git diff --check", "git log -n 5 --oneline", "git rev-parse HEAD"].includes(command)) return;
    if (/^git commit -m (?:"[^"\n]+"|'[^'\n]+')$/.test(command)) {
      authorizePiStructuredWork(this.contract.repoKey, this.contract.repoRoot, this.contract.ticket, this.contract.branch, "git.commit-local", state.plan, parseStructuredLaunchNote(this.#ordinary?.start.note) ?? undefined);
      if (this.#ordinary) {
        this.#commands!.assertCurrent();
        if (state.originalFailure || this.#ordinaryPassedChecks(state).length !== state.plan.checks.length) throw workflowError();
        assertSupportedLocalGitEffects(this.#physical.worktreeRoot, git, { action: "commit", paths: state.plan.paths });
        assertLocalGitIndexMatchesWorking(this.#physical.worktreeRoot, git, state.plan.paths);
      }
      return;
    }
    if (command.startsWith("git add -- ")) { const paths = command.slice(11).split(" "); if (!paths.length || paths.some((path) => !state.plan!.paths.includes(path))) throw workflowError(); for (const path of paths) scopedPath(this.#physical.worktreeRoot, path);
      if (this.#ordinary) assertSupportedLocalGitEffects(this.#physical.worktreeRoot, git, { action: "stage", paths });
      return; }
    throw this.#commands ? executionFailure("EXECUTION_PROJECT_CONTRACT_INVALID") : workflowError();
  }
  prepare(call: PiToolCall, state: ExecutionState, operationId: string): SourceVersion {
    this.#assertCall(call, state);
    const name = workflowText(call.toolName ?? call.name);
    const command = name === "bash" ? parseExecutionCommandText(call.input.command) : "";
    const check = this.#commands?.checks.find((check) => check.command === command);
    return this.evidence.publish("tool-intent", { executionId: this.service.executionId, actor: this.actor, operationId, toolName: name, inputSha256: workflowDigest(JSON.stringify(call.input)),
      command: name === "bash" ? parseExecutionCommandText(call.input.command) : `${name} ${isAbsolute(String(call.input.path)) ? relative(this.#physical.worktreeRoot, String(call.input.path)) : String(call.input.path)}`, before: this.#assertKnown(state),
      ...(check ? { checkedInputsSha256: this.#commands!.inputIdentity(check) } : {}),
      ...(this.#ordinary && command.startsWith("git commit -m ") ? { commitIndexSha256: localGitIndexFingerprint(this.#physical.worktreeRoot, git) } : {}),
    } satisfies NativeIntent);
  }
  #intent(operationId: string, input: unknown): { source: SourceVersion; intent: NativeIntent; state: ExecutionState } {
    const state = this.service.status(this.actor); const source = state.operation?.intent;
    if (state.operation?.id !== operationId || !source) throw workflowError();
    const intent = this.evidence.read(source, "tool-intent") as NativeIntent;
    if (intent.operationId !== operationId || intent.inputSha256 !== workflowDigest(JSON.stringify(input)) || !equal(intent.actor, this.actor) || intent.executionId !== this.service.executionId) throw workflowError();
    return { source, intent, state };
  }
  /** Invoked by the actual built-in wrapper, never by tool JSON. */
  async execute<T>(operationId: string, input: unknown, action: (session: NativeExecutionSession) => Promise<T>): Promise<T> {
    const start = this.#intent(operationId, input);
    if (this.#started.has(operationId)) throw workflowError(); this.#newWork(); this.#assertKnown(start.state); this.#started.add(operationId);
    let result: T | undefined; let error: unknown; this.#activeProcess = null; this.#unprovenProcess = null;
    try { result = await action(this); } catch (caught) { error = caught; }
    const after = captureNativeScope(this.#physical.worktreeRoot);
    const plan = start.state.plan!;
    let settlementError: string | null = null;
    let scopeValid = after.git.branch === this.contract.branch && names(after.git).every((path) => plan.paths.includes(path));
    if (after.git.head !== start.intent.before.git.head) {
      try {
        if (this.#ordinary && start.intent.command.startsWith("git commit -m ")
          && (!start.intent.commitIndexSha256 || localGitTreeFingerprint(this.#physical.worktreeRoot, git, after.git.head) !== start.intent.commitIndexSha256)) throw executionFailure("EXECUTION_CHECKED_CONTENT_UNPROVEN");
        const commits = git(["rev-list", `${start.intent.before.git.head}..${after.git.head}`], this.#physical.worktreeRoot).toString("utf8").trim().split("\n");
        if (!commits.length || commits.length > 256 || commits.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) throw workflowError();
        for (const sha of commits) {
          const changed = git(["diff-tree", "--root", "-m", "--name-only", "--no-renames", "--no-commit-id", "-r", "-z", sha], this.#physical.worktreeRoot).toString("utf8").split("\0").filter(Boolean);
          scopeValid &&= changed.every((path) => plan.paths.includes(path));
        }
        if (!scopeValid) throw workflowError();
        const owner = observeReadonlyRepositoryAuthority(this.#physical.gitDir).owner; if (!owner) throw workflowError();
        withPreparedTicketCapacity({ canonicalRepoKey: this.contract.repoKey, canonicalRepoRoot: this.contract.repoRoot }, (tx) => withExecutionWorktreeAdmission(this.contract.repoRoot, this.contract.worktreeRoot, tx, (worktree) => {
          worktree.advanceDirectSnapshot({ deploymentId: this.actor.deploymentId, ownershipToken: owner.ownershipToken, expected: owner.authorityGitSnapshot ?? owner.preLaunchGitSnapshot, next: after.git });
        }));
      } catch (caught) { scopeValid = false; settlementError = caught instanceof Error ? caught.message : String(caught); }
    }
    const process = this.#activeProcess as NativeProcessResult | null;
    const exitCode = process ? (process.exitCode === 0 && !process.timedOut && !process.aborted && !process.outputLimitExceeded && !error ? 0 : process.exitCode || -1) : error ? -1 : 0;
    let sdkError: NativeBlob | null = null;
    if (error) {
      const sink = this.evidence.sink(workflowDigest(JSON.stringify([start.source, "native-sdk-error/v1"])), "stderr");
      const complete = sink.write(Buffer.from(error instanceof Error ? error.message : String(error))); sdkError = sink.close();
      if (!complete) { scopeValid = false; settlementError = "Native SDK error exceeded its private evidence limit; preserve the started barrier."; }
    }
    const proof = this.evidence.publish("tool-result", { intent: start.source, after, process, exitCode, scopeValid, settlementError, sdkError, unprovenProcess: this.#unprovenProcess,
      error: error ? "Native SDK call failed; original error bytes retained separately." : null } satisfies NativeToolResult);
    const link = workflowDigest(JSON.stringify(["native-result-link/v1", this.service.executionId, operationId]));
    withPreparedWorkflowLocks(this.locks, (scope) => this.evidence.store.publish(scope, `${link}.intent.json`, { schemaVersion: "native-result-link/v1", intent: start.source, result: proof }));
    this.#resultLinks.set(operationId, proof);
    if (error) throw process && process.groupSettled && process.exitCode !== null && process.exitCode !== 0 && !process.timedOut && !process.aborted && !process.outputLimitExceeded && start.state.operation?.check
      ? executionFailure("EXECUTION_PRODUCT_CHECK_FAILED") : executionWorkflowError(error);
    return result as T;
  }
  #activeProcess: NativeProcessResult | null = null;
  #unprovenProcess: SourceVersion | null = null;
  async runBash(operationId: string, input: unknown, command: string, cwd: string, timeout: number, signal?: AbortSignal): Promise<NativeProcessResult> {
    const start = this.#intent(operationId, input);
    if (!this.#started.has(operationId) || start.intent.toolName !== "bash" || start.intent.command !== command || cwd !== this.#physical.worktreeRoot) throw workflowError();
    const remaining = (Date.parse(start.state.bounds.deadlineAt) - Date.now()) / 1000;
    try {
      const check = this.#commands?.checks.find((check) => check.command === command);
      let program = check ? this.#commands!.program(check) : undefined;
      if (check && start.intent.checkedInputsSha256 !== this.#commands!.inputIdentity(check)) throw executionFailure("EXECUTION_CHECKED_CONTENT_UNPROVEN");
      if (this.#ordinary && !check && command.startsWith("git ")) {
        if (command.startsWith("git status ") || command.startsWith("git diff ")) assertSupportedGitMetadataRead(cwd, git);
        const action = command.startsWith("git commit -m ") ? "commit" : command.startsWith("git add -- ") ? "stage" : null;
        if (action) assertSupportedLocalGitEffects(cwd, git, { action, paths: start.state.plan!.paths });
        if (action === "commit") {
          assertLocalGitIndexMatchesWorking(cwd, git, start.state.plan!.paths);
          if (!start.intent.commitIndexSha256 || localGitIndexFingerprint(cwd, git) !== start.intent.commitIndexSha256) throw executionFailure("EXECUTION_CHECKED_CONTENT_UNPROVEN");
        }
        program = { executable: trustedNativeExecutable("git"), argv: ["--no-pager", ...LOCAL_GIT_CONTROL_FLAGS, ...gitArguments(command)], environment: gitEnvironment() };
      }
      const result = await runNativeExecutionProcess({ evidence: this.evidence, intent: start.source, command, cwd,
        timeoutSeconds: Math.min(timeout, remaining, check?.timeoutSeconds ?? 14_400), signal,
        ...(program ? { program, env: program.environment } : {}), ...(check ? { maximumOutputBytes: check.maximumOutputBytes } : {}) });
      this.#activeProcess = result; return result;
    } catch (error) { if (error instanceof NativeProcessEvidenceError) this.#unprovenProcess = error.evidence; throw executionWorkflowError(error); }
  }
  /** Lower file boundary uses dirfd-relative, no-follow traversal. The SDK still
   * owns edit matching/queueing; these operations cannot write through aliases. */
  file(path: string, content?: string, directoryOnly = false): Buffer | void {
    const state = this.service.status(this.actor); if (!state.operation || !this.#started.has(state.operation.id) || !state.plan || !["write", "edit"].includes(state.operation.kind)) throw workflowError();
    if (directoryOnly && path === this.#physical.worktreeRoot) return;
    if (content !== undefined && Buffer.byteLength(content) > 64 * 1024 * 1024) throw workflowError();
    const rel = relative(this.#physical.worktreeRoot, path); scopedPath(this.#physical.worktreeRoot, rel);
    const allowed = directoryOnly ? state.plan.paths.some((candidate) => candidate.startsWith(`${rel}/`)) : state.plan.paths.includes(rel);
    if (!allowed) throw workflowError();
    let directory = openSync(this.#physical.worktreeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parts = rel.split("/"); const ancestors = directoryOnly ? parts : parts.slice(0, -1);
    try {
      for (const part of ancestors) {
        const anchored = `/proc/self/fd/${directory}/${part}`;
        if (directoryOnly) { try { mkdirSync(anchored); fsyncSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
        const next = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); closeSync(directory); directory = next;
      }
      if (directoryOnly) { fsyncSync(directory); return; }
      const fd = openSync(`/proc/self/fd/${directory}/${parts.at(-1)}`, constants.O_NOFOLLOW | (content === undefined ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT), 0o644);
      try {
        const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw workflowError();
        if (content === undefined) return readFileSync(fd);
        // No truncation until the exact opened inode has passed alias checks.
        writeFileSync(fd, content); ftruncateSync(fd, Buffer.byteLength(content)); fsyncSync(fd); fsyncSync(directory);
      } finally { closeSync(fd); }
    } finally { closeSync(directory); }
  }
  #resultSource(operationId: string): SourceVersion {
    const cached = this.#resultLinks.get(operationId); if (cached) return cached;
    const id = workflowDigest(JSON.stringify(["native-result-link/v1", this.service.executionId, operationId]));
    const row = workflowObject(this.evidence.store.read(`${id}.intent.json`), ["schemaVersion", "intent", "result"]);
    if (row.schemaVersion !== "native-result-link/v1") throw workflowError(); return parseSourceVersion(row.result);
  }
  result(event: PiExecutionEndEvent, state: ExecutionState): { evidence: SourceVersion; failure: ExecutionFailure | null; candidateSha: string } {
    const source = this.#resultSource(event.toolCallId); const row = this.evidence.read(source, "tool-result") as NativeToolResult;
    if (state.operation?.id !== event.toolCallId || !equal(state.operation.intent, row.intent) || row.scopeValid !== true || (row.process && row.process.groupSettled !== true)) throw workflowError();
    const observedExit = row.process ? (row.process.exitCode === 0 && row.process.timedOut === false && row.process.aborted === false && row.process.outputLimitExceeded === false && row.error === null ? 0 : row.process.exitCode || -1) : row.error === null ? 0 : -1;
    if (!Number.isSafeInteger(row.exitCode) || row.exitCode !== observedExit || !equal(row.after, captureNativeScope(this.#physical.worktreeRoot))) throw workflowError();
    if (row.process) { const frame = this.evidence.read(row.process.frame, "process-frame") as { intent: SourceVersion }; if (!equal(frame.intent, row.intent)) throw workflowError(); this.evidence.blob(row.process.stdout); this.evidence.blob(row.process.stderr); }
    const intent = this.evidence.read(row.intent, "tool-intent") as NativeIntent;
    if (event.toolName !== intent.toolName || intent.executionId !== this.service.executionId || !equal(intent.actor, this.actor) || (intent.toolName === "bash" && !row.process)) throw workflowError();
    return { evidence: source, candidateSha: row.after.git.head, failure: row.exitCode === 0 ? null : {
      check: state.operation.check ?? `@operation:${state.operation.kind}`, command: intent.command, exitCode: row.exitCode, candidateSha: state.candidateSha, output: source,
    } };
  }
  /** Native report input, never a model-supplied check list or path classifier.
   * Historical results remain labelled with their original candidate. Unknown
   * scope/in-flight work yields metadata only, not guessed safe diff contents. */
  reportFacts(includeDiff = true): NativeExecutionReportFacts {
    this.assertCaller({ cwd: process.cwd() });
    const state = this.service.status(this.actor);
    const snapshot = captureRepositoryGitSnapshot(this.contract.worktreeRoot, git);
    let scopeProven = false;
    try {
      if (state.plan && state.operation === null && !this.#initial.git.dirty) {
        const current = this.#assertKnown(state);
        scopeProven = names(current.git).every((path) => state.plan!.paths.includes(path));
      }
    } catch { /* retained unknown scope, not an empty inventory */ }
    const checks: PhaseReportCheck[] = []; const operations: SourceVersion[] = []; const kinds = new Map<string, string>();
    for (let sequence = 1; sequence <= state.sequence; sequence += 1) {
      const event = this.evidence.store.read(`${this.service.executionId}.transaction-${sequence}.json`) as { command: ExecutionCommand };
      if (event.command.action === "begin") kinds.set(event.command.operation.id, event.command.operation.kind);
      if (event.command.action !== "finish") continue;
      const result = this.evidence.read(event.command.evidence, "tool-result") as NativeToolResult;
      const intent = this.evidence.read(result.intent, "tool-intent") as NativeIntent;
      if (intent.executionId !== this.service.executionId || !equal(intent.actor, this.actor) || result.scopeValid !== true
        || (intent.toolName === "bash" && (!result.process || result.process.groupSettled !== true))) throw workflowError();
      if (result.process) { this.evidence.blob(result.process.stdout); this.evidence.blob(result.process.stderr); }
      if (result.sdkError) this.evidence.blob(result.sdkError);
      operations.push(event.command.evidence);
      if (kinds.get(event.command.operationId) === "check") checks.push({ command: intent.command, candidateSha: intent.before.git.head, state: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, output: event.command.evidence });
    }
    const omissions: string[] = [];
    let diff = Buffer.alloc(0);
    if (scopeProven && state.plan && includeDiff) {
      const arguments_ = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", this.contract.initialHeadSha, "--", ...state.plan.paths];
      const pieces = [git(arguments_, this.contract.worktreeRoot)];
      for (const entry of snapshot.statusEntries ?? []) {
        if (entry.kind !== "untracked") continue;
        if (!state.plan.paths.includes(entry.path)) throw workflowError();
        scopedPath(this.contract.worktreeRoot, entry.path);
        try { pieces.push(git(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", entry.path], this.contract.worktreeRoot)); }
        catch (error) { const failure = error as { status?: number; stdout?: Buffer }; if (failure.status !== 1 || !Buffer.isBuffer(failure.stdout)) throw error; pieces.push(failure.stdout); }
      }
      diff = Buffer.concat(pieces);
      if (diff.length > 1_048_576) throw workflowError(); // no silent truncation of the full companion
      if (diff.includes(Buffer.from("Binary files "))) omissions.push("Binary patch bytes are omitted; Git binary-change metadata and the private content inventory are retained.");
    } else omissions.push(includeDiff ? "Full diff omitted: current source scope or operation settlement is unproven. Preserve all work for its owner."
      : "Full diff not requested for this bounded local Markdown report; native result references and Git history retain source evidence.");
    let pendingResult: SourceVersion | null = null;
    if (state.operation) { try { pendingResult = this.#resultSource(state.operation.id); } catch { omissions.push("The started operation has no durable native result; no terminal cause or process death is inferred."); } }
    if (!equal(snapshot, captureRepositoryGitSnapshot(this.contract.worktreeRoot, git))) throw workflowError();
    this.assertCaller({ cwd: process.cwd() });
    return Object.freeze({ state, snapshot, checks: Object.freeze(checks), operations: Object.freeze(operations), scopeProven, diff, omissions: Object.freeze(omissions), pendingResult });
  }
  localReport(): Readonly<Record<string, unknown>> {
    let facts: NativeExecutionReportFacts;
    try { facts = this.reportFacts(false); }
    catch (error) {
      // Reauthenticate independently: an unavailable Git/check view must not
      // suppress own factual reporting or become an empty/clean inventory.
      this.assertCaller({ cwd: process.cwd() });
      const state = this.service.status(this.actor), staged = readPiForegroundCompletion(getDeployPaths(this.actor.deploymentId).deployDir);
      const markdown = this.publicText(`# Local phase ${state.plan?.phaseId ?? "unplanned"}\nWork: blocked/unproven; current Git scope, checks and commit are unknown, not unchanged.\nProcess: live. Completion: ${staged?.status ?? "not staged"}. Terminal settlement: pending normal process exit.\nNo-progress: ${state.bounds.consecutiveNoProgress}/3. Deadline: ${state.bounds.deadlineAt}.\nCurrent source/check view omitted: ${executionWorkflowError(error).message}\nHistorical native evidence remains retained; no result or passing candidate is inferred. Preserve work and reconcile through its owner. Independent review, CI and UAT remain separate.`);
      const source = this.evidence.publish("local-report", { executionId: this.service.executionId, phaseId: state.plan?.phaseId ?? null,
        candidateSha: null, checks: null, operations: null, scopeProven: false, markdown,
        processState: "live", completionState: staged?.status ?? "not-staged", terminalSettlement: false });
      return Object.freeze({ source, markdown, processState: "live", completionState: staged?.status ?? "not-staged", terminalSettlement: false });
    }
    const staged = readPiForegroundCompletion(getDeployPaths(this.actor.deploymentId).deployDir);
    const failed = facts.checks.filter((check) => check.exitCode !== 0);
    const stopped = facts.state.bounds.consecutiveNoProgress >= 3 || Date.now() >= Date.parse(facts.state.bounds.deadlineAt);
    let committed = false;
    if (this.#ordinary && facts.scopeProven && !facts.snapshot.dirty) {
      for (let sequence = facts.state.sequence; sequence > 0; sequence--) {
        const event = this.evidence.store.read(`${this.service.executionId}.transaction-${sequence}.json`) as { command: ExecutionCommand };
        if (["plan", "advance"].includes(event.command.action)) break;
        if (event.command.action !== "finish") continue;
        const row = this.evidence.read(event.command.evidence, "tool-result") as NativeToolResult;
        const intent = this.evidence.read(row.intent, "tool-intent") as NativeIntent;
        if (!intent.command.startsWith("git commit -m ")) continue;
        committed = row.exitCode === 0 && row.process?.groupSettled === true && row.scopeValid && this.#commitContentProven(intent, row)
          && row.after.git.head !== intent.before.git.head && row.after.git.digestSha256 === facts.snapshot.digestSha256;
        break;
      }
    }
    const readingViews = [...new Set([failed[0], ...failed.slice(-3)].filter((check) => check !== undefined))].map((check) => {
      if (!check.output) return "- Failure output is unknown; do not infer a result.";
      const row = this.evidence.read(check.output, "tool-result") as NativeToolResult;
      const incomplete = row.process && (!row.process.groupSettled || row.process.timedOut || row.process.aborted || row.process.outputLimitExceeded);
      const bytes = incomplete ? Buffer.from("[Incomplete native output and SDK error retained privately; partial secret values must not be exposed.]") : Buffer.concat([...(row.process ? [this.evidence.blob(row.process.stdout), this.evidence.blob(row.process.stderr)] : []),
        ...(row.sdkError ? [this.evidence.blob(row.sdkError)] : [])]);
      // Redact the complete buffer before clipping, including cross-chunk secrets.
      const safe = this.publicText(bytes.toString("utf8"));
      const excerpt = safe.slice(0, 2048).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "?");
      const fence = "`".repeat(Math.max(2, ...[...excerpt.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
      return `### ${check.command}; check result ${check.exitCode}; native process exit ${row.process?.exitCode ?? "unknown"}; timeout ${row.process?.timedOut ?? "unknown"}; aborted ${row.process?.aborted ?? "unknown"}; output-limit ${row.process?.outputLimitExceeded ?? "unknown"}; group-settled ${row.process?.groupSettled ?? "unknown"}\n${fence}text\n${excerpt}\n${fence}${safe.length > 2048 ? "\n[Excerpt clipped; complete channels retained at the check output reference.]" : ""}`;
    });
    const lines = [`# Local phase ${(facts.state.plan?.phaseId ?? "unplanned").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}`, `Agent-planned scope: ${(facts.state.plan?.scope ?? "no source plan").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}`,
      `Current HEAD: ${facts.snapshot.head}`, `Work: ${facts.state.operation ? "in-flight/unknown" : !facts.state.plan ? "blocked/unplanned; no source phase or checks admitted" : !facts.scopeProven ? "blocked by unproven current source scope" : facts.state.originalFailure ? "blocked by unresolved check failure" : committed ? "local phase committed; independent acceptance not claimed" : "local work incomplete; current checks and commit still need proof"}`,
      `Process: live. Completion: ${staged ? `staged ${staged.status}` : "not staged"}. Terminal settlement: pending normal process exit.`,
      `No-progress: ${facts.state.bounds.consecutiveNoProgress}/3. Deadline: ${facts.state.bounds.deadlineAt}.`,
      `Original historical failure: ${failed[0] ? `${failed[0].command}; exit ${failed[0].exitCode}; ${failed[0].output?.ref ?? "output unknown"}` : "none recorded"}.`,
      "", "## Failure reading views (redacted; original channels remain private)", ...readingViews,
      "", "## Actual checks (historical candidate and output retained)",
      ...facts.checks.map((check) => `- ${check.command}: ${check.state}, exit ${check.exitCode ?? "unknown"}, candidate ${check.candidateSha}, output ${check.output?.ref ?? "unknown"}`),
      "", `Repair evidence: ${new Set(facts.state.remedyDigests).size} distinct native content changes; diagnosis evidence: ${new Set(facts.state.diagnosticDigests).size} distinct retained observations.`,
      `First unproven action: ${facts.state.operation ? "settle the exact started native operation" : stopped ? "handoff retained state: native bounds stop further execution; do not reset limits" : !facts.state.plan ? "establish a supported scoped plan and validated project prerequisites" : !facts.scopeProven ? "reconcile the current source scope through its owner without adopting unknown work" : facts.state.originalFailure ? "diagnose/repair and pass every named affected check" : committed ? "next scoped phase within native bounds or separately owned independent acceptance" : "prove every named current-content check and a local commit before phase continuation"}.`,
      "Remaining: independent review, CI, human UAT and live adoption are separate; none is inferred from this report.", ...facts.omissions];
    const markdown = this.publicText(lines.join("\n"));
    const source = this.evidence.publish("local-report", { executionId: this.service.executionId, phaseId: facts.state.plan?.phaseId ?? null,
      candidateSha: facts.snapshot.head, checks: facts.checks, originalFailures: failed, operations: facts.operations, markdown,
      processState: "live", completionState: staged?.status ?? "not-staged", terminalSettlement: false });
    const maximum = 16 * 1024;
    const text = Buffer.byteLength(markdown) <= maximum ? markdown : Buffer.from(markdown).subarray(0, maximum).toString("utf8") + "\n[Reading view truncated; full native report retained at the returned source.]";
    return Object.freeze({ source, markdown: text, processState: "live", completionState: staged?.status ?? "not-staged", terminalSettlement: false });
  }
  publicText(value: string): string {
    const owner = observeReadonlyRepositoryAuthority(this.#physical.gitDir).owner;
    const slot = observeReadonlyRepositoryTicketSlot(this.contract.repoRoot, this.contract.ticket).slot;
    return nativePublicText(value, environmentSecrets(process.env, [owner?.ownershipToken ?? "", slot.slotToken]));
  }
  #commitContentProven(intent: NativeIntent, result: NativeToolResult): boolean {
    try { return Boolean(intent.commitIndexSha256 && localGitTreeFingerprint(this.#physical.worktreeRoot, git, result.after.git.head) === intent.commitIndexSha256); }
    catch { return false; }
  }
  #phaseFacts(state: ExecutionState) {
    if (!this.#ordinary || !state.plan || state.custody.state !== "idle" || state.operation || state.originalFailure || state.recoveryPending) throw executionFailure("EXECUTION_PHASE_PREREQUISITE");
    const snapshot = this.#assertKnown(state);
    if (snapshot.git.dirty || snapshot.git.head === this.contract.initialHeadSha) throw executionFailure("EXECUTION_PHASE_PREREQUISITE");
    for (let sequence = state.sequence; sequence > 0; sequence--) {
      const event = this.evidence.store.read(`${this.service.executionId}.transaction-${sequence}.json`) as { command: ExecutionCommand };
      if (["plan", "advance"].includes(event.command.action)) break;
      if (event.command.action !== "finish") continue;
      const result = this.evidence.read(event.command.evidence, "tool-result") as NativeToolResult;
      const intent = this.evidence.read(result.intent, "tool-intent") as NativeIntent;
      if (!intent.command.startsWith("git commit -m ")) continue;
      if (result.exitCode !== 0 || !result.scopeValid || !result.process?.groupSettled || !this.#commitContentProven(intent, result) || result.after.git.head === intent.before.git.head || !equal(result.after, snapshot)
        || this.#ordinaryPassedChecks({ ...state, sequence: sequence - 1 }).length !== state.plan.checks.length) throw executionFailure("EXECUTION_PHASE_PREREQUISITE");
      const authority = parseStructuredLaunchNote(this.#ordinary.start.note);
      const workflow = authority ? retainedPiSourceIntent(authority, state.plan.phaseId) : null;
      const commands = workflow ? this.#projectCommands() : null;
      if (workflow && !commands) throw executionFailure("EXECUTION_PROJECT_CONTRACT_REQUIRED");
      commands?.assertCurrent();
      return { executionId: this.service.executionId, sequence: state.sequence, phaseId: state.plan.phaseId, candidateSha: state.candidateSha,
        commit: event.command.evidence, snapshot: snapshot.git,
        ...(workflow && commands ? { workflow, projectCommands: { registrationSha256: this.#commandRegistration, sha256: commands.sha256,
          checks: state.plan.checks.map(name => { const check = commands.check(name); if (!check) throw workflowError(); return { id: check.id, command: check.command, inputsSha256: commands.inputIdentity(check) }; }) } } : {}) };
    }
    throw executionFailure("EXECUTION_PHASE_PREREQUISITE");
  }
  #recoveryFacts(state: ExecutionState) {
    if (!state.originalFailure || state.custody.state !== "idle") throw workflowError();
    let failure: ExecutionFailure | null = null;
    let diagnostic: unknown = null, remedy: unknown = null;
    for (let sequence = state.sequence; sequence > 0; sequence--) {
      const event = this.evidence.store.read(`${this.service.executionId}.transaction-${sequence}.json`) as { command: ExecutionCommand };
      if (event.command.action === "attempt") break;
      if (event.command.action !== "finish") continue;
      const result = this.evidence.read(event.command.evidence, "tool-result") as NativeToolResult;
      const intent = this.evidence.read(result.intent, "tool-intent") as NativeIntent;
      if (!failure && event.command.failure?.check === state.originalFailure.check) {
        failure = event.command.failure;
        if (failure.candidateSha !== state.candidateSha || failure.command !== state.originalFailure.command) throw workflowError();
        // One initial diagnosis is bound to the immutable original failure, not
        // to volatile retry logs (timestamps alone must never reset no-progress).
        // Further progress requires genuinely new native source-change evidence.
        const original = this.evidence.read(state.originalFailure.output, "tool-result") as NativeToolResult;
        diagnostic = { executionId: this.service.executionId, originalFailure: state.originalFailure.output, command: state.originalFailure.command, exitCode: state.originalFailure.exitCode,
          stdoutSha256: original.process?.stdout.sha256 ?? null, stderrSha256: original.process?.stderr.sha256 ?? original.sdkError?.sha256 ?? null };
      }
      if (equal(event.command.evidence, state.originalFailure.output)) break;
      if (!remedy && result.exitCode === 0 && result.scopeValid && ["write", "edit"].includes(intent.toolName) && !equal(intent.before.files, result.after.files)) {
        remedy = { executionId: this.service.executionId, originalFailure: state.originalFailure.output, before: intent.before.files, after: result.after.files };
      }
    }
    if (!failure) throw workflowError();
    return { failure, diagnostic, remedy };
  }
  observe(kind: string, rationale?: string): SourceVersion {
    const state = this.service.status(this.actor);
    if (kind === "last-result" && state.operation) return this.#resultSource(state.operation.id);
    const snapshot = this.#assertKnown(state); this.#soleOwner();
    if (kind === "phase") return this.evidence.publish("phase", this.#phaseFacts(state));
    if (kind === "recovery") {
      const facts = this.#recoveryFacts(state);
      if (rationale !== undefined && (typeof rationale !== "string" || !rationale.trim() || rationale.length > 4096)) throw workflowError();
      return this.evidence.publish("recovery", { executionId: this.service.executionId, recovery: { originalFailure: state.originalFailure!.output,
        diagnostic: rationale && facts.diagnostic ? this.evidence.publish("recovery-diagnostic", facts.diagnostic) : null,
        remedy: rationale && facts.remedy ? this.evidence.publish("recovery-remedy", facts.remedy) : null,
        rationale: rationale ?? null, recheck: facts.failure } satisfies ExecutionRecovery });
    }
    if (kind === "holder") return this.evidence.publish("holder", { actor: this.actor, snapshot });
    if (kind === "inventory") return this.evidence.publish("inventory", { actor: this.actor, snapshot, paths: names(snapshot.git).map((path) => { if (!state.plan?.paths.includes(path)) throw workflowError(); return { path, classification: "ticket-produced" }; }) });
    if (kind === "last-result") {
      for (let sequence = state.sequence; sequence > 0; sequence -= 1) { const event = this.evidence.store.read(`${this.service.executionId}.transaction-${sequence}.json`) as { command: ExecutionCommand }; if (event.command.action === "finish") return event.command.evidence; }
    }
    throw workflowError();
  }
  inventory(source: SourceVersion): ExecutionRecoveryInventory {
    const row = this.evidence.read(source, "inventory") as { actor: ExecutionHolder; snapshot: NativeScopeSnapshot; paths: ExecutionRecoveryInventory["paths"] };
    if (!equal(row.actor, this.actor)) throw workflowError();
    return { branch: row.snapshot.git.branch!, headSha: row.snapshot.git.head, porcelainV2Base64: row.snapshot.git.statusPorcelainV2Base64!, snapshotSha256: row.snapshot.git.digestSha256!, paths: row.paths, evidence: source };
  }
  #verify(source: SourceVersion, purpose: string, state: ExecutionState, command: ExecutionCommand): void {
    if (purpose === "begin") { const row = this.evidence.read(source, "tool-intent") as NativeIntent;
      if (command.action !== "begin" || row.operationId !== command.operation.id || row.executionId !== this.service.executionId || !equal(row.actor, this.actor) || !equal(row.before, this.#assertKnown(state))) throw workflowError(); return; }
    if (purpose === "finish") {
      if (command.action !== "finish" || !state.operation) throw workflowError();
      const intent = this.evidence.read(state.operation.intent!, "tool-intent") as NativeIntent;
      const actual = this.result({ toolCallId: command.operationId, toolName: intent.toolName, isError: command.failure !== null, result: null }, state);
      if (!equal(actual.evidence, source) || !equal(actual.failure, command.failure) || actual.candidateSha !== command.candidateSha) throw workflowError(); return;
    }
    if (purpose === "select") { const row = this.evidence.read(source, "holder") as { actor: ExecutionHolder; snapshot: NativeScopeSnapshot }; if (!equal(row.actor, this.actor) || !equal(row.snapshot, this.#assertKnown(state))) throw workflowError(); return; }
    if (purpose === "settle") { const row = this.evidence.read(source, "inventory") as { snapshot: NativeScopeSnapshot }; if (!equal(row.snapshot, this.#assertKnown(state))) throw workflowError(); return; }
    if (purpose === "advance") {
      if (command.action !== "advance" || !equal(source, command.evidence) || !equal(this.evidence.read(source, "phase"), this.#phaseFacts(state))) throw workflowError(); return;
    }
    if (purpose === "attempt") {
      if (command.action !== "attempt" || !state.originalFailure || !equal(command.recovery.originalFailure, state.originalFailure.output)) throw workflowError();
      const facts = this.#recoveryFacts(state), recovery = command.recovery;
      if (!equal(facts.failure, recovery.recheck)) throw workflowError();
      if (recovery.rationale !== null && (!recovery.rationale.trim() || recovery.rationale.length > 4096)) throw workflowError();
      if (recovery.diagnostic && (!recovery.rationale || !equal(this.evidence.read(recovery.diagnostic, "recovery-diagnostic"), facts.diagnostic))) throw workflowError();
      if (recovery.remedy && (!recovery.rationale || !facts.remedy || !equal(this.evidence.read(recovery.remedy, "recovery-remedy"), facts.remedy))) throw workflowError();
      if (![recovery.originalFailure, recovery.recheck.output, recovery.diagnostic, recovery.remedy].some((item) => item && equal(item, source))) throw workflowError(); return;
    }
    if (purpose === "resolve") {
      if (command.action !== "resolve" || !state.originalFailure) throw workflowError();
      const row = this.evidence.read(source, "tool-result") as NativeToolResult;
      const intent = this.evidence.read(row.intent, "tool-intent") as NativeIntent;
      if (row.exitCode !== 0 || row.scopeValid !== true || (intent.toolName === "bash" && (!row.process || row.process.groupSettled !== true))
        || intent.command !== state.originalFailure.command || !equal(row.after, this.#assertKnown(state))) throw workflowError(); return;
    }
    // Independent review/CI/UAT/integration are never inferred from developer
    // checks, model prose or a newly hashed diagnosis/remedy description.
    throw workflowError();
  }
}
