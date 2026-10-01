import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type OverlayOptions } from "@earendil-works/pi-tui";
import {
  GIT_CONTEXT_COLLECTION_DEADLINE_MS,
  GIT_CONTEXT_COMMIT_LIMIT,
  GIT_CONTEXT_FILE_LIMIT,
  GIT_CONTEXT_REFRESH_INTERVAL_MS,
  GIT_CONTEXT_STATE_FILE_NAME,
  GitContextRefreshScheduler,
  collectGitContext,
  gitContextStatePath,
  loadGitContextReference,
  parseGitBranches,
  parseGitLog,
  parseGitNumstat,
  persistGitContextReference,
  resolveGitReference,
  type GitBranch,
  type GitCommandRunner,
  type GitFileRow,
  type GitContextCollectionInput,
  type GitContextState,
} from "../pi-extension/git-context-state.js";
import { contextOverlayOptions } from "../pi-extension/context-overlay-layout.js";
import { registerContextUiModuleWithOptions } from "../pi-extension/context-ui.js";
import {
  GIT_CONTEXT_COMMAND,
  GIT_CONTEXT_SHORTCUT,
  GitContextPanelComponent,
  GitReferenceSelectorComponent,
  formatGitContextLines,
  registerGitContextUiModuleWithOptions,
  type GitContextRefreshSchedulerLike,
} from "../pi-extension/git-context-ui.js";

const OID = "a".repeat(40);
const BRANCHES: GitBranch[] = [
  { name: "develop", fullName: "refs/heads/develop", kind: "local", current: false },
  { name: "main", fullName: "refs/heads/main", kind: "local", current: false },
  { name: "origin/develop", fullName: "refs/remotes/origin/develop", kind: "remote", current: false },
  { name: "origin/main", fullName: "refs/remotes/origin/main", kind: "remote", current: false },
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepository(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "pi-git-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pi Test");
  git(root, "config", "user.email", "pi@example.test");
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "branch", "develop");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  git(root, "update-ref", "refs/remotes/origin/develop", base);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "update-ref", "refs/custom/free-form", base);
  git(root, "tag", "release-test", base);
  git(root, "checkout", "-q", "-b", "feature/test");

  for (let index = 0; index < 25; index++) {
    writeFileSync(join(root, `file-${String(index).padStart(2, "0")}.txt`), `line ${index}\n`);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "feature-01");
  for (let index = 2; index <= 12; index++) {
    writeFileSync(join(root, "file-00.txt"), `extra ${index}\n`, { flag: "a" });
    git(root, "add", "file-00.txt");
    git(root, "commit", "-q", "-m", `feature-${String(index).padStart(2, "0")}`);
  }
  mkdirSync(join(root, "nested"));
  for (let index = 0; index < 25; index++) {
    writeFileSync(join(root, `file-${String(index).padStart(2, "0")}.txt`), `unstaged ${index}\n`, { flag: "a" });
  }
  writeFileSync(join(root, "worktree-only.txt"), "not committed\n");
  return root;
}

