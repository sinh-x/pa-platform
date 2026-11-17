import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, emitStartedEvent, emitPidEvent, ensureDeployDir, MODE_CAPABILITY_SESSION, TicketStore, getDb, getAiUsageDir, getDeploymentEvents, documentPackageSha, workflowDigest, verifyLocalReviewOrigin, RegistryHandoffReviewJournal, type DocumentPackage, type RuntimeAdapter } from "@pa-platform/pa-core";
import { recordPiProcessIdentity } from "../process-identity.js";
import { authenticatePiDocumentCaller, selectsDocumentSession } from "../document-session.js";
import { deployWithPi } from "../deploy.js";
import { mutatePiHandoff } from "../handoff-native.js";
import { mutatePiDocument } from "../document-native.js";
import { registerDocumentModule, assertPolicyDocumentTool } from "../pi-extension/document-tool.js";
import { createHandoffTool } from "../pi-extension/handoff-tool.js";

const binding = { schemaVersion: "pa-mode-capability-binding/v2", configRoot: "/tmp/committed-fixture", configRevision: "a".repeat(40),
  resourcePath: "teams/analyst.yaml", resourceSha256: "b".repeat(64), profile: "pa-document-policy/v1",
  policy: { version: "pa-mode-capabilities/v1", allow: ["document.handoff", "document.local-review", "document.package"] }, repoKey: "example",
  identity: { publicTeam: "analyst", publicMode: "analyze", effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" },
  resources: [{ path: "teams/analyst.yaml", sha256: "b".repeat(64) }] };

test("PAP-316 public session closes native intake/plan/origin/publication/link/queue without env impersonation", async () => {
  const prior = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap316-session-")); closeDb();
  const repo = join(root, "repo"), config = join(root, "config"), usage = join(root, "usage");
  try {
    for (const path of [repo, config, usage]) mkdirSync(path);
    execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Disposable local develop"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    Object.assign(process.env, { PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db"),
      PA_DEPLOYMENT_ID: "d-316101", PA_TEAM: "analyst", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
    delete process.env.PA_TICKET_ID; process.chdir(repo);
    const directory = ensureDeployDir("d-316101"); process.env.PA_DEPLOYMENT_DIR = directory;
    emitStartedEvent({ deploymentId: "d-316101", team: "analyst", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo,
      note: MODE_CAPABILITY_SESSION, modeCapabilityBinding: JSON.stringify(binding) });
    emitPidEvent({ deploymentId: "d-316101", team: "analyst", pid: process.pid });
    assert.equal(recordPiProcessIdentity("d-316101", directory, process.pid), true);
    const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "disposable-analyst" } };
    const caller = authenticatePiDocumentCaller(context);
    assert.deepEqual(caller.capabilities, binding);
    assert.equal(caller.profile, MODE_CAPABILITY_SESSION);
    assert.throws(() => authenticatePiDocumentCaller(context, { ...process.env, PA_DEPLOYMENT_DIR: join(root, "foreign-deployment") }));
    const events = new EventEmitter(), registered = new Set<string>(); let active: string[] = [];
    registerDocumentModule({ on: events.on.bind(events), registerTool: tool => { registered.add(tool.name); }, setActiveTools: names => { active = names; } });
    events.emit("session_start", {}, context);
    assert.deepEqual(active.sort(), ["pa_document", "pa_handoff"]);
    assert.ok(registered.has("pa_handoff")); assert.equal(registered.has("pa_workspace"), false);
    assert.throws(() => assertPolicyDocumentTool("d-316101", { toolName: "functions.pa_handoff", input: {} }, context), /CAPABILITY_OMITTED/);
    const call = (action: string, input: Record<string, unknown> = {}) => mutatePiHandoff(JSON.stringify({ schemaVersion: "pa-handoff-native/v2", action, ...input }), context);
    const intake = await call("intake", { title: "Disposable Analyst intake", content: "Synthetic requirements only." });
    const ticket = "EX-001", store = new TicketStore();
    assert.equal(store.get(ticket)?.title, "Disposable Analyst intake");
    const planned = await call("plan", { ticket, requestId: "identity-plan", expectedTicketVersion: intake.ticketVersion, branch: "feature/EX-001-identity" });
    await call("stage", { ticket, requestId: "identity-review", expectedTicketVersion: planned.ticketVersion, stage: "review" });
    const document: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "public-analyst", revision: 1, repository: { key: "example", root: repo }, ticket, predecessor: null,
      members: (["brief", "requirements", "uat"] as const).map(role => {
        const raw = role === "brief" ? "Synthetic decision brief." : role === "requirements" ? "# FR-1\n# AC-1\nCoverage: TS-1\n" : "# TS-1\nCoverage: FR-1, AC-1\n";
        const source = `agent-teams/requirements/artifacts/reviews/${ticket}/r001/${role}.md`;
        mkdirSync(join(getAiUsageDir(), source, ".."), { recursive: true }); writeFileSync(join(getAiUsageDir(), source), raw);
        return { id: role, role, mediaType: "text/markdown", source, description: role, bytes: Buffer.byteLength(raw), sha256: workflowDigest(raw) };
      }), references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
    const frozen = await mutatePiDocument(JSON.stringify({ action: "freeze", package: document, expectedRevision: 0 }), context);
    assert.equal(frozen.ok, true, JSON.stringify(frozen));
    const prepared = await call("prepare-review", { documentSubjectSha256: documentPackageSha(document), planRequestId: "identity-plan", effects: { publish: true, branchRef: true, queue: true } });
    const subjectSha256 = prepared.subjectSha256;
    const requested = await call("request", { subjectSha256, expectedRevision: 0 });
    const decision = await call("decide", { subjectSha256, expectedRevision: 0, requestKey: requested.requestKey, outcome: "approved" });
    for (const action of ["publish", "complete-branch", "queue"]) await call(action, { subjectSha256, decisionId: decision.decisionId });
    assert.equal(store.get(ticket)!.status, "pending-implementation"); assert.equal(store.get(ticket)!.assignee, "builder/team-manager");
    const statusTool = await createHandoffTool(caller.handoffIdentitySha256!).execute("identity-status", { request: JSON.stringify({ schemaVersion: "pa-handoff-native/v2", action: "show", subjectSha256 }) }, undefined, undefined, context);
    assert.equal(statusTool.isError, undefined, statusTool.content[0]!.text);
    assert.match(statusTool.content[0]!.text, /local-unverified/);
    getDb().pragma("synchronous = FULL");
    const journal = new RegistryHandoffReviewJournal(getDb(), false), saved = journal.subject(String(subjectSha256));
    if (saved.subject.schemaVersion !== "pa-handoff-review/v2") assert.fail("wrong origin contract");
    verifyLocalReviewOrigin(getDb(), store, saved.subject, saved.intent);
    assert.equal(store.inspectHandoffWithIntent(saved.subject.origin.planIdentity)!.record.actor, "requirements/analyze");
    assert.equal(getDeploymentEvents("d-316101").find(event => event.event === "ticket-associated")!.actor, "requirements/analyze");
    assert.equal(authenticatePiDocumentCaller(context).ticket, "EX-001");
    for (const changes of [{ PA_TEAM: "requirements" }, { PA_MODE: "investigate" }, { PA_PI_EXECUTION_MODE: "background" }]) {
      assert.throws(() => authenticatePiDocumentCaller(context, { ...process.env, ...changes }));
    }
    assert.equal(process.env.PA_TEAM, "analyst");
  } finally { closeDb(); process.chdir(cwd); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});

