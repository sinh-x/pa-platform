import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  createTicketWorkflowOwners, getAiUsageDir, getDb, RegistryWorkflowJournal, JsonWorkflowService, JsonWorkflowError,
  loadTemplateRegistry, produceWorkflowSubject, loadSelectedWorkflows, readCanonicalWorkflowArtifact, readReviewEvidenceFile,
  packageDecision, adoptedWorkflow, TicketStore, resolveTrustedTicketMutationContext, observeReadonlyRepositoryTicketSlot,
  workflowTemplateError, TemplateError, captureWorkflowResources, retainedTemplateHost, retainedWorkflowSelection,
  assertRetainedConfigIdentity, withExistingWorkflowJournal, readTicketWorkflow,
  type TemplateHost,
  type WorkflowRepository, type WorkflowHost, type WorkflowObservations, type WorkflowReadHost, type ReviewBundle, type JsonWorkflowEvidenceRef,
} from "@pa-platform/pa-core";
import { ProjectCommandContract } from "./project-command-contract.js";
import { createPiSourceWorkflowOwner } from "./workflow-source.js";
import { createPiMatrixWorkflowOwner } from "./workflow-matrix.js";
import { authenticatePiWorkflowCaller, createPiWorkflowCapture, createPiWorkflowContinuation, type PiWorkflowContext } from "./workflow-native.js";

/** Exact preview location derives from the immutable subject, never directory discovery or a tool path override. */
function sourceBytes(subject: ReviewBundle | undefined, ref: JsonWorkflowEvidenceRef): Uint8Array | null {
  const relative = ref.ref.slice(ref.ref.indexOf(":") + 1), canonical = join(getAiUsageDir(), relative);
  try { lstatSync(canonical); return readCanonicalWorkflowArtifact(ref.ref); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !subject) return null;
    const name = ref.ref === subject.requirements.ref ? "requirements.md" : ref.ref === subject.uat.ref ? "uat-preview.md" : null;
    if (!name) return null;
    const revision = `r${String(subject.revision).padStart(3, "0")}`;
    try { return readReviewEvidenceFile(join(getAiUsageDir(), "agent-teams/requirements/artifacts/reviews", subject.ticket, revision, name), 1_048_576, "workflow.preview"); }
    catch { return null; }
  }
}
export function piWorkflowObservations(subject?: ReviewBundle, repository?: WorkflowRepository, retained?: TemplateHost): WorkflowObservations {
  if (subject && repository && (subject.repository.key !== repository.key || subject.repository.root !== repository.root)) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "ticket-repository", "repository-owner");
  const repo = repository ?? subject?.repository;
  let profile: WorkflowObservations["projectProfile"] = "uninspected", producer: WorkflowObservations["producerContract"] = "missing";
  let producerFailure: JsonWorkflowError | undefined;
  if (repo) { try { profile = ProjectCommandContract.inspect(repo.key, repo.root) ? "supported" : "missing"; } catch { profile = "unsupported"; } }
  try {
    const entry = loadTemplateRegistry(retained?.selection, retained?.resources).registry.entries.find(e => e.id === "review-bundle" && e.validation.kind === "review-bundle");
    if (entry) {
      producer = entry.capabilities.render && entry.capabilities.validate ? "supported" : "unsupported";
      if (producer === "unsupported") producerFailure = workflowTemplateError("TEMPLATE_CAPABILITY");
    }
  } catch (error) {
    producer = "unsupported";
    producerFailure = workflowTemplateError(error instanceof TemplateError ? error.code : undefined);
  }
  return { capabilities: new Set(["operator.foreground", "artifact.paired-publication", "ticket.queue", "execution.scoped-local", "validation.matrix"]), projectProfile: profile, producerContract: producer, ...(producerFailure ? { producerFailure } : {}), readEvidence: ref => sourceBytes(subject, ref) };
}
export function piWorkflowReadHost(): WorkflowReadHost { return { observations: (subject, repository, state) => withExistingWorkflowJournal(journal => {
  if (!state) return piWorkflowObservations(subject, repository);
  if (!journal || !state.resources) return { ...piWorkflowObservations(subject, repository), producerContract: "unsupported", producerFailure: new JsonWorkflowError("WORKFLOW_SOURCE", "retained-resource-closure", "config-runtime-owner") };
  return piWorkflowObservations(subject, repository, retainedTemplateHost(journal, state));
}), operations: new Set(["publication.pair", "ticket.queue", "source.local", "check.matrix"]) }; }
/** Unsigned read-context selection only, not caller/effect authority. Public JSON
 * cannot select a run or import resources; all bytes come from the existing journal. */
