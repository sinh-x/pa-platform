import { lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { readPiProcessIdentity } from "./process-identity.js";
import { userInfo } from "node:os";
import {
  AUTO_LOCAL_EFFECTS, AUTO_EXCLUDED_EFFECTS, AutoCoordinator, AutoStartDecisionService, AutoWaitlistError,
  RegistryAutoJournal, RegistryDocumentJournal, DocumentPackageService, TicketPackagePublication, TicketStore,
  autoMaterialTicketSha256, autoSourceScopeFromRequirements, parseAutoSourceScope, parseReviewEvidenceJson, parseAutoStartIntent, autoStartSha256, documentDestination, documentCompletedOperation,
  documentDecisionRecords, documentRevokedDecisionIds, documentPending, documentPendingAutoReviews, documentRetiredSubjects,
  getAiUsageDir, getTicketsDir, assertLocalFileSource, readArtifactFile, getDeployPaths, getDeploymentEvents, readProcessFingerprint, observeReadonlyRepositoryAuthority, observeReadonlyRepositoryTicketSlot, parseReviewMatrixPlan, resolveDeployTimeoutSeconds,
  resolveRepoExecutionPath, resolveTrustedTicketMutationContext, scanAutoWaitlist, statusVersion, workflowDigest, assertNoSensitiveMatch,
  type AutoItem, type AutoStartIntent, type AutoStartCaptureHost, type AutoOwnerObservation, type AutoEffect, type AutoWorkOwner, type DeployRequest,
} from "@pa-platform/pa-core";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { autoDraftOwner } from "./auto-draft.js";
import { captureAutoFullReview, type AutoTerminal } from "./auto-terminal.js";
import { selectedPiAutoPair } from "./auto-contract.js";
import { deployWithPi, type PiDeployDependencies } from "./deploy.js";
import type { AutoForegroundHooks } from "./auto-foreground.js";
import { ProjectCommandContract } from "./project-command-contract.js";
import { inspectAutoNativeResult } from "./auto-result.js";
import { autoGitCommitSha as nativeGit } from "./auto-git.js";

function nativeIdentity(terminal: AutoTerminal): string {
  terminal.authenticate(); const process = readProcessFingerprint(globalThis.process.pid);
  if (!process) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  return workflowDigest(JSON.stringify(["ppa-auto-foreground/v1", userInfo().uid, process]));
}
function startOwner(journal: RegistryAutoJournal, terminal: AutoTerminal) {
  const documents = new RegistryDocumentJournal(journal.db), service = new AutoStartDecisionService(documents, journal), tickets = new TicketStore();
  const assertCurrent: AutoStartCaptureHost["assertCurrent"] = (item, intent) => {
    const pair = selectedPiAutoPair(); pair.assertCurrent();
    const repository = resolveRepoExecutionPath(item.project), ticket = tickets.get(item.ticket);
    if (!ticket || ticket.project !== item.project || repository.repoRoot !== item.repoRoot || intent.repository.root !== item.repoRoot
      || autoMaterialTicketSha256(ticket) !== intent.materialTicketSha256 || pair.configRoot !== intent.configRoot || pair.configRevision !== intent.configRevision || pair.resourcesSha256 !== intent.configResourcesSha256
      || pair.implementation.provider !== intent.provider || pair.implementation.model !== intent.model || Date.parse(intent.deadlineAt) <= Date.now()) throw new AutoWaitlistError("AUTO_SOURCE");
    const profile = ProjectCommandContract.inspect(item.project, item.repoRoot);
    if (!profile || profile.sha256 !== intent.validation.profileSha256 || intent.validation.commands.some(command => !profile.checks.some(c => c.command === command))) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const observed = scanAutoWaitlist().entries.find(e => e.id === item.ticket);
    if (!observed || observed.archived || ["done", "rejected", "cancelled", "review-uat"].includes(observed.status) || observed.unresolvedDependencies.length || observed.blockingBulletins.length || observed.originalWorkflow
      || observed.competingDeployments.some(id => id !== item.draft?.deploymentId && id !== item.dispatch?.deploymentId)) throw new AutoWaitlistError("AUTO_SOURCE");
    if (observed.status === "implementing" && (!item.dispatch || !getDeploymentEvents(item.dispatch.deploymentId).some(e => e.event === "started"))) throw new AutoWaitlistError("AUTO_SOURCE");
    const events = documents.events(item.project, item.ticket);
    const ownQueue = events.some(e => e.data.kind === "intent" && e.data.operation === "queue" && e.data.subjectSha256 === item.subjectSha256 && e.data.decisionId === item.decisionId);
    if (ticket.assignee !== intent.initialAssignee && !(ownQueue && ticket.assignee === "builder/team-manager")) throw new AutoWaitlistError("AUTO_SOURCE");
    if (documentRetiredSubjects(events).has(intent.subjectSha256) || events.filter(e => e.data.kind === "frozen").at(-1)?.data.subjectSha256 !== intent.subjectSha256
      || documentPending(events).some(effect => effect.decisionId !== item.decisionId || !["publish", "queue"].includes(effect.operation))) throw new AutoWaitlistError("AUTO_SOURCE");
    if (intent.documentScope !== "publish-and-queue") {
      const decision = documentDecisionRecords(events, intent.subjectSha256).at(-1);
      if (!decision || decision.outcome !== "approved" || documentRevokedDecisionIds(events).has(decision.decisionId)
        || new TicketPackagePublication(tickets, getAiUsageDir()).observe(documents.subject(intent.subjectSha256)) !== "complete") throw new AutoWaitlistError("AUTO_SOURCE");
    }
    const links = ticket.linkedBranches.filter(b => b.repo === item.project);
    if (links.length > 1 || links.length === 1 && (links[0]!.branch !== intent.branch.name || links[0]!.state === "materialized" && links[0]!.baseSha !== intent.branch.baseSha)) throw new AutoWaitlistError("AUTO_SOURCE");
    if (intent.branch.state === "planned" && !links.some(l => l.state === "materialized") && nativeGit(item.repoRoot, `refs/heads/${repository.repo.developBranch ?? "develop"}`) !== intent.branch.baseSha) throw new AutoWaitlistError("AUTO_SOURCE");
    if (intent.branch.state === "materialized" && !item.dispatch && nativeGit(item.repoRoot, `refs/heads/${intent.branch.name}`) !== intent.branch.headSha) throw new AutoWaitlistError("AUTO_SOURCE");
  };
  const host: AutoStartCaptureHost = {
    authenticate: () => nativeIdentity(terminal), assertCurrent,
    withdraw: async item => {
      const chosen = await terminal.choose(`Withdraw the saved start proposal for ${item.ticket} and request changes? Existing documents/history remain; this does not repair or cancel any running effect.`, ["Withdraw this never-dispatched start proposal"]);
      terminal.authenticate();
      const evidence = Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-withdraw/v1", itemId: item.itemId, startSha256: item.startSha256, decisionId: item.decisionId, selected: chosen === 0, identity: nativeIdentity(terminal) }));
      return { outcome: chosen === 0 ? "approved" : "cancelled", principal: `local-uid:${userInfo().uid}`, evidence, evidenceSha256: workflowDigest(evidence) };
    },
    capture: async (item, intent) => {
      const subject = documents.subject(intent.subjectSha256);
      const capture = await captureAutoFullReview({ subject, subjectSha256: intent.subjectSha256, documents: subject.members.map(m => documents.snapshot(m.sha256)), startIntent: intent,
        startSha256: autoStartSha256(intent), documentScope: intent.documentScope }, terminal);
      return { ...capture };
    },
  };
  return { service, host, documents, tickets };
}
export function buildPiAutoStartIntent(item: AutoItem, journal: RegistryAutoJournal, sourceScope?: AutoStartIntent["sourceScope"]): AutoStartIntent {
  if (!item.subjectSha256) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  const pair = selectedPiAutoPair(), tickets = new TicketStore(), ticket = tickets.get(item.ticket), repository = resolveRepoExecutionPath(item.project), documents = new RegistryDocumentJournal(journal.db);
  if (!ticket || ticket.project !== item.project || repository.repoRoot !== item.repoRoot) throw new AutoWaitlistError("AUTO_SOURCE");
  const subject = documents.subject(item.subjectSha256), req = subject.members.find(m => m.role === "requirements")!;
  const questions = subject.members.find(m => m.id === "questions" && m.role === "specification");
  if (questions) {
    const pending = parseReviewEvidenceJson(documents.snapshot(questions.sha256), "auto.material-questions");
    const record = pending as Record<string, unknown>;
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).sort().join(",") !== "questions,schemaVersion"
      || record.schemaVersion !== "pa-auto-questions/v1" || !Array.isArray(record.questions) || record.questions.length > 0) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  }
  const matrix = parseReviewMatrixPlan(documents.snapshot(req.sha256), `requirements:${documentDestination(subject, req)}`);
  const profile = ProjectCommandContract.inspect(item.project, item.repoRoot);
  if (!profile) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  const links = ticket.linkedBranches.filter(b => b.repo === item.project);
  if (links.length > 1) throw new AutoWaitlistError("AUTO_SOURCE");
  const linked = links[0], base = linked?.baseSha ?? nativeGit(item.repoRoot, `refs/heads/${repository.repo.developBranch ?? "develop"}`);
  const timeout = resolveDeployTimeoutSeconds({}); if ("error" in timeout) throw new AutoWaitlistError("AUTO_SOURCE");
  const published = new TicketPackagePublication(tickets, getAiUsageDir()).observe(subject) === "complete";
  const documentScope = !published ? "publish-and-queue" : ticket.status === "pending-implementation" && ticket.assignee === "builder/team-manager" ? "none" : "queue-only";
  const objective = `${ticket.title}\n${ticket.description}\nImplement only this exact approved package. Inspect/edit/check/repair and local commits only. Stop review-ready or blocked; no push, PR, merge, release, deploy, ticket-done, checkout return or human UAT sign-off.`;
  const intent = parseAutoStartIntent(Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-start/v1", itemId: item.itemId, ticket: item.ticket, repository: { key: item.project, root: item.repoRoot },
    materialTicketSha256: autoMaterialTicketSha256(ticket), ticketVersion: statusVersion(ticket), initialStatus: ticket.status, initialAssignee: ticket.assignee,
    subjectSha256: item.subjectSha256, documentRevision: subject.revision, runtime: "pi", team: "builder", mode: "orchestrator", provider: pair.implementation.provider, model: pair.implementation.model,
    configRoot: pair.configRoot, configRevision: pair.configRevision, configResourcesSha256: pair.resourcesSha256, objective, timeoutSeconds: timeout.timeout,
    deadlineAt: new Date(Date.now() + timeout.timeout * 1000).toISOString(), branch: { name: linked?.branch ?? matrix.matrix.repository.branch, state: linked?.state ?? "planned", baseSha: base, headSha: linked?.headSha ?? null },
    validation: { matrixSha256: matrix.digest, profileSha256: profile.sha256, commands: matrix.matrix.commands.map(c => c.command) }, sourceScope: sourceScope ?? autoSourceScopeFromRequirements(documents.snapshot(req.sha256)), localEffects: AUTO_LOCAL_EFFECTS, excludedEffects: AUTO_EXCLUDED_EFFECTS, documentScope })));
  if (!isDeepStrictEqual(matrix.matrix.repository, { key: item.project, root: item.repoRoot, baseSha: intent.branch.baseSha, branch: intent.branch.name })) throw new AutoWaitlistError("AUTO_SOURCE");
  assertNoSensitiveMatch("content", JSON.stringify(intent)); pair.assertCurrent(); return intent;
}
/** Factual original-owner settlement only: no kill, lease release, checkout
 * return or inference from a missing reply. Reused before ready/close claims. */
