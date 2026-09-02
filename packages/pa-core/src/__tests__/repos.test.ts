import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { MAX_REPOSITORY_DIAGNOSTIC_CHARS, loadReposYaml, normalizeRemoteUrl, resolveProjectFromCwd, resolveRepoByRemoteIdentity, resolveRepoExecutionPath } from "../repos.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface LinkedFixture {
  root: string;
  config: string;
  repo: string;
  worktree: string;
}

function createLinkedFixture(name: string, remote?: string): LinkedFixture {
  const root = mkdtempSync(join(tmpdir(), `pa-core-repos-execution-${name}-`));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const worktree = join(root, "linked-worktree");
  mkdirSync(config);
  mkdirSync(repo);
  git(["init", "-b", "develop"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "# Test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  if (remote) git(["remote", "add", "origin", remote], repo);
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

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (path: string): void => {
    const relativePath = relative(root, path) || ".";
    const stat = lstatSync(path);
    const metadata = `${stat.mode} ${stat.mtimeMs} ${stat.ctimeMs}`;
    if (stat.isSymbolicLink()) {
      entries.push(`link ${relativePath} ${metadata} ${readlinkSync(path)}`);
      return;
    }
    if (stat.isDirectory()) {
      entries.push(`dir ${relativePath} ${metadata}`);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    entries.push(`file ${relativePath} ${metadata} ${digest}`);
  };
  visit(root);
  return entries;
}

function assertRejectedWithoutMutation(root: string, callback: () => unknown, expected: RegExp): void {
  const before = snapshotTree(root);
  assert.throws(callback, expected);
  assert.deepEqual(snapshotTree(root), before);
}

test("normalizes equivalent SSH and HTTPS GitHub remotes", () => {
  const urls = [
    "git@github.com:sinh-x/pa-platform.git",
    "https://github.com/sinh-x/pa-platform",
    "https://github.com/sinh-x/pa-platform/",
    "ssh://git@github.com/sinh-x/pa-platform.git",
  ];
  assert.deepEqual(new Set(urls.map(normalizeRemoteUrl)), new Set(["github.com/sinh-x/pa-platform"]));
});

test("normalizes mixed-case GitHub repository paths", () => {
  assert.equal(normalizeRemoteUrl("git@GitHub.com:Sinh-X/PA-Platform.git"), "github.com/sinh-x/pa-platform");
  assert.equal(normalizeRemoteUrl("https://github.com/SINH-X/pa-platform"), "github.com/sinh-x/pa-platform");
});

test("keeps host and repository path distinct during normalization", () => {
  assert.notEqual(normalizeRemoteUrl("git@github.com:sinh-x/pa-platform.git"), normalizeRemoteUrl("git@gitlab.com:sinh-x/pa-platform.git"));
  assert.notEqual(normalizeRemoteUrl("git@github.com:sinh-x/pa-platform.git"), normalizeRemoteUrl("git@github.com:other/pa-platform.git"));
});

test("lowercases only remote hosts and preserves generic repository path case", () => {
  assert.equal(normalizeRemoteUrl("ssh://git@GIT.EXAMPLE.COM/Owner/Project.git"), "git.example.com/Owner/Project");
  assert.notEqual(normalizeRemoteUrl("git@git.example.com:Owner/Project.git"), normalizeRemoteUrl("git@git.example.com:owner/project.git"));
  assert.notEqual(normalizeRemoteUrl("git@git.example.com:Owner/Project.GIT"), normalizeRemoteUrl("git@git.example.com:Owner/Project"));
  assert.equal(normalizeRemoteUrl("git@github.com:Owner/Project.GIT"), normalizeRemoteUrl("git@github.com:owner/project"));
});

test("preserves non-default remote ports and omits default ports", () => {
  assert.equal(normalizeRemoteUrl("https://github.com:443/owner/project.git"), "github.com/owner/project");
  assert.equal(normalizeRemoteUrl("ssh://git@github.com:22/owner/project.git"), "github.com/owner/project");
  assert.equal(normalizeRemoteUrl("https://github.com:8443/owner/project.git"), "github.com:8443/owner/project");
  assert.notEqual(normalizeRemoteUrl("https://github.com:8443/owner/project.git"), normalizeRemoteUrl("https://github.com/owner/project.git"));
});

test("merges external and user config repository maps with user precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-config-"));
  const config = join(root, "config");
  const external = join(root, "external");
  mkdirSync(config);
  mkdirSync(external);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  try {
    process.env["PA_PLATFORM_CONFIG"] = config;
    writeFileSync(join(config, "config.yaml"), `config_dir: ${external}\nrepos:\n  shared:\n    path: ${join(root, "user-shared")}\n    prefix: USER\n  user-only:\n    path: ${join(root, "user-only")}\n`);
    writeFileSync(join(external, "config.yaml"), `repos:\n  shared:\n    path: ${join(root, "external-shared")}\n    prefix: EXTERNAL\n  external-only:\n    path: ${join(root, "external-only")}\n`);

    assert.deepEqual(loadReposYaml(), {
      shared: { path: join(root, "user-shared"), prefix: "USER" },
      "user-only": { path: join(root, "user-only") },
      "external-only": { path: join(root, "external-only") },
    });
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes snake-case branch aliases while preserving camel-case settings", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-branches-"));
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const previousHome = process.env["PA_PLATFORM_HOME"];
  process.env["PA_PLATFORM_CONFIG"] = root;
  process.env["PA_PLATFORM_HOME"] = root;
  try {
    writeFileSync(join(root, "config.yaml"), `repos:\n  snake:\n    path: ${root}/snake\n    main_branch: trunk\n    develop_branch: integration\n    feature_branch_pattern: "change/<ticket>-<topic>"\n  camel:\n    path: ${root}/camel\n    mainBranch: stable\n    developBranch: next\n    featureBranchPattern: "feature/<ticket>-<topic>"\n`);
    assert.deepEqual(loadReposYaml(), {
      snake: { path: `${root}/snake`, mainBranch: "trunk", developBranch: "integration", featureBranchPattern: "change/<ticket>-<topic>" },
      camel: { path: `${root}/camel`, mainBranch: "stable", developBranch: "next", featureBranchPattern: "feature/<ticket>-<topic>" },
    });
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    if (previousHome === undefined) delete process.env["PA_PLATFORM_HOME"];
    else process.env["PA_PLATFORM_HOME"] = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves a registered repository from a real linked worktree without an origin", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-worktree-"));
  const repo = join(root, "repo");
  const worktree = join(root, "linked-worktree");
  const config = join(root, "config");
  mkdirSync(repo);
  mkdirSync(config);
  git(["init", "-b", "develop"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "# Test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  git(["worktree", "add", "-b", "feature/PAP-135-linked", worktree], repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    prefix: PAP\n`);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    assert.deepEqual(resolveProjectFromCwd(worktree), { key: "pa-platform", prefix: "PAP", repoRoot: worktree });
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to the actual worktree origin and rejects ambiguous remote identities", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-cwd-remote-"));
  const actual = join(root, "actual");
  const first = join(root, "first");
  const second = join(root, "second");
  const config = join(root, "config");
  for (const path of [actual, first, second, config]) mkdirSync(path);
  for (const path of [actual, first, second]) git(["init"], path);
  git(["remote", "add", "origin", "ssh://git@Git.Example.com/Owner/Project.git"], actual);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    writeFileSync(join(config, "config.yaml"), `repos:\n  wrong-case:\n    path: ${first}\n    prefix: WRONG\n    remote_url: git@git.example.com:owner/project.git\n`);
    assert.equal(resolveProjectFromCwd(actual), undefined);
    writeFileSync(join(config, "config.yaml"), `repos:\n  first:\n    path: ${first}\n    prefix: ONE\n    remote_url: git@git.example.com:Owner/Project.git\n`);
    assert.deepEqual(resolveProjectFromCwd(actual), { key: "first", prefix: "ONE", repoRoot: actual });
    writeFileSync(join(config, "config.yaml"), `repos:\n  first:\n    path: ${first}\n    prefix: ONE\n    remote_url: git@git.example.com:Owner/Project.git\n  second:\n    path: ${second}\n    prefix: TWO\n    remote_url: https://git.example.com/Owner/Project\n`);
    assert.throws(() => resolveProjectFromCwd(actual), /Ambiguous.*first.*second/);
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats local-path CWD origins as unregistered", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-cwd-local-origin-"));
  const actual = join(root, "actual");
  const registered = join(root, "registered");
  const config = join(root, "config");
  for (const path of [actual, registered, config]) mkdirSync(path);
  git(["init"], actual);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${registered}\n    prefix: REG\n    remote_url: git@github.com:owner/project.git\n`);
    git(["remote", "add", "origin", "/srv/git/project.git"], actual);
    for (const origin of ["/srv/git/project.git", "./project.git", "../project.git", "project.git", "subdir/project.git", "file:///srv/git/project.git"]) {
      git(["remote", "set-url", "origin", origin], actual);
      assert.equal(resolveProjectFromCwd(actual), undefined);
    }
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("surfaces malformed configured remote URLs during CWD fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-cwd-invalid-config-"));
  const actual = join(root, "actual");
  const registered = join(root, "registered");
  const config = join(root, "config");
  for (const path of [actual, registered, config]) mkdirSync(path);
  git(["init"], actual);
  git(["remote", "add", "origin", "git@github.com:owner/project.git"], actual);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${registered}\n    prefix: REG\n    remote_url: not-a-remote\n`);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    assert.throws(() => resolveProjectFromCwd(actual), /Invalid remote URL: not-a-remote/);
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves a unique remote and rejects duplicate identities", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-"));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const previous = process.env["PA_PLATFORM_CONFIG"];
  const previousHome = process.env["PA_PLATFORM_HOME"];
  process.env["PA_PLATFORM_CONFIG"] = root;
  process.env["PA_PLATFORM_HOME"] = root;
  writeFileSync(join(root, "config.yaml"), `repos:\n  first:\n    path: ${first}\n    remote_url: git@github.com:owner/project.git\n  second:\n    path: ${second}\n    remote_url: https://github.com/owner/other.git\n`);
  try {
    assert.equal(resolveRepoByRemoteIdentity("https://github.com/owner/missing"), null);
    assert.equal(resolveRepoByRemoteIdentity("https://github.com/owner/project/")?.name, "first");
    writeFileSync(join(root, "config.yaml"), `repos:\n  first:\n    path: ${first}\n    remote_url: git@github.com:owner/project.git\n  second:\n    path: ${second}\n    remote_url: https://github.com/owner/project.git\n`);
    assert.throws(() => resolveRepoByRemoteIdentity("https://github.com/owner/project"), /Ambiguous.*first.*second/);
  } finally {
    if (previous === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previous;
    if (previousHome === undefined) delete process.env["PA_PLATFORM_HOME"];
    else process.env["PA_PLATFORM_HOME"] = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution-path resolution preserves registered key behavior", () => {
  const fixture = createLinkedFixture("canonical-key");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n    prefix: REG\n`);
  try {
    const resolved = withPlatformConfig(fixture.config, () => resolveRepoExecutionPath("registered"));
    assert.equal(resolved.repo.name, "registered");
    assert.equal(resolved.repoKey, "registered");
    assert.equal(resolved.repoRoot, fixture.repo);
    assert.equal(resolved.repositoryCwd, fixture.repo);
    assert.equal(resolved.inferredFrom, "explicit");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-path resolution preserves exact canonical path behavior", () => {
  const fixture = createLinkedFixture("canonical-path");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    const resolved = withPlatformConfig(fixture.config, () => resolveRepoExecutionPath(fixture.repo));
    assert.equal(resolved.repo.name, "registered");
    assert.equal(resolved.repositoryCwd, fixture.repo);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("omitted execution input infers registered root, nested path, and linked worktree but relocates to the configured path", () => {
  const fixture = createLinkedFixture("cwd-inference");
  const registeredNested = join(fixture.repo, "nested", "registered");
  const worktreeNested = join(fixture.worktree, "nested", "worktree");
  mkdirSync(registeredNested, { recursive: true });
  mkdirSync(worktreeNested, { recursive: true });
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    withPlatformConfig(fixture.config, () => {
      for (const cwd of [fixture.repo, registeredNested, fixture.worktree, worktreeNested]) {
        const resolved = resolveRepoExecutionPath(undefined, cwd);
        assert.equal(resolved.repoKey, "registered");
        assert.equal(resolved.repoRoot, fixture.repo);
        assert.equal(resolved.repositoryCwd, fixture.repo);
        assert.equal(resolved.inferredFrom, "cwd");
      }
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit nested, linked-worktree, and symlink-alias paths fail with the registered correction", () => {
  const fixture = createLinkedFixture("explicit-rejections");
  const registeredNested = join(fixture.repo, "nested");
  const alias = join(fixture.root, "repo-alias");
  mkdirSync(registeredNested);
  symlinkSync(fixture.repo, alias, "dir");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    withPlatformConfig(fixture.config, () => {
      for (const path of [registeredNested, fixture.worktree, alias]) {
        assertRejectedWithoutMutation(fixture.root, () => resolveRepoExecutionPath(path), /registered project paths only.*not the exact configured path.*--repo "registered"/is);
      }
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-path resolution rejects a nonexistent path without mutation", () => {
  const fixture = createLinkedFixture("nonexistent");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    withPlatformConfig(fixture.config, () => assertRejectedWithoutMutation(
      fixture.root,
      () => resolveRepoExecutionPath(join(fixture.root, "missing")),
      /registered project paths only.*does not exist.*missing/is,
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-path resolution rejects a non-Git directory without mutation", () => {
  const fixture = createLinkedFixture("non-git");
  const nonGit = join(fixture.root, "not-a-repository");
  mkdirSync(nonGit);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    withPlatformConfig(fixture.config, () => assertRejectedWithoutMutation(
      fixture.root,
      () => resolveRepoExecutionPath(nonGit),
      /registered project paths only.*not a Git working tree/is,
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-path resolution rejects copied .git indirection without mutation", () => {
  const fixture = createLinkedFixture("copied-gitdir");
  const forgedWorktree = join(fixture.root, "forged-worktree");
  mkdirSync(forgedWorktree);
  copyFileSync(join(fixture.worktree, ".git"), join(forgedWorktree, ".git"));
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    withPlatformConfig(fixture.config, () => assertRejectedWithoutMutation(
      fixture.root,
      () => resolveRepoExecutionPath(forgedWorktree),
      /registered project paths only.*belongs to a different working tree/is,
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-path resolution rejects an unrelated linked worktree even when its remote matches", () => {
  const remote = "git@github.com:owner/project.git";
  const fixture = createLinkedFixture("unrelated", remote);
  const otherRepo = join(fixture.root, "other-repo");
  const otherWorktree = join(fixture.root, "other-worktree");
  mkdirSync(otherRepo);
  git(["init", "-b", "develop"], otherRepo);
  git(["config", "user.email", "test@example.com"], otherRepo);
  git(["config", "user.name", "Test"], otherRepo);
  writeFileSync(join(otherRepo, "README.md"), "# Other\n");
  git(["add", "README.md"], otherRepo);
  git(["commit", "-m", "initial"], otherRepo);
  git(["remote", "add", "origin", remote], otherRepo);
  git(["worktree", "add", "-b", "feature/unrelated-other", otherWorktree], otherRepo);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n    remote_url: ${remote}\n`);
  try {
    withPlatformConfig(fixture.config, () => assertRejectedWithoutMutation(
      fixture.root,
      () => resolveRepoExecutionPath(otherWorktree),
      /registered project paths only.*independent or otherwise unregistered checkout.*--repo "registered"/is,
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-path resolution rejects an independent clone with the registered remote", () => {
  const remote = "git@github.com:owner/project.git";
  const fixture = createLinkedFixture("independent-clone", remote);
  const clone = join(fixture.root, "independent-clone");
  git(["clone", fixture.repo, clone], fixture.root);
  git(["remote", "set-url", "origin", remote], clone);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n    remote_url: ${remote}\n`);
  try {
    withPlatformConfig(fixture.config, () => assertRejectedWithoutMutation(
      fixture.root,
      () => resolveRepoExecutionPath(clone),
      /registered project paths only.*independent or otherwise unregistered checkout.*--repo "registered"/is,
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit worktree identity remains ambiguous when multiple registered roots share its Git common directory", () => {
  const remote = "git@github.com:owner/project.git";
  const fixture = createLinkedFixture("remote-narrowing", remote);
  const secondRegisteredPath = join(fixture.root, "second-registered-worktree");
  git(["worktree", "add", "-b", "feature/remote-second", secondRegisteredPath], fixture.repo);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  matching:\n    path: ${fixture.repo}\n    remote_url: https://github.com/OWNER/project\n  other:\n    path: ${secondRegisteredPath}\n    remote_url: git@github.com:owner/other.git\n`);
  try {
    withPlatformConfig(fixture.config, () => {
      assert.throws(() => resolveRepoExecutionPath(fixture.worktree), /ambiguous registered identity.*matching.*other/is);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-path resolution does not trust local origins to narrow candidates", () => {
  const fixture = createLinkedFixture("local-origin", "../local/project.git");
  const secondRegisteredPath = join(fixture.root, "second-registered-worktree");
  git(["worktree", "add", "-b", "feature/local-second", secondRegisteredPath], fixture.repo);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  first:\n    path: ${fixture.repo}\n    remote_url: ../local/project.git\n  second:\n    path: ${secondRegisteredPath}\n    remote_url: git@github.com:owner/other.git\n`);
  try {
    withPlatformConfig(fixture.config, () => assertRejectedWithoutMutation(
      fixture.root,
      () => resolveRepoExecutionPath(fixture.worktree),
      /ambiguous registered identity.*first.*second/is,
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution-path ambiguity names every competing key and canonical path without mutation", () => {
  const fixture = createLinkedFixture("ambiguous");
  const secondRegisteredPath = join(fixture.root, "second-registered-worktree");
  git(["worktree", "add", "-b", "feature/ambiguous-second", secondRegisteredPath], fixture.repo);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  first:\n    path: ${fixture.repo}\n  second:\n    path: ${secondRegisteredPath}\n`);
  try {
    const expected = new RegExp(`ambiguous registered identity.*first \\(${fixture.repo}\\).*second \\(${secondRegisteredPath}\\)`, "is");
    withPlatformConfig(fixture.config, () => assertRejectedWithoutMutation(
      fixture.root,
      () => resolveRepoExecutionPath(fixture.worktree),
      expected,
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("omitted execution input rejects unregistered Git and non-Git working directories", () => {
  const fixture = createLinkedFixture("cwd-rejections");
  const unregistered = join(fixture.root, "unregistered");
  const nonGit = join(fixture.root, "non-git-cwd");
  mkdirSync(unregistered);
  mkdirSync(nonGit);
  git(["init", "-b", "develop"], unregistered);
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  registered:\n    path: ${fixture.repo}\n`);
  try {
    withPlatformConfig(fixture.config, () => {
      assert.throws(() => resolveRepoExecutionPath(undefined, unregistered), /registered project paths only.*does not identify a unique registered project/is);
      assert.throws(() => resolveRepoExecutionPath(undefined, nonGit), /registered project paths only.*not a Git working tree/is);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repository validation diagnostics are bounded", () => {
  const fixture = createLinkedFixture("bounded-diagnostic");
  const entries = Array.from({ length: 120 }, (_, index) => `  repository-${String(index).padStart(3, "0")}-${"x".repeat(24)}:\n    path: ${fixture.root}/missing-${index}-${"y".repeat(24)}`).join("\n");
  writeFileSync(join(fixture.config, "config.yaml"), `repos:\n${entries}\n`);
  try {
    withPlatformConfig(fixture.config, () => {
      let message = "";
      try {
        resolveRepoExecutionPath(join(fixture.root, "not-registered"));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.ok(message.length > 0);
      assert.ok(message.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS, `diagnostic length ${message.length} exceeds ${MAX_REPOSITORY_DIAGNOSTIC_CHARS}`);
      assert.match(message, /registered project paths only/i);
      assert.match(message, /Corrective action/i);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