export function piRetainedTemplateHost(): TemplateHost {
  if (!process.env.PA_TICKET_ID || process.env.PA_ROGUE_ONE === "1" || !["requirements", "builder"].includes(process.env.PA_TEAM ?? "")) return {};
  try {
    const state = readTicketWorkflow(process.env.PA_TICKET_ID); if (!state) return {};
    assertRetainedConfigIdentity(state);
    const team = process.env.PA_TEAM!, mode = process.env.PA_MODE!;
    if (!state.resources?.routes.some(route => route.team === team && route.mode === mode)) throw new Error("unretained route");
    return withExistingWorkflowJournal(journal => { if (!journal) throw new Error("missing journal"); return { ...retainedTemplateHost(journal, state), team, mode }; });
  } catch { throw new TemplateError("TEMPLATE_PAIR", "retained-resource-closure", "original retained resources and physical selection are required; preserve history and do not fall back to current templates"); }
}

export type PiWorkflowMutation = { action: "admit"; producer: string } | { action: "revise"; revision: number; producer: string } | { action: "request-step"; revision: number; stepId: string }
  | { action: "reconcile"; revision: number; intentId: string } | { action: "capture"; revision: number; stepId: string } | { action: "revoke"; revision: number; decisionId: string };
/** Foreground mutation host. Public JSON never supplies a caller, callback, selected config, effect owner or outcome. */
export async function mutatePiWorkflow(request: PiWorkflowMutation, context: PiWorkflowContext): Promise<Record<string, unknown>> {
  const authenticate = () => authenticatePiWorkflowCaller(context);
  const caller = authenticate(), journal = new RegistryWorkflowJournal(getDb()), continues = createPiWorkflowContinuation(authenticate);
  let state = adoptedWorkflow(journal, caller.repoKey, caller.ticket);
  let subject = state?.subject;
  if (state?.resources && request.action !== "revoke" && request.action !== "reconcile") assertRetainedConfigIdentity(state);
  const pinnedTemplates = state?.resources ? retainedTemplateHost(journal, state) : undefined;
  const selection = request.action === "admit" ? loadSelectedWorkflows() : request.action === "revise" && state ? retainedWorkflowSelection(journal, state) : undefined;
  if (request.action === "admit" || request.action === "revise") {
    let occupied = false;
    try { observeReadonlyRepositoryTicketSlot(caller.repoRoot, caller.ticket); occupied = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new JsonWorkflowError("WORKFLOW_UNCERTAIN", "existing-ticket-lineage", "custody-owner"); }
    if (occupied) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "existing-ticket-lineage", "custody-owner");
    if (!selection) throw new JsonWorkflowError("WORKFLOW_SOURCE", "retained-resource-closure", "workflow-owner");
    subject = produceWorkflowSubject(selection, Buffer.from(request.producer), { ...(request.action === "revise" ? pinnedTemplates : {}), team: caller.team, mode: caller.mode }).subject;
  }
  const store = new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: caller.deploymentId }, false));
  const host: WorkflowHost = { authenticate, resources: captureWorkflowResources, observations: () => piWorkflowObservations(subject, undefined, pinnedTemplates), capture: createPiWorkflowCapture(context, authenticate),
    owners: new Map([...createTicketWorkflowOwners(journal, store, getAiUsageDir(), authenticate, continues), ["source.local", createPiSourceWorkflowOwner(journal, authenticate, continues)] as const, ["check.matrix", createPiMatrixWorkflowOwner(journal, authenticate, continues)] as const]), continues, now: () => new Date().toISOString() };
  const service = new JsonWorkflowService(journal, host);
  let decision: unknown;
  if (request.action === "admit") {
    if (state) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "existing-admitted-run", "workflow-owner");
    state = service.admitProduced(selection!, Buffer.from(request.producer), {});
    // Sticky discovery marker, not approval or a second source-of-truth store.
    store.update(caller.ticket, { add_doc_ref: { type: "workflow", path: `registry-workflow:${state.runId}` } }, "workflow/runtime");
  } else {
    if (!state) throw new JsonWorkflowError("WORKFLOW_SOURCE");
    if (request.action === "revise") state = service.reviseProduced(state.runId, request.revision, selection!, Buffer.from(request.producer), {});
    else if (request.action === "capture") decision = await service.decide(state.runId, request.revision, request.stepId);
    else if (request.action === "revoke") await service.revoke(state.runId, request.revision, request.decisionId);
    else if (request.action === "request-step") await service.requestStep(state.runId, request.revision, request.stepId, packageDecision(state));
    else await service.reconcile(state.runId, request.revision, request.intentId);
    state = service.status(state.runId);
  }
  return { schemaVersion: "pa-workflow-result/v1", ok: true, action: request.action, result: { runId: state.runId, revision: state.revision, subjectSha256: state.subjectSha256, outcomes: state.outcomes, attempts: state.attempts, revoked: state.revoked, reconcile: state.pending, ...(decision ? { decision } : {}) }, executionAdmitted: false };
}
