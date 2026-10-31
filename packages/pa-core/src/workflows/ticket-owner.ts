import { isDeepStrictEqual } from "node:util";
import { TicketPairPublication, type TicketPublicationPair } from "../tickets/paired-publication.js";
import type { TicketStore } from "../tickets/store.js";
import type { RegistryWorkflowJournal } from "../registry/workflows.js";
import { digest, parseReviewBundle, reject, type EvidenceRef, type PackagePermission } from "./contracts.js";
import { replayWorkflow, requireDecision, type EffectIntent, type WorkflowCaller, type WorkflowEffectOwner, type WorkflowHost } from "./service.js";

/** Concrete adapters to the existing ticket mutex/audit/lifecycle owner. No default registration or enablement. */
export function createTicketWorkflowOwners(journal: RegistryWorkflowJournal, store: TicketStore, artifactRoot: string, authenticate: () => WorkflowCaller, continues?: WorkflowHost["continues"]): ReadonlyMap<string, WorkflowEffectOwner> {
  const publication = new TicketPairPublication(store, artifactRoot);
  const pair = (intent: EffectIntent): TicketPublicationPair => {
    const state = replayWorkflow(journal, intent.runId);
    if (intent.subjectSha256 !== state.subjectSha256 || intent.owner !== "tickets") reject("WORKFLOW_AUTHORITY");
    const subject = state.subject;
    if (subject.route.team !== "builder" || subject.route.mode !== "orchestrator") reject("WORKFLOW_CAPABILITY");
    const member = (ref: EvidenceRef) => ({ path: ref.ref.slice(ref.ref.indexOf(":") + 1), sha256: ref.sha256, raw: journal.snapshot(ref.sha256) });
    const result: TicketPublicationPair = { ticket: subject.ticket, project: subject.repository.key, requirements: member(subject.requirements), uat: member(subject.uat) };
    const publications = state.definition.steps.filter(step => step.operation.id === "publication.pair");
    const queues = state.definition.steps.filter(step => step.operation.id === "ticket.queue");
    // Follow ONLY the replay-validated explicit attempt chain. An intervening
    // changes-requested attempt has no publication; an observed failed/unknown
    // publication cannot be skipped in favour of a convenient older primary.
    for (const attempt of state.attempts.slice(0, -1).reverse()) {
      const outcomes = publications.map(step => attempt.outcomes[step.id]).filter(outcome => outcome !== undefined);
      if (!outcomes.length) continue;
      if (publications.length !== 1 || outcomes.length !== 1 || outcomes[0] !== "completed") reject("WORKFLOW_UNCERTAIN");
      const previous = parseReviewBundle(journal.snapshot(attempt.subjectSha256));
      result.predecessor = { requirements: member(previous.requirements), uat: member(previous.uat), queued: queues.length === 1 && attempt.outcomes[queues[0]!.id] === "completed" };
      break;
    }
    return result;
  };
  const authority = (intent: EffectIntent, permission: PackagePermission, operation: string, pending = true): void => {
    const state = replayWorkflow(journal, intent.runId), caller = authenticate();
    const step = state.definition.steps.find(s => s.id === intent.stepId);
    if ((!isDeepStrictEqual(caller, state.caller) && !continues?.(state.caller, caller)) || caller.repoKey !== state.subject.repository.key || caller.repoRoot !== state.subject.repository.root || caller.ticket !== state.subject.ticket
      || caller.team !== "requirements" || caller.mode !== "analyze" || intent.owner !== "tickets" || intent.subjectSha256 !== state.subjectSha256
      || !step || step.operation.id !== operation || (pending && !state.pending.some(i => isDeepStrictEqual(i, intent)))) reject("WORKFLOW_AUTHORITY");
    requireDecision(state, intent.decisionId, [permission]);
  };
  const evidence = (intent: EffectIntent, operation: string): EvidenceRef[] => {
    const p = pair(intent);
    const identity = { ticket: p.ticket, project: p.project, requirements: { path: p.requirements.path, sha256: p.requirements.sha256 }, uat: { path: p.uat.path, sha256: p.uat.sha256 },
      ...(p.predecessor ? { predecessor: { requirements: { path: p.predecessor.requirements.path, sha256: p.predecessor.requirements.sha256 }, uat: { path: p.predecessor.uat.path, sha256: p.predecessor.uat.sha256 }, queued: p.predecessor.queued } } : {}) };
    return [{ schemaVersion: "pa-workflow-evidence-ref/v1", ref: `registry-workflow:${intent.runId}:${intent.intentId}:${operation}`, version: "v1", sha256: digest(JSON.stringify({ intent, operation, pair: identity })) }];
  };
  const owners = new Map<string, WorkflowEffectOwner>();
  for (const operation of ["publication.pair", "ticket.queue"] as const) {
    const permission = operation === "publication.pair" ? "artifact.publish-pair" : "ticket.queue.advance";
    const observe: WorkflowEffectOwner["observe"] = async intent => {
      const p = pair(intent), observed = publication.observe(p);
      if (observed === "conflict" || observed === "unknown") return { state: observed };
      if (operation === "ticket.queue" && observed !== "complete") return { state: "unknown" };
      const proven = operation === "publication.pair" ? observed === "complete" : publication.queued(p);
      return proven ? { state: "proven", outcome: "completed", evidence: evidence(intent, operation) } : { state: "absent" };
    };
    owners.set(operation, {
      admit: (caller, subject, intent) => {
        authority(intent, permission, operation, false);
        const state = replayWorkflow(journal, intent.runId);
        if ((!isDeepStrictEqual(caller, state.caller) && !continues?.(state.caller, caller)) || !isDeepStrictEqual(subject, state.subject)) reject("WORKFLOW_AUTHORITY");
        pair(intent);
      },
      observe,
      execute: async intent => {
        const p = pair(intent), authorize = () => authority(intent, permission, operation);
        authorize();
        if (operation === "publication.pair") publication.publish(p, authorize); else publication.queue(p, authorize);
        return observe(intent);
      },
      verify: (intent, result) => {
        const p = pair(intent);
        return result.state === "proven" && result.outcome === "completed" && isDeepStrictEqual(result.evidence, evidence(intent, operation))
          && (operation === "publication.pair" ? publication.observe(p) === "complete" : publication.queued(p));
      },
    });
  }
  return owners;
}
