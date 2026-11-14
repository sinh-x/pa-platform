import { closeSync, constants, fsyncSync, openSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
  AdvisoryFiles, AutoWaitlistError, RegistryAutoDrafts, RegistryAutoJournal, RegistryDocumentJournal, TicketStore, autoDraftTicketVersion, parseAutoDraftTicketAppend,
  assertLocalFileSource, assertNoSensitiveMatch, checkSourceContent, checkDocumentPackage, documentPackageSha, documentDestination, documentPending,
  getAiUsageDir, getTicketsDir, readArtifactFile, openArtifactDirectory, resolveRepoExecutionPath, parseReviewEvidenceJson, parseReviewMatrixPlan, autoSourceScopeFromRequirements,
  workflowDigest, readProcessFingerprint, emitStartedEvent, emitPidEvent, emitCompletedEvent, getDeploymentEvents, LOCAL_GIT_CONTROL_FLAGS,
  type AutoItem, type AutoChoiceRecord, type AutoDraftGeneration, type AutoDraftGenerationHost, type AutoDraftPolicyRef, type AutoDraftTicketAppend, type DocumentPackage, type Ticket,
} from "@pa-platform/pa-core";
import { PiAdapter } from "./adapter.js";
import { autoDraftRead, parseAutoDraftReply, type AutoDraftReply } from "./auto-draft.js";
import { autoGitCommitSha } from "./auto-git.js";
import { ProjectCommandContract } from "./project-command-contract.js";
import { trustedNativeExecutable } from "./native-execution-evidence.js";
import { nativeAutoProducerProcess, type AutoProducerProcessDriver } from "./auto-producer-process.js";
import { selectedPiAutoDelegatedPair, type PiAutoDelegatedPair } from "./auto-delegated-contract.js";

