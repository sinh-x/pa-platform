import { isDeepStrictEqual as equal } from "node:util";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  JsonWorkflowError, RegistryWorkflowJournal, getDb, getDeployPaths, replayWorkflow, requireDecision, assertRetainedConfigIdentity,
  parseReviewMatrixPlan, parseReviewObjective, parseSourceVersion, parseValidationHandoff, readValidationLedger, assertValidationAuthority,
  readWorkflowEvidence, readCanonicalWorkflowArtifact,
  queryReadonlyDeploymentEvents, queryReviewAuthorizationClaim,
  withPreparedTicketCapacity, withExecutionWorktreeAdmission,
  type EffectIntent, type EffectObservation, type WorkflowCaller, type WorkflowEffectOwner, type WorkflowHost,
  type ValidationHandoff, type ValidationLedger, type SourceVersion, type PreparedTicketCapacityTransaction,
} from "@pa-platform/pa-core";
import { PiPreparedNativeAuthority } from "./prepared-native.js";
import { NativeExecutionEvidence } from "./native-execution-evidence.js";
import { assertPiMatrixStartedForLaunch } from "./validation-launch.js";
import type { PiProtectedValidationLaunch } from "./validation-supervisor.js";
import type { NativeScopeSnapshot } from "./execution-native.js";

function blocked(): never { throw new JsonWorkflowError("WORKFLOW_UNCERTAIN", "matrix-native-result", "validation-owner"); }
const readLocks = { repository: (): never => blocked(), worktree: (): never => blocked() };
function locator(intent: EffectIntent): string { return `workflow-decision:${intent.runId}:${intent.decisionId}:${intent.subjectSha256}`; }
function stateFor(journal: RegistryWorkflowJournal, intent: EffectIntent) {
  const state = replayWorkflow(journal, intent.runId), step = state.definition.steps.find(s => s.id === intent.stepId);
  if (state.subjectSha256 !== intent.subjectSha256 || !step || intent.owner !== "validation" || step.owner !== "validation" || step.operation.id !== "check.matrix") blocked();
  if (!state.pending.some(i => equal(i, intent))) blocked();
  return { state, step };
}
/** Gate only an adopted structured route. This is required before candidate
 * selection and claim consumption; legacy review admission stays unchanged. */