function assertPiAutoSettled(item: AutoItem): void {
  if (!item.dispatch) throw new AutoWaitlistError("AUTO_BUSY");
  const id = item.dispatch.deploymentId, events = getDeploymentEvents(id), start = events.find(e => e.event === "started"), pid = events.filter(e => e.event === "pid").at(-1)?.pid;
  if (!start?.worktree_root || !pid || readPiProcessIdentity(id, getDeployPaths(id).deployDir).pid !== pid || readProcessFingerprint(pid)) throw new AutoWaitlistError("AUTO_BUSY");
  try { lstatSync(`/proc/${pid}`); throw new AutoWaitlistError("AUTO_BUSY"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const physical = resolveRepoExecutionPath(undefined, start.worktree_root, { allowLinkedWorktreeCwd: true }), authority = observeReadonlyRepositoryAuthority(physical.gitDir);
  if (physical.repoRoot !== item.repoRoot || authority.owner || authority.implement || authority.borrower || authority.review) throw new AutoWaitlistError("AUTO_BUSY");
  try { observeReadonlyRepositoryTicketSlot(item.repoRoot, item.ticket); throw new AutoWaitlistError("AUTO_BUSY"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function completeApprovedTicketEffects(item: AutoItem, journal: RegistryAutoJournal, terminal: AutoTerminal): Promise<void> {
  const { service, host, documents } = startOwner(journal, terminal), intent = service.authorize(item, host);
  terminal.authenticate();
  // The genuine native operator host owns these finite effects. This is not
  // imported actor/privileged JSON, nor an agent role switch.
  const tickets = new TicketStore(undefined, resolveTrustedTicketMutationContext({ operator: true }, true));
  if (intent.initialStatus === "idea") {
    tickets.setStatusWithIntent(item.ticket, intent.ticketVersion, "requirement-review", "auto/runtime", { scope: item.startSha256!, requestId: `auto-stage-${item.itemId}` },
      { assertCurrent: () => { service.authorize(journal.item(item.itemId), host); } });
  }
  const documentService = new DocumentPackageService(documents, { artifactRoot: getAiUsageDir(), tickets,
    authenticate: () => ({ deploymentId: item.dispatch!.deploymentId, repoKey: item.project, repoRoot: item.repoRoot, ticket: item.ticket, identitySha256: host.authenticate() }),
    assertEffectAvailable: () => { service.authorize(journal.item(item.itemId), host); }, capture: async () => { throw new AutoWaitlistError("AUTO_UNAVAILABLE"); } });
  for (const action of intent.documentScope === "publish-and-queue" ? ["publish", "queue"] : intent.documentScope === "queue-only" ? ["queue"] : []) {
    const events = documents.events(item.project, item.ticket);
    const result = await documentService.execute(JSON.stringify({ action, sha256: intent.subjectSha256, expectedRevision: events.length, decisionId: item.decisionId }));
    if (result.ok !== true) throw new AutoWaitlistError("AUTO_SOURCE");
  }
  tickets.withWorkflowTransaction(() => {
    service.authorize(journal.item(item.itemId), host);
    const current = tickets.get(item.ticket)!;
    if (!current.linkedBranches.some(b => b.repo === item.project)) tickets.update(item.ticket, { add_linked_branch: { repo: item.project, branch: intent.branch.name } }, "auto/runtime");
  });
}
export function piAutoImplementationOwner(journal: RegistryAutoJournal, terminal: AutoTerminal,
  launch: typeof deployWithPi = deployWithPi): AutoWorkOwner {
  const { service, host, documents } = startOwner(journal, terminal);
  const observe = async (item: AutoItem, effect: AutoEffect): Promise<AutoOwnerObservation> => {
    const intent = service.intent(item), events = getDeploymentEvents(effect.deploymentId), starts = events.filter(e => e.event === "started"), start = starts[0];
    if (starts.length !== 1 || !start || start.team !== "builder" || start.mode !== "orchestrator" || start.runtime !== "pi" || start.binary !== "ppa" || start.ticket_id !== item.ticket
      || start.repo_root !== item.repoRoot || start.provider !== intent.provider || start.models?.team !== intent.model || start.rogue_one) return { state: "unknown", settled: false };
    const terminals = events.filter(e => e.event === "completed" || e.event === "crashed"), terminal = terminals[0];
    if (terminals.length > 1) return { state: "unknown", settled: false };
    if (!terminal) {
      try {
        const pid = events.filter(e => e.event === "pid").at(-1)?.pid, anchor = readPiProcessIdentity(effect.deploymentId, getDeployPaths(effect.deploymentId).deployDir);
        return pid && isDeepStrictEqual(readProcessFingerprint(pid), anchor) ? { state: "running", settled: false } : { state: "unknown", settled: false };
      } catch { return { state: "unknown", settled: false }; }
    }
    // A terminal label is not checks/UAT success. Admission/finalization owns
    // cleanup; an error/crash retains the service slot for original reconciliation.
    if (terminal.event === "completed" && terminal.status === "success" && terminal.exit_code === 0) {
      try { assertPiAutoSettled(item); } catch { return { state: "unknown", settled: false }; }
      const actual = inspectAutoNativeResult(item, intent);
      return actual.state === "proven" ? { state: "review-ready", settled: true } : { state: "blocked", settled: true };
    }
    return { state: "failed", settled: false };
  };
  const continueOriginal = async (item: AutoItem, effect: AutoEffect): Promise<AutoOwnerObservation> => {
    const stage = journal.effectStage(effect);
    if (stage === "launch-requested") return observe(item, effect);
    const intent = service.authorize(journal.item(item.itemId), host);
    if (stage === "claimed") journal.advanceEffect(item, effect, "claimed", "ticket-effects", () => { service.authorize(journal.item(item.itemId), host); });
    await completeApprovedTicketEffects(item, journal, terminal);
    const remaining = Math.min(intent.timeoutSeconds, Math.floor((Date.parse(intent.deadlineAt) - Date.now()) / 60_000) * 60);
    if (remaining < 60) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const request: DeployRequest = { team: "builder", mode: "orchestrator", runtime: "pi", repo: item.project, ticket: item.ticket, objective: intent.objective,
      provider: intent.provider, model: intent.model, timeout: remaining, background: false, invocationChannel: "cli" };
    const dependencies: PiDeployDependencies = { autoLaunch: { deploymentId: effect.deploymentId, deadlineAt: intent.deadlineAt,
      baseline: () => service.baseline(journal.item(item.itemId), host),
      assertCurrent: (candidate, resolved) => {
        const control = journal.control(); if (control.paused || !control.dispatchEnabled) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
        service.authorize(journal.item(item.itemId), host);
        if (JSON.stringify(candidate) !== JSON.stringify(request) || resolved && (resolved.provider !== intent.provider || resolved.model !== intent.model)) throw new AutoWaitlistError("AUTO_SOURCE");
      } } };
    journal.advanceEffect(item, effect, "ticket-effects", "launch-requested", () => { dependencies.autoLaunch!.assertCurrent(request); });
    await launch(request, undefined, undefined, dependencies);
    return observe(journal.item(item.itemId), effect);
  };
  return { admit(item) { service.authorize(item, host); }, observe, reconcile: continueOriginal, async execute(item, effect) {
    service.authorize(item, host);
    if (!journal.claimEffect(item, effect, () => { service.authorize(journal.item(item.itemId), host); })) return observe(item, effect);
    return continueOriginal(item, effect);
  } };
}
/** Persist once before the owning launch. Reply-loss recovery ONLY observes the
 * saved deployment; it never repeats publication/admission/spawn from absence. */
export async function dispatchPiAuto(item: AutoItem, journal: RegistryAutoJournal, terminal: AutoTerminal, owner = piAutoImplementationOwner(journal, terminal)): Promise<AutoItem> {
  const coordinator = new AutoCoordinator(journal, () => terminal.authenticate());
  if (item.dispatch) return coordinator.reconcile(item, owner, "dispatch");
  const control = journal.control();
  if (control.paused || !control.dispatchEnabled || item.state !== "approved-pending-dispatch") throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  owner.admit?.(item);
  const effect: AutoEffect = { operationId: `operation-${randomUUID()}`, deploymentId: `d-${randomUUID().replaceAll("-", "").slice(0, 6)}`, state: "intent" };
  const saved = journal.change(item.itemId, item.revision, before => {
    const current = journal.control(); if (current.paused || !current.dispatchEnabled) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    return { ...before, state: "running", dispatch: effect };
  }, () => terminal.authenticate());
  try { return coordinator.apply(saved, "dispatch", await owner.execute(saved, effect)); }
  catch { return coordinator.apply(saved, "dispatch", { state: "unknown", settled: false }); }
}
export const piAutoForegroundHooks: AutoForegroundHooks = {
  async review(item, journal, terminal) {
    const { service, host } = startOwner(journal, terminal);
    let current = item;
    if (!current.startSha256) {
      let sourceScope: AutoStartIntent["sourceScope"] | undefined;
      if (current.subjectSha256) {
        const subject = new RegistryDocumentJournal(journal.db).subject(current.subjectSha256), req = subject.members.find(m => m.role === "requirements")!;
        const text = new RegistryDocumentJournal(journal.db).snapshot(req.sha256).toString("utf8");
        if (!/^## Auto Execution Scope$/m.test(text)) {
          if (!terminal.input) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
          const raw = await terminal.input('The existing package remains unchanged. Propose the finite local source scope for START review as JSON {"files":[],"directories":["exact-relative-directory"],"newPaths":[]}. This is unsigned scope data, not approval.');
          if (raw === null || Buffer.byteLength(raw) > 65_536) return current;
          sourceScope = parseAutoSourceScope(parseReviewEvidenceJson(Buffer.from(raw), "auto.proposed-scope"));
        }
      }
      current = service.propose(current, buildPiAutoStartIntent(current, journal, sourceScope), host);
    }
    current = await service.review(current, host);
    if (current.state === "approved-pending-dispatch") {
      const control = journal.control();
      if (control.paused || !control.dispatchEnabled) terminal.display("Start approval saved; dispatch is paused. No worker is confirmed. Enable compatible new work, then resume this SAME decision without another approval.");
      else current = await dispatchPiAuto(current, journal, terminal);
    }
    return current;
  },
  reconcile: async (item, journal, terminal) => dispatchPiAuto(item, journal, terminal),
  async revise(item, journal, terminal) {
    const { service, host } = startOwner(journal, terminal);
    return service.requestChanges(item, host);
  },
  async redraft(item, journal, terminal) {
    terminal.authenticate();
    if (item.dispatch || !terminal.input) throw new AutoWaitlistError("AUTO_BUSY");
    const { service, host, documents } = startOwner(journal, terminal);
    let current = item;
    if (current.startSha256 || current.decisionId) current = await service.requestChanges(current, host);
    if (current.startSha256 || current.decisionId) return current;
    const notes = await terminal.input("Describe the requested unsigned requirements/UAT changes. The original package is retained; no implementation or publication is authorized.");
    if (notes === null) return current;
    if (Buffer.byteLength(notes) > 16384) throw new AutoWaitlistError("AUTO_INPUT");
    assertNoSensitiveMatch("content", notes);
    const path = join(getTicketsDir(), `${current.ticket}.json`); assertLocalFileSource(path);
    const sha = workflowDigest(readArtifactFile(path, 1_048_576, "ARTIFACT_STALE"));
    const coordinator = new AutoCoordinator(journal, () => terminal.authenticate());
    current = coordinator.prepareRedraft(current, sha, original => {
      if (documentPending(documents.events(original.project, original.ticket)).length || documentPendingAutoReviews(documents.events(original.project, original.ticket)).length || resolveRepoExecutionPath(original.project).repoRoot !== original.repoRoot) throw new AutoWaitlistError("AUTO_BUSY");
    });
    return coordinator.draft(current, autoDraftOwner(journal, () => terminal.authenticate(), undefined, undefined, notes));
  },
  async close(item, journal, terminal) {
    terminal.authenticate(); const documents = new RegistryDocumentJournal(journal.db);
    if (documentPending(documents.events(item.project, item.ticket)).length || documentPendingAutoReviews(documents.events(item.project, item.ticket)).length) throw new AutoWaitlistError("AUTO_BUSY");
    if (item.dispatch) {
      const owner = piAutoImplementationOwner(journal, terminal), observation = await owner.observe(item, item.dispatch);
      if (observation.state !== "review-ready" && observation.state !== "failed" && observation.state !== "blocked") throw new AutoWaitlistError("AUTO_BUSY");
    }
    if (await terminal.choose(`Close the settled service item ${item.ticket}? This frees only coordination, never checkout/custody, files or ticket status.`, ["Close this settled service item"]) !== 0) return item;
    return new AutoCoordinator(journal, () => terminal.authenticate()).close(item, "closed", current => {
      if (documentPending(documents.events(current.project, current.ticket)).length || documentPendingAutoReviews(documents.events(current.project, current.ticket)).length) throw new AutoWaitlistError("AUTO_BUSY");
      if (!current.dispatch) return;
      assertPiAutoSettled(current);
    });
  },
  async enable(journal, terminal) {
    terminal.authenticate(); selectedPiAutoPair().assertCurrent();
    if (await terminal.choose("Enable compatible new scans/dispatch? This is service coordination, not approval of any ticket, and does not install a timer.", ["Enable new compatible work"]) !== 0) return;
    const c = journal.control(); journal.setControl(c.revision, { paused: false, scansEnabled: true, dispatchEnabled: true }, () => { terminal.authenticate(); selectedPiAutoPair().assertCurrent(); });
  },
};
