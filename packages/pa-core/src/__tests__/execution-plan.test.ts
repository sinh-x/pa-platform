import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function resolveRepoPlan(repo: string, root: string) {
  const teamConfig = team();
  return resolveExecutionPlan({
    request: { team: "builder", mode: "implement", repo },
    teamConfig,
    mode: teamConfig.deploy_modes?.[0],
    runtime: "pi",
    deploymentId: "d-repo-plan",
    deploymentDir: root,
    activityLogPath: join(root, "activity.jsonl"),
    environment: {},
    timeoutSeconds: 60,
  });
}

test("execution plans are immutable and resolve selected skill paths", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-plan-"));
  const skillPath = join(root, "pa-cli", "SKILL.md");
  mkdirSync(join(root, "pa-cli"));
  writeFileSync(skillPath, "# pa-cli\n");
  try {
    const plan = resolveExecutionPlan({
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
    });
    assert.equal(plan.skills[0]?.path, skillPath);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.skills), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing selected skills fail with team, mode, name, and attempted path", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-plan-missing-"));
  try {
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
    }), /team 'builder'.*mode 'implement'.*skill 'missing'.*attempted path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution plans preserve canonical cwd for a registered key and exact canonical path", () => {
  const fixture = createExecutionRepoFixture("canonical");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    withPlatformConfig(fixture.config, () => {
      assert.equal(resolveRepoPlan("registered", fixture.root).repositoryCwd, fixture.repo);
      assert.equal(resolveRepoPlan(fixture.repo, fixture.root).repositoryCwd, fixture.repo);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution plans preserve a linked worktree's normalized absolute top level", () => {
  const fixture = createExecutionRepoFixture("linked");
  const nested = join(fixture.worktree, "nested", "directory");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    const plan = withPlatformConfig(fixture.config, () => resolveRepoPlan(nested, fixture.root));
    assert.equal(plan.repositoryCwd, realpathSync(fixture.worktree));
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
      assert.throws(() => resolveRepoPlan(join(fixture.root, "missing"), fixture.root), /execution path does not exist.*missing/);
      assert.throws(() => resolveRepoPlan(nonGit, fixture.root), /not a Git working tree/);
      assert.throws(() => resolveRepoPlan(unrelatedWorktree, fixture.root), /Unrelated linked worktree.*does not match any registered repository/);
      assert.throws(() => resolveRepoPlan(clone, fixture.root), /independent Git checkout is not a linked worktree/);
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
    const expected = new RegExp(`Ambiguous linked worktree.*first \\(${fixture.repo}\\).*second \\(${second}\\)`);
    withPlatformConfig(fixture.config, () => {
      assert.throws(() => resolveRepoPlan(fixture.worktree, fixture.root), expected);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