export function requirePiMatrixIntent(repoKey: string, ticket: string, source: string, approval: string, existingJournal?: RegistryWorkflowJournal): EffectIntent | null {
  if (!approval.startsWith("workflow-decision:")) return null;
  const journal = existingJournal ?? new RegistryWorkflowJournal(getDb());
  const match = /^workflow-decision:([^:]+):([^:]+):([a-f0-9]{64})$/.exec(approval); if (!match) blocked();
  const state = replayWorkflow(journal, match[1]!);
  const intents = state.pending.filter(i => state.definition.steps.some(s => s.id === i.stepId && s.operation.id === "check.matrix"));
  if (intents.length !== 1) blocked();
  const intent = intents[0]!, { step } = stateFor(journal, intent);
  if (state.subject.repository.key !== repoKey || state.subject.ticket !== ticket || state.subject.matrix.ref !== source || locator(intent) !== approval) blocked();
  requireDecision(state, intent.decisionId, step.authorization);
  return structuredClone(intent);
}
interface MatrixStart { intent: EffectIntent; launch: PiProtectedValidationLaunch; before: NativeScopeSnapshot }
interface MatrixResult { start: SourceVersion; ledgerSha256: string; after: NativeScopeSnapshot }
function locks(launch: PiProtectedValidationLaunch) {
  const repo = launch.authority.repository;
  let capacity: PreparedTicketCapacityTransaction | null = null;
  return {
    repository: <T>(action: () => T) => withPreparedTicketCapacity({ canonicalRepoKey: repo.repoKey, canonicalRepoRoot: repo.canonicalRoot }, tx => {
      if (capacity) blocked(); capacity = tx;
      try { return action(); } finally { capacity = null; }
    }),
    worktree: <T>(action: () => T) => { if (!capacity) blocked(); return withExecutionWorktreeAdmission(repo.canonicalRoot, repo.worktreeRoot, capacity!, () => action()); },
  };
}
function evidence(authority: PiPreparedNativeAuthority, launch: PiProtectedValidationLaunch, create = false) {
  const store = authority.execution(create); if (!store) blocked();
  return new NativeExecutionEvidence(store!, authority.evidenceRoot(), create ? locks(launch) : readLocks);
}
function paths(launch: PiProtectedValidationLaunch) {
  const directory = getDeployPaths(launch.deploymentId).deployDir;
  return { directory, root: resolve(directory, "validation-evidence"), ledger: resolve(directory, "validation-evidence/ledger.json") };
}
function fingerprint(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.() || realpathSync(path) !== path) blocked();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash("sha256"), chunk = Buffer.alloc(65_536);
  try {
    const opened = fstatSync(fd); if (opened.ino !== info.ino || opened.dev !== info.dev) blocked();
    let n: number; while ((n = readSync(fd, chunk)) > 0) hash.update(chunk.subarray(0, n));
    const after = lstatSync(path);
    if (after.ino !== info.ino || after.dev !== info.dev || after.mode !== info.mode || after.nlink !== 1 || after.uid !== info.uid || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) blocked();
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
function binding(journal: RegistryWorkflowJournal, start: MatrixStart): ValidationHandoff {
  const { intent, launch } = start, { state } = stateFor(journal, intent), s = state.subject, r = launch.review;
  readWorkflowEvidence(s, ref => readCanonicalWorkflowArtifact(ref.ref));
  const handoff = parseValidationHandoff(launch.validationHandoff), m = handoff.manifest;
  assertValidationAuthority(handoff, launch.authority);
  const matrix = parseReviewMatrixPlan(journal.snapshot(s.requirements.sha256), s.matrix.ref);
  const values = { worktreeRoot: m.repository.worktreeRoot, featureSha: r.featureSha, matrixSource: r.matrixSource,
    matrixAuthoritySha256: r.matrixAuthoritySha256, matrixApprovalEvidence: r.matrixApprovalEvidence, trustedPath: m.environment.PATH };
  const environment = Object.fromEntries(Object.entries(matrix.matrix.environment).map(([name, v]) => [name, "literal" in v ? v.literal : values[v.binding]]));
  if (!equal(environment, m.environment)) blocked();
  if (matrix.digest !== s.matrix.sha256 || r.matrixSource !== s.matrix.ref || r.matrixAuthoritySha256 !== s.matrix.sha256 || r.matrixApprovalEvidence !== locator(intent)
    || r.ticketId !== s.ticket || r.branch !== s.handoff.branch || r.featureSha !== start.before.git.head || start.before.git.dirty
    || m.ticketId !== s.ticket || m.branch !== r.branch || m.featureSha !== r.featureSha
    || m.repository.repoKey !== s.repository.key || m.repository.canonicalRoot !== s.repository.root
    || !equal(m.commands, matrix.matrix.commands.map(c => ({ ...c, cwd: resolve(m.repository.worktreeRoot, c.cwd), artifacts: [] })))
    || !equal(m.matrix, { source: s.matrix.ref, authoritySha256: s.matrix.sha256, approvalEvidence: locator(intent) })) blocked();
  const o = parseReviewObjective(queryReadonlyDeploymentEvents(launch.deploymentId).find(e => e.event === "started")?.objective ?? "");
  if (o.ticket !== s.ticket || o.branch !== r.branch || o.featureSha !== r.featureSha || o.matrixSource !== r.matrixSource
    || o.matrixAuthoritySha256 !== r.matrixAuthoritySha256 || o.matrixApprovalEvidence !== r.matrixApprovalEvidence || o.reviewAuthorizationId !== r.authorizationId) blocked();
  const claim = queryReviewAuthorizationClaim(r.authorizationId);
  if (!claim || claim.deploymentId !== launch.deploymentId || claim.ticketId !== s.ticket || claim.branch !== r.branch || claim.featureSha !== r.featureSha
    || claim.matrixSource !== r.matrixSource || claim.matrixAuthoritySha256 !== r.matrixAuthoritySha256 || claim.matrixApprovalEvidence !== locator(intent)) blocked();
  const starts = queryReadonlyDeploymentEvents(launch.deploymentId).filter(e => e.event === "started"), event = starts[0];
  if (starts.length !== 1 || !event || event.runtime !== "pi" || event.binary !== "ppa" || event.team !== "requirements" || event.mode !== "review-auto" || event.rogue_one || event.parent_deployment_id || event.resumed_from_deployment_id
    || event.ticket_id !== s.ticket || event.repo_root !== s.repository.root || event.worktree_root !== m.repository.worktreeRoot || m.repository.worktreeRoot === s.repository.root) blocked();
  assertPiMatrixStartedForLaunch(paths(launch).directory, launch);
  return handoff;
}
/** Trusted supervisor-only capture, never exposed as a JSON result importer.
 * All normal protected-review admission/readiness/candidate/claim gates still run. */
export async function beginPiWorkflowMatrix(launch: PiProtectedValidationLaunch, authority = new PiPreparedNativeAuthority()): Promise<SourceVersion | null> {
  const r = launch.review;
  if (!r.matrixApprovalEvidence.startsWith("workflow-decision:")) return null;
  const journal = new RegistryWorkflowJournal(getDb());
  const intent = requirePiMatrixIntent(launch.authority.repository.repoKey, r.ticketId, r.matrixSource, r.matrixApprovalEvidence, journal);
  if (!intent) return null;
  const native = await import("./execution-native.js");
  const start: MatrixStart = { intent, launch: structuredClone(launch), before: native.captureNativeScope(launch.authority.repository.worktreeRoot) };
  binding(journal, start);
  const writer = evidence(authority, launch, true);
  return writer.publish("workflow-matrix-start", start, () => {
    requirePiMatrixIntent(launch.authority.repository.repoKey, r.ticketId, r.matrixSource, r.matrixApprovalEvidence, journal);
    for (const name of writer.store.records().filter(n => n.endsWith(".intent.json"))) {
      const row = writer.store.read(name) as { kind?: string; payload?: MatrixStart };
      if (row.kind === "workflow-matrix-start" && row.payload?.intent?.intentId === intent.intentId) blocked(); // unknown prior start is never retried
    }
  });
}
function complete(ledger: ValidationLedger): "passed" | "failed" {
  if (ledger.result === "executor_crash" || ledger.commands.some(c => ["pending", "executor_crash", "cleanup_failure"].includes(c.status) || (c.startedAt && c.processGroupVerifiedDead !== true))) blocked();
  if (ledger.result === "passed") {
    if (!ledger.commands.length || ledger.commands.some(c => c.status !== "passed" || c.exitCode !== 0 || c.signal || !c.stdout || !c.stderr || !c.startedAt || !c.finishedAt)) blocked();
    return "passed";
  }
  if (!ledger.commands.some(c => c.status !== "passed" && c.status !== "skipped")) blocked();
  return "failed";
}
export async function finishPiWorkflowMatrix(startRef: SourceVersion | null, launch: PiProtectedValidationLaunch, authority = new PiPreparedNativeAuthority()): Promise<void> {
  if (!startRef) return;
  const reader = evidence(authority, launch), start = reader.read(startRef, "workflow-matrix-start") as MatrixStart;
  if (!equal(start.launch, launch)) blocked();
  const handoff = binding(new RegistryWorkflowJournal(getDb()), start), p = paths(launch);
  const ledger = await readValidationLedger(handoff, { authority: launch.authority, evidenceRoot: p.root, ledgerPath: p.ledger });
  if (!ledger) blocked(); complete(ledger!);
  const native = await import("./execution-native.js"), after = native.captureNativeScope(handoff.manifest.repository.worktreeRoot);
  if (!equal(start.before, after)) blocked();
  evidence(authority, launch, true).publish("workflow-matrix-result", { start: startRef, ledgerSha256: fingerprint(p.ledger), after } satisfies MatrixResult);
}
/** Interactive bridge: request persists an intent, but never spawns a reviewer
 * or invents a second authorization/attempt. Only the real supervisor seals proof. */
export function createPiMatrixWorkflowOwner(journal: RegistryWorkflowJournal, authenticate: () => WorkflowCaller,
  continues?: WorkflowHost["continues"], authority = new PiPreparedNativeAuthority()): WorkflowEffectOwner {
  let verified: { intent: EffectIntent; result: EffectObservation; start: MatrixStart; fingerprints: { path: string; sha256: string }[] } | null = null;
  let native: typeof import("./execution-native.js") | null = null;
  return {
    admit(caller, subject, intent) {
      const state = replayWorkflow(journal, intent.runId), step = state.definition.steps.find(s => s.id === intent.stepId), current = authenticate();
      if (!step || step.operation.id !== "check.matrix" || step.owner !== "validation" || intent.owner !== "validation" || intent.subjectSha256 !== state.subjectSha256
        || !equal(subject, state.subject) || !equal(caller, current) || (!equal(current, state.caller) && !continues?.(state.caller, current))) blocked();
      requireDecision(state, intent.decisionId, step.authorization); assertRetainedConfigIdentity(state);
    },
    async observe(intent) {
      verified = null;
      try {
        stateFor(journal, intent);
        const store = authority.execution(); if (!store) return { state: "pending" };
        const reader = new NativeExecutionEvidence(store, authority.evidenceRoot(), readLocks), starts: { ref: SourceVersion; start: MatrixStart }[] = [];
        for (const name of store.records().filter(n => n.endsWith(".intent.json"))) {
          const row = store.read(name) as { kind?: string; payload?: MatrixStart };
          if (row.kind !== "workflow-matrix-start" || row.payload?.intent.intentId !== intent.intentId) continue;
          const ref = parseSourceVersion({ ref: `native-execution-evidence:${name.slice(0, 64)}`, version: "native-execution-evidence/v1", sha256: name.slice(0, 64) });
          const start = reader.read(ref, "workflow-matrix-start") as MatrixStart;
          if (!equal(start.intent, intent)) blocked(); starts.push({ ref, start });
        }
        if (!starts.length) return { state: "pending" };
        if (starts.length !== 1) return { state: "conflict" };
        const { ref, start } = starts[0]!, handoff = binding(journal, start), results: { ref: SourceVersion; proof: MatrixResult }[] = [];
        for (const name of store.records().filter(n => n.endsWith(".intent.json"))) {
          const row = store.read(name) as { kind?: string; payload?: MatrixResult };
          if (row.kind !== "workflow-matrix-result" || !equal(row.payload?.start, ref)) continue;
          const reference = parseSourceVersion({ ref: `native-execution-evidence:${name.slice(0, 64)}`, version: "native-execution-evidence/v1", sha256: name.slice(0, 64) });
          results.push({ ref: reference, proof: reader.read(reference, "workflow-matrix-result") as MatrixResult });
        }
        if (!results.length) return { state: "unknown" };
        if (results.length !== 1) return { state: "conflict" };
        const { proof, ref: resultRef } = results[0]!, p = paths(start.launch);
        const ledger = await readValidationLedger(handoff, { authority: start.launch.authority, evidenceRoot: p.root, ledgerPath: p.ledger });
        if (!ledger || fingerprint(p.ledger) !== proof.ledgerSha256) blocked();
        const outcome = complete(ledger!); native = await import("./execution-native.js");
        if (!equal(start.before, proof.after) || !equal(proof.after, native.captureNativeScope(handoff.manifest.repository.worktreeRoot))) blocked();
        const fingerprints = [{ path: p.ledger, sha256: proof.ledgerSha256 }];
        for (const c of ledger!.commands) for (const stream of [c.stdout, c.stderr]) if (stream) fingerprints.push({ path: resolve(p.root, stream.path), sha256: stream.sha256 });
        const result: EffectObservation = { state: "proven", outcome, evidence: [{ schemaVersion: "pa-workflow-evidence-ref/v1", ...resultRef }] };
        verified = { intent: structuredClone(intent), result: structuredClone(result), start, fingerprints }; return result;
      } catch { return { state: "unknown" }; }
    },
    execute: async () => ({ state: "pending" }),
    verify(intent, result) {
      try {
        if (!verified || !native || !equal(intent, verified.intent) || !equal(result, verified.result)) return false;
        binding(journal, verified.start);
        return equal(native.captureNativeScope(verified.start.launch.authority.repository.worktreeRoot), verified.start.before)
          && verified.fingerprints.every(f => fingerprint(f.path) === f.sha256);
      } catch { return false; }
    },
    settle(intent, action) {
      if (!verified || !equal(intent, verified.intent)) blocked();
      const repo = verified!.start.launch.authority.repository;
      return withPreparedTicketCapacity({ canonicalRepoKey: repo.repoKey, canonicalRepoRoot: repo.canonicalRoot }, capacity =>
        withExecutionWorktreeAdmission(repo.canonicalRoot, repo.worktreeRoot, capacity, action));
    },
  };
}
