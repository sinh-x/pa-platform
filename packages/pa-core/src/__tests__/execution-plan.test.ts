import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveExecutionPlan, type ExecutionPlan } from "../deploy/plan.js";
import { MAX_REPOSITORY_DIAGNOSTIC_CHARS } from "../repos.js";
import type { TeamConfig } from "../types.js";

function team(skill?: string): TeamConfig {
  return {
    name: "builder",
    description: "builder",
    objective: "objective",
    agents: [],
    default_mode: "implement",
    deploy_modes: [{
      id: "implement",
      label: "Implement",
      ...(skill ? { skills: [{ name: skill, "inject-as": "reference" as const }] } : {}),
    }],
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface ExecutionRepoFixture {
  root: string;
  config: string;
  repo: string;
  linked: string;
}

function initializeRepo(path: string): void {
  mkdirSync(path);
  git(["init", "-b", "develop"], path);
  git(["config", "user.email", "test@example.com"], path);
  git(["config", "user.name", "Test"], path);
  writeFileSync(join(path, "README.md"), "# Test\n");
  git(["add", "README.md"], path);
  git(["commit", "-m", "initial"], path);
}

function createFixture(name: string): ExecutionRepoFixture {
  const root = mkdtempSync(join(tmpdir(), `execution-plan-${name}-`));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const linked = join(root, "linked");
  mkdirSync(config);
  initializeRepo(repo);
  git(["worktree", "add", "-b", `feature/${name}`, linked], repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n`);
  return { root, config, repo, linked };
}

function withPlatformConfig<T>(config: string, callback: () => T): T {
  const previous = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previous;
  }
}

function resolveRepoPlan(repo: string | undefined, fixture: ExecutionRepoFixture, deploymentId = "d-plan", cwd?: string): ExecutionPlan {
  const teamConfig = team();
  return resolveExecutionPlan({
    request: { team: "builder", mode: "implement", ...(repo ? { repo } : {}) },
    teamConfig,
    mode: teamConfig.deploy_modes?.[0],
    runtime: "pi",
    deploymentId,
    deploymentDir: join(fixture.root, deploymentId),
    activityLogPath: join(fixture.root, deploymentId, "activity.jsonl"),
    environment: { PA_REPO: "/stale/request/path" },
    timeoutSeconds: 60,
    ...(cwd ? { cwd } : {}),
  });
}

test("execution plans are immutable and resolve selected skill paths", () => {
  const fixture = createFixture("immutable");
  const skillPath = join(fixture.root, "pa-cli", "SKILL.md");
  mkdirSync(join(fixture.root, "pa-cli"));
  writeFileSync(skillPath, "# pa-cli\n");
  try {
    const plan = withPlatformConfig(fixture.config, () => resolveExecutionPlan({
      request: { team: "builder", mode: "implement" },
      teamConfig: team("pa-cli"),
      mode: team("pa-cli").deploy_modes?.[0],
      runtime: "pi",
      deploymentId: "d-plan01",
      deploymentDir: fixture.root,
      activityLogPath: join(fixture.root, "activity.jsonl"),
      environment: { PA_TEAM: "builder" },
      timeoutSeconds: 60,
      skillsDir: fixture.root,
      cwd: fixture.repo,
    }));
    assert.equal(plan.skills[0]?.path, skillPath);
    assert.equal(plan.repoKey, "registered");
    assert.equal(plan.repoRoot, fixture.repo);
    assert.equal(plan.repositoryCwd, fixture.repo);
    assert.equal(plan.memoryDocumentRoot, fixture.repo);
    assert.equal(plan.objective, "objective");
    assert.equal(plan.userObjectiveOverride, undefined);
    assert.equal(plan.environment.PA_REPO, fixture.repo);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.skills), true);
    assert.equal(Object.isFrozen(plan.environment), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution plans preserve user objective authority and repository-keyed guides", () => {
  const fixture = createFixture("guides");
  const teamConfig = team();
  const mode = teamConfig.deploy_modes![0]!;
  mode.objective = "configured objective";
  mode.project_guides = { registered: ["docs/registered.md"], unrelated: ["docs/unrelated.md"] };
  try {
    const plan = withPlatformConfig(fixture.config, () => resolveExecutionPlan({
      request: { team: "builder", mode: "implement", objective: "operator override" },
      teamConfig,
      mode,
      runtime: "opencode",
      deploymentId: "d-guides",
      deploymentDir: fixture.root,
      activityLogPath: join(fixture.root, "activity.jsonl"),
      environment: {},
      timeoutSeconds: 60,
      cwd: fixture.repo,
    }));
    assert.equal(plan.objective, "operator override");
    assert.equal(plan.userObjectiveOverride, "operator override");
    assert.deepEqual(plan.memoryDocuments, ["docs/registered.md"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("missing selected skills fail with team, mode, name, and attempted path", () => {
  const fixture = createFixture("missing-skill");
  try {
    withPlatformConfig(fixture.config, () => {
      assert.throws(() => resolveExecutionPlan({
        request: { team: "builder", mode: "implement" },
        teamConfig: team("missing"),
        mode: team("missing").deploy_modes?.[0],
        runtime: "pi",
        deploymentId: "d-plan02",
        deploymentDir: fixture.root,
        activityLogPath: join(fixture.root, "activity.jsonl"),
        environment: {},
        timeoutSeconds: 60,
        skillsDir: fixture.root,
        cwd: fixture.repo,
      }), /team 'builder'.*mode 'implement'.*skill 'missing'.*attempted path/);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("registered key and exact root produce identical repository plan fields", () => {
  const fixture = createFixture("exact");
  try {
    withPlatformConfig(fixture.config, () => {
      const byKey = resolveRepoPlan("registered", fixture, "d-key");
      const byPath = resolveRepoPlan(fixture.repo, fixture, "d-path");
      assert.deepEqual(
        { key: byKey.repoKey, root: byKey.repoRoot, cwd: byKey.repositoryCwd, memoryRoot: byKey.memoryDocumentRoot, paRepo: byKey.environment.PA_REPO },
        { key: byPath.repoKey, root: byPath.repoRoot, cwd: byPath.repositoryCwd, memoryRoot: byPath.memoryDocumentRoot, paRepo: byPath.environment.PA_REPO },
      );
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("linked working-tree inputs and CWDs fail planning with bounded diagnostics", () => {
  const fixture = createFixture("linked-rejection");
  const nested = join(fixture.linked, "nested");
  mkdirSync(nested);
  try {
    withPlatformConfig(fixture.config, () => {
      for (const resolvePlan of [
        () => resolveRepoPlan(fixture.linked, fixture, "d-explicit"),
        () => resolveRepoPlan(undefined, fixture, "d-cwd", nested),
      ]) {
        assert.throws(resolvePlan, (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
          assert.match(message, /linked Git working tree/i);
          assert.match(message, /Corrective action/i);
          return true;
        });
      }
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("two same-root plans independently reach the injected spawn seam without admission state", async () => {
  const fixture = createFixture("same-root");
  try {
    const gitMetadataBefore = readdirSync(join(fixture.repo, ".git")).sort();
    const plans = withPlatformConfig(fixture.config, () => [
      resolveRepoPlan("registered", fixture, "d-first"),
      resolveRepoPlan(fixture.repo, fixture, "d-second"),
    ]);
    const spawned: string[] = [];
    const injectedSpawn = async (plan: ExecutionPlan): Promise<void> => {
      assert.equal(plan.repoRoot, fixture.repo);
      assert.deepEqual(Object.keys(plan.environment).sort(), ["PA_REPO"]);
      spawned.push(plan.lifecycle.deploymentId);
    };

    await Promise.all(plans.map(injectedSpawn));

    assert.deepEqual(spawned.sort(), ["d-first", "d-second"]);
    assert.deepEqual(readdirSync(join(fixture.repo, ".git")).sort(), gitMetadataBefore);
    assert.equal(plans[0]!.environment.PA_REPO, plans[1]!.environment.PA_REPO);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
