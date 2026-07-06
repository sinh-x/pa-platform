import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, runCoreCommand, TicketStore } from "../index.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function withBranchCliEnv(fn: (root: string, repo: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pa-core-branch-"));
  const config = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(config, { recursive: true });
  mkdirSync(repo, { recursive: true });

  git(["init", "-b", "develop"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "# Test");
  git(["add", "."], repo);
  git(["commit", "-m", "initial"], repo);

  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    description: Test repo\n    prefix: PAP\n    developBranch: develop\n    mainBranch: main\n`);

  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const previousRegistry = process.env["PA_REGISTRY_DB"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  process.env["PA_REGISTRY_DB"] = join(root, "registry.db");

  const ticketsDir = join(root, "data", "tickets");
  mkdirSync(ticketsDir, { recursive: true });
  const store = new TicketStore(ticketsDir);

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
