import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertNoSensitiveMatch, captureRepositoryGitSnapshot, findSensitiveMatch, indexPhaseReport, indexPhaseReportDelivery, parsePhaseReport, parseSourceVersion,
  phaseReportDeliverySources, phaseReportIdentity, PhaseReportService, queryReadonlyHelperRegistry, observeReadonlyRepositoryAuthority, observeReadonlyRepositoryTicketSlot, readProcessFingerprint, readReviewEvidenceFile,
  resolveRepoExecutionPath, withPreparedWorkflowLocks, workflowDigest, workflowError, workflowObject, workflowText, workflowTimestamp,
  type ExecutionState, type PhaseReport, type PhaseReportCheck, type PhaseReportDelivery, type PhaseReportHost, type PhaseReportReceipt, type ProcessFingerprint, type SourceVersion,
} from "@pa-platform/pa-core";
import { environmentSecrets } from "./diagnostics.js";
import { PiNativeExecutionAdapter, type NativeExecutionReportFacts } from "./execution-native.js";
import { NativeExecutionEvidence, nativePublicText, type NativeBlob } from "./native-execution-evidence.js";
import { PiPreparedNativeAuthority } from "./prepared-native.js";
import { readPiProcessIdentity } from "./process-identity.js";
import type { PiPhaseReportBinding, PiPreparationContext } from "./pi-extension/prepared-workflow.js";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
interface Actor {
  deploymentId: string; team: "builder" | "rogue-one"; mode: string; ticket: string | null; process: ProcessFingerprint;
  repoKey: string; repoRoot: string; worktreeRoot: string; gitDir: string; startedAt: string;
}
export interface NativeReportDraft { phaseId: string; summary: string; nextAction: string; learning: string }
interface CapturedReport { actor: string; report: NativeBlob; facts: SourceVersion; diff: NativeBlob; phaseId: string; attempt: number }
interface ReportFacts {
  actor: Actor; snapshot: ReturnType<typeof captureRepositoryGitSnapshot>; checks: readonly PhaseReportCheck[]; execution: unknown;
  scopeProven: boolean; operations: readonly SourceVersion[]; omissions: readonly string[]; sourceFailure: boolean;
}
export interface PiNativeReportOptions {
  readonly authority?: PiPreparedNativeAuthority;
  readonly execution?: PiNativeExecutionAdapter;
}
function directory(path: string): void {
  const missing: string[] = []; let current = path;
  while (true) {
    try { const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw workflowError(); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing.push(current); current = dirname(current); }
  }
  if (realpathSync(current) !== current) throw workflowError();
  for (const item of missing.reverse()) mkdirSync(item, { mode: 0o700 });
  const stat = lstatSync(path); if (stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw workflowError();
}
function actor(context: unknown, authority: PiPreparedNativeAuthority): Actor {
  const env = process.env; const id = workflowText(env.PA_DEPLOYMENT_ID);
  if (!/^d-[0-9a-f]{6}$/.test(id)) throw workflowError();
  const status = queryReadonlyHelperRegistry(id).status; const cwd = (context as { cwd?: string } | null)?.cwd;
  if (!status || status.status !== "running" || status.runtime !== "pi" || status.binary !== "ppa" || status.pid !== process.pid || cwd !== process.cwd()
    || env.PA_DEPLOYMENT_DIR !== join(authority.aiUsageRoot, "deployments", id) || env.PA_TEAM !== status.team || (env.PA_MODE ?? "") !== (status.mode ?? "")
    || env.PA_REPO !== cwd || env.PA_WORKTREE_ROOT !== cwd || (env.PA_TICKET_ID || null) !== (status.ticket_id || null)) throw workflowError();
  if (status.team !== "rogue-one" && !(status.team === "builder" && ["orchestrator", "implement"].includes(status.mode ?? ""))) throw workflowError();
  if (status.team === "builder" && !((status.mode === "orchestrator" && status.builder_authority === "orchestrator") || (status.mode === "implement" && ["parented-implement", "standalone-implement"].includes(status.builder_authority ?? "")))) throw workflowError();
  if (status.team === "rogue-one" && (!status.rogue_one || status.builder_authority || status.parent_deployment_id || status.ticket_slot_id || status.repository_permit)) throw workflowError();
  const physical = resolveRepoExecutionPath(undefined, cwd, { allowLinkedWorktreeCwd: true });
  if (status.repo !== physical.worktreeRoot || status.worktree_root !== physical.worktreeRoot || status.repo_root !== physical.repoRoot) throw workflowError();
  if (status.ticket_id && !/^[A-Z][A-Z0-9]*-\d+$/.test(status.ticket_id)) throw workflowError();
  const anchor = readPiProcessIdentity(id, env.PA_DEPLOYMENT_DIR);
  if (anchor.pid !== process.pid || !equal(anchor, readProcessFingerprint(process.pid))) throw workflowError();
  return { deploymentId: id, team: status.team, mode: status.mode ?? "", ticket: status.ticket_id ?? null, process: anchor,
    repoKey: physical.repoKey, repoRoot: physical.repoRoot, worktreeRoot: physical.worktreeRoot, gitDir: physical.gitDir, startedAt: workflowTimestamp(status.started_at) };
}
/** Artifact-only native authority. Rogue-one/ticketless reporting never acquires
 * builder capacity, a worktree lease, a child or source-write permission. */
export class PiNativePhaseReportAdapter {
  readonly authority: PiPreparedNativeAuthority;
  readonly #execution: PiNativeExecutionAdapter;
  readonly #sessions = new Map<string, NativeReportSession>();
  constructor(options: PiNativeReportOptions = {}) { this.authority = options.authority ?? new PiPreparedNativeAuthority(); this.#execution = options.execution ?? new PiNativeExecutionAdapter({ authority: this.authority }); }
  resolve(context: unknown): PiPhaseReportBinding | null {
    if (!["rogue-one", "builder"].includes(process.env.PA_TEAM ?? "")) return null;
    // No policy namespace: preserve the inactive baseline without role probes,
    // artifact roots, registry initialization or a fabricated ticket requirement.
    if (!this.authority.reports() && !this.authority.hasReportPolicyState()) return null;
    const physical = resolveRepoExecutionPath(undefined, process.cwd(), { allowLinkedWorktreeCwd: true });
    const policy = this.authority.hasReportPolicyState() ? this.authority.reportPolicy(physical) : null;
    const locator = process.env.PA_DEPLOYMENT_ID;
    const existing = locator && /^d-[0-9a-f]{6}$/.test(locator) ? this.authority.reports(false, locator) : null;
    const name = `${workflowDigest(JSON.stringify(["native-report-owner/v1", process.env.PA_DEPLOYMENT_ID]))}.intent.json`;
    if (!policy && (!existing || !existing.records().includes(name))) return null;
    const current = actor(context, this.authority); const key = workflowDigest(JSON.stringify(current));
    let session = this.#sessions.get(key);
    if (!session) {
      session = new NativeReportSession(this.authority, this.#execution, current, policy, context); this.#sessions.set(key, session);
    }
    session.assertCurrent(context); return session.binding;
  }
}
class NativeReportSession {
  readonly binding: PiPhaseReportBinding;
  readonly #authority: PiPreparedNativeAuthority;
  readonly #execution: PiNativeExecutionAdapter;
  readonly #actor: Actor;
  readonly #identity: string;
  readonly #policy: SourceVersion;
  readonly #evidence: NativeExecutionEvidence;
  readonly #root: string;
  readonly #ownerName: string;
  readonly #service: PhaseReportService;
  #indexing = false;
  constructor(authority: PiPreparedNativeAuthority, execution: PiNativeExecutionAdapter, current: Actor, policy: SourceVersion | null, context: unknown) {
    this.#authority = authority; this.#execution = execution; this.#actor = current; this.#identity = workflowDigest(JSON.stringify(current));
    const store = authority.reports(policy !== null, current.deploymentId); if (!store) throw workflowError();
    // Synchronous single-Pi owner: exact PID (not descendant locators) above,
    // sequential tool dispatch, immutable records and owner Markdown CAS below.
    this.#evidence = new NativeExecutionEvidence(store, authority.reportEvidenceRoot(current.deploymentId), { repository: (run) => run(), worktree: (run) => run() });
    this.#root = join(authority.aiUsageRoot, "agent-teams", current.team, "artifacts");
    this.#ownerName = `${current.startedAt.slice(0, 10)}-${current.ticket ?? "ticketless"}-${current.deploymentId}-owner.md`;
    const name = `${workflowDigest(JSON.stringify(["native-report-owner/v1", current.deploymentId]))}.intent.json`;
    const descriptor = { schemaVersion: "native-report-owner/v1", actor: current, policy, root: this.#root, ownerName: this.#ownerName };
    if (store.records().includes(name)) {
      const previous = workflowObject(store.read(name), ["schemaVersion", "actor", "policy", "root", "ownerName"]);
      if (previous.schemaVersion !== descriptor.schemaVersion || !equal(previous.actor, current) || previous.root !== this.#root || previous.ownerName !== this.#ownerName) throw workflowError();
      this.#policy = parseSourceVersion(previous.policy);
    } else {
      if (!policy) throw workflowError(); this.#policy = policy;
      // Use the existing protected record publisher rather than another workflow DB.
      withPreparedWorkflowLocks(this.#evidence.locks, (scope) => store.publish(scope, name, descriptor));
    }
    this.assertCurrent(context); directory(this.#root);
    const host: PhaseReportHost = {
      authorize: (_action, identity) => { this.assertCurrent({ cwd: process.cwd() }); if (identity.deploymentId !== current.deploymentId || identity.team !== current.team || identity.ticket !== current.ticket) throw workflowError(); },
      verifyReport: (report) => { this.#find(report); },
      resolvePublicDiff: (report) => this.#evidence.blob(this.#find(report).record.diff),
      sanitize: (markdown) => this.#safe(markdown), assertPublic: (bytes) => this.#assertPublic(bytes),
      verifyCanonical: (receipt) => {
        const found = this.#findReceipt(receipt); this.#find(found.report);
        const path = join(this.#reportDirectory(receipt.identity), "diff.patch");
        if (!Buffer.from(readReviewEvidenceFile(path, 1_048_576, "native public diff")).equals(this.#evidence.blob(found.record.diff))) throw workflowError();
      },
      dependencyState: (receipt) => {
        const found = this.#findReceipt(receipt);
        const reference = this.#evidence.read(found.record.facts, "report-facts") as { blob: NativeBlob };
        const facts = JSON.parse(this.#evidence.blob(reference.blob).toString("utf8")) as ReportFacts;
        if (!equal(facts.snapshot, captureRepositoryGitSnapshot(this.#actor.worktreeRoot))) return "historical";
        const execution = facts.execution as ExecutionState | null;
        if (!facts.scopeProven || !execution?.plan || execution.operation || execution.originalFailure || Date.now() >= Date.parse(execution.bounds.deadlineAt) || !execution.plan.checks.every((check) => Object.hasOwn(execution.passedChecks, check))) return "missing-check-evidence";
        try {
          const fresh = this.#execution.resolve({ cwd: process.cwd() })?.reportFacts();
          if (!fresh?.scopeProven || fresh.state.sequence !== execution.sequence) return "historical";
        } catch { return "historical"; }
        return "available";
      },
      index: (receipt) => this.#ownerUpdate((text) => indexPhaseReport(text, workflowDigest(text), receipt).markdown),
      resolveDelivery: (source) => ({ ...(this.#evidence.read(source, "report-delivery") as Omit<PhaseReportDelivery, "evidence">), evidence: source }),
      loadDeliverySources: (receipt) => phaseReportDeliverySources(this.#ownerRead(), receipt),
      recordDelivery: (receipt, delivery) => this.#ownerUpdate((text) => indexPhaseReportDelivery(text, workflowDigest(text), receipt, delivery).markdown),
    };
    this.#service = new PhaseReportService(this.#root, host);
    this.binding = { service: this.#service, readingLocations: (receipt) => ({ markdown: join(this.#reportDirectory(receipt.identity), "report.md"), html: join(this.#reportDirectory(receipt.identity), "report.html"), diff: join(this.#reportDirectory(receipt.identity), "diff.patch"), owner: join(this.#root, this.#ownerName) }), capture: (id, draft) => this.capture(id, draft),
      resolveReport: (source) => this.#readReport(source).report,
      recordReceipt: (receipt) => { const found = this.#findReceipt(receipt); return this.#evidence.publish("report-receipt", { actor: this.#identity, source: found.source, receipt }); },
      resolveReceipt: (source) => {
        const row = workflowObject(this.#evidence.read(source, "report-receipt"), ["actor", "source", "receipt"]);
        if (row.actor !== this.#identity) throw workflowError(); const report = this.#readReport(parseSourceVersion(row.source)).report;
        const receipt = row.receipt as PhaseReportReceipt;
        if (receipt.reportId !== phaseReportIdentity(report.identity) || receipt.outcome !== report.outcome) throw workflowError(); return receipt;
      }, observeDelivery: (receipt, application, ctx, signal) => this.#observeDelivery(receipt, application, ctx, signal) };
  }
  assertCurrent(context: unknown): void {
    if (!equal(actor(context, this.#authority), this.#actor)) throw workflowError();
    this.#authority.assertReportPolicy(this.#actor, this.#policy);
  }
  #safe(text: string): string {
    const authority = observeReadonlyRepositoryAuthority(this.#actor.gitDir);
    const values = [authority.owner?.ownershipToken, authority.implement?.ownershipToken, authority.borrower?.borrowerToken, authority.review?.reservationToken].filter((value): value is string => typeof value === "string");
    const ticket = authority.owner?.ticket ?? authority.implement?.ticket;
    if (ticket) values.push(observeReadonlyRepositoryTicketSlot(this.#actor.repoRoot, ticket).slot.slotToken);
    return nativePublicText(text, environmentSecrets(process.env, values));
  }
  #assertPublic(bytes: Buffer): void { const text = bytes.toString("utf8"); if (this.#safe(text) !== text) throw workflowError(); assertNoSensitiveMatch("content", text); }
  #blob(kind: string, bytes: Buffer): NativeBlob {
    if (bytes.length > 1_048_576) throw workflowError();
    const id = workflowDigest(JSON.stringify([kind, workflowDigest(bytes)])); const name = `${id}.stdout.log`;
    try {
      const path = join(this.#authority.reportEvidenceRoot(this.#actor.deploymentId), name); const stat = lstatSync(path);
      const existing = { name, bytes: bytes.length, sha256: workflowDigest(bytes) };
      if (stat.isSymbolicLink() || !this.#evidence.blob(existing).equals(bytes)) throw workflowError(); return existing;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const sink = this.#evidence.sink(id, "stdout", 1_048_576); if (!sink.write(bytes)) throw workflowError(); return sink.close();
  }
  #reports(): { source: SourceVersion; record: CapturedReport; report: PhaseReport }[] {
    const result = [];
    for (const name of this.#evidence.store.records().filter((name) => name.endsWith(".intent.json"))) {
      const value = this.#evidence.store.read(name) as { schemaVersion?: string; kind?: string; payload?: CapturedReport };
      if (value.kind !== "phase-report" || value.payload?.actor !== this.#identity) continue;
      const id = name.slice(0, -12); const source = parseSourceVersion({ ref: `native-execution-evidence:${id}`, version: "native-execution-evidence/v1", sha256: id });
      result.push({ source, ...this.#readReport(source) });
    }
    return result;
  }
  #readReport(source: SourceVersion): { record: CapturedReport; report: PhaseReport } {
    const record = this.#evidence.read(source, "phase-report") as CapturedReport;
    if (record.actor !== this.#identity) throw workflowError();
    const report = parsePhaseReport(JSON.parse(this.#evidence.blob(record.report).toString("utf8")));
    const facts = this.#evidence.read(record.facts, "report-facts") as { actor: string; blob: NativeBlob };
    if (facts.actor !== this.#identity || !equal(report.evidence, record.facts) || report.identity.deploymentId !== this.#actor.deploymentId) throw workflowError();
    this.#evidence.blob(facts.blob); this.#assertPublic(this.#evidence.blob(record.diff)); return { record, report };
  }
  #find(report: PhaseReport) { const found = this.#reports().find((item) => equal(item.report, report)); if (!found) throw workflowError(); return found; }
  #findReceipt(receipt: PhaseReportReceipt) { const found = this.#reports().find((item) => phaseReportIdentity(item.report.identity) === receipt.reportId && equal(item.report.identity, receipt.identity) && item.report.outcome === receipt.outcome); if (!found) throw workflowError(); return found; }
  capture(id: string, draft: NativeReportDraft): SourceVersion {
    this.assertCurrent({ cwd: process.cwd() });
    const parsed = workflowObject(draft, ["phaseId", "summary", "nextAction", "learning"]);
    const phaseId = workflowText(parsed.phaseId); if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(phaseId)) throw workflowError();
    for (const field of [parsed.summary, parsed.nextAction, parsed.learning]) if (typeof field !== "string" || !field.trim() || Buffer.byteLength(field) > 4096) throw workflowError();
    const key = `${workflowDigest(JSON.stringify(["native-report-capture/v1", this.#identity, workflowText(id)]))}.intent.json`;
    if (this.#evidence.store.records().includes(key)) {
      const previous = workflowObject(this.#evidence.store.read(key), ["schemaVersion", "draftSha256", "source"]);
      if (previous.schemaVersion !== "native-report-capture/v1" || previous.draftSha256 !== workflowDigest(JSON.stringify(draft))) throw workflowError(); return parseSourceVersion(previous.source);
    }
    const previous = this.#reports().filter((item) => item.report.identity.phaseId === phaseId).sort((a, b) => a.report.identity.attempt - b.report.identity.attempt);
    if (previous.length >= 32) throw workflowError();
    let native: NativeExecutionReportFacts | null = null; let sourceFailure = false;
    if (this.#actor.team === "builder" && this.#actor.mode === "orchestrator") {
      try { native = this.#execution.resolve({ cwd: process.cwd() })?.reportFacts() ?? null; } catch { sourceFailure = true; }
      if (native?.state.plan && native.state.plan.phaseId !== phaseId) throw workflowError();
    }
    const snapshot = captureRepositoryGitSnapshot(this.#actor.worktreeRoot);
    if (native && !equal(native.snapshot, snapshot)) throw workflowError();
    const omissions = [...(native?.omissions ?? ["No native execution custody evidence: source contents/diff and check passes are not inferred from narrative or environment."])];
    if (sourceFailure) omissions.push("Native execution evidence could not be authenticated; report-only observation grants no source continuation or terminal reconstruction.");
    const originalDiff = native?.scopeProven ? native.diff : Buffer.from("No safe source diff available; preserve work and native evidence.\n");
    let rawDiff: string;
    try { rawDiff = new TextDecoder("utf-8", { fatal: true }).decode(originalDiff); }
    catch { rawDiff = "Non-UTF8 diff content omitted; exact scoped bytes and inventory remain private.\n"; omissions.push("Non-UTF8 diff cannot become a lossy purported full text patch."); }
    const publicDiff = Buffer.from(this.#safe(rawDiff)); if (publicDiff.toString() !== rawDiff) omissions.push("Private/sensitive diff content was redacted or withheld; original scoped input remains private.");
    const privateDiff = this.#blob("raw-diff", originalDiff); const diff = this.#blob("public-diff", publicDiff);
    const checks = native?.checks.map((check) => ({ ...check, command: this.#safe(check.command) })) ?? [];
    if (native?.checks.some((check, index) => check.command !== checks[index]?.command)) omissions.push("Sensitive command text was redacted; the exact original command/result remains in the private native evidence.");
    const facts: ReportFacts = { actor: this.#actor, snapshot, checks: native?.checks ?? [], execution: native?.state ?? null, scopeProven: native?.scopeProven ?? false, operations: native?.operations ?? [], omissions, sourceFailure };
    const factSource = this.#evidence.publish("report-facts", { actor: this.#identity, blob: this.#blob("report-facts", Buffer.from(JSON.stringify({ ...facts, privateDiff }))) });
    const inventory = (snapshot.statusEntries ?? []).map((entry) => ({ ...entry, classification: native?.scopeProven ? "native-plan-scoped" : "unclassified", path: this.#publicPath(entry.path), ...(entry.sourcePath ? { sourcePath: this.#publicPath(entry.sourcePath) } : {}), pathBase64: "private inventory only", sourcePathBase64: "private inventory only" }));
    const outcome = native?.state.originalFailure ? "failed" : "partial";
    const report = parsePhaseReport({ schemaVersion: "phase-report/v1", identity: { date: this.#actor.startedAt.slice(0, 10), team: this.#actor.team, ticket: this.#actor.ticket,
      deploymentId: this.#actor.deploymentId, phaseId, attempt: previous.length + 1, executor: this.#actor.team === "rogue-one" ? "rogue-one" : this.#actor.mode === "implement" ? "implement" : "orchestrator-direct" },
      outcome, startedAt: this.#actor.startedAt, finishedAt: new Date().toISOString(), baseSha: native?.state.binding.initialHeadSha ?? null, candidateSha: snapshot.head,
      commitState: native ? snapshot.head === native.state.binding.initialHeadSha ? "no-commit" : "committed" : "unknown", checks, previousAttempts: previous.map((item) => item.source), evidence: factSource,
      sections: { summary: `Agent-provided narrative (not acceptance evidence):\n\n${this.#safe(String(parsed.summary))}`, changes: native?.scopeProven ? "Changes are confined to the native written plan; see the full safe diff and private source inventory." : "Change ownership is unproven; no unrelated content is published.",
        traceability: native?.state.plan ? JSON.stringify(native.state.plan.requirements) : "No native phase plan; no requirement completion inferred.",
        unproven: "Partial evidence report only. No phase acceptance, independent review/CI, human UAT, integration, activation or ticket completion is claimed.",
        gitInventory: `HEAD ${snapshot.head}; branch ${this.#safe(snapshot.branch ?? "unknown")}; full NUL inventory SHA-256 ${snapshot.digestSha256 ?? "unknown"}.\n\n${this.#safe(JSON.stringify(inventory))}`,
        diff: `[Full safe diff](diff.patch), SHA-256 ${diff.sha256}.\n\nReading excerpt (full companion is authoritative):\n\n${publicDiff.subarray(0, 8192).toString("utf8").split("\n").map((line) => `    ${line}`).join("\n")}`,
        failures: native?.state.originalFailure ? `Original failure retained: ${JSON.stringify({ ...native.state.originalFailure, command: this.#safe(native.state.originalFailure.command) })}` : "No native original failure available; absence is not a validation pass.",
        custody: native ? JSON.stringify({ state: native.state.custody.state, inFlight: native.state.operation !== null, candidateSha: native.state.candidateSha, settledOperationCount: native.operations.length, pendingNativeResult: native.pendingResult }) : "Report-only authority; no builder/source custody is acquired or inferred.",
        risks: "Managed process-group evidence is not arbitrary escaped-descendant confinement. Trusted terminal reconstruction and final qualification remain separate.",
        nextAction: this.#safe(String(parsed.nextAction)), owner: `${this.#actor.team}/${this.#actor.mode || "default"}; existing runtime owner report ${this.#ownerName}`,
        learning: this.#safe(String(parsed.learning)), reconstruction: "Live native observation; no historical terminal cause or process death is reconstructed from prose or a quiet log.",
        omissions: omissions.join("\n") || "No additional omissions beyond explicitly bounded/binary reading representation.", rebaseMapping: "No rebase adoption inferred; original preparation/launch binding is preserved." } });
    if (!equal(snapshot, captureRepositoryGitSnapshot(this.#actor.worktreeRoot))) throw workflowError(); this.assertCurrent({ cwd: process.cwd() });
    const source = this.#evidence.publish("phase-report", { actor: this.#identity, facts: factSource, report: this.#blob("report-body", Buffer.from(JSON.stringify(report))), diff, phaseId, attempt: report.identity.attempt } satisfies CapturedReport);
    withPreparedWorkflowLocks(this.#evidence.locks, (scope) => this.#evidence.store.publish(scope, key, { schemaVersion: "native-report-capture/v1", draftSha256: workflowDigest(JSON.stringify(draft)), source }));
    return source;
  }
  #publicPath(path: string): string { return findSensitiveMatch("path", path) || findSensitiveMatch("filename", path) ? `[omitted path SHA-256 ${workflowDigest(path)}]` : this.#safe(path); }
  #reportDirectory(identity: PhaseReport["identity"]): string { return join(this.#root, `${identity.date}-${identity.ticket ?? "ticketless"}-${identity.phaseId}-${identity.deploymentId}`, `attempt-${identity.attempt}`); }
  #ownerRead(): string {
    const path = join(this.#root, this.#ownerName);
    try { const stat = lstatSync(path); if ((stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw workflowError(); return Buffer.from(readReviewEvidenceFile(path, 1_048_576, "native owner report")).toString("utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return `# Runtime owner report\n\nDeployment ${this.#actor.deploymentId}; team ${this.#actor.team}. Phase outcomes and source-bound delivery are indexed below; no ticket completion is implied.\n`; }
  }
  #ownerUpdate(update: (value: string) => string): void {
    this.assertCurrent({ cwd: process.cwd() }); if (this.#indexing) throw workflowError(); this.#indexing = true;
    try {
      const before = this.#ownerRead(); const after = update(before); if (after === before) return; this.#assertPublic(Buffer.from(after));
      const fd = openSync(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (realpathSync(`/proc/self/fd/${fd}`) !== this.#root || fstatSync(fd).uid !== process.getuid?.() || (fstatSync(fd).mode & 0o022)) throw workflowError();
        const temporary = `/proc/self/fd/${fd}/.${randomUUID()}.tmp`; const output = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(output, after); fsyncSync(output); } finally { closeSync(output); }
        if (this.#ownerRead() !== before) throw workflowError();
        renameSync(temporary, `/proc/self/fd/${fd}/${this.#ownerName}`); fsyncSync(fd);
        if (this.#ownerRead() !== after) throw workflowError();
      } finally { closeSync(fd); }
    } finally { this.#indexing = false; }
  }
  async #observeDelivery(receipt: PhaseReportReceipt, application: "browser" | "obsidian", context: unknown, signal?: AbortSignal): Promise<SourceVersion | null> {
    this.assertCurrent(context); const ctx = context as PiPreparationContext;
    if (ctx.mode !== "tui" || process.env.PA_PI_EXECUTION_MODE !== "foreground" || !ctx.ui?.select || signal?.aborted) throw workflowError();
    const before = this.#service.settle(receipt);
    const known = phaseReportDeliverySources(this.#ownerRead(), receipt);
    for (const source of known) { const value = this.#evidence.read(source, "report-delivery") as { application: string }; if (value.application === application) return source; }
    const confirm = `I opened this exact ${application} reading view and checked its source identity`;
    const selected = await ctx.ui.select(`Report ${receipt.reportId}; Markdown SHA-256 ${receipt.sourceSha256}; HTML SHA-256 ${receipt.htmlSha256}. View ${join(this.#reportDirectory(receipt.identity), application === "browser" ? "report.html" : "report.md")}. Confirm actual ${application} observation, not generation or product UAT.`, [confirm, "Not observed"], { signal });
    if (signal?.aborted || selected !== confirm) return null;
    this.assertCurrent(context); const after = this.#service.settle(receipt);
    if (before.sourceSha256 !== after.sourceSha256) throw workflowError();
    return this.#evidence.publish("report-delivery", { application, kind: "native-operator", reportId: receipt.reportId, sourceSha256: receipt.sourceSha256, htmlSha256: receipt.htmlSha256, observedAt: new Date().toISOString() });
  }
}
