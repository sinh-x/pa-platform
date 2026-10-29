import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  createTicketWorkflowOwners, getAiUsageDir, getDb, RegistryWorkflowJournal, JsonWorkflowService, JsonWorkflowError,
  loadTemplateRegistry, produceWorkflowSubject, loadSelectedWorkflows, readCanonicalWorkflowArtifact, readReviewEvidenceFile,
  packageDecision, adoptedWorkflow, TicketStore, resolveTrustedTicketMutationContext, observeReadonlyRepositoryTicketSlot,
  type WorkflowHost, type WorkflowObservations, type WorkflowReadHost, type ReviewBundle, type JsonWorkflowEvidenceRef,
} from "@pa-platform/pa-core";
import { ProjectCommandContract } from "./project-command-contract.js";
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
export function piWorkflowObservations(subject?: ReviewBundle): WorkflowObservations {
  let profile: WorkflowObservations["projectProfile"] = "missing", producer: WorkflowObservations["producerContract"] = "missing";
  if (subject) { try { profile = ProjectCommandContract.inspect(subject.repository.key, subject.repository.root) ? "supported" : "missing"; } catch { profile = "unsupported"; } }
  try { if (loadTemplateRegistry().registry.entries.some(e => e.id === "review-bundle" && e.validation.kind === "review-bundle" && e.capabilities.render && e.capabilities.validate)) producer = "supported"; } catch { /* missing pair is a blocker, never fallback */ }
  return { capabilities: new Set(["operator.foreground", "artifact.paired-publication", "ticket.queue"]), projectProfile: profile, producerContract: producer, readEvidence: ref => sourceBytes(subject, ref) };
}
export function piWorkflowReadHost(): WorkflowReadHost { return { observations: piWorkflowObservations, operations: new Set(["publication.pair", "ticket.queue"]) }; }

export type PiWorkflowMutation = { action: "admit"; producer: string } | { action: "request-step"; revision: number; stepId: string }
  | { action: "reconcile"; revision: number; intentId: string } | { action: "capture"; revision: number; stepId: string } | { action: "revoke"; revision: number; decisionId: string };
/** Foreground mutation host. Public JSON never supplies a caller, callback, selected config, effect owner or outcome. */
export async function mutatePiWorkflow(request: PiWorkflowMutation, context: PiWorkflowContext): Promise<Record<string, unknown>> {
  const authenticate = () => authenticatePiWorkflowCaller(context);
  const caller = authenticate(), journal = new RegistryWorkflowJournal(getDb()), continues = createPiWorkflowContinuation(authenticate);
  let state = adoptedWorkflow(journal, caller.repoKey, caller.ticket);
  let subject = state?.subject;
  const selection = request.action === "admit" ? loadSelectedWorkflows() : undefined;
  if (request.action === "admit") {
    let occupied = false;
    try { observeReadonlyRepositoryTicketSlot(caller.repoRoot, caller.ticket); occupied = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new JsonWorkflowError("WORKFLOW_UNCERTAIN", "existing-ticket-lineage", "custody-owner"); }
    if (occupied) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "existing-ticket-lineage", "custody-owner");
    subject = produceWorkflowSubject(selection!, Buffer.from(request.producer), { team: caller.team, mode: caller.mode }).subject;
  }
  const store = new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: caller.deploymentId }, false));
  const host: WorkflowHost = { authenticate, observations: () => piWorkflowObservations(subject), capture: createPiWorkflowCapture(context, authenticate),
    owners: createTicketWorkflowOwners(journal, store, getAiUsageDir(), authenticate, continues), continues, now: () => new Date().toISOString() };
  const service = new JsonWorkflowService(journal, host);
  let decision: unknown;
  if (request.action === "admit") {
    if (state) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "existing-admitted-run", "workflow-owner");
    state = service.admitProduced(selection!, Buffer.from(request.producer), {});
    // Sticky discovery marker, not approval or a second source-of-truth store.
    store.update(caller.ticket, { add_doc_ref: { type: "workflow", path: `registry-workflow:${state.runId}` } }, "workflow/runtime");
  } else {
    if (!state) throw new JsonWorkflowError("WORKFLOW_SOURCE");
    if (request.action === "capture") decision = await service.decide(state.runId, request.revision, request.stepId);
    else if (request.action === "revoke") await service.revoke(state.runId, request.revision, request.decisionId);
    else if (request.action === "request-step") await service.requestStep(state.runId, request.revision, request.stepId, packageDecision(state));
    else await service.reconcile(state.runId, request.revision, request.intentId);
    state = service.status(state.runId);
  }
  return { schemaVersion: "pa-workflow-result/v1", ok: true, action: request.action, result: { runId: state.runId, revision: state.revision, subjectSha256: state.subjectSha256, outcomes: state.outcomes, revoked: state.revoked, reconcile: state.pending, ...(decision ? { decision } : {}) }, executionAdmitted: false };
}
