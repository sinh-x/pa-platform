import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, runCoreCommand } from "../index.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function withBranchCliEnv(
  fn: (root: string, repo: string) => Promise<void>,
  options: { initialBranch?: string; repoConfig?: (repo: string) => string } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pa-core-branch-"));
  const config = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(repo, { recursive: true });

  git(["init", "-b", options.initialBranch ?? "develop"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "# Test");
  git(["add", "."], repo);
  git(["commit", "-m", "initial"], repo);

  writeFileSync(join(config, "repos.yaml"), options.repoConfig?.(repo) ?? `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n    developBranch: develop\n    mainBranch: main\n`);

  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");

  const ticketsDir = join(root, "data", "tickets");
  mkdirSync(ticketsDir, { recursive: true });

  return fn(root, repo).finally(() => {
    closeDb();
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    if (previousRegistry === undefined) delete process.env["PA_REGISTRY_DB"];
    else process.env["PA_REGISTRY_DB"] = previousRegistry;
    rmSync(root, { recursive: true, force: true });
  });
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

test("branch create with valid ticket and topic creates branch", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "create", "PAP-001", "--topic", "fix-login"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stdout.join("\n"), /Created and checked out feature\/PAP-001-fix-login/);
    assert.equal(git(["branch", "--show-current"], repo), "feature/PAP-001-fix-login");
  });
});

test("branch create honors snake-case custom base branch and pattern", async () => {
  const rootPrefix = "change/PAP-001-snake-case";
  await withBranchCliEnv(async (_root, repo) => {
    const baseCommit = git(["rev-parse", "integration"], repo);
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "create", "PAP-001", "--topic", "snake-case"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(git(["branch", "--show-current"], repo), rootPrefix);
    assert.equal(git(["rev-parse", "HEAD^0"], repo), baseCommit);
  }, {
    initialBranch: "integration",
    repoConfig: (repo) => `repos:\n  pa-platform:\n    path: ${repo}\n    prefix: PAP\n    main_branch: trunk\n    develop_branch: integration\n    feature_branch_pattern: "change/<ticket>-<topic>"\n`,
  });
});

test("branch create without ticket id returns error", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "create"], { io: captured.io }), 1);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stderr.join("\n"), /requires at least one ticket id/);
  });
});

test("branch create without --topic returns error", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "create", "PAP-001"], { io: captured.io }), 1);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stderr.join("\n"), /requires --topic/);
  });
});

test("branch create with duplicate branch name returns error", async () => {
  await withBranchCliEnv(async (root, repo) => {
    git(["checkout", "-b", "feature/PAP-001-existing", "develop"], repo);
    git(["checkout", "develop"], repo);
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "create", "PAP-001", "--topic", "existing"], { io: captured.io }), 1);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stderr.join("\n"), /already exists/);
  });
});

test("branch validate on conforming branch returns success", async () => {
  await withBranchCliEnv(async (root, repo) => {
    git(["checkout", "-b", "feature/PAP-001-fix-login", "develop"], repo);
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "validate"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(captured.stdout, []);
  });
});

test("branch validate reads the invoking linked worktree branch", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const worktree = join(root, "linked-worktree");
    git(["worktree", "add", "-b", "feature/PAP-135-linked", worktree], repo);
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(worktree);
    try {
      assert.equal(await runCoreCommand(["branch", "validate"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(captured.stdout, []);
    assert.deepEqual(captured.stderr, []);
  });
});

test("branch create operates on the invoking linked worktree", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const worktree = join(root, "linked-worktree");
    git(["worktree", "add", "-b", "feature/PAP-135-linked", worktree], repo);
    const canonicalBefore = execFileSync("git", ["status", "--porcelain=v2", "--branch"], { cwd: repo });
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(worktree);
    try {
      assert.equal(await runCoreCommand(["branch", "create", "PAP-135", "--topic", "isolated"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }

    assert.equal(git(["branch", "--show-current"], worktree), "feature/PAP-135-isolated");
    assert.equal(git(["branch", "--show-current"], repo), "develop");
    assert.deepEqual(execFileSync("git", ["status", "--porcelain=v2", "--branch"], { cwd: repo }), canonicalBefore);
  });
});

test("branch validate on non-conforming branch prints warning", async () => {
  await withBranchCliEnv(async (root, repo) => {
    git(["checkout", "-b", "my-random-branch", "develop"], repo);
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "validate"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stdout.join("\n"), /does not match the configured branch pattern/);
  });
});

test("branch validate on develop (base branch) prints warning", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "validate"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stdout.join("\n"), /is a base branch, not a feature branch/);
  });
});

test("branch create with multiple tickets creates multi-ticket branch", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "create", "PAP-001", "PAP-002", "--topic", "shared-work"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stdout.join("\n"), /Created and checked out feature\/PAP-001-PAP-002-shared-work/);
    assert.equal(git(["branch", "--show-current"], repo), "feature/PAP-001-PAP-002-shared-work");
  });
});

test("branch validate not in registered repo returns error", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const outsideDir = join(root, "outside");
    mkdirSync(outsideDir, { recursive: true });
    git(["init"], outsideDir);
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(outsideDir);
    try {
      assert.equal(await runCoreCommand(["branch", "validate"], { io: captured.io }), 1);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stderr.join("\n"), /Not in a registered repository/);
  });
});

test("branch create warns on unknown ticket id but still creates branch", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "create", "PAP-999", "--topic", "new-feature"], { io: captured.io }), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stderr.join("\n"), /Warning: ticket "PAP-999" not found/);
    assert.match(captured.stdout.join("\n"), /Created and checked out feature\/PAP-999-new-feature/);
  });
});

test("unknown branch subcommand returns error", async () => {
  await withBranchCliEnv(async (root, repo) => {
    const captured = capture();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(await runCoreCommand(["branch", "unknown"], { io: captured.io }), 1);
    } finally {
      process.chdir(cwd);
    }
    assert.match(captured.stderr.join("\n"), /Unknown branch subcommand/);
    assert.match(captured.stderr.join("\n"), /Available subcommands: create, validate/);
  });
});
