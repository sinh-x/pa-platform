import { randomUUID, createHash } from "node:crypto";
import { userInfo } from "node:os";
import { lstatSync, readFileSync } from "node:fs";
import { readPiProcessIdentity } from "./process-identity.js";
import { isDeepStrictEqual } from "node:util";
import { getDeployPaths, readProcessFingerprint, queryDeploymentStatus, getDeploymentEvents, getDeploymentsByTicketId, workflowCoordinator, coordinatorAdoptionEligible, coordinatorAdoptionPurpose, JsonWorkflowError, MAX_WORKFLOW_RECORD_BYTES, type WorkflowCaller, type WorkflowState, type WorkflowHost } from "@pa-platform/pa-core";
import { assertPiDocumentContinuation } from "./workflow-document.js";
import { authenticatePiPreparationCaller, type PiPreparationContext } from "./pi-extension/prepared-workflow.js";

export interface PiWorkflowContext extends PiPreparationContext {
  readonly ui?: { select(title: string, choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined> };
}
export function authenticatePiWorkflowCaller(context: PiWorkflowContext, env: NodeJS.ProcessEnv = process.env): WorkflowCaller {
  // Reuse existing registry/process-incarnation/canonical-root/foreground authentication, not environment identity alone.
  const caller = authenticatePiPreparationCaller(context, env);
  return { deploymentId: caller.deploymentId, repoKey: caller.repoKey, repoRoot: caller.repoRoot, ticket: caller.ticket,
    team: "requirements", mode: "analyze", identitySha256: caller.callerIdentity };
}
/** Current caller is authenticated by the existing foreground/process owner, never supplied by JSON.
 * Only immutable registry resume edges of the SAME role/repository/ticket can continue an admitted run. */
export function createPiWorkflowContinuation(authenticate: () => WorkflowCaller): NonNullable<WorkflowHost["continues"]> {
  return (original, current) => {
    if (!isDeepStrictEqual(authenticate(), current) || original.repoKey !== current.repoKey || original.repoRoot !== current.repoRoot || original.ticket !== current.ticket
      || original.team !== current.team || original.mode !== current.mode) return false;
    let id = current.deploymentId; const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(id)) return false; seen.add(id);
      const status = queryDeploymentStatus(id), starts = getDeploymentEvents(id).filter(e => e.event === "started"), start = starts[0];
      if (!status || starts.length !== 1 || !start || start.runtime !== "pi" || start.binary !== "ppa" || start.team !== original.team || start.mode !== original.mode
        || start.repo_root !== original.repoRoot || start.repo !== original.repoRoot || start.worktree_root !== original.repoRoot || start.ticket_id !== original.ticket || start.builder_authority || start.rogue_one
        || status.runtime !== "pi" || status.team !== original.team || status.mode !== original.mode
        || status.repo_root !== original.repoRoot || status.ticket_id !== original.ticket || status.rogue_one
        || (depth === 0 ? status.status !== "running" : status.status === "running")) return false;
      if (id === original.deploymentId) return true;
      const predecessor = starts[0]!.resumed_from_deployment_id;
      if (!predecessor || predecessor !== status.resumed_from_deployment_id) return false;
      id = predecessor;
    }
    return false;
  };
}
/** Fail closed on absent historical anchors, PID reuse, unreadable procfs and
 * staged completion. Terminal registry evidence alone never releases an owner. */
