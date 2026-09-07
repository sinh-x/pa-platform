import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveExecutionPlan, type ExecutionPlan } from "../deploy/plan.js";
import { MAX_REPOSITORY_DIAGNOSTIC_CHARS } from "../repos.js";
import { repositoryMutationLeasePath, type RepositoryAdmissionOperation, type RepositoryGitSnapshot } from "../deploy/repository-admission.js";
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
    assert.equal(plan.repositoryAdmission.access, "exclusive-builder");
    assert.equal(plan.repositoryAdmission.ownershipIntent, "acquire-before-spawn");
    assert.equal(Object.isFrozen(plan.repositoryAdmission), true);
    assert.equal(Object.isFrozen(plan.repositoryAdmission.gitSnapshot), true);
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

test("two same-root plans independently reach the injected spawn seam without ownership mutation", async () => {
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
    assert.equal(plans[0]!.repositoryAdmission.ownershipIntent, "acquire-before-spawn");
    assert.equal(plans[1]!.repositoryAdmission.ownershipIntent, "acquire-before-spawn");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

const dirtySnapshot: RepositoryGitSnapshot = Object.freeze({
  branch: "feature/PAP-174-dirty",
  head: "b".repeat(40),
  stagedCount: 1,
  unstagedCount: 2,
  untrackedCount: 3,
  dirty: true,
  statusSummary: "M  staged.ts\\n M unstaged.ts\\n?? untracked.ts",
});

test("all requirements modes bypass Git status and lease operations even with dirty and live-looking evidence", () => {
  const fixture = createFixture("requirements-bypass");
  const leasePath = repositoryMutationLeasePath(fixture.repo);
  const exactEvidence = JSON.stringify({ deploymentId: "d-live", processFingerprint: { pid: process.pid, startTimeTicks: "live", bootId: "fixture" } });
  writeFileSync(leasePath, exactEvidence);
  const requirements: TeamConfig = {
    name: "requirements",
    description: "requirements",
    objective: "analyze",
    agents: [],
    default_mode: "analyze",
    deploy_modes: ["analyze", "review", "review-auto", "review-auto-openai", "focus", "focus-openai", "spike", "spike-minimax", "spike-openai", "analyze-auto", "analyze-auto-openai"].map((id) => ({ id, label: id })),
  };
  const operations: RepositoryAdmissionOperation[] = [];
  const spawned: string[] = [];
  try {
    withPlatformConfig(fixture.config, () => {
      for (const mode of requirements.deploy_modes ?? []) {
        const plan = resolveExecutionPlan({
          request: { team: requirements.name, mode: mode.id, background: true },
          teamConfig: requirements,
          mode,
          runtime: "pi",
          deploymentId: `d-${mode.id}`,
          deploymentDir: join(fixture.root, `d-${mode.id}`),
          activityLogPath: join(fixture.root, `d-${mode.id}`, "activity.jsonl"),
          environment: {},
          timeoutSeconds: 60,
          cwd: fixture.repo,
          captureRepositoryGitSnapshot: () => { throw new Error(`requirements/${mode.id} inspected Git status`); },
          observeRepositoryAdmissionOperation: (operation) => operations.push(operation),
        });
        assert.deepEqual(plan.repositoryAdmission, {
          access: "read-only",
          launchMode: "background",
          ownershipIntent: "none",
          force: false,
        });
        spawned.push(plan.lifecycle.deploymentId);
      }
    });
    assert.deepEqual(operations, []);
    assert.deepEqual(spawned, ["d-analyze", "d-review", "d-review-auto", "d-review-auto-openai", "d-focus", "d-focus-openai", "d-spike", "d-spike-minimax", "d-spike-openai", "d-analyze-auto", "d-analyze-auto-openai"]);
    assert.equal(readFileSync(leasePath, "utf8"), exactEvidence);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("other teams retain non-locking planning behavior without Git status inspection", () => {
  const fixture = createFixture("non-locking");
  const maintenance: TeamConfig = { name: "maintenance", description: "maintenance", objective: "inspect", agents: [], default_mode: "fix", deploy_modes: [{ id: "fix", label: "Fix" }] };
  try {
    const plan = withPlatformConfig(fixture.config, () => resolveExecutionPlan({
      request: { team: "maintenance", mode: "fix", background: true, force: true },
      teamConfig: maintenance,
      mode: maintenance.deploy_modes?.[0],
      runtime: "opencode",
      deploymentId: "d-maintenance",
      deploymentDir: join(fixture.root, "d-maintenance"),
      activityLogPath: join(fixture.root, "d-maintenance", "activity.jsonl"),
      environment: {},
      timeoutSeconds: 60,
      cwd: fixture.repo,
      captureRepositoryGitSnapshot: () => { throw new Error("non-locking team inspected Git status"); },
    }));
    assert.deepEqual(plan.repositoryAdmission, { access: "non-locking", launchMode: "background", ownershipIntent: "none", force: true });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dirty foreground builders retain immutable evidence while dirty background builders reject without ownership", () => {
  const fixture = createFixture("dirty-builder");
  const teamConfig = team();
  const operations: RepositoryAdmissionOperation[] = [];
  try {
    withPlatformConfig(fixture.config, () => {
      const foreground = resolveExecutionPlan({
        request: { team: "builder", mode: "implement", force: true },
        teamConfig,
        mode: teamConfig.deploy_modes?.[0],
        runtime: "opencode",
        deploymentId: "d-foreground",
        deploymentDir: join(fixture.root, "d-foreground"),
        activityLogPath: join(fixture.root, "d-foreground", "activity.jsonl"),
        environment: {},
        timeoutSeconds: 60,
        cwd: fixture.repo,
        captureRepositoryGitSnapshot: () => dirtySnapshot,
        observeRepositoryAdmissionOperation: (operation) => operations.push(operation),
      });
      assert.deepEqual(foreground.repositoryAdmission, {
        access: "exclusive-builder",
        launchMode: "foreground",
        ownershipIntent: "acquire-before-spawn",
        force: true,
        gitSnapshot: dirtySnapshot,
      });
      assert.equal(Object.isFrozen(foreground.repositoryAdmission), true);
      assert.equal(Object.isFrozen(foreground.repositoryAdmission.gitSnapshot), true);

      const dryRun = resolveExecutionPlan({
        request: { team: "builder", mode: "implement", dryRun: true, force: true },
        teamConfig,
        mode: teamConfig.deploy_modes?.[0],
        runtime: "pi",
        deploymentId: "d-dry-run",
        deploymentDir: join(fixture.root, "d-dry-run"),
        activityLogPath: join(fixture.root, "d-dry-run", "activity.jsonl"),
        environment: {},
        timeoutSeconds: 60,
        cwd: fixture.repo,
        captureRepositoryGitSnapshot: () => dirtySnapshot,
        observeRepositoryAdmissionOperation: (operation) => operations.push(operation),
      });
      assert.equal(dryRun.repositoryAdmission.launchMode, "dry-run");
      assert.equal(dryRun.repositoryAdmission.ownershipIntent, "preview");

      assert.throws(() => resolveExecutionPlan({
        request: { team: "builder", mode: "implement", background: true, force: true, ticket: "PAP-174" },
        teamConfig,
        mode: teamConfig.deploy_modes?.[0],
        runtime: "pi",
        deploymentId: "d-background",
        deploymentDir: join(fixture.root, "d-background"),
        activityLogPath: join(fixture.root, "d-background", "activity.jsonl"),
        environment: {},
        timeoutSeconds: 60,
        cwd: fixture.repo,
        captureRepositoryGitSnapshot: () => dirtySnapshot,
        observeRepositoryAdmissionOperation: (operation) => operations.push(operation),
      }), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
        assert.match(message, /state=dirty-background/);
        assert.match(message, /no ownership was acquired/);
        assert.match(message, /foreground.*'ppa' 'deploy' 'builder'.*'--ticket' 'PAP-174'/);
        assert.match(message, /Deploy force does not bypass/);
        assert.doesNotMatch(message, /--force|manual quarantine|\bmv\b/);
        return true;
      });
    });
    assert.deepEqual(operations, ["git-status", "git-status", "git-status"]);
    assert.equal(readdirSync(join(fixture.repo, ".git")).some((name) => name.includes("pa-repository-mutation")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("force does not bypass the ticket guard or trigger status inspection", () => {
  const fixture = createFixture("force-ticket");
  const teamConfig = team();
  const mode = teamConfig.deploy_modes![0]!;
  mode.require_ticket = true;
  let statusCalls = 0;
  try {
    withPlatformConfig(fixture.config, () => {
      assert.throws(() => resolveExecutionPlan({
        request: { team: "builder", mode: "implement", force: true },
        teamConfig,
        mode,
        runtime: "pi",
        deploymentId: "d-ticket",
        deploymentDir: join(fixture.root, "d-ticket"),
        activityLogPath: join(fixture.root, "d-ticket", "activity.jsonl"),
        environment: {},
        timeoutSeconds: 60,
        cwd: fixture.repo,
        captureRepositoryGitSnapshot: () => { statusCalls += 1; return dirtySnapshot; },
      }), /Ticket is required/);
    });
    assert.equal(statusCalls, 0);
    assert.equal(readdirSync(join(fixture.repo, ".git")).some((name) => name.includes("pa-repository-mutation")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