function makeEdgeRepository(t: test.TestContext): { root: string; renamedPath: string; unusualPath: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-git-edge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pi Edge Test");
  git(root, "config", "user.email", "pi-edge@example.test");
  writeFileSync(join(root, "README.md"), "base\n");
  writeFileSync(join(root, "delete me.txt"), "remove me\n");
  writeFileSync(join(root, "old name.txt"), "rename me without changing content\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "branch", "develop");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  git(root, "update-ref", "refs/remotes/origin/develop", base);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "checkout", "-q", "-b", "feature/edge");

  const renamedPath = "renamed \t界\nfile.txt";
  const unusualPath = "space \tUnicode-界\nnew.txt";
  git(root, "mv", "old name.txt", renamedPath);
  rmSync(join(root, "delete me.txt"));
  writeFileSync(join(root, "binary file.bin"), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(join(root, unusualPath), "unusual path\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "rename delete binary and unusual paths");
  writeFileSync(join(root, "worktree only.txt"), "not committed\n");
  return { root, renamedPath, unusualPath };
}

function scriptedRunner(overrides: Partial<Record<string, string | Error | "pending">> = {}, calls?: string[][]): GitCommandRunner {
  return async (_cwd, args) => {
    calls?.push([...args]);
    const key = args[0] === "rev-parse" && args.includes("--show-toplevel")
      ? "root"
      : args[0] === "diff"
        ? args.length === 5 ? "unstaged-diff" : "committed-diff"
        : args[0]!;
    const override = overrides[key];
    if (override === "pending") return new Promise<string>(() => {});
    if (override instanceof Error) throw override;
    if (typeof override === "string") return override;
    switch (key) {
      case "root": return "/repo\n";
      case "rev-parse": return `${OID}\n`;
      case "symbolic-ref": return "feature/test\n";
      case "for-each-ref": return "refs/heads/develop\0\nrefs/heads/feature/test\0\n";
      case "merge-base": return `${OID}\n`;
      case "rev-list": return "0\n";
      case "log":
      case "committed-diff":
      case "unstaged-diff": return "";
      default: throw new Error(`Unexpected command: ${args.join(" ")}`);
    }
  };
}

async function scriptedCollection(overrides: Partial<Record<string, string | Error | "pending">> = {}, input: { explicitReference?: string } = {}): Promise<GitContextState> {
  return collectGitContext(undefined, { cwd: "/repo", ...input }, {
    runGit: scriptedRunner(overrides),
    canonicalize: async () => "/repo",
    loadReference: async () => undefined,
    now: () => 123,
    deadlineMs: 50,
  });
}

test("branch parser exposes only concrete local/remote branches and detects remote default", () => {
  const parsed = parseGitBranches([
    "refs/heads/main\0",
    "refs/heads/develop\0",
    "refs/remotes/origin/main\0",
    "refs/remotes/origin/develop\0",
    "refs/remotes/origin/HEAD\0refs/remotes/origin/main",
    "refs/tags/v1\0",
    "refs/custom/free-form\0",
    "",
  ].join("\n"), "main");
  assert.deepEqual(parsed.branches.map(({ name, kind, current }) => ({ name, kind, current })), [
    { name: "develop", kind: "local", current: false },
    { name: "main", kind: "local", current: true },
    { name: "origin/develop", kind: "remote", current: false },
    { name: "origin/main", kind: "remote", current: false },
  ]);
  assert.equal(parsed.detectedDefault, "origin/main");
  assert.ok(!parsed.branches.some((branch) => branch.name.endsWith("/HEAD")));
});

test("reference resolution honors saved selection then exact default/develop/origin fallback without persistence", () => {
  assert.deepEqual(resolveGitReference(BRANCHES, { savedReference: "main", detectedDefault: "origin/main" }), {
    branch: BRANCHES[1], source: "saved", missingExplicit: false,
  });
  assert.equal(resolveGitReference(BRANCHES, { savedReference: "missing", detectedDefault: "origin/main" }).source, "default");
  assert.equal(resolveGitReference(BRANCHES.filter((branch) => branch.name !== "origin/main"), { detectedDefault: "missing" }).source, "develop");
  assert.equal(resolveGitReference(BRANCHES.filter((branch) => branch.name !== "origin/main" && branch.name !== "develop"), {}).source, "origin-develop");
  assert.deepEqual(resolveGitReference(BRANCHES.filter((branch) => branch.name === "main"), {}), { missingExplicit: false });
  assert.deepEqual(resolveGitReference(BRANCHES, { explicitReference: OID }), { branch: undefined, source: undefined, missingExplicit: true });
});

test("NUL parsers preserve metadata, unusual paths, renames, and binary markers", () => {
  assert.deepEqual(parseGitLog(["abc1234", "message with\ttab", "An Author", "2026-08-28T10:00:00+07:00", ""].join("\0")), [{
    hash: "abc1234",
    message: "message with\ttab",
    author: "An Author",
    date: "2026-08-28T10:00:00+07:00",
  }]);
  assert.deepEqual(parseGitNumstat([
    "2\t1\tline\nwith\ttab.txt",
    "3\t4\t", "old\nname.txt", "new\tname.txt",
    "-\t-\tbinary.dat",
    "",
  ].join("\0")), [
    { path: "line\nwith\ttab.txt", displayPath: "line\nwith\ttab.txt", additions: 2, deletions: 1, binary: false },
    { path: "new\tname.txt", oldPath: "old\nname.txt", displayPath: "old\nname.txt → new\tname.txt", additions: 3, deletions: 4, binary: false },
    { path: "binary.dat", displayPath: "binary.dat", additions: null, deletions: null, binary: true },
  ]);
});

test("snapshot reuses NUL-safe numstat semantics for tracked unstaged rows and aggregates every row", async () => {
  const state = await scriptedCollection({
    "unstaged-diff": [
      "2\t1\tline\nwith\ttab.txt",
      "3\t4\t", "old\nname.txt", "new\tname.txt",
      "-\t-\tbinary.dat",
      "0\t7\tdeleted.txt",
      "",
    ].join("\0"),
  });
  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;

  assert.equal(state.snapshot.unstagedFileTotal, 4);
  assert.equal(state.snapshot.unstagedFileTruncated, 0);
  assert.equal(state.snapshot.unstagedAdditions, 5);
  assert.equal(state.snapshot.unstagedDeletions, 12);
  assert.deepEqual(state.snapshot.unstagedFiles.map((file) => `${file.oldPath ?? ""}\0${file.path}`), [
    "\0binary.dat",
    "\0deleted.txt",
    "\0line\nwith\ttab.txt",
    "old\nname.txt\0new\tname.txt",
  ]);
  assert.ok(state.snapshot.unstagedFiles.some((file) => file.binary
    && file.additions === null && file.deletions === null));
  assert.ok(state.snapshot.unstagedFiles.some((file) => file.path === "deleted.txt"
    && file.additions === 0 && file.deletions === 7));
  assert.ok(state.snapshot.unstagedFiles.some((file) => file.oldPath === "old\nname.txt"
    && file.displayPath === "old\nname.txt → new\tname.txt"));
});

test("real Git collection uses exact no-range argv and includes only tracked working-tree changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-unstaged-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pi Unstaged Test");
  git(root, "config", "user.email", "pi-unstaged@example.test");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  writeFileSync(join(root, "staged-only.txt"), "base\n");
  writeFileSync(join(root, "mixed.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  git(root, "branch", "develop");
  git(root, "checkout", "-q", "-b", "feature/unstaged");

  writeFileSync(join(root, "tracked.txt"), "one\ntwo\n", { flag: "a" });
  writeFileSync(join(root, "staged-only.txt"), "staged\n", { flag: "a" });
  git(root, "add", "staged-only.txt");
  writeFileSync(join(root, "mixed.txt"), "staged\n", { flag: "a" });
  git(root, "add", "mixed.txt");
  writeFileSync(join(root, "mixed.txt"), "unstaged\n", { flag: "a" });
  writeFileSync(join(root, "untracked.txt"), "untracked\n");

  const calls: string[][] = [];
  const runGit: GitCommandRunner = async (cwd, args) => {
    calls.push([...args]);
    return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  const state = await collectGitContext(undefined, { cwd: root, explicitReference: "develop" }, { runGit });
  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;

  assert.deepEqual(calls.at(-1), ["diff", "--numstat", "-z", "--find-renames", "--"]);
  assert.deepEqual(state.snapshot.unstagedFiles.map((file) => file.path), ["mixed.txt", "tracked.txt"]);
  assert.equal(state.snapshot.unstagedFileTotal, 2);
  assert.equal(state.snapshot.unstagedFileTruncated, 0);
  assert.equal(state.snapshot.unstagedAdditions, 3);
  assert.equal(state.snapshot.unstagedDeletions, 0);
  assert.ok(!state.snapshot.unstagedFiles.some((file) => file.path === "staged-only.txt"));
  assert.ok(!state.snapshot.unstagedFiles.some((file) => file.path === "untracked.txt"));
});

test("real Git numstat preserves rename, deletion, binary, spaces, tabs, Unicode, and newlines", async (t) => {
  const { root, renamedPath, unusualPath } = makeEdgeRepository(t);
  const state = await collectGitContext(undefined, { cwd: root });
  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;

  assert.equal(state.snapshot.reference.name, "origin/main");
  assert.equal(state.snapshot.fileTotal, 4);
  assert.equal(state.snapshot.fileTruncated, 0);
  const sortKeys = state.snapshot.files.map((file) => `${file.oldPath ?? ""}\0${file.path}`);
  assert.deepEqual(sortKeys, [...sortKeys].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
  assert.ok(state.snapshot.files.some((file) => file.oldPath === "old name.txt"
    && file.path === renamedPath
    && file.displayPath === `old name.txt → ${renamedPath}`));
  assert.ok(state.snapshot.files.some((file) => file.path === "delete me.txt" && file.additions === 0 && file.deletions === 1));
  assert.ok(state.snapshot.files.some((file) => file.path === "binary file.bin" && file.binary
    && file.additions === null && file.deletions === null));
  assert.ok(state.snapshot.files.some((file) => file.path === unusualPath));
  assert.ok(!state.snapshot.files.some((file) => file.path === "worktree only.txt"));
  assert.match(formatGitContextLines(state, root).join("\n"), /renamed  界↵file\.txt/);
});

test("collector canonicalizes a nested worktree and returns exact committed 10/20 limits", async (t) => {
  const root = makeRepository(t);
  const state = await collectGitContext(undefined, { cwd: join(root, "nested") });
  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;
  assert.equal(state.snapshot.repositoryRoot, realpathSync(root));
  assert.equal(state.snapshot.activeBranch, "feature/test");
  assert.equal(state.snapshot.reference.name, "origin/main");
  assert.equal(state.snapshot.referenceSource, "default");
  assert.equal(state.snapshot.commitTotal, 12);
  assert.equal(state.snapshot.commits.length, GIT_CONTEXT_COMMIT_LIMIT);
  assert.equal(state.snapshot.commitTruncated, 2);
  assert.equal(state.snapshot.commits[0]?.message, "feature-12");
  assert.equal(state.snapshot.commits[0]?.author, "Pi Test");
  assert.match(state.snapshot.commits[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.snapshot.fileTotal, 25);
  assert.equal(state.snapshot.files.length, GIT_CONTEXT_FILE_LIMIT);
  assert.equal(state.snapshot.fileTruncated, 5);
  assert.equal(state.snapshot.additions, 36);
  assert.equal(state.snapshot.deletions, 0);
  assert.equal(state.snapshot.unstagedFileTotal, 25);
  assert.equal(state.snapshot.unstagedFiles.length, GIT_CONTEXT_FILE_LIMIT);
  assert.equal(state.snapshot.unstagedFileTruncated, 5);
  assert.equal(state.snapshot.unstagedAdditions, 25);
  assert.equal(state.snapshot.unstagedDeletions, 0);
  assert.deepEqual(state.snapshot.unstagedFiles.map((file) => file.path),
    Array.from({ length: GIT_CONTEXT_FILE_LIMIT }, (_, index) => `file-${String(index).padStart(2, "0")}.txt`));
  assert.ok(!state.snapshot.unstagedFiles.some((file) => file.path === "worktree-only.txt"));
  assert.ok(!state.snapshot.files.some((file) => file.path === "worktree-only.txt"));
  assert.ok(!state.snapshot.branches.some((branch) => ["origin/HEAD", "release-test", "custom/free-form"].includes(branch.name)));
  assert.equal(await loadGitContextReference(root), undefined);
  assert.ok(!readdirSync(root).includes(CONFIG_DIR_NAME));

  assert.equal(await persistGitContextReference(root, "develop", state.snapshot.branches), true);
  const restored = await collectGitContext(undefined, { cwd: root });
  assert.equal(restored.status, "ready");
  if (restored.status === "ready") {
    assert.equal(restored.snapshot.reference.name, "develop");
    assert.equal(restored.snapshot.referenceSource, "saved");
  }
});

test("project-local state ignores missing/malformed values and atomically restores concurrent valid selections", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-persistence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = gitContextStatePath(root);
  assert.equal(statePath, join(root, CONFIG_DIR_NAME, "pa-git-context.json"));
  assert.equal(await loadGitContextReference(root), undefined);
  mkdirSync(join(root, CONFIG_DIR_NAME));
  writeFileSync(statePath, "{ malformed");
  assert.equal(await loadGitContextReference(root), undefined);
  writeFileSync(statePath, JSON.stringify({ version: 1, reference: 42 }));
  assert.equal(await loadGitContextReference(root), undefined);

  const writes = await Promise.all([
    persistGitContextReference(root, "main", BRANCHES, { uniqueId: () => "first" }),
    persistGitContextReference(root, "origin/main", BRANCHES, { uniqueId: () => "second" }),
  ]);
  assert.deepEqual(writes, [true, true]);
  assert.ok(["main", "origin/main"].includes((await loadGitContextReference(root)) ?? ""));
  assert.equal(await persistGitContextReference(root, OID, BRANCHES), false);
  assert.ok(["main", "origin/main"].includes((await loadGitContextReference(root)) ?? ""));
  assert.deepEqual(readdirSync(join(root, CONFIG_DIR_NAME)), ["pa-git-context.json"]);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).version, 1);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);

  const beforeFailedReplacement = readFileSync(statePath, "utf8");
  assert.equal(await persistGitContextReference(root, "develop", BRANCHES, {
    uniqueId: () => "replaced",
    rename: async () => {
      throw new Error("concurrent replacement rejected temporary file");
    },
  }), false);
  assert.equal(readFileSync(statePath, "utf8"), beforeFailedReplacement);
  assert.deepEqual(readdirSync(join(root, CONFIG_DIR_NAME)), ["pa-git-context.json"]);
});

test("state load and persistence reject symlink escapes without reading or modifying external targets", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-git-containment-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "repo");
  const outside = join(sandbox, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const outsideState = join(outside, "pa-git-context.json");
  const originalExternalState = `${JSON.stringify({ version: 1, reference: "main" }, null, 2)}\n`;
  writeFileSync(outsideState, originalExternalState);

  symlinkSync(outside, join(root, CONFIG_DIR_NAME), "dir");
  assert.equal(await loadGitContextReference(root), undefined);
  assert.equal(await persistGitContextReference(root, "develop", BRANCHES), false);
  assert.equal(readFileSync(outsideState, "utf8"), originalExternalState);
  assert.deepEqual(readdirSync(outside), ["pa-git-context.json"]);

  rmSync(join(root, CONFIG_DIR_NAME));
  mkdirSync(join(root, CONFIG_DIR_NAME));
  symlinkSync(outsideState, gitContextStatePath(root), "file");
  assert.equal(await loadGitContextReference(root), undefined);
  assert.equal(await persistGitContextReference(root, "origin/develop", BRANCHES), false);
  assert.equal(readFileSync(outsideState, "utf8"), originalExternalState);
  assert.deepEqual(readdirSync(join(root, CONFIG_DIR_NAME)), ["pa-git-context.json"]);

  const canonicalTarget = join(sandbox, "canonical-target");
  const aliasedRoot = join(sandbox, "repo-link");
  mkdirSync(canonicalTarget);
  symlinkSync(canonicalTarget, aliasedRoot, "dir");
  assert.equal(await loadGitContextReference(aliasedRoot), undefined);
  assert.equal(await persistGitContextReference(aliasedRoot, "develop", BRANCHES), false);
  assert.deepEqual(readdirSync(canonicalTarget), []);
  assert.equal(readFileSync(outsideState, "utf8"), originalExternalState);
});

test("parent replacement at the temp-create boundary cannot redirect persistence outside the validated directory", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-git-parent-swap-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "repo");
  const outside = join(sandbox, "outside");
  const displacedConfig = join(sandbox, "validated-config");
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(join(root, CONFIG_DIR_NAME));

  const priorState = `${JSON.stringify({ version: 1, reference: "main" }, null, 2)}\n`;
  writeFileSync(gitContextStatePath(root), priorState, { mode: 0o600 });
  writeFileSync(join(outside, "pa-git-context.json"), "external state must not be read or replaced\n");
  writeFileSync(join(outside, "sentinel.bin"), Buffer.from([0, 255, 1, 254]));
  const outsideBefore = readdirSync(outside).map((name) => ({
    name,
    bytes: readFileSync(join(outside, name)),
    mode: statSync(join(outside, name)).mode,
  }));

  let createBoundaryReached = false;
  const saved = await persistGitContextReference(root, "develop", BRANCHES, {
    uniqueId: () => "parent-swap",
    writeFile: async (path, data, options) => {
      createBoundaryReached = true;
      renameSync(join(root, CONFIG_DIR_NAME), displacedConfig);
      symlinkSync(outside, join(root, CONFIG_DIR_NAME), "dir");
      await writeFileAsync(path, data, options);
    },
  });

  assert.equal(createBoundaryReached, true);
  assert.equal(saved, false);
  const outsideAfter = readdirSync(outside).map((name) => ({
    name,
    bytes: readFileSync(join(outside, name)),
    mode: statSync(join(outside, name)).mode,
  }));
  assert.deepEqual(outsideAfter, outsideBefore);
  assert.equal(readFileSync(join(displacedConfig, GIT_CONTEXT_STATE_FILE_NAME), "utf8"), priorState);
  assert.deepEqual(readdirSync(displacedConfig), [GIT_CONTEXT_STATE_FILE_NAME]);
});