export function assertPiWorkflowCoordinatorInactive(owner: WorkflowCaller): void {
  const candidates = getDeploymentsByTicketId(owner.ticket);
  if (candidates.length > 256) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "coordinator-lineage-unbounded", "coordinator-owner");
  const seen = new Set<string>();
  const check = (caller: WorkflowCaller) => {
    if (seen.has(caller.deploymentId)) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "coordinator-lineage-conflict", "coordinator-owner");
    seen.add(caller.deploymentId);
    assertInactiveIncarnation(caller);
    for (const candidate of candidates.filter(c => c.resumed_from_deployment_id === caller.deploymentId)) {
      // A supported resume remains an owner even without a workflow mutation.
      // A nonowning auditor has no such edge and cannot block this proof.
      check({ ...caller, deploymentId: candidate.deploy_id });
    }
  };
  check(owner);
}
function assertInactiveIncarnation(owner: WorkflowCaller): void {
  const fail = (gate: string): never => { throw new JsonWorkflowError("WORKFLOW_AUTHORITY", gate, "coordinator-owner"); };
  try {
    const status = queryDeploymentStatus(owner.deploymentId), starts = getDeploymentEvents(owner.deploymentId).filter(e => e.event === "started");
    const start = starts[0];
    if (!status || starts.length !== 1 || !start || start.runtime !== "pi" || start.binary !== "ppa"
      || start.team !== owner.team || start.mode !== owner.mode || start.ticket_id !== owner.ticket
      || start.repo_root !== owner.repoRoot || start.repo !== owner.repoRoot || start.worktree_root !== owner.repoRoot || start.rogue_one || start.builder_authority
      || status.runtime !== "pi" || status.team !== owner.team || status.mode !== owner.mode || status.ticket_id !== owner.ticket
      || status.repo_root !== owner.repoRoot || status.rogue_one || status.builder_authority) fail("coordinator-identity-unproven");
    if (!["success", "partial", "failed", "crashed", "dead"].includes(status!.status)) fail("coordinator-lifecycle-unsettled");
    const anchor = readPiProcessIdentity(owner.deploymentId, getDeployPaths(owner.deploymentId).deployDir);
    if (anchor.pid !== status!.pid || readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== anchor.bootId) fail("coordinator-incarnation-unproven");
    const live = readProcessFingerprint(anchor.pid);
    if (live) fail(isDeepStrictEqual(live, anchor) ? "coordinator-live" : "coordinator-pid-reused");
    // readProcessFingerprint intentionally collapses read errors; only a real
    // ENOENT on procfs constitutes death here, not EACCES or malformed data.
    try { lstatSync(`/proc/${anchor.pid}`); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    fail("coordinator-liveness-unknown");
  } catch (error) { if (error instanceof JsonWorkflowError) throw error; fail("coordinator-liveness-unknown"); }
}
export function piWorkflowCoordinatorCaller(state: WorkflowState, context: PiWorkflowContext): Record<string, unknown> {
  try {
    const current = authenticatePiWorkflowCaller(context), effective = workflowCoordinator(state);
    if (current.repoKey !== state.subject.repository.key || current.repoRoot !== state.subject.repository.root || current.ticket !== state.subject.ticket
      || current.team !== effective.team || current.mode !== effective.mode) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "coordinator-caller-context", "launcher-owner");
    if (isDeepStrictEqual(current, effective)) return { status: "authenticated-coordinator", relation: "exact", effectsAdmitted: false };
    if (createPiWorkflowContinuation(() => authenticatePiWorkflowCaller(context))(effective, current)) return { status: "authenticated-coordinator", relation: "registry-resume", effectsAdmitted: false };
    if (!coordinatorAdoptionEligible(state)) return { status: "adoption-ineligible", correctionOwner: "workflow-owner", effectsAdmitted: false };
    assertPiWorkflowCoordinatorInactive(effective);
    if (coordinatorAdoptionPurpose(state) === "document-continuation") assertPiDocumentContinuation(state, state.subject, false);
    return { status: "eligible-for-native-adoption-consent", purpose: coordinatorAdoptionPurpose(state), correctionOwner: "operator", effectsAdmitted: false };
  } catch (error) {
    const failure = error instanceof JsonWorkflowError ? error : new JsonWorkflowError("WORKFLOW_AUTHORITY", "foreground-caller-unproven", "launcher-owner");
    return { status: "blocked", code: failure.code, gateId: failure.gateId, correctionOwner: failure.correctionOwner, effectsAdmitted: false };
  }
}
const CHOICES = ["Approve exact package and displayed permissions", "Reject exact package", "Request changes", "Cancel"];
const TECHNICAL = "View exact technical bindings";
const visible = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
function pages(lines: string[]): string[] {
  const wrapped = lines.flatMap(line => {
    const text = Array.from(visible(line)), result: string[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 72, text.length);
      if (end < text.length) { const space = text.lastIndexOf(" ", end); if (space >= start + 24) end = space; }
      result.push(text.slice(start, end).join("")); start = end;
      if (text[start] === " ") start++;
    }
    return result.length ? result : [""];
  });
  const result: string[] = [];
  for (let index = 0; index < wrapped.length; index += 9) result.push(wrapped.slice(index, index + 9).join("\n"));
  return result;
}
/** Native-only port. All finite scope is reviewed in short ordinary-language
 * pages before the decision. Exact JSON is optional technical detail, never the
 * primary question. Capture evidence binds both source bytes and presentation.
 */
