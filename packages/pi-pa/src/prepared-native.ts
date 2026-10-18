import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePreparationContract, parseReviewMatrix, parseReviewEvidenceJson, parseSourceVersion, parseExecutionCustody, preparationIdentity, ProtectedWorkflowStore,
  readNativePreparationRetry, readReviewEvidenceFile, requireTicketLinkedBranch, withPreparedTicketCapacity, withPreparedWorkflowLocks,
  workflowDigest, workflowError, workflowObject, workflowPath, workflowSha, workflowText, workflowTimestamp, loadRepoEntry,
  readProcessFingerprint, TicketStore, type PreparedReceipt, type PreparationContract, type SourceVersion, type Ticket, type ProcessFingerprint,
} from "@pa-platform/pa-core";
import type { PiPreparationCaller } from "./pi-extension/prepared-workflow.js";

export interface PreparedNativeRuntime {
  readonly sourceSha: string;
  readonly packageVersion: string;
  readonly configSha: string;
  readonly storeRoot: string;
}
/** Native qualification producer's protected evidence, not a public report or model flag.
 * The Phase-6 producer is deliberately separate from capture/activation. */
export interface PreparedNativeQualification {
  readonly schemaVersion: "prepared-native-qualification/v1";
  readonly runtime: PreparedNativeRuntime;
  readonly review: SourceVersion;
  readonly ci: SourceVersion;
  readonly pairing: SourceVersion;
  readonly humanUat: SourceVersion;
  readonly delivery: SourceVersion;
}
interface NativePolicy {
  readonly schemaVersion: "prepared-native-policy/v1";
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly runtime: PreparedNativeRuntime;
  readonly qualification: SourceVersion;
  readonly deploymentId: string;
  readonly callerIdentity: string;
  readonly capturedAt: string;
}
export interface NativePreparationGrant {
  readonly schemaVersion: "prepared-native-grant/v1";
  readonly policyId: string;
  readonly grantId: string;
  readonly contract: PreparationContract;
  readonly deploymentId: string;
  readonly callerIdentity: string;
  readonly capturedAt: string;
}
export interface NativePreparedConsumer {
  readonly schemaVersion: "native-prepared-consumer/v1";
  readonly grantId: string;
  readonly operationId: string;
  readonly receiptId: string;
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly ticket: string;
  readonly worktreeRoot: string;
  readonly headSha: string;
  readonly deploymentId: string;
  readonly deploymentDirectory: string;
  readonly process: ProcessFingerprint;
  readonly slotToken: string;
  readonly capturedAt: string;
}
export interface PreparedNativeDependencies {
  /** Test/embedding construction only. None is a CLI/tool/environment option. */
  readonly root?: string;
  readonly aiUsageRoot?: string;
  readonly runtime?: () => PreparedNativeRuntime;
  readonly now?: () => string;
}
function json(bytes: Uint8Array): unknown { return parseReviewEvidenceJson(bytes, "prepared native evidence"); }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function runtime(value: unknown): PreparedNativeRuntime {
  const row = workflowObject(value, ["sourceSha", "packageVersion", "configSha", "storeRoot"]);
  return Object.freeze({ sourceSha: workflowSha(row.sourceSha, 40), packageVersion: workflowText(row.packageVersion), configSha: workflowSha(row.configSha, 40), storeRoot: workflowPath(row.storeRoot) });
}
/** Production ignores PA_* / HOME authority-root overrides. A development checkout
 * cannot masquerade as an installed, revision-bound native activation target. */
