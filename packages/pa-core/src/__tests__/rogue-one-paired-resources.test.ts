import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RogueOneConfig } from "../deploy/rogue-one-config.js";
import { getDeployPaths } from "../deploy/paths.js";
import { loadTeamConfig } from "../teams/index.js";
import { appendRegistryEvent, closeDb } from "../registry/index.js";

const selectedRoot = process.env.ROGUE_ONE_CONFIG_FIXTURE_ROOT;
test("paired PAPC reporting checker and complete selected closure survive live-config deletion", { skip: !selectedRoot && "explicit paired config source not selected" }, () => {
  const previous = process.env, root = mkdtempSync(join(tmpdir(), "rogue-paired-resources-")), clone = join(root, "original-config"); closeDb();
  const select = (config: string) => {
    process.env = { ...previous, PA_PLATFORM_CONFIG: join(root, "user-config"), PA_PLATFORM_HOME: config, PA_PLATFORM_TEAMS: join(config, "teams"),
      PA_PLATFORM_SKILLS: join(config, "skills/global"), PA_AI_USAGE_HOME: join(root, "ai"), PA_REGISTRY_DB: join(root, "registry.db") };
  };
  const context = { deploymentId: "d-349abc", runtime: "pi" as const, repoKey: "pa-platform", repoRoot: "/fixture/project", worktreeRoot: "/fixture/project" };
  const pair = { provider: "openai-codex", model: "gpt-6.1-sol", source: "default" as const }; // content-only fixture, not model-adoption evidence
  try {
    select(selectedRoot!);
    const original = RogueOneConfig.capture(context, { team: "rogue-one" }, loadTeamConfig("rogue-one"), pair);
    for (const resource of original.resources) {
      const path = join(clone, resource.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, original.read(resource.path));
    }
    select(clone);
    const captured = RogueOneConfig.capture(context, { team: "rogue-one" }, loadTeamConfig("rogue-one"), pair);
    assert.deepEqual(captured.resources, original.resources);
    const dir = getDeployPaths(context.deploymentId).deployDir; mkdirSync(dir, { recursive: true, mode: 0o700 }); captured.materialize(context.deploymentId);
    writeFileSync(join(dir, "session-id-pi.txt"), "paired-original-session", { mode: 0o600 });
    appendRegistryEvent({ deployment_id: context.deploymentId, team: "rogue-one", mode: captured.mode.id, rogue_one: true, event: "started", timestamp: new Date().toISOString(),
      runtime: "pi", binary: "ppa", repo: context.worktreeRoot, repo_root: context.repoRoot, worktree_root: context.worktreeRoot, provider: pair.provider, models: { team: pair.model }, note: captured.note });
    const report = join(root, "report.html"), html = captured.read("docs/workflow/templates/outcome-report.html").replace(/\{\{[^}]+\}\}/g, "fixture");
    writeFileSync(report, html); rmSync(clone, { recursive: true });
    const resumed = RogueOneConfig.resume(context.deploymentId, { team: "rogue-one" }, context).forDeployment("d-349def");
    mkdirSync(getDeployPaths("d-349def").deployDir, { recursive: true, mode: 0o700 });
    const projection = resumed.materialize("d-349def");
    for (const resource of resumed.resources) assert.equal(createHash("sha256").update(readFileSync(join(projection, resource.path))).digest("hex"), resource.sha256);
    const result = JSON.parse(execFileSync(process.execPath, [join(projection, "scripts/check-report-style.mjs"), report], { cwd: root, encoding: "utf8", env: process.env, timeout: 10_000 }));
    assert.equal(result.status, "valid-static-style");
    assert.equal(result.sha256, createHash("sha256").update(html).digest("hex"));
    assert.equal(result.browserObserved, false); assert.equal(result.nativeAuthority, false);
  } finally { closeDb(); process.env = previous; rmSync(root, { recursive: true, force: true }); }
});
