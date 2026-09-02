import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { resolveExecutionPlan } from "../deploy/plan.js";
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
  worktree: string;
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

function createExecutionRepoFixture(name: string): ExecutionRepoFixture {
  const root = mkdtempSync(join(tmpdir(), `execution-plan-repo-${name}-`));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const worktree = join(root, "linked-worktree");
  mkdirSync(config);
  initializeRepo(repo);
  git(["worktree", "add", "-b", `feature/${name}`, worktree], repo);
  return { root, config, repo, worktree };
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

function resolveRepoPlan(repo: string | undefined, root: string, cwd?: string) {
  const teamConfig = team();
  return resolveExecutionPlan({
    request: { team: "builder", mode: "implement", ...(repo ? { repo } : {}) },
    teamConfig,
    mode: teamConfig.deploy_modes?.[0],
    runtime: "pi",
    deploymentId: "d-repo-plan",
    deploymentDir: root,
    activityLogPath: join(root, "activity.jsonl"),
    environment: { PA_REPO: "/stale/request/path" },
    timeoutSeconds: 60,
    ...(cwd ? { cwd } : {}),
  });
}

test("execution plans are immutable and resolve selected skill paths", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-plan-"));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const skillPath = join(root, "pa-cli", "SKILL.md");
  mkdirSync(config);
  mkdirSync(join(root, "pa-cli"));
  initializeRepo(repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n`);
  writeFileSync(skillPath, "# pa-cli\n");
  try {
    const plan = withPlatformConfig(config, () => resolveExecutionPlan({
      request: { team: "builder", mode: "implement" },
      teamConfig: team("pa-cli"),
      mode: team("pa-cli").deploy_modes?.[0],
      runtime: "pi",
      deploymentId: "d-plan01",
      deploymentDir: root,
      activityLogPath: join(root, "activity.jsonl"),
      environment: { PA_TEAM: "builder" },
      timeoutSeconds: 60,
      skillsDir: root,
      cwd: repo,
    }));
    assert.equal(plan.skills[0]?.path, skillPath);
    assert.equal(plan.repoKey, "registered");
    assert.equal(plan.repoRoot, repo);
    assert.equal(plan.repositoryCwd, repo);
    assert.equal(plan.memoryDocumentRoot, repo);
    assert.equal(plan.repositoryAccess, "mutating");
    assert.equal(plan.environment.PA_REPO, repo);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.skills), true);
    assert.equal(Object.isFrozen(plan.environment), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing selected skills fail with team, mode, name, and attempted path", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-plan-missing-"));
  const config = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(config);
  initializeRepo(repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n`);
  try {
    withPlatformConfig(config, () => {
      assert.throws(() => resolveExecutionPlan({
        request: { team: "builder", mode: "implement" },
        teamConfig: team("missing"),
        mode: team("missing").deploy_modes?.[0],
        runtime: "pi",
        deploymentId: "d-plan02",
        deploymentDir: root,
        activityLogPath: join(root, "activity.jsonl"),
        environment: {},
        timeoutSeconds: 60,
        skillsDir: root,
        cwd: repo,
      }), /team 'builder'.*mode 'implement'.*skill 'missing'.*attempted path/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution plans preserve canonical cwd for a registered key and exact canonical path", () => {
  const fixture = createExecutionRepoFixture("canonical");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    withPlatformConfig(fixture.config, () => {
      const byKey = resolveRepoPlan("registered", fixture.root);
      const byPath = resolveRepoPlan(fixture.repo, fixture.root);
      assert.equal(byKey.repoKey, "registered");
      assert.equal(byKey.repoRoot, fixture.repo);
      assert.equal(byKey.repositoryCwd, fixture.repo);
      assert.equal(byKey.memoryDocumentRoot, fixture.repo);
      assert.equal(byKey.environment.PA_REPO, fixture.repo);
      assert.deepEqual(
        { key: byKey.repoKey, root: byKey.repoRoot, cwd: byKey.repositoryCwd, memoryRoot: byKey.memoryDocumentRoot, paRepo: byKey.environment.PA_REPO },
        { key: byPath.repoKey, root: byPath.repoRoot, cwd: byPath.repositoryCwd, memoryRoot: byPath.memoryDocumentRoot, paRepo: byPath.environment.PA_REPO },
      );
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution plans infer a linked-worktree CWD but relocate every repository field to the configured root", () => {
  const fixture = createExecutionRepoFixture("linked");
  const nested = join(fixture.worktree, "nested", "directory");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    const plan = withPlatformConfig(fixture.config, () => resolveRepoPlan(undefined, fixture.root, nested));
    assert.equal(plan.repoKey, "registered");
    assert.equal(plan.repoRoot, fixture.repo);
    assert.equal(plan.repositoryCwd, fixture.repo);
    assert.equal(plan.memoryDocumentRoot, fixture.repo);
    assert.equal(plan.environment.PA_REPO, fixture.repo);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution planning rejects invalid, unrelated, and independent-clone paths", () => {
  const fixture = createExecutionRepoFixture("rejections");
  const nonGit = join(fixture.root, "non-git");
  const unrelatedRepo = join(fixture.root, "unrelated-repo");
  const unrelatedWorktree = join(fixture.root, "unrelated-worktree");
  const clone = join(fixture.root, "independent-clone");
  const remote = "git@github.com:owner/project.git";
  mkdirSync(nonGit);
  initializeRepo(unrelatedRepo);
  git(["worktree", "add", "-b", "feature/unrelated", unrelatedWorktree], unrelatedRepo);
  git(["clone", fixture.repo, clone], fixture.root);
  git(["remote", "set-url", "origin", remote], clone);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n    remote_url: ${remote}\n`);
  try {
    withPlatformConfig(fixture.config, () => {
      assert.throws(() => resolveRepoPlan(join(fixture.root, "missing"), fixture.root), /registered project paths only.*does not exist.*missing/is);
      assert.throws(() => resolveRepoPlan(nonGit, fixture.root), /registered project paths only.*not a Git working tree/is);
      assert.throws(() => resolveRepoPlan(unrelatedWorktree, fixture.root), /registered project paths only.*not a registered repository key or exact configured path/is);
      assert.throws(() => resolveRepoPlan(clone, fixture.root), /registered project paths only.*independent or otherwise unregistered checkout/is);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-plan ambiguity names every competing repository key and path", () => {
  const fixture = createExecutionRepoFixture("ambiguity");
  const second = join(fixture.root, "second-registered-worktree");
  git(["worktree", "add", "-b", "feature/second", second], fixture.repo);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  first:\n    path: ${fixture.repo}\n  second:\n    path: ${second}\n`);
  try {
    const expected = new RegExp(`ambiguous registered identity.*first \\(${fixture.repo}\\).*second \\(${second}\\)`, "is");
    withPlatformConfig(fixture.config, () => {
      assert.throws(() => resolveRepoPlan(fixture.worktree, fixture.root), expected);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
