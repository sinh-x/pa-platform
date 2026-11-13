import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  closeDb, getDb, AutoWaitlistError, RegistryAutoJournal, RegistryDocumentJournal, AutoCoordinator, AutoStartDecisionService,
  routeAutoTicket, workflowDigest, parseReviewMatrixPlan, getDeploymentEvents, documentDestination,
  emitStartedEvent, emitCompletedEvent,
} from "@pa-platform/pa-core";
import { runAutoForeground } from "../auto-foreground.js";
import { selectedPiAutoPair } from "../auto-contract.js";
import { autoDraftOwner, type AutoDraftDriver } from "../auto-draft.js";
import { buildPiAutoStartIntent, dispatchPiAuto, piAutoImplementationOwner } from "../auto-runtime.js";
import { ProjectCommandContract } from "../project-command-contract.js";
import { captureAutoFullReview, type AutoTerminal } from "../auto-terminal.js";

function fixture() {
  const oldEnv = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pap302-native-owner-"));
  const repo = join(root, "repo"), cfg = join(root, "pair"), user = join(root, "user"), usage = join(root, "usage");
  const git = (args: string[], cwd: string) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (path: string, value: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  for (const path of [repo, cfg]) {
    mkdirSync(path); git(["init", "-b", "develop"], path); git(["config", "user.email", "fixture@example.invalid"], path); git(["config", "user.name", "Synthetic fixture"], path);
  }
  put(join(repo, "README.md"), "# Synthetic source\n"); put(join(repo, "check.cjs"), "process.exit(0);\n");
  const manifest = JSON.stringify({ schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: [{ id: "fixture-check", executable: realpathSync(process.execPath), argv: ["check.cjs"], environment: {}, readPaths: ["README.md"], prerequisites: [{ path: "check.cjs", sha256: workflowDigest("process.exit(0);\n") }], timeoutSeconds: 10, maximumOutputBytes: 4096 }] });
  put(join(repo, "checks.json"), manifest); git(["add", "."], repo); git(["commit", "-m", "Synthetic source"], repo);
  put(join(cfg, "contracts/auto-waitlist-v1.json"), JSON.stringify({ schemaVersion: "pa-auto-pair/v1", producer: "pa-auto-draft/v1", review: "pa-auto-start/v1", draftMode: "auto-draft", resources: ["skills/auto.md"], enabled: true }));
  put(join(cfg, "skills/auto.md"), "Synthetic test-only unsigned drafting instructions. Never approve or mutate source.");
  put(join(cfg, "teams/requirements.yaml"), "name: requirements\ndescription: synthetic\nobjective: synthetic\nagents: []\ndefault_mode: auto-draft\ndeploy_modes:\n  - id: auto-draft\n    label: Synthetic draft\n    provider: openai\n    model: openai/fixture-model\n    objective: skills/auto.md\n    require_ticket: true\n");
  put(join(cfg, "teams/builder.yaml"), "name: builder\ndescription: synthetic\nobjective: synthetic\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Synthetic builder\n    provider: openai\n    model: openai/fixture-model\n    require_ticket: true\n");
  git(["add", "."], cfg); git(["commit", "-m", "Synthetic opt-in pair; not host activation"], cfg);
  put(join(user, "config.yaml"), JSON.stringify({ config_dir: cfg, repos: { "pa-platform": { path: repo, prefix: "PAP", projectCommands: { manifest: "checks.json", sha256: workflowDigest(manifest) } }, "pa-platform-config": { path: cfg, prefix: "PAPC" } } }));
  process.env.PA_AI_USAGE_HOME = usage; process.env.PA_PLATFORM_CONFIG = user; process.env.PA_PLATFORM_HOME = cfg; process.env.PA_PLATFORM_DATA = join(root, "data"); process.env.PA_REGISTRY_DB = join(usage, "registry.db");
  delete process.env.PA_PLATFORM_TEAMS; delete process.env.PA_PLATFORM_SKILLS;
  const at = new Date().toISOString(), raw = JSON.stringify({ id: "PAP-1", project: "pa-platform", title: "Synthetic task", summary: "Synthetic", description: "Scoped local fixture work only", type: "feature", status: "idea", priority: "medium", assignee: "sinh", estimate: "M", tags: [], blockedBy: [], doc_refs: [], linkedBranches: [], linkedCommits: [], comments: [], subTickets: [], nextSubTicketCounter: 0, from: "", to: "", createdAt: at, updatedAt: at, resolvedAt: null });
  put(join(usage, "tickets/PAP-1.json"), raw); mkdirSync(join(usage, "bulletins/active"), { recursive: true });
  const journal = new RegistryAutoJournal(getDb()), coordinator = new AutoCoordinator(journal, () => {}), documents = new RegistryDocumentJournal(journal.db);
  const entry = routeAutoTicket({ id: "PAP-1", project: "pa-platform", title: "Synthetic task", priority: "medium", status: "idea", createdAt: at, ticketSha256: workflowDigest(raw), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" } });
  const selected = journal.select(entry, repo, () => entry, () => {});
  const template = readFileSync(new URL("../../../pa-core/src/__tests__/fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url));
  const baseMatrix = parseReviewMatrixPlan(template, "requirements:agent-teams/requirements/artifacts/fixture-producer-node-pnpm.md").matrix;
  let invocations = 0;
  const driver = (questions: string[] = []): AutoDraftDriver => ({ invoke(prompt) {
    invocations++; assert.ok(prompt.includes("Synthetic task"));
    const item = journal.active()!, prior = item.subjectSha256 ? documents.subject(item.subjectSha256) : null;
    const packageId = prior?.packageId ?? `auto-${item.draft!.operationId}`, revision = prior ? prior.revision + 1 : 1;
    const source = `requirements:agent-teams/requirements/artifacts/packages/PAP-1/${packageId}/r${String(revision).padStart(3, "0")}/requirements.md`;
    const matrix = structuredClone(baseMatrix); matrix.source = source; matrix.repository = { key: "pa-platform", root: repo, baseSha: git(["rev-parse", "HEAD"], repo), branch: "feature/PAP-1-auto" }; matrix.environment.PA_TICKET_ID = { literal: "PAP-1" };
    matrix.prerequisites = matrix.prerequisites.map(p => p.kind === "operatorGate" ? { ...p, ticket: "PAP-1" } : p);
    matrix.commands[0]!.command = ProjectCommandContract.inspect("pa-platform", repo)!.checks[0]!.command;
    return Buffer.from(JSON.stringify({ action: "finish", brief: "Synthetic brief; UNAPPROVED.", requirements: `# Requirements\n- FR-1 synthetic scope\n\n### Full Validation Matrix\n\nMatrix Source: ${source}\n\n\`\`\`json\n${JSON.stringify(matrix)}\n\`\`\`\n\n## Auto Execution Scope\n\`\`\`json\n{"files":["README.md"],"directories":[],"newPaths":[]}\n\`\`\`\n`, uat: "# UAT\n- TS-1 synthetic; not run", questions }));
  } });
  return { root, repo, cfg, usage, journal, coordinator, documents, selected, driver, count: () => invocations,
    close() { closeDb(); process.env = oldEnv; rmSync(root, { recursive: true, force: true }); } };
}
test("default selected contract and native producer persist one unsigned package, zero product writes, then explicit redraft retains history", async () => {
  const f = fixture(); try {
    const before = readFileSync(join(f.repo, "README.md"));
    const prepared = await f.coordinator.draft(f.selected, autoDraftOwner(f.journal, () => {}, selectedPiAutoPair, f.driver(["Material question remains"])));
    assert.equal(prepared.state, "blocked"); assert.ok(prepared.subjectSha256); assert.equal(f.count(), 1);
    const original = f.documents.subject(prepared.subjectSha256!), question = original.members.find(m => m.id === "questions")!;
    assert.deepEqual(JSON.parse(f.documents.snapshot(question.sha256).toString()), { schemaVersion: "pa-auto-questions/v1", questions: ["Material question remains"] });
    assert.throws(() => buildPiAutoStartIntent(prepared, f.journal));
    const revised = f.coordinator.prepareRedraft(prepared, prepared.ticketSha256, () => {});
    const ready = await f.coordinator.draft(revised, autoDraftOwner(f.journal, () => {}, selectedPiAutoPair, f.driver(), "Resolve the synthetic question without broadening scope"));
    assert.equal(ready.state, "awaiting-review"); assert.equal(f.count(), 2);
    const next = f.documents.subject(ready.subjectSha256!); assert.equal(next.packageId, original.packageId); assert.equal(next.revision, 2);
    assert.equal(f.documents.subject(prepared.subjectSha256!).revision, 1); assert.ok(f.journal.history(ready.itemId).some(e => e.item.draft?.deploymentId === prepared.draft!.deploymentId));
    assert.ok(readFileSync(join(f.repo, "README.md")).equals(before)); assert.equal(getDeploymentEvents(ready.draft!.deploymentId).filter(e => e.event === "started").length, 1);
  } finally { f.close(); }
});
test("actual foreground controller retains a typed busy cause through its public error boundary", async () => {
  const f = fixture(); try {
    await f.coordinator.draft(f.selected, autoDraftOwner(f.journal, () => {}, selectedPiAutoPair, f.driver()));
    const output: string[] = [];
    const result = await runAutoForeground({ authenticate() {}, display(text) { output.push(text); }, choose: async () => 1 }, { review: async () => { throw new AutoWaitlistError("AUTO_BUSY"); } });
    assert.equal(result, 1); const diagnostic = output.at(-1)!; assert.match(diagnostic, /AUTO_BUSY/); assert.ok(diagnostic.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(diagnostic.split(`${label}:`).length, 2);
    assert.ok(f.journal.active());
  } finally { f.close(); }
});
test("native combined start completes actual status/publication/queue owners once, but a synthetic success without native process/check/cleanup proof is held uncertain", async () => {
  const f = fixture(); try {
    const ready = await f.coordinator.draft(f.selected, autoDraftOwner(f.journal, () => {}, selectedPiAutoPair, f.driver()));
    let prompts = 0;
    const terminal: AutoTerminal = { authenticate() {}, display() {}, choose: async () => { prompts++; return 0; } };
    const service = new AutoStartDecisionService(f.documents, f.journal), intent = buildPiAutoStartIntent(ready, f.journal);
    const host = { authenticate: () => "a".repeat(64), assertCurrent() {}, capture: async () => {
      const subject = f.documents.subject(ready.subjectSha256!); return captureAutoFullReview({ subject, subjectSha256: ready.subjectSha256!, documents: subject.members.map(m => f.documents.snapshot(m.sha256)), startIntent: intent, startSha256: workflowDigest(JSON.stringify(intent)), documentScope: intent.documentScope }, terminal);
    } };
    const approved = await service.review(service.propose(ready, intent, host), host);
    f.journal.setControl(0, { scansEnabled: true, dispatchEnabled: true, paused: false }, () => {});
    let launches = 0;
    const owner = piAutoImplementationOwner(f.journal, terminal, async (request, _adapter, _diagnostics, dependencies) => {
      launches++; dependencies!.autoLaunch!.assertCurrent(request, { provider: intent.provider, model: intent.model });
      assert.equal(dependencies!.autoLaunch!.baseline().startSha256, approved.startSha256);
      const id = dependencies!.autoLaunch!.deploymentId;
      emitStartedEvent({ deploymentId: id, team: "builder", mode: "orchestrator", runtime: "pi", binary: "ppa", ticketId: "PAP-1", repo: f.repo, repoRoot: f.repo, worktreeRoot: f.repo, provider: intent.provider, models: { team: intent.model }, note: "ordinary-native-execution/v1" });
      emitCompletedEvent({ deploymentId: id, team: "builder", status: "success", exitCode: 0, summary: "Synthetic fixture process only; NOT actual implementation or UAT" });
      return { status: "success", deploymentId: id, team: "builder", mode: "orchestrator" };
    });
    const blocked = await dispatchPiAuto(approved, f.journal, terminal, owner);
    assert.equal(launches, 1); assert.equal(prompts, 1); assert.equal(blocked.state, "uncertain"); assert.equal(blocked.reason, "uncertain");
    const ticket = JSON.parse(readFileSync(join(f.usage, "tickets/PAP-1.json"), "utf8"));
    assert.equal(ticket.status, "pending-implementation"); assert.equal(ticket.assignee, "builder/team-manager"); assert.equal(ticket.linkedBranches[0].branch, intent.branch.name);
    for (const member of f.documents.subject(ready.subjectSha256!).members) assert.ok(readFileSync(join(f.usage, documentDestination(f.documents.subject(ready.subjectSha256!), member))).length > 0);
    await dispatchPiAuto(blocked, f.journal, terminal, owner); assert.equal(launches, 1); assert.equal(prompts, 1);
  } finally { f.close(); }
});