test("persistence fails closed before temp creation when descriptor-relative operations are unavailable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-no-dirfd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let writes = 0;
  assert.equal(await persistGitContextReference(root, "develop", BRANCHES, {
    directoryHandlePath: () => undefined,
    writeFile: async (...args) => {
      writes++;
      await writeFileAsync(...args);
    },
  }), false);
  assert.equal(writes, 0);
  assert.deepEqual(readdirSync(join(root, CONFIG_DIR_NAME)), []);
});

test("real repositories expose non-Git, unborn, detached, missing-ref, and missing-merge-base states", async (t) => {
  const nonGit = mkdtempSync(join(tmpdir(), "pi-git-non-repo-"));
  const unborn = mkdtempSync(join(tmpdir(), "pi-git-unborn-"));
  const disconnected = mkdtempSync(join(tmpdir(), "pi-git-disconnected-"));
  t.after(() => {
    rmSync(nonGit, { recursive: true, force: true });
    rmSync(unborn, { recursive: true, force: true });
    rmSync(disconnected, { recursive: true, force: true });
  });

  assert.equal((await collectGitContext(undefined, { cwd: nonGit })).status, "non-git");
  git(unborn, "init", "-q", "-b", "main");
  assert.equal((await collectGitContext(undefined, { cwd: unborn })).status, "unborn-head");

  git(disconnected, "init", "-q", "-b", "main");
  git(disconnected, "config", "user.name", "Pi State Test");
  git(disconnected, "config", "user.email", "pi-state@example.test");
  writeFileSync(join(disconnected, "base.txt"), "base\n");
  git(disconnected, "add", ".");
  git(disconnected, "commit", "-q", "-m", "base");
  git(disconnected, "branch", "develop");
  git(disconnected, "checkout", "-q", "-b", "feature/state");
  writeFileSync(join(disconnected, "feature.txt"), "feature\n");
  git(disconnected, "add", ".");
  git(disconnected, "commit", "-q", "-m", "feature");

  assert.equal((await collectGitContext(undefined, { cwd: disconnected, explicitReference: "missing" })).status, "missing-ref");
  git(disconnected, "checkout", "-q", "--detach", "HEAD");
  assert.equal((await collectGitContext(undefined, { cwd: disconnected })).status, "detached-head");
  git(disconnected, "checkout", "-q", "feature/state");
  git(disconnected, "checkout", "-q", "--orphan", "unrelated");
  git(disconnected, "rm", "-q", "-rf", ".");
  writeFileSync(join(disconnected, "unrelated.txt"), "unrelated\n");
  git(disconnected, "add", ".");
  git(disconnected, "commit", "-q", "-m", "unrelated");
  git(disconnected, "checkout", "-q", "feature/state");
  assert.equal((await collectGitContext(undefined, { cwd: disconnected, explicitReference: "unrelated" })).status, "missing-merge-base");
});

