import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDeploymentEvents, getDeployPaths, type RuntimeAdapter } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";

for (const drift of [false, true]) test(`PAP-316 real public launch binds committed resources and ${drift ? "rejects pre-spawn drift" : "preserves public execution identity"}`, async () => {
  const prior = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap316-selected-launch-")); closeDb();
  const config = join(root, "config"), repo = join(root, "repo"), usage = join(root, "usage");
  try {
    for (const path of [join(config, "teams"), join(config, "docs"), repo, usage]) mkdirSync(path, { recursive: true });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    writeFileSync(join(config, "docs/objective.md"), "Captured public objective.\n");
    writeFileSync(join(config, "docs/completion.md"), "Captured PUBLIC completion, not the legacy fragment.\n");
    writeFileSync(join(config, "teams/analyst.yaml"), `name: analyst\nobjective: fallback must not load\nagents: []\ndefault_mode: analyze\nglobal_docs: [docs/completion.md]\ndeploy_modes:\n - id: analyze\n   label: Analyze\n   provider: openai\n   model: fixture\n   objective: docs/objective.md\n   document_profile: pa-document-policy/v1\n   capability_policy: {version: pa-mode-capabilities/v1, allow: []}\n`);
    for (const path of [config, repo]) {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
      git("init", "-b", "develop"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Disposable source fixture");
    }
    Object.assign(process.env, { PA_PLATFORM_HOME: config, PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: join(config, "teams"), PA_PLATFORM_SKILLS: join(config, "skills/global"),
      PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db") });
    for (const key of ["PA_DEPLOYMENT_ID", "PA_TEAM", "PA_MODE", "PA_TICKET_ID"]) delete process.env[key];
    process.chdir(repo);
    let spawns = 0;
    const adapter: RuntimeAdapter = { name: "pi", defaultModel: "", sessionFileName: "fixture", allocateSessionId: () => "disposable-launch",
      installHooks() { if (drift) writeFileSync(join(config, "docs/objective.md"), "Changed AFTER immutable selection.\n"); },
      describeTools: () => ({ runtime: "pi", markdown: "Disposable source tools." }), extractActivity: () => [],
      async resume() { throw Error("No retained adoption"); },
      async spawn(options) {
        spawns++; assert.equal(options.env?.PA_TEAM, "analyst"); assert.equal(options.env?.PA_MODE, "analyze");
        assert.equal(options.executionPlan?.team, "analyst"); assert.equal(options.executionPlan?.repositoryAdmission.access, "read-only");
        assert.equal(options.executionPlan?.repositoryAdmission.ownershipIntent, "none");
        const primer = readFileSync(options.primerPath, "utf8");
        assert.match(primer, /Captured public objective/); assert.match(primer, /Captured PUBLIC completion/);
        assert.match(primer, /Effective native identity and audit actor: requirements\/analyze/);
        assert.doesNotMatch(primer, /fallback must not load/);
        return { sessionId: options.sessionId!, exitCode: 0, metadata: { sessionId: options.sessionId! } };
      } };
    if (!drift) {
      for (const excluded of [{ background: true }, { resume: "d-316fff" }, { ticketWorktree: true }, { force: true }]) {
        const rejected = await deployWithPi({ team: "analyst", repo: "example", ...excluded }, adapter);
        assert.equal(rejected.status, "failed"); assert.equal(rejected.deploymentId, undefined);
      }
      process.env.PA_DEPLOYMENT_ID = "d-316999";
      const inherited = await deployWithPi({ team: "analyst", repo: "example" }, adapter);
      assert.equal(inherited.status, "failed"); assert.equal(inherited.deploymentId, undefined);
      delete process.env.PA_DEPLOYMENT_ID;
      assert.equal(spawns, 0);
    }
    const result = await deployWithPi({ team: "analyst", repo: "example" }, adapter);
    assert.equal(result.status, drift ? "failed" : "success", result.reason);
    assert.equal(spawns, drift ? 0 : 1);
    assert.ok(result.deploymentId);
    const started = getDeploymentEvents(result.deploymentId).find(event => event.event === "started")!;
    assert.equal(started.team, "analyst"); assert.equal(started.mode, "analyze");
    assert.match(started.mode_capability_binding!, /pa-mode-capability-binding\/v2/);
    assert.ok(getDeployPaths(result.deploymentId).deployDir.startsWith(usage));
    if (drift) assert.match(result.reason ?? "", /CAPABILITY_BINDING/);
  } finally { closeDb(); process.chdir(cwd); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});