export interface PiAutoDraftAuthority {
  authenticate(): string;
  /** Must query the genuinely adopted CURRENT native policy and selection.
   * No caller/model policy flags or old content/start receipts are accepted. */
  authorizeDraft(item: AutoItem, choice: AutoChoiceRecord, reference?: AutoDraftPolicyRef): AutoDraftPolicyRef;
}
interface DraftFacts {
  schemaVersion: "pa-auto-delegated-draft-request/v1"; ticket: Ticket; repoRoot: string; repositoryConfigSha256: string;
  repositoryObservation: { headSha: string; statusSha256: string };
  branch: { name: string; baseSha: string; headSha: string | null; state: "planned" | "materialized" };
  validation: { profileSha256: string; commands: string[] } | null;
  clock: { bootId: string; startedNs: string }; documentRevision: number; documentEventsSha256: string;
  questions: string[]; configRoot: string; configRevision: string; resourcesSha256: string; provider: string; model: string; mode: string;
}
interface DraftBundle {
  schemaVersion: "pa-auto-delegated-draft-bundle/v1"; requestSha256: string; outputSha256: string;
  subject: DocumentPackage; documents: Array<{ id: string; text: string }>; questions: string[];
}
export interface PiDelegatedDraftDependencies {
  pair?: () => PiAutoDelegatedPair; driver?: () => AutoProducerProcessDriver; root?: string; tickets?: TicketStore;
  /** Native fault-test seam only, never CLI/request data. */
  afterStage?(stage: "output" | "artifact" | "freeze" | "append" | "finish"): void;
}
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
function repositoryObservation(root: string) {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  const status = execFileSync(trustedNativeExecutable("git"), ["--no-replace-objects", "--no-optional-locks", ...LOCAL_GIT_CONTROL_FLAGS, "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], { env, timeout: 10_000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "ignore"] });
  return { headSha: autoGitCommitSha(root, "HEAD"), statusSha256: workflowDigest(status) };
}
/** Actual finite draft producer and append adapter. Authority is mandatory and
 * separately native; this class never captures a human approval or starts code
 * implementation. The old manual auto-draft HOLD is deliberately unchanged. */
export class PiDelegatedDraftOwner {
  readonly drafts: RegistryAutoDrafts;
  readonly host: AutoDraftGenerationHost;
  private readonly root: string;
  private readonly files: AdvisoryFiles;
  private readonly tickets: TicketStore;
  private readonly pairing: () => PiAutoDelegatedPair;
  constructor(readonly journal: RegistryAutoJournal, private readonly authority: PiAutoDraftAuthority, private readonly deps: PiDelegatedDraftDependencies = {}) {
    if (typeof authority?.authenticate !== "function" || typeof authority.authorizeDraft !== "function") throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    this.root = deps.root ?? getAiUsageDir(); this.files = new AdvisoryFiles(this.root); this.tickets = deps.tickets ?? new TicketStore();
    this.pairing = deps.pair ?? selectedPiAutoDelegatedPair; this.drafts = new RegistryAutoDrafts(journal);
    this.host = { authenticate: () => authority.authenticate(), now: () => new Date().toISOString(), authorize: (item, choice, ref) => authority.authorizeDraft(item, choice, ref), assertCurrent: g => this.assertFacts(g) };
  }
  private facts(g: AutoDraftGeneration): DraftFacts {
    const r = parseReviewEvidenceJson(this.drafts.blob(g.requestSha256), "auto.delegated.draft.facts") as DraftFacts;
    if (!r || r.schemaVersion !== "pa-auto-delegated-draft-request/v1" || r.ticket.id !== this.journal.item(g.itemId).ticket) throw new AutoWaitlistError("AUTO_SOURCE"); return JSON.parse(JSON.stringify(r));
  }
  private prepare(item: AutoItem, pair: PiAutoDelegatedPair): DraftFacts {
    const native = readProcessFingerprint(process.pid); if (!native) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const clock = { bootId: native.bootId, startedNs: process.hrtime.bigint().toString() };
    const repository = resolveRepoExecutionPath(item.project), ticket = this.tickets.get(item.ticket), path = join(getTicketsDir(), `${item.ticket}.json`);
    if (!ticket || ticket.id !== item.ticket || ticket.project !== item.project || repository.repoRoot !== item.repoRoot || item.subjectSha256) throw new AutoWaitlistError("AUTO_SOURCE");
    assertLocalFileSource(path); const bytes = readArtifactFile(path, 1_048_576, "ARTIFACT_STALE");
    if (workflowDigest(bytes) !== item.ticketSha256) throw new AutoWaitlistError("AUTO_SOURCE");
    checkSourceContent({ source: { kind: "local-file", path }, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    const links = ticket.linkedBranches.filter(branch => branch.repo === item.project); if (links.length > 1) throw new AutoWaitlistError("AUTO_SOURCE");
    const linked = links[0], baseSha = linked?.baseSha ?? autoGitCommitSha(item.repoRoot, `refs/heads/${repository.repo.developBranch ?? "develop"}`);
    const profile = ProjectCommandContract.inspect(item.project, item.repoRoot), questions: string[] = [];
    if (!profile) questions.push("The registered project check profile is unavailable; implementation admission must hold.");
    if (linked?.state === "materialized" && autoGitCommitSha(item.repoRoot, `refs/heads/${linked.branch}`) !== linked.headSha) questions.push("Original linked branch head requires its repository owner's reconciliation before implementation.");
    const documentEvents = new RegistryDocumentJournal(this.journal.db).events(item.project, item.ticket);
    if (documentPending(documentEvents).length) throw new AutoWaitlistError("AUTO_BUSY");
    const result: DraftFacts = { schemaVersion: "pa-auto-delegated-draft-request/v1", ticket, repoRoot: item.repoRoot, repositoryConfigSha256: workflowDigest(JSON.stringify(repository.repo)), repositoryObservation: repositoryObservation(item.repoRoot),
      branch: { name: linked?.branch ?? `feature/${item.ticket}-auto`, baseSha, headSha: linked?.headSha ?? null, state: linked?.state ?? "planned" },
      validation: profile ? { profileSha256: profile.sha256, commands: profile.checks.map(check => check.command) } : null,
      clock, documentRevision: documentEvents.length, documentEventsSha256: workflowDigest(JSON.stringify(documentEvents)),
      questions, configRoot: pair.configRoot, configRevision: pair.configRevision, resourcesSha256: pair.resourcesSha256, provider: pair.draft.provider, model: pair.draft.model, mode: pair.draft.mode };
    assertNoSensitiveMatch("content", JSON.stringify(result)); return result;
  }
  private remaining(g: AutoDraftGeneration): number {
    const facts = this.facts(g), native = readProcessFingerprint(process.pid);
    if (!native || native.bootId !== facts.clock?.bootId || !/^\d{1,30}$/.test(facts.clock.startedNs)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const elapsed = process.hrtime.bigint() - BigInt(facts.clock.startedNs);
    if (elapsed < 0n || Date.now() < Date.parse(g.createdAt)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    return Math.floor(Math.min(Date.parse(g.deadlineAt) - Date.now(), 1_800_000 - Number(elapsed) / 1_000_000));
  }
  private assertFacts(g: AutoDraftGeneration): void {
    if (this.remaining(g) <= 0) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const facts = this.facts(g), item = this.journal.item(g.itemId), pair = this.pairing(); pair.assertCurrent();
    const repository = resolveRepoExecutionPath(item.project), profile = ProjectCommandContract.inspect(item.project, item.repoRoot);
    if ((profile?.sha256 ?? null) !== (facts.validation?.profileSha256 ?? null) || workflowDigest(JSON.stringify(repository.repo)) !== facts.repositoryConfigSha256) throw new AutoWaitlistError("AUTO_SOURCE");
    if (pair.configRoot !== facts.configRoot || pair.configRevision !== facts.configRevision || pair.resourcesSha256 !== facts.resourcesSha256 || pair.draft.provider !== facts.provider || pair.draft.model !== facts.model || pair.draft.mode !== facts.mode
      || resolveRepoExecutionPath(item.project).repoRoot !== item.repoRoot || item.repoRoot !== facts.repoRoot || !isDeepStrictEqual(repositoryObservation(item.repoRoot), facts.repositoryObservation)
      || documentPending(new RegistryDocumentJournal(this.journal.db).events(item.project, item.ticket)).length) throw new AutoWaitlistError("AUTO_SOURCE");
    const events = new RegistryDocumentJournal(this.journal.db).events(item.project, item.ticket), extra = events.slice(facts.documentRevision);
    if (workflowDigest(JSON.stringify(events.slice(0, facts.documentRevision))) !== facts.documentEventsSha256 || extra.length > 1
      || extra.length === 1 && (!g.subjectSha256 || extra[0]!.data.kind !== "frozen" || extra[0]!.data.subjectSha256 !== g.subjectSha256)) throw new AutoWaitlistError("AUTO_SOURCE");
    for (const turn of this.drafts.turns(g)) if (turn.sourceSha256 && turn.outputSha256) {
      const request = parseAutoDraftReply(this.drafts.blob(turn.outputSha256)); if (request.action === "finish") throw new AutoWaitlistError("AUTO_SOURCE");
      let current: string; try { current = autoDraftRead(item.repoRoot, request); } catch { current = "Source unavailable through native policy. Preserve the limitation; do not bypass it."; }
      if (workflowDigest(current) !== turn.sourceSha256) throw new AutoWaitlistError("AUTO_SOURCE");
    }
    const ticket = this.tickets.get(item.ticket); if (!ticket || ticket.id !== facts.ticket.id || ticket.project !== facts.ticket.project) throw new AutoWaitlistError("AUTO_SOURCE");
    const version = autoDraftTicketVersion(ticket);
    if (version !== g.ticketVersion) {
      if (!g.appendSha256) throw new AutoWaitlistError("AUTO_SOURCE");
      const observed = this.tickets.observeAutoDraftAppend(this.drafts.blob(g.appendSha256, 65_536));
      if (!["ticket", "completed"].includes(observed.state) || observed.expectedVersion !== g.ticketVersion || observed.appliedVersion !== version || observed.currentVersion !== version) throw new AutoWaitlistError("AUTO_SOURCE");
    }
    if (this.remaining(g) <= 0) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  }
  private register(g: AutoDraftGeneration): void {
    const facts = this.facts(g), item = this.journal.item(g.itemId), events = getDeploymentEvents(g.deploymentId), starts = events.filter(e => e.event === "started");
    if (!starts.length) {
      if (events.length || this.drafts.turns(g).length) throw new AutoWaitlistError("AUTO_SOURCE");
      this.drafts.assertCurrent(g, this.host);
      emitStartedEvent({ deploymentId: g.deploymentId, team: "requirements", mode: facts.mode, ticketId: item.ticket, repo: item.repoRoot, repoRoot: item.repoRoot, worktreeRoot: item.repoRoot,
        runtime: "pi", binary: "ppa", provider: facts.provider, models: { team: facts.model }, effectiveTimeoutSeconds: Math.floor((Date.parse(g.deadlineAt) - Date.parse(g.createdAt)) / 1000), invocationChannel: "cli", note: `pa-auto-delegated-draft/v1:${g.operationId}` });
      // Registry liveness belongs to this producer controller. Each actual Pi
      // child incarnation remains separately bound in the immutable turn log.
      emitPidEvent({ deploymentId: g.deploymentId, team: "requirements", pid: process.pid });
    } else if (starts.length !== 1 || starts[0]!.team !== "requirements" || starts[0]!.runtime !== "pi" || starts[0]!.binary !== "ppa" || starts[0]!.mode !== facts.mode || starts[0]!.rogue_one || starts[0]!.note !== `pa-auto-delegated-draft/v1:${g.operationId}` || starts[0]!.ticket_id !== item.ticket || starts[0]!.repo_root !== item.repoRoot || starts[0]!.provider !== facts.provider || starts[0]!.models?.team !== facts.model) throw new AutoWaitlistError("AUTO_SOURCE");
  }
  private complete(g: AutoDraftGeneration): void {
    this.register(g);
    const status = g.state === "ready" ? "success" : g.state === "questions" ? "partial" : "failed", exitCode = g.state === "blocked" ? 1 : 0;
    const terminals = getDeploymentEvents(g.deploymentId).filter(e => e.event === "completed" || e.event === "crashed");
    if (terminals.length > 1 || terminals.length === 1 && (terminals[0]!.event !== "completed" || terminals[0]!.status !== status || terminals[0]!.exit_code !== exitCode)) throw new AutoWaitlistError("AUTO_SOURCE");
    if (!terminals.length) emitCompletedEvent({ deploymentId: g.deploymentId, team: "requirements", status: g.state === "ready" ? "success" : g.state === "questions" ? "partial" : "failed", exitCode: g.state === "blocked" ? 1 : 0,
      summary: g.state === "ready" ? "Own unsigned draft package and nonprimary ticket evidence saved; delegated admission remains separate."
        : g.state === "questions" ? "Own unsigned draft evidence saved with material questions; implementation remains held."
        : "Draft preparation did not produce a complete unsigned package.\nSource: PPA bounded draft and package owners.\nCondition: This generation did not reach native package freeze or ticket append. Original process and output evidence remain.\nReason: The native producer result was not admitted as a complete bounded draft. No stronger cause or repository-write containment is asserted.\nCorrection:\n1. Inspect the original item with ppa auto shortlist --json. Impact: read-only. Actor: agent or operator. New approval: not required. Prerequisite: supported candidate PPA inspection.\n2. Ask its runtime/requirements owner to reconcile the original result. Impact: none to ask. Actor: agent or operator. New approval: not required to ask; repairs need their own authority. Prerequisite: retained original-generation evidence.\nResume Action: Continue only after the owner establishes a corrected original intent; any effect request is admitted again. Inspection does not start a replacement producer or worker." });
  }
  private buildBundle(g: AutoDraftGeneration, final: Extract<AutoDraftReply, { action: "finish" }>, outputSha256: string): DraftBundle {
    const facts = this.facts(g), item = this.journal.item(g.itemId), folder = `agent-teams/requirements/artifacts/drafts/${g.deploymentId}`;
    const questions = [...new Set([...facts.questions, ...final.questions])];
    if (questions.length > 32 || questions.some(q => !q.trim() || q !== q.trim() || q.length > 2048 || /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(q))) throw new AutoWaitlistError("AUTO_SOURCE");
    const documents: Array<{ id: string; text: string }> = (["brief", "requirements", "uat"] as const).map(id => ({ id, text: `Agent-authored UNAPPROVED draft. No human content approval, implementation or UAT sign-off is asserted.\n\n${final[id]}` }));
    if (Buffer.byteLength(documents[0]!.text) > 16_384 || documents[0]!.text.split(/\s+/).length > 1000 || documents.reduce((n, d) => n + Buffer.byteLength(d.text), 0) > 1_048_576) throw new AutoWaitlistError("AUTO_LIMIT");
    documents.push({ id: "questions", text: JSON.stringify({ schemaVersion: "pa-auto-questions/v1", questions }) });
    const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: `auto-${g.operationId}`, revision: 1, repository: { key: item.project, root: item.repoRoot }, ticket: item.ticket, predecessor: null,
      members: documents.map(document => ({ id: document.id, role: document.id === "questions" ? "specification" : document.id as "brief" | "requirements" | "uat", mediaType: document.id === "questions" ? "text/plain" : "text/markdown",
        source: `${folder}/${document.id === "questions" ? "questions.json" : `${document.id}.md`}`, description: "Own agent-authored unsigned draft; genuine delegation/admission and final human review are separate", bytes: Buffer.byteLength(document.text), sha256: workflowDigest(document.text) })),
      references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
    if (!checkDocumentPackage(subject, documents.map(d => Buffer.from(d.text))).structuralPass) throw new AutoWaitlistError("AUTO_SOURCE");
    if (!questions.length) {
      const requirements = subject.members.find(m => m.role === "requirements")!, bytes = Buffer.from(documents.find(d => d.id === "requirements")!.text);
      const matrix = parseReviewMatrixPlan(bytes, `requirements:${documentDestination(subject, requirements)}`);
      const requirementText = bytes.toString("utf8"), ids = (value: string, prefix: string) => [...new Set(value.match(new RegExp(`\\b${prefix}-[A-Za-z0-9][A-Za-z0-9.-]*\\b`, "g")) ?? [])];
      if (["FR", "NFR", "AC", "TS"].some(prefix => !ids(requirementText, prefix).length) || ids(requirementText, "TS").some(id => !ids(final.uat, "TS").includes(id))) throw new AutoWaitlistError("AUTO_SOURCE");
      autoSourceScopeFromRequirements(bytes);
      if (!facts.validation || !isDeepStrictEqual(matrix.matrix.repository, { key: item.project, root: item.repoRoot, branch: facts.branch.name, baseSha: facts.branch.baseSha })
        || !matrix.matrix.commands.length || matrix.matrix.commands.some(command => !facts.validation!.commands.includes(command.command))) throw new AutoWaitlistError("AUTO_SOURCE");
    }
    return { schemaVersion: "pa-auto-delegated-draft-bundle/v1", requestSha256: g.requestSha256, outputSha256, subject, documents, questions };
  }
  private bundle(g: AutoDraftGeneration): DraftBundle {
    if (!g.bundleSha256 || !g.outputSha256) throw new AutoWaitlistError("AUTO_SOURCE");
    const b = JSON.parse(JSON.stringify(parseReviewEvidenceJson(this.drafts.blob(g.bundleSha256, 4 * 1_048_576), "auto.delegated.draft.bundle"))) as DraftBundle;
    const last = this.drafts.turns(g).at(-1), parsed = last?.outputSha256 ? parseAutoDraftReply(this.drafts.blob(last.outputSha256)) : null;
    if (!b || b.schemaVersion !== "pa-auto-delegated-draft-bundle/v1" || !parsed || parsed.action !== "finish" || !last?.outputSha256 || !isDeepStrictEqual(b, this.buildBundle(g, parsed, last.outputSha256))) throw new AutoWaitlistError("AUTO_SOURCE");
    return b;
  }
  private artifact(g: AutoDraftGeneration, member: DocumentPackage["members"][number], bytes: Buffer): void {
    this.drafts.assertCurrent(g, this.host); const folder = dirname(member.source); this.files.file(folder, undefined, true);
    const directory = openArtifactDirectory(join(this.root, folder), "ARTIFACT_STALE");
    try {
      let fd: number;
      try { fd = openSync(`/proc/self/fd/${directory}/${basename(member.source)}`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const retained = readArtifactFile(join(this.root, member.source), 1_048_576, "ARTIFACT_STALE"); if (!retained.equals(bytes)) throw new AutoWaitlistError("AUTO_SOURCE"); return; }
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); } fsyncSync(directory);
    } finally { closeSync(directory); }
    if (!readArtifactFile(join(this.root, member.source), 1_048_576, "ARTIFACT_STALE").equals(bytes)) throw new AutoWaitlistError("AUTO_SOURCE");
  }
  private finalize(g: AutoDraftGeneration): AutoDraftGeneration {
    const bundle = this.bundle(g), docs = new RegistryDocumentJournal(this.journal.db);
    if (g.state === "output-saved") {
      bundle.subject.members.forEach((member, i) => { this.artifact(g, member, Buffer.from(bundle.documents[i]!.text)); this.deps.afterStage?.("artifact"); });
      const sha = documentPackageSha(bundle.subject);
      g = this.drafts.freeze(g, sha, () => { docs.freeze(bundle.subject, docs.events(bundle.subject.repository.key, bundle.subject.ticket).length, bundle.documents.map(d => Buffer.from(d.text))); }, this.host);
      this.deps.afterStage?.("freeze");
    }
    if (g.state === "frozen") {
      const append: AutoDraftTicketAppend = { schemaVersion: "pa-auto-draft-ticket-append/v1", ticket: bundle.subject.ticket, project: this.journal.item(g.itemId).project, itemId: g.itemId, generation: g.generation,
        deploymentId: g.deploymentId, requestId: `operation-${randomUUID()}`, expectedVersion: g.ticketVersion,
        artifacts: bundle.subject.members.filter(member => ["brief", "requirements", "uat"].includes(member.role)).map(member => ({ role: member.role as "brief" | "requirements" | "uat", path: member.source, sha256: member.sha256 })),
        comment: "Own unsigned brief, requirements and UAT are attached as nonprimary draft evidence. Native delegated admission and final human review remain separate." };
      g = this.drafts.appendIntent(g, encoded(append), this.host);
    }
    if (g.state === "attaching") {
      const raw = this.drafts.blob(g.appendSha256!, 65_536), expected = parseAutoDraftTicketAppend(raw);
      this.tickets.appendAutoDraftWithIntent(raw, { assertCurrent: request => {
        if (!isDeepStrictEqual(request, expected)) throw new AutoWaitlistError("AUTO_SOURCE"); this.drafts.assertCurrent(g, this.host);
      }, assertArtifacts: request => {
        this.drafts.assertCurrent(g, this.host);
        for (const artifact of request.artifacts) {
          const member = bundle.subject.members.find(m => m.source === artifact.path);
          if (!member || member.sha256 !== artifact.sha256 || workflowDigest(readArtifactFile(join(this.root, artifact.path), 1_048_576, "ARTIFACT_STALE")) !== member.sha256) throw new AutoWaitlistError("AUTO_SOURCE");
        }
      } });
      this.deps.afterStage?.("append");
      g = this.drafts.finish(g, Boolean(bundle.questions.length), () => {
        const observed = this.tickets.observeAutoDraftAppend(raw);
        if (observed.state !== "completed" || observed.currentVersion !== observed.appliedVersion || this.tickets.pendingAutoDraftAppends(bundle.subject.ticket).length) throw new AutoWaitlistError("AUTO_BUSY");
      }, this.host);
      this.deps.afterStage?.("finish"); this.complete(g);
    }
    return g;
  }
  async run(item: AutoItem): Promise<AutoDraftGeneration> {
    this.authority.authenticate(); let g = this.drafts.current(item.itemId);
    let driver: AutoProducerProcessDriver | undefined;
    if (!g) {
      const choice = this.drafts.shortlists.selectionForItem(item.itemId); if (!choice) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      const admission: unknown = this.authority.authorizeDraft(item, choice);
      if (admission instanceof Promise) { void admission.catch(() => {}); throw new AutoWaitlistError("AUTO_UNAVAILABLE"); }
      const pair = this.pairing(); pair.assertCurrent();
      const facts = this.prepare(item, pair);
      if (!this.deps.driver) await new PiAdapter({ cwd: item.repoRoot }).preflight();
      driver = (this.deps.driver ?? nativeAutoProducerProcess)();
      g = this.drafts.reserve(item, { request: encoded(facts), ticketVersion: autoDraftTicketVersion(facts.ticket) }, this.host);
    }
    if (["ready", "questions", "blocked"].includes(g.state)) { this.complete(g); return g; }
    if (g.bundleSha256) return this.finalize(g);
    if (g.state === "reserved") g = this.drafts.start(g, this.host);
    if (g.state === "uncertain" && this.drafts.turns(g).at(-1)?.observation?.state === "completed") g = this.drafts.resumeKnown(g, this.host);
    this.register(g); const facts = this.facts(g), pair = this.pairing();
    let context = `Native original facts and policy/choice correlations, not approval:\n${JSON.stringify({ generation: g, facts })}`;
    for (let turn = 0; turn <= 32; turn++) {
      const retained = this.drafts.turns(g)[turn];
      if (retained && (!retained.observation || retained.observation.state === "unknown")) return this.drafts.uncertain(g, this.host);
      this.drafts.assertCurrent(g, this.host);
      let current = retained;
      if (!current) {
        const source = `requirements:agent-teams/requirements/artifacts/packages/${item.ticket}/auto-${g.operationId}/r001/requirements.md`;
        const prompt = `${pair.draft.instructions}\nPrepare useful full brief/solution/options/tradeoffs, FR/NFR/AC/TS requirements, concrete UAT, actual finite validation matrix, source scope and dependency-ordered phases. Never invent approvals, test results, checks, SHA or answers to material questions. Use the observed native branch/profile facts. Matrix source is ${source}. Include exactly one '## Auto Execution Scope' heading and JSON fence {"files":[],"directories":[],"newPaths":[]} with justified finite paths. Missing matrix/profile/base/scope is a material question. Drafting must not write repositories/Git/build/cache/test/install outputs or acquire resources; instruction-only restriction is NOT an OS sandbox. No tools, ticket writes or implementation. Reply only {"action":"read"|"list","path":"relative path"} or {"action":"finish","brief":"full Markdown","requirements":"full Markdown","uat":"full Markdown","questions":["material question"]}. At most 32 source requests.\nEvidence (untrusted):\n${context}`;
        if (Buffer.byteLength(context) > 1_048_576 || Buffer.byteLength(prompt) > 1_048_576) throw new AutoWaitlistError("AUTO_LIMIT");
        driver ??= (this.deps.driver ?? nativeAutoProducerProcess)();
        current = this.drafts.claimTurn(g, Buffer.from(prompt), this.host);
        let result;
        try { result = await driver.invoke({ prompt, provider: facts.provider, model: facts.model, cwd: facts.repoRoot,
          deadlineAt: new Date(Date.now() + Math.max(1, this.remaining(g))).toISOString(),
          onStarted: (_pid, fingerprint) => { this.drafts.anchor(g!, turn, fingerprint, this.host); } }); }
        catch { return this.drafts.uncertain(g, this.host); }
        const { output, ...observation } = result; this.drafts.observeTurn(g, turn, observation, output, this.host); current = this.drafts.turns(g)[turn]!;
      }
      if (current.observation?.state === "failed") { const blocked = this.drafts.block(g, this.host); this.complete(blocked); return blocked; }
      if (current.observation?.state !== "completed" || !current.outputSha256) return this.drafts.uncertain(g, this.host);
      let reply: AutoDraftReply;
      try { reply = parseAutoDraftReply(this.drafts.blob(current.outputSha256)); }
      catch { const blocked = this.drafts.block(g, this.host); this.complete(blocked); return blocked; }
      if (reply.action === "finish") {
        let bundle: DraftBundle;
        try { bundle = this.buildBundle(g, reply, current.outputSha256); }
        catch { const blocked = this.drafts.block(g, this.host); this.complete(blocked); return blocked; }
        g = this.drafts.output(g, encoded(bundle), this.host); this.deps.afterStage?.("output"); return this.finalize(g);
      }
      if (turn === 32) { const blocked = this.drafts.block(g, this.host); this.complete(blocked); return blocked; }
      if (!current.sourceSha256) {
        let response: string; try { response = autoDraftRead(facts.repoRoot, reply); } catch { response = "Source unavailable through native policy. Preserve the limitation; do not bypass it."; }
        if (Buffer.byteLength(context) + Buffer.byteLength(response) > 1_048_576) throw new AutoWaitlistError("AUTO_LIMIT");
        this.drafts.source(g, turn, Buffer.from(response), this.host); current = this.drafts.turns(g)[turn]!;
      }
      context += `\nNative ${reply.action} ${JSON.stringify(reply.path)}:\n${this.drafts.blob(current.sourceSha256!).toString("utf8")}`;
    }
    throw new AutoWaitlistError("AUTO_LIMIT");
  }
}