test("a missing saved ref follows fallback order without rewriting project-local state", async (t) => {
  const { root } = makeEdgeRepository(t);
  const statePath = gitContextStatePath(root);
  mkdirSync(join(root, CONFIG_DIR_NAME));
  const persisted = `${JSON.stringify({ version: 1, reference: "missing/saved" }, null, 2)}\n`;
  writeFileSync(statePath, persisted);

  const state = await collectGitContext(undefined, { cwd: root });
  assert.equal(state.status, "ready");
  if (state.status === "ready") {
    assert.equal(state.snapshot.reference.name, "origin/main");
    assert.equal(state.snapshot.referenceSource, "default");
  }
  assert.equal(readFileSync(statePath, "utf8"), persisted);
});

test("collector models every initial edge state and retains only prior error/timeout snapshots as stale", async () => {
  assert.equal((await scriptedCollection({ root: new Error("fatal: not a git repository") })).status, "non-git");
  assert.equal((await scriptedCollection({ "symbolic-ref": new Error("not symbolic") })).status, "detached-head");
  assert.equal((await scriptedCollection({ "rev-parse": new Error("unknown revision") })).status, "unborn-head");
  assert.equal((await scriptedCollection({}, { explicitReference: "missing" })).status, "missing-ref");
  assert.equal((await scriptedCollection({ "for-each-ref": "" })).status, "unavailable");
  assert.equal((await scriptedCollection({ "merge-base": new Error("no merge base") })).status, "missing-merge-base");
  assert.equal((await scriptedCollection({ "merge-base": new Error("permission denied") })).status, "git-error");
  assert.equal((await scriptedCollection({ "for-each-ref": new Error("Git exploded") })).status, "git-error");

  const timeout = await collectGitContext(undefined, { cwd: "/repo" }, {
    runGit: scriptedRunner({ root: "pending" }),
    canonicalize: async () => "/repo",
    deadlineMs: 5,
    now: () => 200,
  });
  assert.equal(GIT_CONTEXT_COLLECTION_DEADLINE_MS, 2_000);
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.stale, false);

  assert.equal((await scriptedCollection({ "unstaged-diff": new Error("unstaged diff failed") })).status, "git-error");

  const ready = await scriptedCollection({ "unstaged-diff": "1\t2\ttracked.txt\0" });
  assert.equal(ready.status, "ready");
  const staleUnstagedError = await collectGitContext(ready, { cwd: "/repo" }, {
    runGit: scriptedRunner({ "unstaged-diff": new Error("unstaged diff failed") }),
    canonicalize: async () => "/repo",
    now: () => 250,
  });
  assert.equal(staleUnstagedError.status, "stale");
  if (staleUnstagedError.status === "stale" && ready.status === "ready") {
    assert.equal(staleUnstagedError.cause, "git-error");
    assert.equal(staleUnstagedError.snapshot, ready.snapshot);
    assert.equal(staleUnstagedError.snapshot.unstagedFileTotal, 1);
    assert.equal(staleUnstagedError.snapshot.unstagedAdditions, 1);
    assert.equal(staleUnstagedError.snapshot.unstagedDeletions, 2);
  }
  const staleError = await collectGitContext(ready, { cwd: "/repo" }, {
    runGit: scriptedRunner({ root: new Error("Git unavailable") }),
    canonicalize: async () => "/repo",
    now: () => 300,
  });
  assert.equal(staleError.status, "stale");
  if (staleError.status === "stale") assert.equal(staleError.cause, "git-error");
  const staleTimeout = await collectGitContext(ready, { cwd: "/repo" }, {
    runGit: scriptedRunner({ root: "pending" }),
    canonicalize: async () => "/repo",
    deadlineMs: 5,
    now: () => 400,
  });
  assert.equal(staleTimeout.status, "stale");
  if (staleTimeout.status === "stale" && ready.status === "ready") {
    assert.equal(staleTimeout.cause, "timeout");
    assert.equal(staleTimeout.snapshot, ready.snapshot);
  }
});

