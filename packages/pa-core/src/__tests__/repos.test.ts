import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadReposYaml, normalizeRemoteUrl, resolveProjectFromCwd, resolveRepoByRemoteIdentity } from "../repos.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

test("keeps host and repository path distinct during normalization", () => {
  assert.notEqual(normalizeRemoteUrl("git@github.com:sinh-x/pa-platform.git"), normalizeRemoteUrl("git@gitlab.com:sinh-x/pa-platform.git"));
  assert.notEqual(normalizeRemoteUrl("git@github.com:sinh-x/pa-platform.git"), normalizeRemoteUrl("git@github.com:other/pa-platform.git"));
});

test("lowercases only remote hosts and preserves generic repository path case", () => {
  assert.equal(normalizeRemoteUrl("ssh://git@GIT.EXAMPLE.COM/Owner/Project.git"), "git.example.com/Owner/Project");
  assert.notEqual(normalizeRemoteUrl("git@git.example.com:Owner/Project.git"), normalizeRemoteUrl("git@git.example.com:owner/project.git"));
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
    assert.deepEqual(resolveProjectFromCwd(worktree), { key: "pa-platform", prefix: "PAP" });
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
    assert.deepEqual(resolveProjectFromCwd(actual), { key: "first", prefix: "ONE" });
    writeFileSync(join(config, "config.yaml"), `repos:\n  first:\n    path: ${first}\n    prefix: ONE\n    remote_url: git@git.example.com:Owner/Project.git\n  second:\n    path: ${second}\n    prefix: TWO\n    remote_url: https://git.example.com/Owner/Project\n`);
    assert.throws(() => resolveProjectFromCwd(actual), /Ambiguous.*first.*second/);
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
