import { randomUUID } from "node:crypto";
import type { TemplateHost } from "../templates/service.js";
import { readWorkflowEvidence } from "./evidence.js";
import { produceWorkflowSubject } from "./producer.js";
import { RegistryWorkflowJournal, type WorkflowJournalEntry } from "../registry/workflows.js";
import { array, digest, evidenceRef, ID, integer, workflowTicket, literal, object, oneOf, PACKAGE_PERMISSIONS, parseReviewBundle, reject, JsonWorkflowError, SHA256, strictJson, STEP_OUTCOMES, text, unique, type EvidenceRef, type PackagePermission, type ReviewBundle, type StepOutcome, type WorkflowDefinition } from "./contracts.js";
import { evaluatePredicate, parseWorkflowDefinition } from "./definition.js";
import { preflightWorkflow, preflightPinnedWorkflow, projectExecutionPrerequisites, type WorkflowObservations, type WorkflowPreflight } from "./preflight.js";
import { subjectRevisionReason, type WorkflowAttempt } from "./revisions.js";
import { selectNewWorkflow, type WorkflowSelection } from "./selected.js";

export interface WorkflowCaller { deploymentId: string; repoKey: string; repoRoot: string; ticket: string; team: string; mode: string; identitySha256: string }
export interface WorkflowDecision {
  schemaVersion: "pa-decision/v1"; decisionId: string; kind: "package"; runId: string; stepId: string;
  subjectRef: string; subjectSha256: string; outcome: "approved" | "rejected" | "changes-requested" | "cancelled";
  permissions: PackagePermission[]; captureEvidenceRef: EvidenceRef; principal: string; issuedAt: string;
}
export interface EffectIntent { intentId: string; runId: string; stepId: string; owner: string; decisionId: string; subjectSha256: string }
export type EffectObservation = { state: "absent" } | { state: "pending" } | { state: "unknown" | "conflict" } | { state: "proven"; outcome: StepOutcome; evidence: EvidenceRef[] };
/** Existing service implements admission AND idempotency/reconciliation. Declaration metadata cannot supply these ports. */
export interface WorkflowEffectOwner {
  admit(caller: WorkflowCaller, subject: ReviewBundle, intent: EffectIntent): void;
  observe(intent: EffectIntent): Promise<EffectObservation>;
  execute(intent: EffectIntent): Promise<EffectObservation>;
  verify(intent: EffectIntent, observation: EffectObservation): boolean;
  /** Existing owner may serialize final verification and registry settlement
   * with its effect boundary. Holding a lock is not source/custody authority. */
  settle?<T>(intent: EffectIntent, action: () => T): T;
}
export interface WorkflowHost {
  authenticate(): WorkflowCaller;
  observations(): WorkflowObservations;
  capture(request: { action: "package" | "revoke"; runId: string; revision: number; subject: ReviewBundle; subjectSha256: string; decisionId?: string }): Promise<{ outcome: WorkflowDecision["outcome"]; principal: string; evidence: EvidenceRef }>;
  owners: ReadonlyMap<string, WorkflowEffectOwner>;
  /** Runtime-authenticated registry/process continuation only; never a public flag. */
  continues?(original: WorkflowCaller, current: WorkflowCaller): boolean;
  now(): string;
}
export interface WorkflowState {
  runId: string; revision: number; definition: WorkflowDefinition; subject: ReviewBundle; subjectSha256: string;
  configRevision: string; caller: WorkflowCaller; decisions: WorkflowDecision[]; revoked: string[];
  outcomes: Record<string, StepOutcome>; pending: EffectIntent[]; attempts: WorkflowAttempt[];
}
function parseCaller(value: unknown): WorkflowCaller {
  const r = object(value, ["deploymentId", "repoKey", "repoRoot", "ticket", "team", "mode", "identitySha256"]);
  return { deploymentId: text(r.deploymentId, /^d-[a-f0-9]{6}$/), repoKey: text(r.repoKey, ID), repoRoot: text(r.repoRoot), ticket: workflowTicket(r.ticket),
    team: text(r.team, ID), mode: text(r.mode, ID), identitySha256: text(r.identitySha256, SHA256) };
}
function parseDecision(value: unknown): WorkflowDecision {
  const r = object(value, ["schemaVersion", "decisionId", "kind", "runId", "stepId", "subjectRef", "subjectSha256", "outcome", "permissions", "captureEvidenceRef", "principal", "issuedAt"]);
  const issuedAt = text(r.issuedAt); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(issuedAt) || !Number.isFinite(Date.parse(issuedAt))) reject();
  return { schemaVersion: literal(r.schemaVersion, "pa-decision/v1"), decisionId: text(r.decisionId, ID), kind: literal(r.kind, "package"), runId: text(r.runId, ID), stepId: text(r.stepId, ID),
    subjectRef: text(r.subjectRef, ID), subjectSha256: text(r.subjectSha256, SHA256), outcome: oneOf(r.outcome, STEP_OUTCOMES.decision),
    permissions: unique(array(r.permissions, p => oneOf(p, PACKAGE_PERMISSIONS))), captureEvidenceRef: evidenceRef(r.captureEvidenceRef), principal: text(r.principal), issuedAt };
}
function parseIntent(value: unknown): EffectIntent {
  const r = object(value, ["intentId", "runId", "stepId", "owner", "decisionId", "subjectSha256"]);
  return { intentId: text(r.intentId, ID), runId: text(r.runId, ID), stepId: text(r.stepId, ID), owner: text(r.owner, ID), decisionId: text(r.decisionId, ID), subjectSha256: text(r.subjectSha256, SHA256) };
}
function context(state: WorkflowState): Record<string, string> {
  return { "repository.key": state.subject.repository.key, ticket: state.subject.ticket, "route.team": state.subject.route.team, "route.mode": state.subject.route.mode, "handoff.type": state.subject.handoff.type, runtime: "pi" };
}
export function eligibleSteps(state: WorkflowState): string[] {
  return state.definition.steps.filter(s => state.outcomes[s.id] === undefined && !state.pending.some(i => i.stepId === s.id)
    && evaluatePredicate(s.when, context(state)) && s.dependsOn.every(d => d.outcome !== "unknown" && state.outcomes[d.stepId] === d.outcome
      && state.definition.steps.find(producer => producer.id === d.stepId)?.transitions[d.outcome] === s.id)).map(s => s.id);
}
/** Pure replay validates every event's discriminated grammar and semantic predecessor. No exported JSON is accepted as state. */
export function replayWorkflow(journal: RegistryWorkflowJournal, runId: string, entries = journal.read(runId)): WorkflowState {
  const first = entries[0]; if (!first || first.event.type !== "admitted") reject("WORKFLOW_UNCERTAIN");
  const a = object(first.event.data, ["definitionSha256", "subjectSha256", "configRevision", "caller"], ["producerSha256"]);
  let subjectSha256 = text(a.subjectSha256, SHA256); const definitionSha256 = text(a.definitionSha256, SHA256);
  const definition = parseWorkflowDefinition(journal.snapshot(definitionSha256)); let subject = parseReviewBundle(journal.snapshot(subjectSha256));
  if (subject.workflow.sha256 !== definitionSha256 || subject.workflow.id !== definition.workflowId || subject.workflow.version !== definition.version) reject("WORKFLOW_UNCERTAIN");
  const state: WorkflowState = { runId, revision: 1, definition, subject, subjectSha256, configRevision: text(a.configRevision, /^[a-f0-9]{40}$/), caller: parseCaller(a.caller), decisions: [], revoked: [], outcomes: Object.create(null) as Record<string, StepOutcome>, pending: [], attempts: [] };
  state.attempts.push({ attemptId: `attempt-${runId}`, predecessor: null, subjectRef: subject.subjectId, subjectSha256, revision: 1, reason: "initial", outcomes: state.outcomes });
  assertSubjectCaller(state, state.caller, false);
  if (a.producerSha256 !== undefined) verifyRetainedProducer(journal, state, a.producerSha256);
  for (const entry of entries.slice(1)) {
    const { type, data } = entry.event;
    if (type === "subject-revised") {
      const r = object(data, ["previousSubjectSha256", "subjectSha256", "previousAttemptId", "attemptId", "reason"], ["producerSha256"]);
      const next = parseReviewBundle(journal.snapshot(text(r.subjectSha256, SHA256)));
      const previous = state.attempts.at(-1)!;
      if (r.previousSubjectSha256 !== subjectSha256 || r.previousAttemptId !== previous.attemptId || subjectRevisionReason(state, next) !== r.reason) reject("WORKFLOW_UNCERTAIN");
      const attemptId = text(r.attemptId, ID);
      if (state.attempts.some(attempt => attempt.attemptId === attemptId)) reject("WORKFLOW_UNCERTAIN");
      subject = next; subjectSha256 = text(r.subjectSha256, SHA256);
      state.subject = subject; state.subjectSha256 = subjectSha256; state.outcomes = Object.create(null) as Record<string, StepOutcome>;
      state.attempts.push({ attemptId, predecessor: previous.attemptId, subjectRef: subject.subjectId, subjectSha256, revision: entry.revision, reason: oneOf(r.reason, ["changes-requested", "material-amendment"]), outcomes: state.outcomes });
      readWorkflowEvidence(subject, ref => journal.snapshot(ref.sha256));
      if (r.producerSha256 !== undefined) verifyRetainedProducer(journal, state, r.producerSha256);
    } else if (type === "decision") {
      const r = object(data, ["record"]); const d = parseDecision(r.record);
      const step = definition.steps.find(s => s.id === d.stepId);
      if (d.runId !== runId || d.subjectSha256 !== subjectSha256 || d.subjectRef !== subject.subjectId || !step || step.kind !== "decision" || !eligibleSteps(state).includes(step.id)
        || state.decisions.some(old => old.decisionId === d.decisionId || old.captureEvidenceRef.ref === d.captureEvidenceRef.ref)
        || (d.outcome === "approved" ? d.permissions.length !== subject.requestedPermissions.length || subject.requestedPermissions.some(p => !d.permissions.includes(p)) : d.permissions.length !== 0)) reject("WORKFLOW_UNCERTAIN");
      state.decisions.push(d); state.outcomes[d.stepId] = d.outcome;
    } else if (type === "revocation") {
      const r = object(data, ["decisionId", "captureEvidenceRef", "principal"]); const id = text(r.decisionId, ID); evidenceRef(r.captureEvidenceRef); text(r.principal);
      if (!state.decisions.some(d => d.decisionId === id) || state.revoked.includes(id)) reject("WORKFLOW_UNCERTAIN");
      state.revoked.push(id);
    } else if (type === "intent") {
      const r = object(data, ["intent"]); const intent = parseIntent(r.intent);
      const step = definition.steps.find(s => s.id === intent.stepId);
      if (!step || step.kind === "decision" || intent.runId !== runId || intent.subjectSha256 !== subjectSha256 || intent.owner !== step.owner || !eligibleSteps(state).includes(step.id)) reject("WORKFLOW_UNCERTAIN");
      requireDecision(state, intent.decisionId, step.authorization); state.pending.push(intent);
    } else if (type === "reconcile") {
      const r = object(data, ["intentId"]); if (!state.pending.some(i => i.intentId === text(r.intentId, ID))) reject("WORKFLOW_UNCERTAIN");
    } else if (type === "result") {
      const r = object(data, ["intentId", "outcome", "evidence"]); const intentId = text(r.intentId, ID);
      const intent = state.pending.find(i => i.intentId === intentId); if (!intent) reject("WORKFLOW_UNCERTAIN");
      const step = definition.steps.find(s => s.id === intent.stepId)!;
      const outcome = oneOf(r.outcome, STEP_OUTCOMES[step.kind]); const refs = array(r.evidence, evidenceRef); if (!refs.length) reject("WORKFLOW_UNCERTAIN");
      state.outcomes[step.id] = outcome; state.pending = state.pending.filter(i => i.intentId !== intentId);
    } else reject("WORKFLOW_UNCERTAIN");
    state.revision = entry.revision;
  }
  return state;
}
function assertSubjectCaller(state: WorkflowState, caller: WorkflowCaller, exactIdentity = true, continues?: WorkflowHost["continues"]): void {
  if (caller.repoKey !== state.subject.repository.key || caller.repoRoot !== state.subject.repository.root || caller.ticket !== state.subject.ticket
    || (exactIdentity && (caller.team !== state.caller.team || caller.mode !== state.caller.mode
      || ((caller.deploymentId !== state.caller.deploymentId || caller.identitySha256 !== state.caller.identitySha256) && !continues?.(state.caller, caller))))) reject("WORKFLOW_AUTHORITY");
}
function verifyRetainedProducer(journal: RegistryWorkflowJournal, state: WorkflowState, producerSha256: unknown): void {
  const p = object(strictJson(journal.snapshot(text(producerSha256, SHA256))), ["schemaVersion", "unsigned", "requestSha256", "producer"]);
  literal(p.schemaVersion, "pa-workflow-producer-provenance/v1"); text(p.requestSha256, SHA256);
  const producer = p.producer as Record<string, unknown>;
  if (p.unsigned !== true || producer?.candidateSha256 !== state.subjectSha256 || producer.configRevision !== state.configRevision || producer.consumerContract !== "pa-review-bundle/v1") reject("WORKFLOW_UNCERTAIN");
  readWorkflowEvidence(state.subject, ref => journal.snapshot(ref.sha256));
}
export function requireDecision(state: WorkflowState, id: string, permissions: readonly PackagePermission[]): WorkflowDecision {
  const decision = state.decisions.find(d => d.decisionId === id);
  if (!decision || decision.outcome !== "approved" || decision.subjectSha256 !== state.subjectSha256 || state.revoked.includes(id)
    || permissions.some(p => !decision.permissions.includes(p))) reject("WORKFLOW_AUTHORITY");
  return decision;
}
function requiresProjectCommands(step: WorkflowDefinition["steps"][number]): boolean {
  return step.effects.some(effect => effect === "source.scoped" || effect === "check.scoped" || effect === "git.local");
}
export function projectWorkflowNext(state: WorkflowState, operations: ReadonlySet<string>, observations?: Pick<WorkflowObservations, "projectProfile">) {
  const blocked: { stepId: string; code: "WORKFLOW_AUTHORITY" | "WORKFLOW_CAPABILITY" }[] = [];
  const eligible = eligibleSteps(state).filter(id => {
    const step = state.definition.steps.find(s => s.id === id)!;
    if (step.kind === "decision") return true;
    if (!state.decisions.some(d => d.subjectSha256 === state.subjectSha256 && d.outcome === "approved" && !state.revoked.includes(d.decisionId) && step.authorization.every(p => d.permissions.includes(p)))) {
      blocked.push({ stepId: id, code: "WORKFLOW_AUTHORITY" }); return false;
    }
    if (!operations.has(step.operation.id) || (requiresProjectCommands(step) && observations?.projectProfile !== "supported")) { blocked.push({ stepId: id, code: "WORKFLOW_CAPABILITY" }); return false; }
    return true;
  });
  return { runId: state.runId, revision: state.revision, eligible, reconcile: state.pending, blocked };
}
function requireStaticCompatibility(report: WorkflowPreflight): void {
  if (report.status === "static-compatible") return;
  const blocked = report.gates.find(g => g.outcome === "blocked");
  if (!blocked || blocked.code === "WORKFLOW_STATIC_COMPATIBLE" || blocked.code === "WORKFLOW_LIVE_DEFERRED") throw new JsonWorkflowError("WORKFLOW_CAPABILITY", "preflight", "runtime-owner");
  throw new JsonWorkflowError(blocked.code, blocked.gateId, blocked.correctionOwner);
}
export class JsonWorkflowService {
  constructor(private readonly journal: RegistryWorkflowJournal, private readonly host: WorkflowHost) {}
  status(runId: string): WorkflowState { return replayWorkflow(this.journal, runId); }
  private caller(state: WorkflowState): WorkflowCaller {
    const caller = parseCaller(this.host.authenticate()); assertSubjectCaller(state, caller, true, this.host.continues); return caller;
  }
  next(runId: string): { runId: string; revision: number; eligible: string[]; reconcile: EffectIntent[]; blocked: { stepId: string; code: "WORKFLOW_AUTHORITY" | "WORKFLOW_CAPABILITY" }[] } {
    return projectWorkflowNext(this.status(runId), new Set(this.host.owners.keys()), this.host.observations());
  }
  admitProduced(selection: WorkflowSelection, request: Uint8Array, templateHost: TemplateHost): WorkflowState {
    const caller = parseCaller(this.host.authenticate());
    const produced = produceWorkflowSubject(selection, request, { ...templateHost, team: caller.team, mode: caller.mode });
    return this.admitInternal(selection, produced.raw, produced.provenance, caller);
  }
  /** Trusted-host seam for non-template internal fixtures; not a public raw-subject import. */
  admit(selection: WorkflowSelection, rawSubject: Uint8Array): WorkflowState {
    return this.admitInternal(selection, rawSubject);
  }
  private admitInternal(selection: WorkflowSelection, rawSubject: Uint8Array, provenance?: Uint8Array, originalCaller?: WorkflowCaller): WorkflowState {
    const caller = parseCaller(this.host.authenticate()); const subject = parseReviewBundle(rawSubject);
    if (originalCaller && JSON.stringify(caller) !== JSON.stringify(originalCaller)) reject("WORKFLOW_AUTHORITY");
    const selected = selectNewWorkflow(selection, caller.team, caller.mode);
    const report = preflightWorkflow(selection, caller.team, caller.mode, this.host.observations(), subject);
    requireStaticCompatibility(report);
    const runId = `wf-${randomUUID()}`;
    const state = { subject, caller } as WorkflowState; assertSubjectCaller(state, caller, false);
    const evidence = readWorkflowEvidence(subject, this.host.observations().readEvidence);
    this.journal.append(runId, 0, () => {
      // All new-run admissions serialize through the existing SQLite owner too.
      if (this.journal.runs(caller.repoKey, caller.ticket).length) reject("WORKFLOW_CONFLICT");
      return { eventId: `event-${randomUUID()}`, type: "admitted", data: { definitionSha256: selected.sha256, subjectSha256: digest(rawSubject), configRevision: selected.configRevision, caller, ...(provenance ? { producerSha256: digest(provenance) } : {}) } };
    }, [selected.raw, rawSubject, ...evidence, ...(provenance ? [provenance] : [])]);
    return this.status(runId);
  }
  /** A new linked attempt in the SAME pinned run, never a second lineage or
   * an implicit latest-subject selection. Publication/custody still belong to
   * their existing owners; public JSON cannot supply result/authority fields. */
  reviseProduced(runId: string, expectedRevision: number, selection: WorkflowSelection, request: Uint8Array, templateHost: TemplateHost): WorkflowState {
    const state = this.status(runId); const caller = this.caller(state);
    if (state.revision !== expectedRevision) reject("WORKFLOW_CONFLICT");
    if (selection.configRevision !== state.configRevision) reject("WORKFLOW_SOURCE");
    const produced = produceWorkflowSubject(selection, request, { ...templateHost, team: caller.team, mode: caller.mode });
    return this.reviseInternal(state, expectedRevision, produced.raw, produced.provenance, caller);
  }
  /** Trusted raw-subject seam for isolated owner tests, never a public import. */
  revise(runId: string, expectedRevision: number, rawSubject: Uint8Array): WorkflowState {
    return this.reviseInternal(this.status(runId), expectedRevision, rawSubject);
  }
  private reviseInternal(state: WorkflowState, expectedRevision: number, rawSubject: Uint8Array, provenance?: Uint8Array, originalCaller?: WorkflowCaller): WorkflowState {
    const caller = this.caller(state);
    if (originalCaller && JSON.stringify(caller) !== JSON.stringify(originalCaller)) reject("WORKFLOW_AUTHORITY");
    if (state.revision !== expectedRevision) reject("WORKFLOW_CONFLICT");
    const subject = parseReviewBundle(rawSubject), reason = subjectRevisionReason(state, subject);
    const report = preflightPinnedWorkflow({ definition: state.definition, sha256: state.subject.workflow.sha256, configRevision: state.configRevision }, this.host.observations(), subject);
    requireStaticCompatibility(report);
    const evidence = readWorkflowEvidence(subject, this.host.observations().readEvidence);
    this.journal.append(state.runId, expectedRevision, entries => {
      const current = replayWorkflow(this.journal, state.runId, entries);
      if (subjectRevisionReason(current, subject) !== reason || JSON.stringify(this.caller(current)) !== JSON.stringify(caller)) reject("WORKFLOW_CONFLICT");
      readWorkflowEvidence(subject, this.host.observations().readEvidence);
      return { eventId: `event-${randomUUID()}`, type: "subject-revised", data: { previousSubjectSha256: current.subjectSha256, subjectSha256: digest(rawSubject), previousAttemptId: current.attempts.at(-1)!.attemptId,
        attemptId: `attempt-${randomUUID()}`, reason, ...(provenance ? { producerSha256: digest(provenance) } : {}) } };
    }, [rawSubject, ...evidence, ...(provenance ? [provenance] : [])]);
    return this.status(state.runId);
  }
  async decide(runId: string, expectedRevision: number, stepId: string): Promise<WorkflowDecision> {
    const state = this.status(runId); this.caller(state);
    const step = state.definition.steps.find(s => s.id === stepId);
    if (state.revision !== expectedRevision || !step || step.kind !== "decision" || !eligibleSteps(state).includes(stepId)) reject("WORKFLOW_CONFLICT");
    readWorkflowEvidence(state.subject, this.host.observations().readEvidence);
    const capture = await this.host.capture({ action: "package", runId, revision: expectedRevision, subject: structuredClone(state.subject), subjectSha256: state.subjectSha256 });
    this.caller(state);
    readWorkflowEvidence(state.subject, this.host.observations().readEvidence);
    const issuedAt = this.host.now();
    const decision = parseDecision({ schemaVersion: "pa-decision/v1", decisionId: `decision-${randomUUID()}`, kind: "package", runId, stepId, subjectRef: state.subject.subjectId, subjectSha256: state.subjectSha256,
      outcome: capture.outcome, permissions: capture.outcome === "approved" ? state.subject.requestedPermissions : [], captureEvidenceRef: capture.evidence, principal: capture.principal, issuedAt });
    this.journal.append(runId, expectedRevision, entries => { const current = replayWorkflow(this.journal, runId, entries); if (current.subjectSha256 !== state.subjectSha256 || !eligibleSteps(current).includes(stepId)) reject("WORKFLOW_CONFLICT"); return { eventId: `event-${randomUUID()}`, type: "decision", data: { record: decision } }; });
    return decision;
  }
  async revoke(runId: string, expectedRevision: number, decisionId: string): Promise<WorkflowState> {
    const state = this.status(runId); this.caller(state);
    if (state.revision !== expectedRevision || !state.decisions.some(d => d.decisionId === decisionId) || state.revoked.includes(decisionId)) reject("WORKFLOW_CONFLICT");
    const decision = state.decisions.find(d => d.decisionId === decisionId)!;
    const subject = parseReviewBundle(this.journal.snapshot(decision.subjectSha256));
    const capture = await this.host.capture({ action: "revoke", runId, revision: expectedRevision, subject, subjectSha256: decision.subjectSha256, decisionId });
    if (capture.outcome !== "approved") return this.status(runId);
    this.caller(state);
    this.journal.append(runId, expectedRevision, () => ({ eventId: `event-${randomUUID()}`, type: "revocation", data: { decisionId, captureEvidenceRef: evidenceRef(capture.evidence), principal: text(capture.principal) } }));
    return this.status(runId);
  }
  async requestStep(runId: string, expectedRevision: number, stepId: string, decisionId: string): Promise<WorkflowState> {
    const state = this.status(runId); const caller = this.caller(state);
    if (state.revision !== expectedRevision || !eligibleSteps(state).includes(stepId)) reject("WORKFLOW_CONFLICT");
    const step = state.definition.steps.find(s => s.id === stepId)!; if (step.kind === "decision") reject("WORKFLOW_AUTHORITY");
    requireDecision(state, decisionId, step.authorization);
    if (requiresProjectCommands(step)) {
      const blocked = projectExecutionPrerequisites(this.host.observations())[0];
      if (blocked) throw new JsonWorkflowError("WORKFLOW_CAPABILITY", blocked.gateId, blocked.correctionOwner);
    }
    const owner = this.host.owners.get(step.operation.id); if (!owner) throw new JsonWorkflowError("WORKFLOW_CAPABILITY", step.operation.id, step.owner);
    const intent: EffectIntent = { intentId: `intent-${randomUUID()}`, runId, stepId, owner: step.owner, decisionId, subjectSha256: state.subjectSha256 };
    owner.admit(caller, state.subject, intent);
    this.journal.append(runId, expectedRevision, entries => { const current = replayWorkflow(this.journal, runId, entries); requireDecision(current, decisionId, step.authorization); return { eventId: `event-${randomUUID()}`, type: "intent", data: { intent } }; });
    return this.perform(intent, owner);
  }
  async reconcile(runId: string, expectedRevision: number, intentId: string): Promise<WorkflowState> {
    const state = this.status(runId); this.caller(state);
    const intent = state.pending.find(i => i.intentId === intentId); if (!intent || state.revision !== expectedRevision) reject("WORKFLOW_CONFLICT");
    const step = state.definition.steps.find(s => s.id === intent.stepId)!; const owner = this.host.owners.get(step.operation.id); if (!owner) throw new JsonWorkflowError("WORKFLOW_CAPABILITY", step.operation.id, step.owner);
    this.journal.append(runId, expectedRevision, () => ({ eventId: `event-${randomUUID()}`, type: "reconcile", data: { intentId } }));
    return this.perform(intent, owner);
  }
  private async perform(intent: EffectIntent, owner: WorkflowEffectOwner): Promise<WorkflowState> {
    let observed = await owner.observe(intent);
    if (observed.state === "absent") {
      const state = this.status(intent.runId); const caller = this.caller(state);
      const step = state.definition.steps.find(s => s.id === intent.stepId)!;
      // Revocation blocks NEW work, not settlement of an already proven effect.
      requireDecision(state, intent.decisionId, step.authorization); owner.admit(caller, state.subject, intent);
      // Owner must execute idempotently by intentId, including overlapping original/recovery callers.
      observed = await owner.execute(intent);
    }
    // Interactive native owners can acknowledge the SAME durable intent while
    // awaiting their authenticated caller. This is neither a result nor a
    // license to retry uncertain work; native custody still owns every effect.
    if (observed.state === "pending") return this.status(intent.runId);
    if (observed.state !== "proven") throw new JsonWorkflowError("WORKFLOW_UNCERTAIN", `effect.${intent.stepId}`, intent.owner);
    const result = observed;
    const settle = () => {
      if (!owner.verify(intent, result)) throw new JsonWorkflowError("WORKFLOW_UNCERTAIN", `effect.${intent.stepId}`, intent.owner);
      const current = this.status(intent.runId);
      if (!current.pending.some(i => i.intentId === intent.intentId)) return current;
      const step = current.definition.steps.find(s => s.id === intent.stepId)!;
      oneOf(result.outcome, STEP_OUTCOMES[step.kind]); if (!result.evidence.length) reject("WORKFLOW_UNCERTAIN");
      this.journal.append(intent.runId, current.revision, entries => {
        if (!replayWorkflow(this.journal, intent.runId, entries).pending.some(i => i.intentId === intent.intentId)) reject("WORKFLOW_CONFLICT");
        return { eventId: `event-${randomUUID()}`, type: "result", data: { intentId: intent.intentId, outcome: result.outcome, evidence: result.evidence.map(evidenceRef) } };
      });
      return this.status(intent.runId);
    };
    return owner.settle ? owner.settle(intent, settle) : settle();
  }
}