test("the complete collection attempt uses one fake 2,000 ms deadline and aborts late Git", async () => {
  const previous = await scriptedCollection({ "unstaged-diff": "1\t0\ttracked.txt\0" });
  assert.equal(previous.status, "ready");
  let deadline: (() => void) | undefined;
  let delay: number | undefined;
  let timerCount = 0;
  let clearCount = 0;
  let aborted = false;
  const setTimer = ((handler: () => void, timeout?: number) => {
    timerCount++;
    deadline = handler;
    delay = timeout;
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  const clearTimer = (() => { clearCount++; }) as typeof clearTimeout;
  const calls: string[][] = [];
  const baseRunner = scriptedRunner({}, calls);
  const collection = collectGitContext(previous, { cwd: "/repo" }, {
    runGit: async (cwd, args, signal) => {
      if (args[0] === "diff" && args.length === 5) {
        calls.push([...args]);
        return new Promise<string>(() => {
          signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        });
      }
      return baseRunner(cwd, args, signal);
    },
    canonicalize: async () => "/repo",
    setTimer,
    clearTimer,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timerCount, 1);
  assert.equal(delay, GIT_CONTEXT_COLLECTION_DEADLINE_MS);
  assert.deepEqual(calls.at(-1), ["diff", "--numstat", "-z", "--find-renames", "--"]);
  deadline?.();
  const state = await collection;
  assert.equal(state.status, "stale");
  if (state.status === "stale" && previous.status === "ready") {
    assert.equal(state.cause, "timeout");
    assert.equal(state.snapshot, previous.snapshot);
  }
  assert.equal(aborted, true);
  assert.equal(clearCount, 1);
});

test("collector subprocess surface is fixed, validated, and read-only", async () => {
  const calls: string[][] = [];
  const state = await collectGitContext(undefined, { cwd: "/repo", explicitReference: "develop" }, {
    runGit: scriptedRunner({}, calls),
    canonicalize: async () => "/repo",
    now: () => 1,
  });
  assert.equal(state.status, "ready");
  assert.deepEqual(calls.map((args) => args[0]), [
    "rev-parse", "rev-parse", "symbolic-ref", "for-each-ref", "merge-base", "rev-list", "log", "diff", "diff",
  ]);
  const forbidden = new Set(["fetch", "checkout", "switch", "stage", "add", "commit", "reset"]);
  assert.ok(calls.every((args) => !args.some((arg) => forbidden.has(arg))));
  assert.deepEqual(calls[4]?.slice(0, 2), ["merge-base", "refs/heads/develop"]);
  assert.deepEqual(calls[7], ["diff", "--numstat", "-z", "--find-renames", `${OID}..HEAD`, "--"]);
  assert.deepEqual(calls[8], ["diff", "--numstat", "-z", "--find-renames", "--"]);
});

test("first-open, reference-change, and event hooks coalesce to one start per 10 seconds and dispose", () => {
  assert.equal(GIT_CONTEXT_REFRESH_INTERVAL_MS, 10_000);
  let now = 0;
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  let clears = 0;
  const fakeSetTimer = ((handler: () => void, timeout?: number) => {
    callback = handler;
    delay = timeout;
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  const fakeClearTimer = (() => { clears++; }) as typeof clearTimeout;
  const scheduler = new GitContextRefreshScheduler(10_000, () => now, fakeSetTimer, fakeClearTimer);
  const starts: Array<{ at: number; reason: string }> = [];
  const refresh = (reason: string) => { starts.push({ at: now, reason }); };

  scheduler.firstOpen(refresh);
  scheduler.event(refresh);
  scheduler.referenceChange(refresh);
  assert.deepEqual(starts, [{ at: 0, reason: "first-open" }]);
  assert.equal(delay, 10_000);
  now = 10_000;
  callback?.();
  assert.deepEqual(starts, [
    { at: 0, reason: "first-open" },
    { at: 10_000, reason: "reference-change" },
  ]);
  scheduler.event(refresh);
  scheduler.dispose();
  assert.ok(clears >= 1);
  now = 20_000;
  callback?.();
  assert.equal(starts.length, 2);
});

function uiUnstagedFiles(): GitFileRow[] {
  return Array.from({ length: 25 }, (_, index) => ({
    path: `worktree/long/path/file-${String(index).padStart(2, "0")}-界面.ts`,
    displayPath: `worktree/long/path/file-${String(index).padStart(2, "0")}-界面.ts`,
    additions: index + 1,
    deletions: index,
    binary: false,
  }));
}

function uiReadyState(reference = "main", unstagedFiles: GitFileRow[] = []): GitContextState {
  const branches = BRANCHES.map((branch) => ({ ...branch }));
  const selected = branches.find((branch) => branch.name === reference) ?? branches[1]!;
  return {
    status: "ready",
    stale: false,
    snapshot: {
      repositoryRoot: "/repo",
      activeBranch: "feature/PAP-149-wide-界面",
      reference: selected,
      referenceSource: reference === "main" ? "saved" : "explicit",
      branches,
      mergeBase: OID,
      commits: Array.from({ length: 12 }, (_, index) => ({
        hash: `c${String(index).padStart(6, "0")}`,
        message: `commit ${index} with a long message and unicode 界面`,
        author: `Author ${index}`,
        date: "2026-08-28T10:00:00+07:00",
      })),
      commitTotal: 12,
      commitTruncated: 2,
      files: Array.from({ length: 25 }, (_, index) => ({
        path: `src/long/path/file-${index}-界面.ts`,
        displayPath: `src/long/path/file-${index}-界面.ts`,
        additions: index + 1,
        deletions: index,
        binary: false,
      })),
      fileTotal: 25,
      fileTruncated: 5,
      additions: 325,
      deletions: 300,
      unstagedFiles,
      unstagedFileTotal: unstagedFiles.length,
      unstagedFileTruncated: Math.max(0, unstagedFiles.length - GIT_CONTEXT_FILE_LIMIT),
      unstagedAdditions: unstagedFiles.reduce((total, file) => total + (file.additions ?? 0), 0),
      unstagedDeletions: unstagedFiles.reduce((total, file) => total + (file.deletions ?? 0), 0),
      collectedAt: 123,
    },
  };
}

const TEST_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const REQUIRED_WIDTHS = [40, 80, 119, 120, 160] as const;

test("Git panel and SelectList selector are width-safe at 40, 80, 119, 120, and 160 columns", () => {
  const state = uiReadyState("main", uiUnstagedFiles());
  const panel = new GitContextPanelComponent(
    { requestRender() {} } as never,
    TEST_THEME as never,
    () => state,
    () => "/worktrees/PAP-230/exact Pi cwd-界",
    () => {},
    () => {},
  );
  const selector = new GitReferenceSelectorComponent(
    { requestRender() {} } as never,
    TEST_THEME as never,
    BRANCHES,
    "main",
    () => {},
  );

  for (const width of REQUIRED_WIDTHS) {
    assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width), `panel overflow at ${width}`);
    assert.ok(selector.render(width).every((line) => visibleWidth(line) <= width), `selector overflow at ${width}`);
    panel.invalidate();
    selector.invalidate();
  }

  const content = formatGitContextLines(state, "/worktrees/PAP-230/exact Pi cwd-界");
  assert.equal(content[0], "Path: /worktrees/PAP-230/exact Pi cwd-界");
  assert.match(content.join("\n"), /Active: feature\/PAP-149-wide-界面/);
  assert.match(content.join("\n"), /Reference: main \(saved\)/);
  assert.match(content.join("\n"), /Commits: 10\/12 shown • 2 truncated/);
  assert.equal(content.filter((line) => /^  c\d{6} /.test(line)).length, GIT_CONTEXT_COMMIT_LIMIT);
  const unstagedHeading = content.indexOf("Unstaged Changes:");
  assert.ok(unstagedHeading > 0);
  const committedContent = content.slice(0, unstagedHeading);
  const unstagedContent = content.slice(unstagedHeading);
  assert.match(committedContent.join("\n"), /Diff: \+325 -300/);
  assert.match(committedContent.join("\n"), /Files: 20\/25 shown • 5 truncated/);
  assert.equal(committedContent.filter((line) => /^  \+\d+ -\d+ /.test(line)).length, GIT_CONTEXT_FILE_LIMIT);
  assert.match(unstagedContent.join("\n"), /Diff: \+325 -300/);
  assert.match(unstagedContent.join("\n"), /Files: 20\/25 shown • 5 truncated/);
  assert.equal(unstagedContent.filter((line) => /^  \+\d+ -\d+ /.test(line)).length, GIT_CONTEXT_FILE_LIMIT);
  assert.match(unstagedContent.join("\n"), /worktree\/long\/path\/file-00-界面\.ts/);
  assert.match(unstagedContent.join("\n"), /worktree\/long\/path\/file-19-界面\.ts/);
  assert.doesNotMatch(unstagedContent.join("\n"), /worktree\/long\/path\/file-20-界面\.ts/);

  const layout = contextOverlayOptions();
  assert.equal(layout.anchor, "top-right");
  assert.equal(layout.width, "68%");
  assert.equal(layout.minWidth, 42);
  assert.equal(layout.maxHeight, "90%");
  assert.deepEqual(layout.margin, { right: 1 });
  for (const width of [40, 80, 119]) assert.equal(layout.visible?.(width, 40), false);
  for (const width of [120, 160]) assert.equal(layout.visible?.(width, 40), true);
});

test("ready and retained-stale panels render explicit empty unstaged aggregates after exact Path", () => {
  const cwd = "/worktrees/PAP-230/exact Pi cwd";
  const ready = uiReadyState();
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const stale: GitContextState = {
    status: "stale",
    stale: true,
    snapshot: ready.snapshot,
    cause: "git-error",
    checkedAt: 456,
  };

  for (const state of [ready, stale]) {
    const lines = formatGitContextLines(state, cwd);
    assert.equal(lines[0], `Path: ${cwd}`);
    const heading = lines.indexOf("Unstaged Changes:");
    assert.ok(heading > 0);
    assert.deepEqual(lines.slice(heading, heading + 3), [
      "Unstaged Changes:",
      "Diff: +0 -0",
      "Files: 0/0 shown",
    ]);
  }
});

test("unstaged rendering reuses binary, deletion, rename, and single-line path semantics without patch content", () => {
  const cwd = "/worktrees/PAP-230/exact Pi cwd";
  const ready = uiReadyState("main", [
    { path: "binary.dat", displayPath: "binary.dat", additions: null, deletions: null, binary: true },
    { path: "deleted.txt", displayPath: "deleted.txt", additions: 0, deletions: 7, binary: false },
    {
      path: "new\nname\u0001.txt",
      oldPath: "old\tname.txt",
      displayPath: "old\tname.txt → new\nname\u0001.txt",
      additions: 3,
      deletions: 4,
      binary: false,
    },
  ]);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const stale: GitContextState = {
    status: "stale",
    stale: true,
    snapshot: ready.snapshot,
    cause: "timeout",
    checkedAt: 789,
  };

  const readyLines = formatGitContextLines(ready, cwd);
  const staleLines = formatGitContextLines(stale, cwd);
  for (const lines of [readyLines, staleLines]) {
    assert.equal(lines[0], `Path: ${cwd}`);
    const rendered = lines.slice(lines.indexOf("Unstaged Changes:")).join("\n");
    assert.match(rendered, /^Unstaged Changes:\nDiff: \+3 -11\nFiles: 3\/3 shown/m);
    assert.match(rendered, /^  binary binary\.dat$/m);
    assert.match(rendered, /^  \+0 -7 deleted\.txt$/m);
    assert.match(rendered, /^  \+3 -4 old name\.txt → new↵name�\.txt$/m);
    assert.doesNotMatch(rendered, /@@|patch content/);
  }
  assert.deepEqual(staleLines.slice(2), readyLines.slice(2));
});

test("one registered panel retains shared geometry and bounded focused lines across 160→80→160 reopen", async () => {
  const events = new Map<string, (event: unknown, context: unknown) => unknown>();
  const commands = new Map<string, (args: string, context: unknown) => unknown>();
  const shortcuts = new Map<string, (context: unknown) => unknown>();
  const tui = { terminal: { columns: 160 }, requestRender() {} };
  type RecordedOverlay = {
    panel: GitContextPanelComponent;
    layout: OverlayOptions;
    hidden: boolean;
    focused: boolean;
    removed: boolean;
  };
  const overlays: RecordedOverlay[] = [];
  let collectionStarts = 0;

  registerGitContextUiModuleWithOptions({
    on: ((name: string, handler: (event: unknown, context: unknown) => unknown) => events.set(name, handler)) as never,
    registerCommand: (name, definition) => commands.set(name, definition.handler),
    registerShortcut: (key, definition) => shortcuts.set(key, definition.handler),
  }, {
    schedulerFactory: () => ({
      firstOpen: (refresh) => {
        if (collectionStarts === 0) void refresh("first-open");
      },
      referenceChange() {},
      event() {},
      dispose() {},
    }),
    collect: async () => {
      collectionStarts++;
      return uiReadyState();
    },
  });

  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    ui: {
      notify() {},
      custom: (factory: (tuiValue: typeof tui, theme: typeof TEST_THEME, keybindings: unknown, done: (result: void) => void) => unknown, options?: {
        overlay?: boolean;
        overlayOptions?: OverlayOptions;
        onHandle?: (handle: unknown) => void;
      }) => {
        assert.equal(options?.overlay, true);
        const panel = factory(tui, TEST_THEME, {}, () => {}) as GitContextPanelComponent;
        const record: RecordedOverlay = {
          panel,
          layout: options?.overlayOptions ?? {},
          hidden: false,
          focused: false,
          removed: false,
        };
        const handle = {
          setHidden(hidden: boolean) {
            record.hidden = hidden;
            if (hidden) record.focused = false;
          },
          focus() {
            for (const overlay of overlays) overlay.focused = false;
            record.hidden = false;
            record.focused = true;
          },
          unfocus() { record.focused = false; },
          hide() {
            record.hidden = true;
            record.focused = false;
            record.removed = true;
          },
        };
        overlays.push(record);
        options?.onHandle?.(handle);
        return new Promise<void>(() => {});
      },
    },
  };
  const assertCurrentOverlay = (width: number) => {
    const visible = overlays.filter((overlay) => !overlay.removed && !overlay.hidden);
    assert.equal(visible.length, 1);
    const current = visible[0]!;
    assert.equal(current.layout, contextOverlayOptions());
    assert.equal(current.focused, true);
    assert.ok(current.panel.render(width).every((line) => visibleWidth(line) <= width));
  };

  events.get("session_start")?.({}, context);
  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  await new Promise((resolve) => setImmediate(resolve));
  assertCurrentOverlay(160);

  shortcuts.get(GIT_CONTEXT_SHORTCUT)?.(context);
  tui.terminal.columns = 80;
  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  assertCurrentOverlay(80);

  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  tui.terminal.columns = 160;
  shortcuts.get(GIT_CONTEXT_SHORTCUT)?.(context);
  assertCurrentOverlay(160);
  assert.equal(overlays.length, 1);
  assert.equal(collectionStarts, 1);
});

test("Git panel renders all named states with exact Path first and width-safe lines", () => {
  const cwd = "/worktrees/PAP-230/exact Pi cwd-界";
  const ready = uiReadyState();
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const stale: GitContextState = {
    status: "stale",
    stale: true,
    snapshot: ready.snapshot,
    cause: "timeout",
    checkedAt: 2,
  };
  const pending: GitContextState = {
    status: "pending",
    stale: false,
    repositoryRoot: ready.snapshot.repositoryRoot,
    activeBranch: ready.snapshot.activeBranch,
    reference: ready.snapshot.reference,
    branches: ready.snapshot.branches,
    requestedAt: 1,
    recoverySnapshot: ready.snapshot,
  };
  const states: Array<{ name: string; state: GitContextState }> = [
    { name: "pending", state: pending },
    { name: "ready", state: ready },
    { name: "stale", state: stale },
    ...(["non-git", "detached-head", "unborn-head", "missing-ref", "missing-merge-base", "git-error", "timeout", "unavailable"] as const)
      .map((status) => ({ name: status, state: { status, stale: false, checkedAt: 1, detail: "detail\nline" } as GitContextState })),
  ];

  for (const { name, state } of states) {
    const lines = formatGitContextLines(state, cwd);
    assert.equal(lines[0], `Path: ${cwd}`, `${name} Path row`);
    const panel = new GitContextPanelComponent(
      { requestRender() {} } as never,
      TEST_THEME as never,
      () => state,
      () => cwd,
      () => {},
      () => {},
    );
    for (const width of REQUIRED_WIDTHS) {
      assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width), `${name} overflow at ${width}`);
      panel.invalidate();
    }
    if (state.status !== "pending" && state.status !== "ready" && state.status !== "stale") {
      assert.equal(lines[1], `State: ${state.status}`);
      assert.match(lines[2] ?? "", /detail↵line/);
      assert.ok(!lines.some((line) => /^(Active|Reference|Commits|Files|Diff):/.test(line)));
    }
  }

  assert.equal(formatGitContextLines(pending, cwd)[1], "State: loading (pending collection)");
  assert.equal(formatGitContextLines(ready, cwd)[1], "State: ready");
  const staleLines = formatGitContextLines(stale, cwd);
  assert.equal(staleLines[1], "State: stale (timeout)");
  assert.match(staleLines.join("\n"), /Reference: main/);
});

