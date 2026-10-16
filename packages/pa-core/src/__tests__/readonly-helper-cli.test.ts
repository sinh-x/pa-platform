import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, inspectRepositoryMutationLease, ReadOnlyHelperFailure, repositoryMutationLeasePath, resolveRepoExecutionPath, runCoreCommand, TicketStore,
  type ReadOnlyHelperCapability, type ReadOnlyHelperRole } from "../index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const roles: ReadOnlyHelperRole[] = ["orchestrator", "parented-implement", "standalone-implement", "worker-consistency-only", "review-auto"];
async function isolated(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PA_|PI_|GIT_)/.test(key)));
  for (const key of Object.keys(inherited)) delete process.env[key];
  const cwd = process.cwd(), root = realpathSync(mkdtempSync(join(tmpdir(), "pap249-cli-")));
  Object.assign(process.env, { PA_AI_USAGE_HOME: root, PA_PLATFORM_CONFIG: join(root, "config"), PA_REGISTRY_DB: join(root, "registry.db"),
    PA_PLATFORM_DATA: join(root, "data"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  closeDb();
  try { await run(fixture(root)); } finally {
    process.chdir(cwd); closeDb();
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
    Object.assign(process.env, inherited); rmSync(root, { recursive: true, force: true });
  }
}
function fixture(root: string) {
  const canonical = join(root, "canonical"), candidate = join(root, "candidate");
  mkdirSync(canonical); git(canonical, "init", "-q", "-b", "develop");
  git(canonical, "config", "user.name", "Fixture"); git(canonical, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(canonical, "identity"), "canonical\n"); git(canonical, "add", "."); git(canonical, "commit", "-qm", "fixture");
  git(canonical, "worktree", "add", "-b", "feature/ALT-7-helper", candidate);
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "repos.yaml"), `repos:\n  fixture:\n    path: ${canonical}\n    prefix: ALT\n  unrelated:\n    path: ${root}/unrelated\n    prefix: OTHER\n`);
  const store = new TicketStore();
  for (const project of ["fixture", "unrelated"]) store.create({ project, title: `${project} board sentinel`, summary: "fixture",
    status: "implementing", priority: "medium", type: "task", assignee: "fixture", estimate: "S", tags: [] });
  // Prepare existing registry and canonical inspection mutex outside measured helper access.
  getDb().pragma("journal_mode = DELETE");
  inspectRepositoryMutationLease(canonical);
  const physical = resolveRepoExecutionPath(undefined, candidate, { allowLinkedWorktreeCwd: true });
  process.chdir(candidate);
  return { root, canonical, candidate, physical };
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else result[path] = readFileSync(path).toString("base64");
  } }; walk(root); return result;
}
async function command(argv: string[], capability?: ReadOnlyHelperCapability, binaryName = "ppa") {
  const stdout: string[] = [], stderr: string[] = [];
  const code = await runCoreCommand(argv, { binaryName, hooks: capability ? { readOnlyHelperContext: capability } : {},
    io: { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) } });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

test("helper dispatch targets admitted branches and canonical projects for every role; no checkout/evidence writes", async (t) => {
  for (const role of roles) await t.test(role, () => isolated(async (f) => {
    let authentications = 0, rereads = 0;
    const capability: ReadOnlyHelperCapability = { authenticate: (cwd) => {
      assert.equal(cwd, f.candidate); authentications++;
      return { context: { ...f.physical, access: "read-only", role }, reread: () => { rereads++; } };
    } };
    const before = snapshot(f.root);
    const branch = await command(["branch", "validate"], capability);
    assert.equal(branch.code, 0); assert.equal(branch.stdout, ""); assert.equal(branch.stderr, "");
    const board = await command(["board"], capability);
    assert.equal(board.code, 0); assert.match(board.stdout, /fixture board sentinel/); assert.doesNotMatch(board.stdout, /unrelated board sentinel/);
    const inspection = await command(["repository", "inspect"], capability);
    assert.equal(inspection.code, 0); assert.match(inspection.stdout, new RegExp(`role=${role}`));
    assert.ok(inspection.stdout.includes(`repo_root=${f.canonical} worktree_root=${f.candidate}`));
    assert.match(inspection.stdout, /state=absent/); assert.match(inspection.stdout, /Owner: unavailable/);
    assert.match(inspection.stdout, role === "standalone-implement" ? /slot=implement/ : /slot=orchestrator/);
    assert.equal(authentications, 3); assert.equal(rereads, 3);
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(git(f.canonical, "branch", "--show-current"), "develop");
    assert.equal(git(f.candidate, "branch", "--show-current"), "feature/ALT-7-helper");
  }));
});

