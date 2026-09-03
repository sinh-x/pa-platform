import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_REPOSITORY_DIAGNOSTIC_CHARS,
  loadReposYaml,
  resolveProjectFromCwd,
  resolveRepoExecutionPath,
} from "../repos.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface RepoFixture {
  root: string;
  config: string;
  repo: string;
  linked: string;
}

function createFixture(name: string, remote?: string): RepoFixture {
  const root = mkdtempSync(join(tmpdir(), `pa-core-repos-${name}-`));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const linked = join(root, "linked");
  mkdirSync(config);
  mkdirSync(repo);
  git(["init", "-b", "develop"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "# Test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  if (remote) git(["remote", "add", "origin", remote], repo);
  git(["worktree", "add", "-b", `feature/${name}`, linked], repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n    prefix: REG\n${remote ? `    remote_url: ${remote}\n` : ""}`);
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

function diagnostic(callback: () => unknown): string {
  try {
    callback();
    assert.fail("expected repository resolution to fail");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function assertBoundedActionable(message: string): void {
  assert.ok(message.length > 0);
  assert.ok(message.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS, `diagnostic length ${message.length} exceeds ${MAX_REPOSITORY_DIAGNOSTIC_CHARS}`);
  assert.match(message, /registered project paths only/i);
  assert.match(message, /Corrective action/i);
}

test("merges external and user config repository maps with user precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-config-"));
  const config = join(root, "config");
  const external = join(root, "external");
  mkdirSync(config);
  mkdirSync(external);
  try {
    writeFileSync(join(config, "config.yaml"), `config_dir: ${external}\nrepos:\n  shared:\n    path: ${root}/user-shared\n    prefix: USER\n  user-only:\n    path: ${root}/user-only\n`);
    writeFileSync(join(external, "config.yaml"), `repos:\n  shared:\n    path: ${root}/external-shared\n    prefix: EXTERNAL\n  external-only:\n    path: ${root}/external-only\n`);
    assert.deepEqual(withPlatformConfig(config, loadReposYaml), {
      shared: { path: `${root}/user-shared`, prefix: "USER" },
      "user-only": { path: `${root}/user-only` },
      "external-only": { path: `${root}/external-only` },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered key and exact configured root resolve identically", () => {
  const fixture = createFixture("exact");
  try {
    withPlatformConfig(fixture.config, () => {
      const byKey = resolveRepoExecutionPath("registered");
      const byPath = resolveRepoExecutionPath(fixture.repo);
      assert.deepEqual(
        { key: byKey.repoKey, root: byKey.repoRoot, cwd: byKey.repositoryCwd },
        { key: byPath.repoKey, root: byPath.repoRoot, cwd: byPath.repositoryCwd },
      );
      assert.equal(byKey.inferredFrom, "explicit");
      assert.equal(byPath.inferredFrom, "explicit");
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("omitted input resolves the exact configured root from root and nested CWDs", () => {
  const fixture = createFixture("cwd");
  const nested = join(fixture.repo, "nested", "directory");
  mkdirSync(nested, { recursive: true });
  try {
    withPlatformConfig(fixture.config, () => {
      for (const cwd of [fixture.repo, nested]) {
        const resolved = resolveRepoExecutionPath(undefined, cwd);
        assert.equal(resolved.repoKey, "registered");
        assert.equal(resolved.repoRoot, fixture.repo);
        assert.equal(resolved.repositoryCwd, fixture.repo);
        assert.equal(resolved.inferredFrom, "cwd");
      }
      assert.deepEqual(resolveProjectFromCwd(nested), { key: "registered", prefix: "REG", repoRoot: fixture.repo });
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit linked working-tree input fails with a bounded actionable diagnostic", () => {
  const fixture = createFixture("explicit-linked");
  try {
    const message = withPlatformConfig(fixture.config, () => diagnostic(() => resolveRepoExecutionPath(fixture.linked)));
    assertBoundedActionable(message);
    assert.match(message, /linked Git working tree/i);
    assert.match(message, /--repo "registered"/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("linked working-tree CWD inference fails with a bounded actionable diagnostic", () => {
  const fixture = createFixture("cwd-linked");
  const nested = join(fixture.linked, "nested");
  mkdirSync(nested);
  try {
    const message = withPlatformConfig(fixture.config, () => diagnostic(() => resolveRepoExecutionPath(undefined, nested)));
    assertBoundedActionable(message);
    assert.match(message, /linked Git working tree/i);
    assert.equal(withPlatformConfig(fixture.config, () => resolveProjectFromCwd(nested)), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a linked working tree cannot itself be configured as a deployment root", () => {
  const fixture = createFixture("configured-linked");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  linked:\n    path: ${fixture.linked}\n`);
  try {
    const message = withPlatformConfig(fixture.config, () => diagnostic(() => resolveRepoExecutionPath("linked")));
    assertBoundedActionable(message);
    assert.match(message, /Register the primary working tree root/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit nested paths, aliases, clones, and unknown paths are rejected", () => {
  const fixture = createFixture("reject", "git@github.com:owner/project.git");
  const nested = join(fixture.repo, "nested");
  const alias = join(fixture.root, "alias");
  const clone = join(fixture.root, "clone");
  mkdirSync(nested);
  symlinkSync(fixture.repo, alias, "dir");
  git(["clone", fixture.repo, clone], fixture.root);
  git(["remote", "set-url", "origin", "git@github.com:owner/project.git"], clone);
  try {
    withPlatformConfig(fixture.config, () => {
      for (const input of [nested, alias, clone, join(fixture.root, "missing")]) {
        assertBoundedActionable(diagnostic(() => resolveRepoExecutionPath(input)));
      }
      assert.equal(resolveProjectFromCwd(clone), undefined);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repository validation diagnostics stay bounded with a large registry", () => {
  const fixture = createFixture("bounded");
  const entries = Array.from({ length: 120 }, (_, index) => `  repository-${String(index).padStart(3, "0")}-${"x".repeat(24)}:\n    path: ${fixture.root}/missing-${index}-${"y".repeat(24)}`).join("\n");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n${entries}\n`);
  try {
    const message = withPlatformConfig(fixture.config, () => diagnostic(() => resolveRepoExecutionPath(join(fixture.root, "not-registered"))));
    assertBoundedActionable(message);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