test("Path escapes every terminal control while preserving printable text in every named state", () => {
  const ready = uiReadyState();
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const stale: GitContextState = {
    status: "stale",
    stale: true,
    snapshot: ready.snapshot,
    cause: "timeout",
    checkedAt: 2,
  };
  const pending: GitContextState = {
    status: "pending",
    stale: false,
    repositoryRoot: ready.snapshot.repositoryRoot,
    activeBranch: ready.snapshot.activeBranch,
    reference: ready.snapshot.reference,
    branches: ready.snapshot.branches,
    requestedAt: 1,
    recoverySnapshot: ready.snapshot,
  };
  const states: Array<{ name: string; state: GitContextState }> = [
    { name: "pending", state: pending },
    { name: "ready", state: ready },
    { name: "stale", state: stale },
    ...(["non-git", "detached-head", "unborn-head", "missing-ref", "missing-merge-base", "git-error", "timeout", "unavailable"] as const)
      .map((status) => ({ name: status, state: { status, stale: false, checkedAt: 1 } as GitContextState })),
  ];
  const printable = Array.from({ length: 0x7f - 0x20 }, (_, index) => String.fromCharCode(0x20 + index)).join("");
  const controlCodes = [
    ...Array.from({ length: 0x20 }, (_, index) => index),
    0x7f,
    ...Array.from({ length: 0x20 }, (_, index) => 0x80 + index),
  ];
  const allControls = controlCodes.map((code) => String.fromCharCode(code)).join("");
  const allEscapes = controlCodes.map((code) => `x${code.toString(16).padStart(2, "0")}`).join("");
  const cwd = `${printable}é界\nnewline\x1b[31mCSI\x1b]52;c;payload\x07OSC\x9b31mC1-CSI\x9d52;c;payload\x9cC1-OSC-ST${allControls}end`;
  const expectedPath = `Path: ${printable}é界x0anewlinex1b[31mCSIx1b]52;c;payloadx07OSCx9b31mC1-CSIx9d52;c;payloadx9cC1-OSC-ST${allEscapes}end`;
  const rawTerminalControl = /[\u0000-\u001f\u007f-\u009f]/;

  for (const { name, state } of states) {
    const lines = formatGitContextLines(state, cwd);
    assert.equal(lines[0], expectedPath, `${name} escaped Path row`);
    assert.equal(lines.filter((line) => line.startsWith("Path: ")).length, 1, `${name} single Path row`);
    assert.doesNotMatch(lines[0] ?? "", rawTerminalControl, `${name} raw terminal control`);
    assert.equal((lines[0] ?? "").split(/\r\n|\r|\n/).length, 1, `${name} Path must stay on one line`);
  }

  assert.ok(expectedPath.startsWith(`Path: ${printable}é界`), "all printable ASCII and Unicode remain exact");
  assert.match(expectedPath, /x0anewlinex1b\[31mCSI/);
  assert.match(expectedPath, /x1b\]52;c;payloadx07OSC/);
  assert.match(expectedPath, /x9b31mC1-CSIx9d52;c;payloadx9cC1-OSC-ST/);
});