export function currentPreparedNativeRuntime(): PreparedNativeRuntime {
  const module = realpathSync(fileURLToPath(import.meta.url));
  const match = /^(\/nix\/store\/[a-z0-9]{32}-[^/]+)\/share\/pa-platform\/packages\/pi-pa\/dist\/prepared-native\.js$/.exec(module);
  if (!match) throw workflowError();
  const storeRoot = match[1]!;
  const provenance = json(readReviewEvidenceFile(join(storeRoot, "share/pa-platform/review-runtime-provenance.json"), 65_536, "prepared runtime provenance")) as Record<string, unknown>;
  const packagePath = join(storeRoot, "share/pa-platform/packages/pi-pa/package.json");
  const packageJson = json(readReviewEvidenceFile(packagePath, 65_536, "prepared runtime package")) as Record<string, unknown>;
  if (provenance.schemaVersion !== "pa-review-runtime/v1" || packageJson.name !== "@pa-platform/pi-pa" || packageJson.version !== provenance.packageVersion) throw workflowError();
  const facts = runtime({ sourceSha: provenance.sourceSha, packageVersion: provenance.packageVersion, configSha: provenance.configSha, storeRoot });
  const configRoot = workflowPath(loadRepoEntry("pa-platform-config")?.path);
  if (realpathSync(configRoot) !== configRoot) throw workflowError();
  const git = (args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", configRoot, ...args], { env: { PATH: process.env.PATH, HOME: userInfo().homedir, LANG: "C.UTF-8", TZ: "UTC" }, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["rev-parse", "--show-toplevel"]) !== configRoot || git(["rev-parse", "HEAD"]) !== facts.configSha || git(["status", "--porcelain=v2", "--untracked-files=all"]) !== "") throw workflowError();
  git(["merge-base", "--is-ancestor", facts.configSha, "origin/develop"]);
  return facts;
}
function header(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = [...source.matchAll(new RegExp(`^> ${escaped}: ([^\\r\\n]+)\\r?$`, "gm"))];
  if (rows.length !== 1) throw workflowError(); return workflowText(rows[0]![1]);
}
function sourcePath(root: string, reference: string, prefix?: "requirements" | "uat"): string {
  const text = workflowText(reference);
  const path = prefix ? text.startsWith(`${prefix}:`) ? text.slice(prefix.length + 1) : "" : text;
  if (!path.startsWith("agent-teams/requirements/artifacts/") || /[\\%?#\u0000]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) throw workflowError();
  const result = resolve(root, path); if (!result.startsWith(`${root}/agent-teams/requirements/artifacts/`)) throw workflowError(); return result;
}
function readSource(path: string): Buffer { return Buffer.from(readReviewEvidenceFile(path, 1_048_576, "prepared promoted source")); }
function source(ref: string, version: string, bytes: Buffer): SourceVersion { return parseSourceVersion({ ref, version, sha256: workflowDigest(bytes) }); }
function matrixRegion(markdown: string): Buffer {
  const starts = [...markdown.matchAll(/^### Full Validation Matrix[ \t]*\r?$/gm)];
  if (starts.length !== 1) throw workflowError();
  const start = starts[0]!.index!;
  const after = start + starts[0]![0].length;
  const end = /^#{1,3} /m.exec(markdown.slice(after));
  return Buffer.from(markdown.slice(start, end ? after + end.index : undefined));
}
function protectedRoot(root: string, create: boolean): ProtectedWorkflowStore | null {
  try { lstatSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw workflowError();
    if (!create) return null;
    // Check ancestors before creating anything; never create through an alias.
    let parent = dirname(root); const missing: string[] = [root];
    while (true) {
      try { const info = lstatSync(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw workflowError(); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw workflowError(); missing.push(parent); parent = dirname(parent); }
    }
    if (realpathSync(parent) !== parent) throw workflowError();
    for (const directory of missing.reverse()) mkdirSync(directory, { mode: 0o700 });
  }
  return new ProtectedWorkflowStore(root);
}
/** Concrete native reader/capture owner. Public ticket comments/documents are
 * corroboration; only a protected native operator capture can grant adoption.
 * No constructor, parser or caller-supplied JSON enables the production tool. */
export class PiPreparedNativeAuthority {
  readonly root: string;
  readonly aiUsageRoot: string;
  readonly #runtime: () => PreparedNativeRuntime;
  readonly #now: () => string;
  constructor(dependencies: PreparedNativeDependencies = {}) {
    const home = userInfo().homedir;
    this.root = workflowPath(dependencies.root ?? join(home, ".local/share/pa-platform/prepared-autonomy"));
    this.aiUsageRoot = workflowPath(dependencies.aiUsageRoot ?? join(home, "Documents/ai-usage"));
    this.#runtime = dependencies.runtime ?? currentPreparedNativeRuntime;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }
  #store(create = false): ProtectedWorkflowStore | null { return protectedRoot(join(this.root, "native"), create); }
  operations(create = false): ProtectedWorkflowStore | null { return protectedRoot(join(this.root, "operations"), create); }
  execution(create = false): ProtectedWorkflowStore | null { return protectedRoot(join(this.root, "execution"), create); }
  evidenceRoot(): string { return join(this.root, "execution"); }
  reports(create = false, deploymentId?: string): ProtectedWorkflowStore | null { return protectedRoot(this.reportEvidenceRoot(deploymentId), create); }
  reportEvidenceRoot(deploymentId?: string): string {
    if (deploymentId !== undefined && !/^d-[0-9a-f]{6}$/.test(deploymentId)) throw workflowError();
    return deploymentId === undefined ? join(this.root, "reports") : join(this.root, "reports", deploymentId);
  }
  hasReportPolicyState(): boolean {
    const store = this.#store();
    return store !== null && store.records().some((name) => (store.read(name) as { schemaVersion?: string }).schemaVersion === "prepared-native-policy/v1");
  }
  reportPolicy(caller: Pick<PiPreparationCaller, "repoKey" | "repoRoot">): SourceVersion | null {
    const active = this.#policy(caller); if (!active) return null;
    return source(`native-report-policy:${active.id}`, "prepared-native-policy/v1", Buffer.from(JSON.stringify(active.policy)));
  }
  /** Retained report settlement grants artifact authority only, never new work,
   * activation, source adoption or a different runtime's implicit migration. */
  assertReportPolicy(caller: Pick<PiPreparationCaller, "repoKey" | "repoRoot">, reference: SourceVersion): void {
    const ref = parseSourceVersion(reference); const id = this.#policyId(caller, this.#facts()); const store = this.#store();
    if (!store || ref.ref !== `native-report-policy:${id}` || ref.version !== "prepared-native-policy/v1") throw workflowError();
    const value = store.read(`${id}.intent.json`);
    const row = workflowObject(value, ["schemaVersion", "repoKey", "repoRoot", "runtime", "qualification", "deploymentId", "callerIdentity", "capturedAt"]);
    if (row.schemaVersion !== ref.version || row.repoKey !== caller.repoKey || row.repoRoot !== caller.repoRoot || !equal(row.runtime, this.#facts()) || ref.sha256 !== workflowDigest(JSON.stringify(value))) throw workflowError();
  }
  /** Retained adopted lineages may finish/settle/report after revocation. This
   * never authorizes a new source operation or upgrades a different runtime. */
  retained(caller: Pick<PiPreparationCaller, "repoKey" | "repoRoot" | "ticket">, grantId: string): { grant: NativePreparationGrant; active: boolean } {
    const store = this.#store(); if (!store) throw workflowError();
    const id = workflowSha(grantId); const row = workflowObject(store.read(`${id}.intent.json`), ["schemaVersion", "policyId", "grantId", "contract", "deploymentId", "callerIdentity", "capturedAt"]);
    const contract = parsePreparationContract(row.contract);
    if (row.schemaVersion !== "prepared-native-grant/v1" || row.grantId !== id || contract.repoKey !== caller.repoKey || contract.repoRoot !== caller.repoRoot || contract.ticket !== caller.ticket
      || row.policyId !== this.#policyId(caller, this.#facts())) throw workflowError();
    if (id !== workflowDigest(JSON.stringify(["prepared-native-grant/v1", row.policyId, caller.ticket, contract.requirements, contract.uat, contract.finalChecks, contract.matrix]))) throw workflowError();
    const grant: NativePreparationGrant = Object.freeze({ schemaVersion: "prepared-native-grant/v1", policyId: workflowSha(row.policyId), grantId: id, contract,
      deploymentId: workflowText(row.deploymentId), callerIdentity: workflowSha(row.callerIdentity), capturedAt: workflowTimestamp(row.capturedAt) });
    let active = false;
    if (this.#policy(caller)) {
      try { active = equal(this.promoted({ ...caller, deploymentId: grant.deploymentId, callerIdentity: grant.callerIdentity }, contract.requirements.ref, id), contract); }
      catch { active = false; }
    }
    return { grant, active };
  }
  retainedConsumer(grant: NativePreparationGrant, reference: SourceVersion, deploymentId: string): NativePreparedConsumer {
    const store = this.operations(); if (!store) throw workflowError(); const ref = parseSourceVersion(reference);
    const match = /^native-prepared-consumer:([0-9a-f]{64})$/.exec(ref.ref);
    if (!match || ref.version !== "native-prepared-consumer/v1") throw workflowError();
    const value = store.read(`${match[1]}.intent.json`);
    const row = workflowObject(value, ["schemaVersion", "grantId", "operationId", "receiptId", "repoKey", "repoRoot", "ticket", "worktreeRoot", "headSha", "deploymentId", "deploymentDirectory", "process", "slotToken", "capturedAt"]);
    if (row.schemaVersion !== ref.version || workflowDigest(JSON.stringify(value)) !== ref.sha256 || row.grantId !== grant.grantId || row.operationId !== preparationIdentity(grant.contract)
      || row.repoKey !== grant.contract.repoKey || row.repoRoot !== grant.contract.repoRoot || row.ticket !== grant.contract.ticket || row.deploymentId !== deploymentId
      || row.deploymentDirectory !== join(this.aiUsageRoot, "deployments", deploymentId)
      || match[1] !== workflowDigest(JSON.stringify(["native-prepared-consumer/v1", grant.grantId, row.receiptId, deploymentId]))) throw workflowError();
    workflowSha(row.receiptId); workflowSha(row.headSha, 40); workflowPath(row.worktreeRoot); workflowText(row.slotToken); workflowTimestamp(row.capturedAt);
    const holder = parseExecutionCustody({ state: "orchestrator-direct", holder: { deploymentId, process: row.process }, inFlightOperation: null });
    if (!holder.holder) throw workflowError();
    return Object.freeze({ ...(value as NativePreparedConsumer), process: holder.holder.process });
  }
  tickets(): TicketStore { return new TicketStore(join(this.aiUsageRoot, "tickets")); }
  #facts(): PreparedNativeRuntime { return runtime(this.#runtime()); }
  #policyId(caller: Pick<PiPreparationCaller, "repoKey" | "repoRoot">, facts: PreparedNativeRuntime): string {
    return workflowDigest(JSON.stringify(["prepared-autonomy/v1", caller.repoKey, caller.repoRoot, facts]));
  }
  #readQualification(store: ProtectedWorkflowStore, facts: PreparedNativeRuntime): SourceVersion {
    const id = workflowDigest(JSON.stringify(["prepared-native-qualification/v1", facts]));
    const name = `${id}.intent.json`;
    const value = store.read(name); const row = workflowObject(value, ["schemaVersion", "runtime", "review", "ci", "pairing", "humanUat", "delivery"]);
    if (row.schemaVersion !== "prepared-native-qualification/v1" || !equal(runtime(row.runtime), facts)) throw workflowError();
    // Qualification references must resolve to immutable native records in THIS
    // protected store. No public Markdown/prose or arbitrary path is accepted.
    for (const kind of ["review", "ci", "pairing", "humanUat", "delivery"] as const) {
      const ref = parseSourceVersion(row[kind]);
      const match = /^native-prepared-evidence:([0-9a-f]{64})$/.exec(ref.ref);
      if (!match || ref.version !== "prepared-native-evidence/v1") throw workflowError();
      const evidence = store.read(`${match[1]}.intent.json`);
      const item = workflowObject(evidence, ["schemaVersion", "kind", "runtime", "result", "source", "capturedAt"]);
      if (item.schemaVersion !== ref.version || item.kind !== kind || item.result !== "passed" || !equal(runtime(item.runtime), facts)
        || workflowDigest(JSON.stringify(evidence)) !== ref.sha256) throw workflowError();
      parseSourceVersion(item.source);
      if (workflowTimestamp(item.capturedAt) > workflowTimestamp(this.#now())) throw workflowError();
    }
    return source(`native-prepared-qualification:${id}`, "prepared-native-qualification/v1", Buffer.from(JSON.stringify(value)));
  }
  #policy(caller: Pick<PiPreparationCaller, "repoKey" | "repoRoot">): { id: string; policy: NativePolicy; store: ProtectedWorkflowStore } | null {
    const store = this.#store(); if (!store) return null;
    const facts = this.#facts(); const id = this.#policyId(caller, facts); const names = store.records();
    if (!names.includes(`${id}.intent.json`)) return null;
    const row = workflowObject(store.read(`${id}.intent.json`), ["schemaVersion", "repoKey", "repoRoot", "runtime", "qualification", "deploymentId", "callerIdentity", "capturedAt"]);
    if (row.schemaVersion !== "prepared-native-policy/v1" || row.repoKey !== caller.repoKey || row.repoRoot !== caller.repoRoot || !equal(runtime(row.runtime), facts)) throw workflowError();
    const policy: NativePolicy = { schemaVersion: "prepared-native-policy/v1", repoKey: caller.repoKey, repoRoot: caller.repoRoot, runtime: facts, qualification: parseSourceVersion(row.qualification), deploymentId: workflowText(row.deploymentId), callerIdentity: workflowSha(row.callerIdentity), capturedAt: workflowTimestamp(row.capturedAt) };
    if (names.includes(`${id}.transaction-1.json`)) {
      const revoke = workflowObject(store.read(`${id}.transaction-1.json`), ["schemaVersion", "policyId", "policySha256", "deploymentId", "callerIdentity", "capturedAt"]);
      if (revoke.schemaVersion !== "prepared-native-revocation/v1" || revoke.policyId !== id || revoke.policySha256 !== workflowDigest(JSON.stringify(policy))) throw workflowError();
      workflowText(revoke.deploymentId); workflowSha(revoke.callerIdentity); workflowTimestamp(revoke.capturedAt); return null;
    }
    if (!equal(this.#readQualification(store, facts), policy.qualification)) throw workflowError();
    return { id, policy, store };
  }
  status(caller: Pick<PiPreparationCaller, "repoKey" | "repoRoot">): Readonly<{ active: boolean }> { return Object.freeze({ active: this.#policy(caller) !== null }); }
  activationPreview(caller: PiPreparationCaller): Readonly<{ runtimeSourceSha: string; configSha: string; qualificationSha256: string }> {
    const facts = this.#facts(); const store = this.#store(); if (!store) throw workflowError();
    const qualification = this.#readQualification(store, facts);
    return Object.freeze({ runtimeSourceSha: facts.sourceSha, configSha: facts.configSha, qualificationSha256: qualification.sha256 });
  }
  /** Called ONLY after authenticated native foreground UI and a fresh reread. */
  activate(caller: PiPreparationCaller): void {
    const facts = this.#facts(); const store = this.#store(); if (!store) throw workflowError();
    const qualification = this.#readQualification(store, facts); const id = this.#policyId(caller, facts);
    if (store.records().includes(`${id}.transaction-1.json`)) throw workflowError(); // no implicit reactivation/cap reset
    if (this.#policy(caller)) return;
    const policy: NativePolicy = { schemaVersion: "prepared-native-policy/v1", repoKey: caller.repoKey, repoRoot: caller.repoRoot, runtime: facts, qualification,
      deploymentId: caller.deploymentId, callerIdentity: caller.callerIdentity, capturedAt: workflowTimestamp(this.#now()) };
    this.#publish(caller, store, `${id}.intent.json`, policy);
  }
  deactivate(caller: PiPreparationCaller): void {
    const active = this.#policy(caller); if (!active) return;
    this.#publish(caller, active.store, `${active.id}.transaction-1.json`, { schemaVersion: "prepared-native-revocation/v1", policyId: active.id,
      policySha256: workflowDigest(JSON.stringify(active.policy)), deploymentId: caller.deploymentId, callerIdentity: caller.callerIdentity, capturedAt: workflowTimestamp(this.#now()) });
  }
  #publish(caller: PiPreparationCaller, store: ProtectedWorkflowStore, name: string, value: unknown): void {
    withPreparedWorkflowLocks({ repository: (run) => withPreparedTicketCapacity({ canonicalRepoKey: caller.repoKey, canonicalRepoRoot: caller.repoRoot }, () => run()), worktree: (run) => run() }, (scope) => store.publish(scope, name, value));
  }
  sources(caller: PiPreparationCaller): readonly string[] {
    const ticket = this.#ticket(caller.ticket);
    return Object.freeze(ticket.doc_refs.filter((ref) => ref.type === "requirements").map((ref) => `requirements:${ref.path}`).filter((ref) => { sourcePath(this.aiUsageRoot, ref, "requirements"); return true; }));
  }
  #ticket(ticket: string): Ticket {
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw workflowError();
    const path = join(this.aiUsageRoot, "tickets", `${ticket}.json`);
    const value = json(readReviewEvidenceFile(path, 1_048_576, "prepared ticket")) as Ticket;
    if (value.id !== ticket || !Array.isArray(value.doc_refs) || !Array.isArray(value.comments) || !Array.isArray(value.linkedBranches)) throw workflowError(); return value;
  }
  promoted(caller: PiPreparationCaller, reference: string, grantId: string): PreparationContract {
    const ticket = this.#ticket(caller.ticket);
    if (!ticket.doc_refs.some((ref) => ref.type === "requirements" && `requirements:${ref.path}` === reference)) throw workflowError();
    const req = readSource(sourcePath(this.aiUsageRoot, reference, "requirements")); const markdown = new TextDecoder("utf-8", { fatal: true }).decode(req);
    const revision = header(markdown, "Review Revision");
    const uatRef = header(markdown, "Review Companion UAT").split(";")[0]!;
    if (!ticket.doc_refs.some((ref) => ref.type === "uat" && `uat:${ref.path}` === uatRef)) throw workflowError();
    const uat = readSource(sourcePath(this.aiUsageRoot, uatRef, "uat"));
    const uatMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(uat);
    if (!header(uatMarkdown, "Status").startsWith("Approved") || header(uatMarkdown, "Ticket") !== caller.ticket || header(uatMarkdown, "Review Revision") !== revision
      || header(markdown, "Author") !== "requirements/analyst" || header(markdown, "Route") !== "builder/implement") throw workflowError();
    if (!header(markdown, "Status").startsWith("Approved") || header(markdown, "Shape-Conformance") !== "13/13" || header(markdown, "Ticket") !== caller.ticket
      || header(markdown, "Repository Key") !== caller.repoKey || header(markdown, "Repository Root") !== caller.repoRoot) throw workflowError();
    const checkRef = header(markdown, "Review Record").split(";")[0]!;
    const checkBytes = readSource(sourcePath(this.aiUsageRoot, checkRef)); const checks = json(checkBytes) as Record<string, unknown>;
    const region = matrixRegion(markdown); const digest = workflowDigest(region);
    if (checks.stage !== "final" || checks.revision !== revision || checks.shapeConformance !== "13/13" || checks.passed !== 13 || checks.total !== 13
      || checks.requirementsSha256 !== workflowDigest(req) || checks.uatSha256 !== workflowDigest(uat) || checks.matrixAuthoritySha256 !== digest || !Array.isArray(checks.checks)
      || checks.checks.length !== 13 || checks.checks.some((check, index) => !check || check.number !== index + 1 || check.status !== "pass")) throw workflowError();
    const blocks = [...region.toString("utf8").matchAll(/^```json\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
    if (blocks.length !== 1) throw workflowError();
    const matrix = parseReviewMatrix(blocks[0]![1]!);
    const link = requireTicketLinkedBranch(ticket, caller.repoKey);
    const amendment = /^> Handoff Type: amendment\r?$/m.test(markdown);
    const baseHeader = amendment ? "Retained Base SHA" : "Approved Base SHA";
    if (new RegExp(`^> ${amendment ? "Approved Base SHA" : "Retained Base SHA"}:`, "m").test(markdown)) throw workflowError();
    const base = header(markdown, baseHeader); const branch = header(markdown, "Feature Branch");
    const approval = header(markdown, "Review Approval Evidence"); const matrixApproval = header(markdown, "Matrix Approval Evidence");
    const approvalId = /^([A-Z][A-Z0-9]*-\d+) comment (c-\d{17}) by sinh$/.exec(approval);
    const matrixId = /^([A-Z][A-Z0-9]*-\d+) comment (c-\d{17}) by sinh$/.exec(matrixApproval);
    if (!approvalId || !matrixId || approvalId[1] !== caller.ticket || matrixId[1] !== caller.ticket || header(markdown, "Matrix Source") !== reference
      || header(markdown, "Matrix Authority SHA-256") !== digest || matrix.source !== reference || matrix.repository.key !== caller.repoKey || matrix.repository.root !== caller.repoRoot
      || matrix.repository.branch !== branch || matrix.repository.baseSha !== base || link.branch !== branch || (link.state === "materialized" && link.baseSha !== base)) throw workflowError();
    for (const id of [approvalId[2], matrixId[2]]) {
      const comments = ticket.comments.filter((comment) => comment.id === id);
      if (comments.length !== 1 || comments[0]!.author !== "sinh" || !comments[0]!.content.includes(branch) || !comments[0]!.content.includes(digest)) throw workflowError();
    }
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    if (execFileSync("git", ["--no-optional-locks", "-C", caller.repoRoot, "rev-parse", "--show-toplevel"], { env: gitEnv, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"] }).trim() !== caller.repoRoot) throw workflowError();
    return parsePreparationContract({ schemaVersion: "prepared-workflow/v1", policyVersion: "prepared-autonomy/v1", repoKey: caller.repoKey, repoRoot: caller.repoRoot, ticket: caller.ticket,
      branch, integrationTarget: "origin/develop", approvalBaseSha: base, requirements: source(reference, revision, req), uat: source(uatRef, revision, uat),
      promotionEvidence: `native-preparation-grant:${grantId}`, signoffEvidence: `${caller.ticket}#${approvalId[2]}`, finalChecks: source(checkRef, "analyst-final-review/13", checkBytes), finalCheckCount: 13,
      matrix: parseSourceVersion({ ref: reference, version: "pa-review-matrix/v1", sha256: digest }), matrixApprovalEvidence: `${caller.ticket}#${matrixId[2]}` });
  }
  preview(caller: PiPreparationCaller, reference: string): PreparationContract {
    return this.promoted(caller, reference, workflowDigest("preview-not-authority"));
  }
  bind(caller: PiPreparationCaller, reference: string): NativePreparationGrant {
    const active = this.#policy(caller); if (!active) throw workflowError();
    const preview = this.preview(caller, reference);
    const grantId = workflowDigest(JSON.stringify(["prepared-native-grant/v1", active.id, caller.ticket, preview.requirements, preview.uat, preview.finalChecks, preview.matrix]));
    const contract = this.promoted(caller, reference, grantId);
    const existing = this.resolve(caller);
    if (existing) { if (existing.grantId !== grantId) throw workflowError(); return existing; }
    const grant: NativePreparationGrant = { schemaVersion: "prepared-native-grant/v1", policyId: active.id, grantId, contract,
      deploymentId: caller.deploymentId, callerIdentity: caller.callerIdentity, capturedAt: workflowTimestamp(this.#now()) };
    this.#publish(caller, active.store, `${grantId}.intent.json`, grant); this.operations(true); return grant;
  }
  resolve(caller: PiPreparationCaller): NativePreparationGrant | null {
    const active = this.#policy(caller); if (!active) return null;
    const grants: NativePreparationGrant[] = [];
    for (const name of active.store.records().filter((name) => name.endsWith(".intent.json"))) {
      const value = active.store.read(name) as Record<string, unknown>;
      if (value.schemaVersion !== "prepared-native-grant/v1" || value.policyId !== active.id) continue;
      const row = workflowObject(value, ["schemaVersion", "policyId", "grantId", "contract", "deploymentId", "callerIdentity", "capturedAt"]);
      const contract = parsePreparationContract(row.contract);
      if (contract.ticket !== caller.ticket) continue;
      if (contract.repoKey !== caller.repoKey || contract.repoRoot !== caller.repoRoot || name !== `${workflowSha(row.grantId)}.intent.json`
        || !equal(this.promoted(caller, contract.requirements.ref, String(row.grantId)), contract)) throw workflowError();
      grants.push(Object.freeze({ schemaVersion: "prepared-native-grant/v1", policyId: active.id, grantId: String(row.grantId), contract,
        deploymentId: workflowText(row.deploymentId), callerIdentity: workflowSha(row.callerIdentity), capturedAt: workflowTimestamp(row.capturedAt) }));
    }
    if (grants.length > 1) throw workflowError(); return grants[0] ?? null;
  }
  assertCurrent(caller: PiPreparationCaller, grant: NativePreparationGrant): void {
    if (!equal(this.resolve(caller), grant)) throw workflowError();
  }
  createConsumer(caller: PiPreparationCaller, grant: NativePreparationGrant, receipt: PreparedReceipt, deploymentDirectory: string): SourceVersion {
    this.assertCurrent(caller, grant);
    if (!/^d-[0-9a-f]{6}$/.test(caller.deploymentId) || receipt.state !== "ready" || receipt.operationId !== preparationIdentity(grant.contract)
      || !equal(receipt.contract, grant.contract) || deploymentDirectory !== join(this.aiUsageRoot, "deployments", caller.deploymentId)
      || realpathSync(deploymentDirectory) !== deploymentDirectory) throw workflowError();
    const process = readProcessFingerprint(globalThis.process.pid); if (!process) throw workflowError();
    const capturedAt = workflowTimestamp(this.#now());
    if (capturedAt < receipt.observedAt) throw workflowError();
    const store = this.operations(); if (!store) throw workflowError();
    const id = workflowDigest(JSON.stringify(["native-prepared-consumer/v1", grant.grantId, receipt.receiptId, caller.deploymentId]));
    const name = `${id}.intent.json`;
    let record: NativePreparedConsumer;
    if (store.records().includes(name)) record = store.read(name) as NativePreparedConsumer;
    else {
      record = { schemaVersion: "native-prepared-consumer/v1", grantId: grant.grantId, operationId: receipt.operationId, receiptId: receipt.receiptId,
        repoKey: caller.repoKey, repoRoot: caller.repoRoot, ticket: caller.ticket, worktreeRoot: receipt.worktreeRoot, headSha: receipt.preparedHeadSha,
        deploymentId: caller.deploymentId, deploymentDirectory, process, slotToken: randomUUID(), capturedAt };
      this.#publish(caller, store, name, record);
    }
    const reference = source(`native-prepared-consumer:${id}`, "native-prepared-consumer/v1", Buffer.from(JSON.stringify(record)));
    this.consumer(caller, grant, reference);
    return reference;
  }
  consumer(caller: PiPreparationCaller, grant: NativePreparationGrant, reference: SourceVersion): NativePreparedConsumer {
    this.assertCurrent(caller, grant);
    const record = this.retainedConsumer(grant, reference, caller.deploymentId);
    const process = readProcessFingerprint(globalThis.process.pid);
    if (!process || !equal(record.process, process) || record.capturedAt > workflowTimestamp(this.#now())) throw workflowError();
    return record;
  }
  authorize(caller: PiPreparationCaller, grant: NativePreparationGrant, operation: "request" | "retry" | "consume", contract: PreparationContract, evidence: SourceVersion | null): void {
    this.assertCurrent(caller, grant); if (!equal(contract, grant.contract) || operation === "consume") throw workflowError();
    if (operation === "retry") {
      const store = this.operations(); if (!store || !evidence) throw workflowError();
      // Exact-attempt/failure checks are repeated by the engine under its mutex.
      const statusSource = store.read(`${preparationIdentity(contract)}.intent.json`) as Record<string, unknown>;
      if (!statusSource) throw workflowError();
      const match = /^native-preparation-retry:([0-9a-f]{64})$/.exec(evidence.ref);
      if (!match) throw workflowError();
      const row = store.read(`${match[1]}.intent.json`) as Record<string, unknown>;
      readNativePreparationRetry(store, evidence, { operationId: preparationIdentity(contract), bindingIdentity: workflowDigest(JSON.stringify(grant)), callerIdentity: caller.callerIdentity,
        deploymentId: caller.deploymentId, preparationAttempt: Number(row.preparationAttempt), failureSha256: String(row.failureSha256) });
    }
  }
}