export function createPiWorkflowCapture(context: PiWorkflowContext, authenticate: () => WorkflowCaller = () => authenticatePiWorkflowCaller(context), signal?: AbortSignal): WorkflowHost["capture"] {
  return async request => {
    if (context.mode !== "tui" || !context.ui?.select) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "native-foreground", "operator");
    if (signal?.aborted) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "cancelled-native-request", "operator");
    const before = authenticate(), subject = request.subject;
    const recovering = request.action === "recover", adopting = request.action === "adopt";
    if (adopting && (!request.succession || !isDeepStrictEqual(request.succession.current, before))) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "coordinator-binding", "coordinator-owner");
    const raw = JSON.stringify(request, null, 2);
    if (Buffer.byteLength(raw, "utf8") > MAX_WORKFLOW_RECORD_BYTES) throw new JsonWorkflowError("WORKFLOW_CONTRACT", "decision-request-size", "package-owner");
    const list = (title: string, values: readonly string[]) => [title, ...(values.length ? values.map(value => `- ${value}`) : ["- none"])];
    const identifiers = (title: string, values: readonly string[]) => [`${title}: ${values.length ? values.join(", ") : "none"}`];
    const review = pages([
      `${subject.ticket}: review the exact implementation plan`,
      `Plan: ${subject.subjectId.replace(/[-.]/g, " ")}`,
      adopting ? "Decide whether this fresh foreground session may continue the retained workflow. This is not package approval."
        : recovering ? `Resume cancelled review ${request.decisionId}. Previous cancellation stays in history; only your fresh decision can grant permissions.`
        : request.action === "revoke" ? `Revoke decision ${request.decisionId}; this does not undo completed effects.` : "Approve, reject, request changes, or cancel this exact package.",
      ...(adopting ? [
        `Continue this retained workflow from ${request.succession!.previous.deploymentId} in ${request.succession!.current.deploymentId}.`,
        "The previous coordinator must be inactive. This transfers coordination of this exact retained package only.",
        "It does not approve the package, renew revoked permissions, run checks, publish, queue or launch a builder.",
        request.succession!.purpose === "document-continuation"
          ? "Document continuation only: revise and review documents, then publish an exactly approved pair. No source/check execution or builder custody is transferred. Queueing the adopted package is denied; only a NEW revised subject's exact approval can separately authorize its queue operation."
          : "Only cancelled review recovery or settlement of the existing queue intent is eligible. A separate package review is required for cancellation recovery.",
        `Continuation purpose: ${request.succession!.purpose}.`,
        ...(request.succession!.queueIntent ? [`Existing queue intent: ${request.succession!.queueIntent.intentId}`, `Existing package decision: ${request.succession!.queueIntent.decisionId}`] : []),
      ] : []),
      "Approval is not a claim that tests or human UAT passed.",
      `Repository: ${subject.repository.key} (${subject.repository.root})`,
      `Route: ${subject.route.team}/${subject.route.mode}`,
      `Branch: ${subject.handoff.branch} (${subject.handoff.branchAction})`,
      `Base: ${subject.handoff.baseSha}`,
      ...(subject.handoff.type === "amendment" ? [`Feature: ${subject.handoff.featureSha}`] : []),
      ...(["requirements", "uat", "matrix"] as const).flatMap(kind => [`${kind}: ${subject[kind].version}`, subject[kind].ref]),
      "Exact document/check hashes are bound by the subject SHA256; full bindings are available in technical details.",
      ...identifiers("Requirements", subject.scope.requirements), ...identifiers("Acceptance criteria", subject.scope.acceptanceCriteria),
      ...list("Files", subject.scope.files), ...list("Directories", subject.scope.directories), ...list("New paths", subject.scope.newPaths),
      ...identifiers("Checks (IDs in the exact matrix above)", subject.scope.checks.map(check => check.commandId)),
      ...list("Requested permissions", subject.requestedPermissions), ...list("Excluded effects", subject.scope.excludedEffects),
      `Run: ${request.runId}; revision: ${request.revision}`, `Subject: ${subject.subjectId}; revision: ${subject.revision}`, `Subject SHA256: ${request.subjectSha256}`,
      `Workflow: ${subject.workflow.id}/${subject.workflow.version}`,
      ...(request.resources ? [`Pinned config: ${request.resources.configRevision}`] : []),
    ]);
    const technical = pages(raw.split("\n")), transcript: { title: string; selected: string | null }[] = [];
    const select = async (title: string, choices: string[]) => {
      if (signal?.aborted) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "cancelled-native-request", "operator");
      const selected = await context.ui!.select(title, choices, signal ? { signal } : undefined);
      if (signal?.aborted) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "cancelled-native-request", "operator");
      transcript.push({ title, selected: choices.includes(selected ?? "") ? selected! : null }); return selected;
    };
    const readPages = async (label: string, content: string[]) => {
      for (let index = 0; index < content.length; index++) if (await select(`${label} ${index + 1}/${content.length}\n${content[index]}`, ["Continue review", "Cancel"]) !== "Continue review") return false;
      return true;
    };
    let selected: string | undefined;
    if (await readPages(adopting ? "Continue retained workflow" : recovering ? "Resume cancelled package review" : "Exact package review", review)) {
      const choices = adopting ? ["Continue this exact retained workflow", "Cancel", TECHNICAL] : request.action === "revoke" ? ["Revoke this exact decision", "Cancel", TECHNICAL] : [...CHOICES, TECHNICAL];
      for (let attempt = 0; attempt < 16; attempt++) {
        selected = await select(`${visible(subject.ticket)}: ${adopting ? "transfer coordination of this retained workflow?" : request.action === "revoke" ? "revoke the named decision?" : "approve the reviewed plan and its finite permissions?"}\nNo scope beyond the reviewed pages is granted.\nSubject SHA256:\n${request.subjectSha256}`, choices);
        if (selected !== TECHNICAL) break;
        selected = undefined;
        if (!await readPages("Technical bindings", technical)) break;
      }
    }
    const after = authenticate();
    if (signal?.aborted) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "cancelled-native-request", "operator");
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "stale-native-caller", "launcher-owner");
    const outcome = adopting ? selected === "Continue this exact retained workflow" ? "approved" : "cancelled" : request.action === "revoke" ? selected === "Revoke this exact decision" ? "approved" : "cancelled"
      : selected === CHOICES[0] ? "approved" : selected === CHOICES[1] ? "rejected" : selected === CHOICES[2] ? "changes-requested" : "cancelled";
    const captureId = randomUUID();
    const sha256 = createHash("sha256").update(JSON.stringify({ schemaVersion: "pa-native-review/v2", captureId, caller: before.identitySha256, raw, review, transcript, outcome })).digest("hex");
    return { outcome, principal: `local-uid:${userInfo().uid}`, evidence: { schemaVersion: "pa-workflow-evidence-ref/v1", ref: `native-workflow-capture:${captureId}`, version: "v2", sha256 } };
  };
}