test("PAP-316 omitted Analyst policy stops before allocation and spawn instead of generic fallback", async () => {
  const prior = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pap316-launch-")); closeDb();
  try {
    mkdirSync(join(root, "teams")); mkdirSync(join(root, "usage"));
    writeFileSync(join(root, "config.yaml"), "repos: {}\n");
    writeFileSync(join(root, "teams/analyst.yaml"), "name: analyst\nobjective: staged\nagents: []\ndefault_mode: analyze\ndeploy_modes:\n - id: analyze\n   label: Analyze\n - id: investigate\n   label: Investigate\n - id: research\n   label: Research\n");
    Object.assign(process.env, { PA_PLATFORM_HOME: root, PA_PLATFORM_TEAMS: join(root, "teams"), PA_PLATFORM_CONFIG: root, PA_AI_USAGE_HOME: join(root, "usage"), PA_REGISTRY_DB: join(root, "must-not-create.db") });
    for (const key of ["PA_DEPLOYMENT_ID", "PA_TEAM", "PA_MODE", "PA_TICKET_ID"]) delete process.env[key];
    let probes = 0;
    const adapter: RuntimeAdapter = { name: "pi", defaultModel: "", sessionFileName: "fixture", allocateSessionId() { probes++; throw Error("not admitted"); },
      installHooks() { probes++; }, describeTools() { probes++; throw Error("not admitted"); }, async spawn() { probes++; throw Error("not admitted"); },
      async resume() { probes++; throw Error("not admitted"); }, extractActivity: () => [] };
    for (const mode of [undefined, "analyze", "investigate", "research"]) {
      const result = await deployWithPi({ team: "analyst", ...(mode ? { mode } : {}) }, adapter);
      assert.equal(result.status, "failed"); assert.equal(result.deploymentId, undefined);
      assert.match(result.reason ?? "", /CAPABILITY_PROFILE/);
    }
    assert.equal(probes, 0); assert.deepEqual(readdirSync(join(root, "usage")), []);
    assert.deepEqual(readdirSync(root).sort(), ["config.yaml", "teams", "usage"]);
    const fresh = { team: "analyst", mode: "analyze", pinned: false, resume: false, inherited: false, rogue: false, background: false, ticketWorktree: false, supportedConfig: true };
    assert.equal(selectsDocumentSession(fresh), true);
    for (const key of ["pinned", "resume", "inherited", "rogue", "background", "ticketWorktree"] as const) assert.equal(selectsDocumentSession({ ...fresh, [key]: true }), false);
  } finally { closeDb(); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});