test("inferred inspection does not substitute canonical ownership for missing selected-worktree ownership", () => isolated(async (f) => {
  writeFileSync(repositoryMutationLeasePath(f.canonical), "{malformed canonical evidence\n");
  const capability: ReadOnlyHelperCapability = { authenticate: () => ({ context: { ...f.physical, access: "read-only", role: "review-auto" }, reread() {} }) };
  const before = snapshot(f.root);
  const inferred = await command(["repository", "inspect"], capability);
  assert.equal(inferred.code, 0); assert.match(inferred.stdout, /state=absent/); assert.doesNotMatch(inferred.stdout, /state=malformed/);
  const explicit = await command(["repository", "inspect", "--repo", "fixture"], capability);
  assert.equal(explicit.code, 0); assert.match(explicit.stdout, /state=malformed/); assert.ok(explicit.stdout.includes(`root=${f.canonical}`));
  assert.deepEqual(snapshot(f.root), before);
}));

test("reread rejection happens before branch, board or inspection output and does not mutate feature state", () => isolated(async (f) => {
  for (const classification of ["helper-incompatible", "authority-rejected", "command-unavailable"] as const) {
    for (const argv of [["branch", "validate"], ["board"], ["repository", "inspect"]]) {
      const before = snapshot(f.root); let rereads = 0;
      const result = await command(argv, { authenticate: () => ({ context: { ...f.physical, access: "read-only" }, reread() {
        rereads++; throw new ReadOnlyHelperFailure(classification, "unknown", "synthetic immediate reread", "fixture evidence changed");
      } }) });
      assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.equal(rereads, 1);
      assert.match(result.stderr, new RegExp(classification)); assert.match(result.stderr, /implementation unknown/);
      assert.ok(result.stderr.length <= 2000);
      for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.ok(result.stderr.includes(`${label}:`));
      assert.deepEqual(snapshot(f.root), before);
    }
  }
}));

test("explicit neutral board selection and canonical inspection do not invoke deployment authentication", () => isolated(async (f) => {
  const forbidden: ReadOnlyHelperCapability = { authenticate() { assert.fail("explicit neutral selection has no checkout capability"); } };
  const before = snapshot(f.root);
  const all = await command(["board", "--all"], forbidden);
  assert.equal(all.code, 0); assert.match(all.stdout, /fixture board sentinel/); assert.match(all.stdout, /unrelated board sentinel/);
  const explicit = await command(["board", "--project", "OTHER"], forbidden);
  assert.equal(explicit.code, 0); assert.match(explicit.stdout, /unrelated board sentinel/); assert.doesNotMatch(explicit.stdout, /fixture board sentinel/);
  assert.equal((await command(["repository", "inspect", "--repo", "fixture"], forbidden)).code, 0);
  assert.deepEqual(snapshot(f.root), before);
}));

test("capability never widens branch create or quarantine; OPA/CPA and binary spelling alone retain default rejection", () => isolated(async (f) => {
  const forbidden: ReadOnlyHelperCapability = { authenticate() { assert.fail("mutation commands cannot consume helper capability"); } };
  const before = snapshot(f.root);
  for (const argv of [["branch", "create", "ALT-7", "--topic", "forbidden"], ["repository", "quarantine", "--expected-evidence", `v1-${"a".repeat(64)}`]]) {
    const result = await command(argv, forbidden); assert.equal(result.code, 1); assert.match(result.stderr, /linked Git working tree/i);
  }
  for (const binary of ["opa", "cpa", "ppa"]) {
    for (const argv of [["branch", "validate"], ["board"], ["repository", "inspect"]]) {
      assert.equal((await command(argv, undefined, binary)).code, 1);
    }
  }
  assert.deepEqual(snapshot(f.root), before);
}));

test("canonical naming warnings remain advisory and bypass the adapter capability", () => isolated(async (f) => {
  const forbidden: ReadOnlyHelperCapability = { authenticate() { assert.fail("canonical CWD requires no deployment evidence"); } };
  process.chdir(f.canonical);
  const base = await command(["branch", "validate"], forbidden); assert.equal(base.code, 0); assert.match(base.stdout, /is a base branch/);
  git(f.canonical, "switch", "-c", "arbitrary-name");
  const warning = await command(["branch", "validate"], forbidden); assert.equal(warning.code, 0); assert.match(warning.stdout, /does not match/);
}));