test("Alt+G and command share one overlay; selection renders pending immediately while collection stays deferred", async () => {
  const events = new Map<string, (event: unknown, context: unknown) => unknown>();
  const commands = new Map<string, (args: string, context: unknown) => unknown>();
  const shortcuts = new Map<string, (context: unknown) => unknown>();
  const refreshReasons: string[] = [];
  let deferredReferenceRefresh: ((reason: "reference-change") => void | Promise<void>) | undefined;
  let schedulerDisposals = 0;
  const scheduler: GitContextRefreshSchedulerLike = {
    firstOpen: (refresh) => { refreshReasons.push("first-open"); void refresh("first-open"); },
    referenceChange: (refresh) => {
      refreshReasons.push("reference-change");
      deferredReferenceRefresh = refresh;
    },
    event: (refresh) => { refreshReasons.push("event"); void refresh("event"); },
    dispose: () => { schedulerDisposals++; },
  };
  const collectionInputs: GitContextCollectionInput[] = [];
  const persisted: string[] = [];
  let overlayCount = 0;
  let panel: GitContextPanelComponent | undefined;
  let selector: GitReferenceSelectorComponent | undefined;
  let overlayHidden = false;
  let focusCount = 0;
  let unfocusCount = 0;
  let overlayHides = 0;
  let selectorCompletions = 0;
  const notifications: string[] = [];
  const executionPath = "/worktrees/PAP-230/nested";
  const overlayHandle = {
    setHidden: (hidden: boolean) => { overlayHidden = hidden; },
    isHidden: () => overlayHidden,
    focus: () => { focusCount++; overlayHidden = false; },
    unfocus: () => { unfocusCount++; },
    isFocused: () => !overlayHidden,
    hide: () => { overlayHides++; overlayHidden = true; },
  };
  const tui = { terminal: { columns: 160 }, requestRender() {} };

  registerGitContextUiModuleWithOptions({
    on: ((name: string, handler: (event: unknown, context: unknown) => unknown) => events.set(name, handler)) as never,
    registerCommand: (name, definition) => commands.set(name, definition.handler),
    registerShortcut: (key, definition) => shortcuts.set(key, definition.handler),
  }, {
    schedulerFactory: () => scheduler,
    collect: async (_previous, input) => {
      collectionInputs.push({ ...input });
      return uiReadyState(input.explicitReference ?? "main");
    },
    persist: async (_root, reference, branches) => {
      assert.ok(branches.some((branch) => branch.name === reference));
      persisted.push(reference);
      return true;
    },
    now: () => 1,
  });

  const context = {
    mode: "tui",
    hasUI: true,
    cwd: executionPath,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: (factory: (tuiValue: unknown, theme: unknown, keybindings: unknown, done: (result: string | null) => void) => unknown, customOptions?: {
        overlay?: boolean;
        overlayOptions?: OverlayOptions;
        onHandle?: (handle: typeof overlayHandle) => void;
      }) => new Promise<string | null>((resolve) => {
        const component = factory(tui, TEST_THEME, {}, (result) => {
          if (!customOptions?.overlay) selectorCompletions++;
          resolve(result);
        });
        if (customOptions?.overlay) {
          overlayCount++;
          panel = component as GitContextPanelComponent;
          assert.equal(customOptions.overlayOptions, contextOverlayOptions());
          customOptions.onHandle?.(overlayHandle);
        } else {
          selector = component as GitReferenceSelectorComponent;
        }
      }),
    },
  };

  events.get("session_start")?.({}, context);
  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlayCount, 1);
  assert.deepEqual(refreshReasons, ["first-open"]);
  assert.equal(collectionInputs.length, 1);
  assert.equal(collectionInputs[0]?.cwd, executionPath);

  panel?.handleInput("r");
  assert.ok(selector);
  selector?.handleInput("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selectorCompletions, 1);
  assert.ok(focusCount >= 2);
  assert.deepEqual(persisted, []);

  selector = undefined;
  panel?.handleInput("r");
  selector?.handleInput("\x1b[B");
  selector?.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persisted, ["origin/develop"]);
  assert.equal(collectionInputs.length, 1);
  assert.ok(refreshReasons.includes("reference-change"));
  const pendingLines = panel?.render(80) ?? [];
  assert.ok(pendingLines.some((line) => line.includes(`Path: ${executionPath}`)));
  assert.ok(pendingLines.some((line) => line.includes("State: loading (pending collection)")));
  assert.ok(pendingLines.some((line) => line.includes("Reference: origin/develop (selected)")));
  assert.ok(pendingLines.every((line) => visibleWidth(line) <= 80));

  await deferredReferenceRefresh?.("reference-change");
  assert.equal(collectionInputs.at(-1)?.explicitReference, "origin/develop");

  shortcuts.get(GIT_CONTEXT_SHORTCUT)?.(context);
  assert.equal(overlayHidden, true);
  assert.equal(unfocusCount, 1);
  const movedExecutionPath = "/worktrees/PAP-230/moved";
  context.cwd = movedExecutionPath;
  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  assert.equal(overlayCount, 1);
  assert.equal(overlayHidden, false);
  assert.ok(panel?.render(80).some((line) => line.includes(`Path: ${movedExecutionPath}`)));

  events.get("turn_end")?.({}, context);
  events.get("session_tree")?.({}, context);
  assert.equal(refreshReasons.filter((reason) => reason === "event").length, 2);

  panel?.handleInput("r");
  events.get("session_shutdown")?.({}, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(schedulerDisposals >= 1);
  assert.equal(overlayHides, 1);
  assert.equal(selectorCompletions, 3);
  assert.deepEqual(notifications, []);
});

