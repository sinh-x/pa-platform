import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  claimReviewAuthorization, getDeployPaths, digestValidationManifest, executeValidationHandoff, parseReviewMatrixPlan,
  workflowDecisionReference, materializeTicketBranch, appendRegistryEvent, readValidationLedger,
  type ValidationHandoff, type WorkflowState, type ReviewBundle, type WorkflowEffectOwner, type WorkflowHost, type JsonWorkflowService, type RegistryWorkflowJournal,
} from "@pa-platform/pa-core";
import { createPiMatrixWorkflowOwner, beginPiWorkflowMatrix, finishPiWorkflowMatrix, requirePiMatrixIntent } from "../workflow-matrix.js";
import { writePiMatrixStartedEvent } from "../validation-launch.js";
import { runPiValidationBeforeReviewer, type PiProtectedValidationLaunch } from "../validation-supervisor.js";
import { versionedReviewEnvironment } from "../review-v1-launch.js";
import { resolvePiStructuredBaseline } from "../workflow-consumers.js";
import type { PiPreparedNativeAuthority } from "../prepared-native.js";

interface WorkflowRuntimeTestFixture {
  repo: string; checkout: string; base: string; git(args: string[], cwd?: string): string;
  bundle: ReviewBundle; evidence: Map<string, Buffer>; state: WorkflowState;
  authority: { runId: string; decisionId: string; subjectSha256: string };
  nativeAuthority: PiPreparedNativeAuthority; matrixOwner: WorkflowEffectOwner; service: JsonWorkflowService;
  journal: RegistryWorkflowJournal; host: WorkflowHost;
}
type Fixture = (run: (f: WorkflowRuntimeTestFixture) => Promise<void>, amendment?: boolean, source?: boolean, matrix?: boolean | "failure") => Promise<void>;
async function setup(f: WorkflowRuntimeTestFixture) {
  const approval = workflowDecisionReference(f.state, f.authority.decisionId);
  assert.throws(() => requirePiMatrixIntent("example", "EX-1", f.bundle.matrix.ref, approval), /WORKFLOW_UNCERTAIN/);
  const waiting = await f.service.requestStep(f.state.runId, f.state.revision, "validate", f.authority.decisionId), intent = waiting.pending[0]!;
  assert.equal(waiting.outcomes.validate, undefined);
  assert.equal(requirePiMatrixIntent("example", "EX-1", f.bundle.matrix.ref, approval)!.intentId, intent.intentId);
  const baseline = resolvePiStructuredBaseline("example", f.repo, "EX-1")!;
  materializeTicketBranch({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo, worktreeRoot: f.checkout, ticketId: "EX-1", intendedTaskBaseline: baseline, rereadStructuredTaskBaseline: () => resolvePiStructuredBaseline("example", f.repo, "EX-1")! });
  const matrix = parseReviewMatrixPlan(f.evidence.get(f.bundle.requirements.ref)!, f.bundle.matrix.ref).matrix;
  const deploymentId = "d-a12345", authorizationId = "review-auth:123e4567-e89b-42d3-a456-426614174000";
  const objective = { schemaVersion: "pa-review-objective/v1" as const, ticket: "EX-1", branch: f.bundle.handoff.branch, featureSha: f.base,
    matrixSource: f.bundle.matrix.ref, matrixAuthoritySha256: f.bundle.matrix.sha256, matrixApprovalEvidence: approval, reviewAuthorizationId: authorizationId, prerequisiteEvidence: {} };
  appendRegistryEvent({ deployment_id: deploymentId, team: "requirements", mode: "review-auto", runtime: "pi", binary: "ppa", event: "started", timestamp: new Date().toISOString(),
    ticket_id: "EX-1", repo: f.checkout, repo_root: f.repo, worktree_root: f.checkout, objective: JSON.stringify(objective) });
  const directory = getDeployPaths(deploymentId).deployDir;
  const event = { deploymentId, authorizationId, ticketId: "EX-1", branch: objective.branch, featureSha: f.base, candidateHead: f.base,
    matrixSource: objective.matrixSource, matrixAuthoritySha256: objective.matrixAuthoritySha256, matrixApprovalEvidence: approval, repoKey: "example", repoRoot: f.repo, worktreeRoot: f.checkout };
  const started = writePiMatrixStartedEvent({ deploymentDirectory: directory, event });
  claimReviewAuthorization({ deploymentId, authorizationId, ticketId: "EX-1", branch: objective.branch, featureSha: f.base,
    matrixSource: objective.matrixSource, matrixAuthoritySha256: objective.matrixAuthoritySha256, matrixApprovalEvidence: approval, objective: JSON.stringify(objective) });
  assert.throws(() => claimReviewAuthorization({ deploymentId, authorizationId, ticketId: "EX-1", branch: objective.branch, featureSha: f.base,
    matrixSource: objective.matrixSource, matrixAuthoritySha256: objective.matrixAuthoritySha256, matrixApprovalEvidence: approval, objective: JSON.stringify(objective) }), /one-use|already|consumed/i);
  const repository = { repoKey: "example", canonicalRoot: f.repo, worktreeRoot: f.checkout };
  const environment = versionedReviewEnvironment(matrix, objective, f.checkout, process.env.PATH!.split(":").filter(p => p.startsWith("/")).join(":"));
  const protectedEnvironment = Object.fromEntries(Object.entries(environment).filter(([k]) => k.startsWith("PA_")));
  const manifest = { schemaVersion: "pa-validation-manifest/v1" as const, ticketId: "EX-1", branch: objective.branch, featureSha: f.base,
    matrix: { source: objective.matrixSource, authoritySha256: objective.matrixAuthoritySha256, approvalEvidence: approval }, repository, environment,
    commands: matrix.commands.map(c => ({ ...c, cwd: resolve(f.checkout, c.cwd), artifacts: [] })) };
  const handoff: ValidationHandoff = { schemaVersion: "pa-validation-handoff/v1", manifestSha256: digestValidationManifest(manifest), manifest,
    repositoryEvidence: { ...repository, ticketId: "EX-1", branch: objective.branch, featureSha: f.base, authenticated: true }, protectedEnvironment };
  const launch: PiProtectedValidationLaunch = { schemaVersion: "pi-protected-validation/v1", deploymentId,
    admission: { authorization: "consumed", matrixDigest: "verified", featureSha: "verified", approval: "verified", activeReview: "admitted", prerequisites: [{ sourceOrder: 1, text: "Synthetic admission only; actual executor, registry claim, start journal and native proof owners", status: "verified" }] },
    validationHandoff: handoff, authority: { ticketId: "EX-1", branch: objective.branch, featureSha: f.base, matrixSource: objective.matrixSource,
      matrixAuthoritySha256: objective.matrixAuthoritySha256, matrixApprovalEvidence: approval, repository, protectedEnvironment },
    review: { reviewDeploymentId: deploymentId, candidateHead: f.base, prerequisiteStartedAt: started.timestamp, authorizationId, ticketId: "EX-1", branch: objective.branch,
      featureSha: f.base, matrixSource: objective.matrixSource, matrixAuthoritySha256: objective.matrixAuthoritySha256, matrixApprovalEvidence: approval } };
  const evidenceRoot = resolve(directory, "validation-evidence"), ledgerPath = resolve(evidenceRoot, "ledger.json");
  mkdirSync(evidenceRoot, { mode: 0o700 });
  return { intent, launch, handoff, evidenceRoot, ledgerPath };
}
export function registerWorkflowMatrixCases(fixture: Fixture) {
  test("check.matrix: real executor/ledger/streams settle one durable intent; source flags and a missing native seal cannot pass", () => fixture(async f => {
    const x = await setup(f), { intent, launch, handoff, evidenceRoot, ledgerPath } = x;
    assert.equal(f.matrixOwner.verify(intent, { state: "proven", outcome: "passed", evidence: [] }), false);
    let start: Awaited<ReturnType<typeof beginPiWorkflowMatrix>> = null, reviewerStarts = 0;
    const result = await runPiValidationBeforeReviewer(launch, { evidenceRoot, ledgerPath,
      beforeExecute: async () => {
        start = await beginPiWorkflowMatrix(launch, f.nativeAuthority); assert.ok(start);
        assert.equal((await f.matrixOwner.observe(intent)).state, "unknown");
        await assert.rejects(beginPiWorkflowMatrix(launch, f.nativeAuthority), /WORKFLOW_UNCERTAIN/);
      },
      afterMatrix: async () => {
        assert.equal((await f.matrixOwner.observe(intent)).state, "unknown"); // ledger alone is not workflow proof
        await finishPiWorkflowMatrix(start, launch, f.nativeAuthority);
      },
      startReviewer: async () => { reviewerStarts++; assert.equal((await f.matrixOwner.observe(intent)).state, "proven"); },
    });
    assert.equal(result.admitted, true); assert.equal(reviewerStarts, 1);
    if (!result.admitted) throw Error("supervisor rejected");
    assert.equal(result.validation.ledger!.result, "passed"); assert.equal(result.validation.ledger!.commands.length, 2);
    // Recreate the adapter: private caches are not persistence authority.
    const restarted = createPiMatrixWorkflowOwner(f.journal, f.host.authenticate, undefined, f.nativeAuthority);
    const observed = await restarted.observe(intent); assert.equal(observed.state, "proven"); assert.equal(restarted.verify(intent, observed), true);
    const forged = structuredClone(observed); if (forged.state === "proven") forged.evidence[0]!.sha256 = "a".repeat(64);
    assert.equal(restarted.verify(intent, forged), false); assert.equal(restarted.verify(intent, observed), true);
    const raw = readFileSync(ledgerPath), ledger = JSON.parse(raw.toString());
    for (const mutate of [(r: typeof ledger) => r.commands.pop(), (r: typeof ledger) => r.commands[0].command = "echo forged", (r: typeof ledger) => r.featureSha = "a".repeat(40), (r: typeof ledger) => r.commands[0].processGroupVerifiedDead = false]) {
      const changed = structuredClone(ledger); mutate(changed); writeFileSync(ledgerPath, JSON.stringify(changed));
      assert.equal((await f.matrixOwner.observe(intent)).state, "unknown"); writeFileSync(ledgerPath, raw);
    }
    const streamPath = resolve(evidenceRoot, ledger.commands[0].stdout.path), stream = readFileSync(streamPath);
    unlinkSync(streamPath); assert.equal((await f.matrixOwner.observe(intent)).state, "unknown"); writeFileSync(streamPath, stream, { mode: 0o600 });
    writeFileSync(resolve(f.checkout, "check.cjs"), "process.exit(0) // changed input\n"); assert.equal((await f.matrixOwner.observe(intent)).state, "unknown"); f.git(["checkout", "--", "check.cjs"], f.checkout);
    const artifactPath = resolve(process.env.PA_AI_USAGE_HOME!, f.bundle.requirements.ref.slice("requirements:".length)), artifact = readFileSync(artifactPath);
    writeFileSync(artifactPath, Buffer.concat([artifact, Buffer.from("changed canonical input")])); assert.equal((await f.matrixOwner.observe(intent)).state, "unknown"); writeFileSync(artifactPath, artifact);
    // Revocation stops dependent new effects but not genuine completed settlement.
    await f.service.revoke(f.state.runId, f.service.status(f.state.runId).revision, f.authority.decisionId);
    assert.throws(() => requirePiMatrixIntent("example", "EX-1", f.bundle.matrix.ref, launch.review.matrixApprovalEvidence), /WORKFLOW_AUTHORITY/);
    const settled = await f.service.reconcile(f.state.runId, f.service.status(f.state.runId).revision, intent.intentId);
    assert.equal(settled.outcomes.validate, "passed"); assert.equal(settled.pending.length, 0);
    assert.deepEqual(readFileSync(ledgerPath), raw);
  }, false, false, true));
  test("check.matrix retains native failed exit and skipped successors as failed, never passed or retried", () => fixture(async f => {
    const x = await setup(f), start = await beginPiWorkflowMatrix(x.launch, f.nativeAuthority);
    const result = await executeValidationHandoff(x.handoff, { authority: x.launch.authority, evidenceRoot: x.evidenceRoot, ledgerPath: x.ledgerPath, requireProcessGroupSettlement: true });
    assert.equal(result.ledger!.result, "failed"); assert.equal(result.ledger!.commands[0]!.exitCode, 7); assert.equal(result.ledger!.commands[1]!.status, "skipped");
    await finishPiWorkflowMatrix(start, x.launch, f.nativeAuthority);
    const state = await f.service.reconcile(f.state.runId, f.service.status(f.state.runId).revision, x.intent.intentId);
    assert.equal(state.outcomes.validate, "failed"); assert.equal(state.pending.length, 0); assert.deepEqual(f.service.next(state.runId).eligible, []);
    assert.throws(() => requirePiMatrixIntent("example", "EX-1", f.bundle.matrix.ref, x.launch.review.matrixApprovalEvidence), /WORKFLOW_UNCERTAIN/);
  }, false, false, "failure"));
  for (const change of ["candidate", "environment", "command", "matrix", "foreign-claim"] as const) test(`check.matrix rejects changed ${change} before dispatch`, () => fixture(async f => {
    const x = await setup(f), altered = structuredClone(x.launch), h = altered.validationHandoff as ValidationHandoff;
    if (change === "candidate") altered.review.featureSha = "a".repeat(40);
    if (change === "environment") h.manifest.environment.CI = "forged";
    if (change === "command") h.manifest.commands[0]!.command = "echo forged";
    if (change === "matrix") altered.review.matrixAuthoritySha256 = "a".repeat(64);
    if (change === "foreign-claim") altered.review.authorizationId = "review-auth:123e4567-e89b-42d3-a456-426614174001";
    h.manifestSha256 = digestValidationManifest(h.manifest);
    await assert.rejects(beginPiWorkflowMatrix(altered, f.nativeAuthority));
    assert.equal((await f.matrixOwner.observe(x.intent)).state, "pending");
    assert.equal(await readValidationLedger(x.handoff, { authority: x.launch.authority, evidenceRoot: x.evidenceRoot, ledgerPath: x.ledgerPath }), null);
  }, false, false, true));
  test("check.matrix 32 competing native starts accept exactly one and retain the unknown operation", () => fixture(async f => {
    const x = await setup(f);
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => beginPiWorkflowMatrix(x.launch, f.nativeAuthority)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 31);
    assert.equal((await f.matrixOwner.observe(x.intent)).state, "unknown");
    assert.equal(f.service.status(f.state.runId).pending.length, 1);
  }, false, false, true));
  test("check.matrix interrupted start remains unknown after owner restart and revocation; no second dispatch or journal reset", () => fixture(async f => {
    const x = await setup(f); await beginPiWorkflowMatrix(x.launch, f.nativeAuthority);
    const before = f.nativeAuthority.execution()!.records();
    const restarted = createPiMatrixWorkflowOwner(f.journal, f.host.authenticate, undefined, f.nativeAuthority);
    assert.equal((await restarted.observe(x.intent)).state, "unknown");
    await f.service.revoke(f.state.runId, f.service.status(f.state.runId).revision, f.authority.decisionId);
    await assert.rejects(beginPiWorkflowMatrix(x.launch, f.nativeAuthority), /WORKFLOW_AUTHORITY/);
    await assert.rejects(f.service.reconcile(f.state.runId, f.service.status(f.state.runId).revision, x.intent.intentId), /WORKFLOW_UNCERTAIN/);
    assert.deepEqual(f.nativeAuthority.execution()!.records(), before); assert.equal(f.service.status(f.state.runId).pending[0]!.intentId, x.intent.intentId);
  }, false, false, true));
}