test("registered selection flow retains the ready snapshot as stale after deferred timeout and Git error", async (t) => {
  for (const cause of ["timeout", "git-error"] as const) {
    await t.test(cause, async () => {
      const events = new Map<string, (event: unknown, context: unknown) => unknown>();
      const commands = new Map<string, (args: string, context: unknown) => unknown>();
      let deferredRefresh: ((reason: "reference-change") => void | Promise<void>) | undefined;
      let referenceRequests = 0;
      let collectionStarts = 0;
      let panel: GitContextPanelComponent | undefined;
      let selector: GitReferenceSelectorComponent | undefined;
      const tui = { terminal: { columns: 160 }, requestRender() {} };

      registerGitContextUiModuleWithOptions({
        on: ((name: string, handler: (event: unknown, context: unknown) => unknown) => events.set(name, handler)) as never,
        registerCommand: (name, definition) => commands.set(name, definition.handler),
      }, {
        schedulerFactory: () => ({
          firstOpen: (refresh) => { void refresh("first-open"); },
          referenceChange: (refresh) => {
            referenceRequests++;
            deferredRefresh = refresh;
          },
          event() {},
          dispose() {},
        }),
        collect: async (previous, input) => {
          collectionStarts++;
          if (collectionStarts === 1) return uiReadyState();
          assert.equal(previous?.status, "pending");
          assert.equal(input.explicitReference, "origin/develop");
          return collectGitContext(previous, input, {
            runGit: cause === "timeout"
              ? scriptedRunner({ root: "pending" })
              : scriptedRunner({ root: new Error("selected reference Git failure") }),
            canonicalize: async () => "/repo",
            deadlineMs: 5,
            now: () => 500,
          });
        },
        persist: async () => true,
        now: () => 250,
      });

      const overlayHandle = {
        setHidden() {},
        focus() {},
        unfocus() {},
        hide() {},
      };
      const context = {
        mode: "tui",
        hasUI: true,
        cwd: "/repo",
        ui: {
          notify() {},
          custom: (factory: (tuiValue: unknown, theme: unknown, keybindings: unknown, done: (result: string | null) => void) => unknown, options?: {
            overlay?: boolean;
            onHandle?: (handle: typeof overlayHandle) => void;
          }) => new Promise<string | null>((resolve) => {
            const component = factory(tui, TEST_THEME, {}, resolve);
            if (options?.overlay) {
              panel = component as GitContextPanelComponent;
              options.onHandle?.(overlayHandle);
            } else {
              selector = component as GitReferenceSelectorComponent;
            }
          }),
        },
      };

      events.get("session_start")?.({}, context);
      commands.get(GIT_CONTEXT_COMMAND)?.("", context);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(collectionStarts, 1);

      panel?.handleInput("r");
      selector?.handleInput("\x1b[B");
      selector?.handleInput("\r");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(referenceRequests, 1);
      assert.equal(collectionStarts, 1, "selection must not bypass the deferred cadence slot");
      const pendingLines = panel?.render(80) ?? [];
      assert.ok(pendingLines.some((line) => line.includes("State: loading (pending collection)")));
      assert.ok(pendingLines.some((line) => line.includes("Reference: origin/develop (selected)")));

      await deferredRefresh?.("reference-change");
      assert.equal(collectionStarts, 2);
      const staleLines = panel?.render(80) ?? [];
      assert.ok(staleLines.some((line) => line.includes(`State: stale (${cause})`)));
      assert.ok(staleLines.some((line) => line.includes("Reference: main (saved)")));
      events.get("session_shutdown")?.({}, context);
    });
  }
});

test("shutdown and reload reject late overlay creation and refresh only the replacement session", async () => {
  const events = new Map<string, (event: unknown, context: unknown) => unknown>();
  const commands = new Map<string, (args: string, context: unknown) => unknown>();
  type Handle = {
    setHidden(hidden: boolean): void;
    focus(): void;
    unfocus(options?: unknown): void;
    hide(): void;
  };
  type PendingOverlay = {
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown;
    onHandle?: (handle: Handle) => void;
  };
  const pending: PendingOverlay[] = [];
  let collectionStarts = 0;
  let schedulerDisposals = 0;
  let staleHandleHides = 0;
  let replacementHandleFocuses = 0;

  registerGitContextUiModuleWithOptions({
    on: ((name: string, handler: (event: unknown, context: unknown) => unknown) => events.set(name, handler)) as never,
    registerCommand: (name, definition) => commands.set(name, definition.handler),
  }, {
    schedulerFactory: () => ({
      firstOpen: (refresh) => { void refresh("first-open"); },
      referenceChange: (refresh) => { void refresh("reference-change"); },
      event: (refresh) => { void refresh("event"); },
      dispose: () => { schedulerDisposals++; },
    }),
    collect: async () => {
      collectionStarts++;
      return uiReadyState();
    },
  });

  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    ui: {
      notify() {},
      custom: (factory: PendingOverlay["factory"], customOptions?: { overlay?: boolean; onHandle?: (handle: Handle) => void }) => {
        assert.equal(customOptions?.overlay, true);
        pending.push({ factory, onHandle: customOptions.onHandle });
        return new Promise<void>(() => {});
      },
    },
  };
  const tui = { terminal: { columns: 160 }, requestRender() {} };
  const staleHandle: Handle = {
    setHidden() {},
    focus() {},
    unfocus() {},
    hide: () => { staleHandleHides++; },
  };
  const replacementHandle: Handle = {
    setHidden() {},
    focus: () => { replacementHandleFocuses++; },
    unfocus() {},
    hide() {},
  };

  events.get("session_start")?.({}, context);
  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  const staleOverlay = pending.shift();
  assert.ok(staleOverlay);
  events.get("session_shutdown")?.({}, context);
  staleOverlay.factory(tui, TEST_THEME, {}, () => {});
  staleOverlay.onHandle?.(staleHandle);
  assert.equal(staleHandleHides, 1);
  assert.equal(collectionStarts, 0);

  events.get("session_start")?.({ reason: "reload" }, context);
  commands.get(GIT_CONTEXT_COMMAND)?.("", context);
  const replacementOverlay = pending.shift();
  assert.ok(replacementOverlay);
  replacementOverlay.factory(tui, TEST_THEME, {}, () => {});
  replacementOverlay.onHandle?.(replacementHandle);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(collectionStarts, 1);
  assert.equal(replacementHandleFocuses, 1);
  events.get("session_shutdown")?.({}, context);
  assert.equal(schedulerDisposals, 2);
});

test("Git registrations remain isolated from Alt+I and /pa-context", () => {
  const commands = new Map<string, (args: string, context: unknown) => unknown>();
  const shortcuts = new Map<string, (context: unknown) => unknown>();
  const runtime = {
    registerCommand: (name: string, definition: { handler: (args: string, context: unknown) => unknown }) => commands.set(name, definition.handler),
    registerShortcut: (key: string, definition: { handler: (context: unknown) => unknown }) => shortcuts.set(key, definition.handler),
  };
  registerContextUiModuleWithOptions(runtime as never);
  registerGitContextUiModuleWithOptions(runtime as never);
  assert.deepEqual([...commands.keys()], ["pa-context", GIT_CONTEXT_COMMAND]);
  assert.deepEqual([...shortcuts.keys()], ["alt+i", GIT_CONTEXT_SHORTCUT]);

  const notifications: string[] = [];
  const context = { mode: "rpc", hasUI: true, cwd: "/repo", ui: { notify: (message: string) => notifications.push(message) } };
  shortcuts.get("alt+i")?.(context);
  shortcuts.get(GIT_CONTEXT_SHORTCUT)?.(context);
  assert.deepEqual(notifications, [
    "PA context sidebar requires TUI mode.",
    "PA Git context requires TUI mode.",
  ]);
});

test("Git context toggles warn safely and create no custom component outside TUI mode", () => {
  let command: ((args: string, context: unknown) => unknown) | undefined;
  let shortcut: ((context: unknown) => unknown) | undefined;
  let customCalls = 0;
  const notifications: string[] = [];
  registerGitContextUiModuleWithOptions({
    registerCommand: (_name, definition) => { command = definition.handler; },
    registerShortcut: (_key, definition) => { shortcut = definition.handler; },
  });
  const ui = {
    notify: (message: string) => notifications.push(message),
    custom: () => { customCalls++; throw new Error("must not open"); },
  };

  command?.("", { mode: "rpc", hasUI: true, cwd: "/repo", ui });
  shortcut?.({ mode: "json", hasUI: false, cwd: "/repo", ui });
  command?.("", { mode: "print", hasUI: false, cwd: "/repo", ui });
  assert.equal(customCalls, 0);
  assert.deepEqual(notifications, ["PA Git context requires TUI mode."]);
});
