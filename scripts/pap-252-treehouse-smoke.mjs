// Loaded through the BUILT ppa wrapper with NODE_OPTIONS=--import=... .
// It exits before the CLI handles arguments; no production smoke command is added.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const share = resolve(dirname(process.argv[1]), "../../..");
assert.match(process.env.PA_TREEHOUSE_BINARY ?? "", /^\/nix\/store\/.*ppa-treehouse-3\.1\.3\/bin\/treehouse$/);
const { TreehouseClient, SUPPORTED_TREEHOUSE_VERSION } = await import(pathToFileURL(join(share, "packages/pi-pa/dist/treehouse.js")));
const { deployWithPi } = await import(pathToFileURL(join(share, "packages/pi-pa/dist/deploy.js")));
const { closeDb } = await import(pathToFileURL(join(share, "packages/pa-core/dist/index.js")));
assert.equal(SUPPORTED_TREEHOUSE_VERSION, "3.1.3");
const root = process.env.HOME;
assert.ok(root && root.includes("pap252-"));
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = join(root, "repo");
for (const dir of [repo, "config", "teams", "tickets"].map((p) => p === repo ? p : join(root, p))) mkdirSync(dir);
git(["init", "-b", "develop"], repo);
git(["config", "user.name", "Fixture"], repo);
git(["config", "user.email", "fixture@example.invalid"], repo);
writeFileSync(join(repo, "README.md"), "isolated Treehouse 3.1.3 fixture\n");
git(["add", "."], repo); git(["commit", "-m", "fixture"], repo);
const base = git(["rev-parse", "HEAD"], repo);
process.env.PA_PLATFORM_CONFIG = join(root, "config");
process.env.PA_PLATFORM_TEAMS = join(root, "teams");
process.env.PA_AI_USAGE_HOME = root;
process.env.PA_REGISTRY_DB = join(root, "registry.db");
process.env.TREEHOUSE_ROOT = join(root, "pools");
writeFileSync(join(root, "config/config.yaml"), `config_dir: ${root}\nrepos:\n  fixture:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n    feature_branch_pattern: feature/<ticket>-<topic>\n`);
writeFileSync(join(root, "teams/builder.yaml"), "name: builder\ndescription: Fixture\nobjective: Build\nagents: []\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
writeFileSync(join(root, "tickets/PAP-252.json"), JSON.stringify({ id: "PAP-252", project: "fixture", title: "isolated fixture", linkedBranches: [{ repo: "fixture", branch: "feature/PAP-252-fixture", state: "planned", linkedAt: new Date().toISOString(), linkedBy: "fixture" }] }));
process.chdir(repo);
const snapshot = () => [git(["branch", "--show-current"], repo), git(["rev-parse", "HEAD"], repo), git(["status", "--porcelain=v2", "--untracked-files=all"], repo)];
const before = snapshot();
const client = new TreehouseClient();
assert.deepEqual(client.status(repo), [], "real empty pool");
let spawnCount = 0;
let plan;
const adapter = {
  name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "fixture-session", preflight: async () => {},
  installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "fixture" }), extractActivity: () => [],
  spawn(opts) { spawnCount++; plan = opts.executionPlan; return { sessionId: opts.sessionId ?? "fixture-session", exitCode: 0, metadata: { sessionId: opts.sessionId ?? "fixture-session" } }; },
  resume() { throw new Error("unexpected resume"); },
};
try {
  const deployment = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-252", repo: "fixture", timeout: 60 }, adapter);
  assert.equal(deployment.status, "success", deployment.reason);
  assert.equal(spawnCount, 1);
  assert.equal(plan.repoRoot, repo);
  assert.equal(plan.treehouse.baseSha, base);
  assert.equal(plan.treehouse.headSha, base);
  assert.equal(plan.environment.PA_REPO, plan.worktreeRoot);
  assert.equal(plan.environment.PA_WORKTREE_ROOT, plan.worktreeRoot);
  assert.equal(git(["branch", "--show-current"], plan.worktreeRoot), "feature/PAP-252-fixture");
  const sole = client.status(repo);
  assert.equal(sole.length, 1); assert.equal(sole[0].leased, true);
  assert.equal(client.acquireOrReuse(repo, "fixture", "PAP-252").leaseId, sole[0].leaseId, "real reuse without get");
  const other = client.getLease(repo, "pa:fixture:PAP-253");
  assert.notEqual(other.leaseId, sole[0].leaseId);
  assert.equal(git(["symbolic-ref", "-q", "--short", "HEAD"], plan.worktreeRoot), "feature/PAP-252-fixture");
  // Seed a free slot as an isolated state fixture, never by returning a lease.
  const poolRoot = join(root, "pools/.treehouse");
  const poolName = readdirSync(poolRoot, { withFileTypes: true }).find((entry) => entry.isDirectory()).name;
  const pool = join(poolRoot, poolName);
  const freePath = join(pool, "99", "repo");
  mkdirSync(dirname(freePath), { recursive: true });
  git(["worktree", "add", "--detach", freePath, "develop"], repo);
  const statePath = join(pool, "treehouse-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const retained = state.worktrees.filter((entry) => entry.leased);
  state.worktrees.push({ name: "99", path: freePath, created_at: new Date().toISOString() });
  writeFileSync(statePath, JSON.stringify(state));
  assert.equal(client.status(repo).filter((row) => !row.leased).length, 1, "real mixed pool includes free detached slot");
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).worktrees.filter((entry) => entry.leased), retained);
  // A separate state fixture exercises the free-only pool without releasing any lease.
  const freeRoot = join(root, "free-only");
  const freePool = join(freeRoot, ".treehouse", poolName);
  mkdirSync(freePool, { recursive: true });
  writeFileSync(join(freePool, "treehouse-state.json"), JSON.stringify({ version: state.version, worktrees: [state.worktrees.at(-1)] }));
  process.env.TREEHOUSE_ROOT = freeRoot;
  assert.deepEqual(client.status(repo).map((row) => row.leased), [false], "real free-only state fixture");
  process.env.TREEHOUSE_ROOT = join(root, "pools");
  const stateBeforeRejection = readFileSync(statePath);
  const refsBeforeRejection = git(["show-ref"], repo);
  const incompatible = join(root, "unsupported-treehouse");
  const bash = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  writeFileSync(incompatible, `#!${bash}\nif [[ "$*" == --version ]]; then printf 'v3.1.4\\n'; else touch '${root}/forbidden-command'; exit 78; fi\n`);
  chmodSync(incompatible, 0o755);
  assert.throws(() => new TreehouseClient({ binary: incompatible }).acquireOrReuse(repo, "fixture", "PAP-254"), /expected Treehouse v3.1.3.*actual v3.1.4/);
  assert.equal(existsSync(join(root, "forbidden-command")), false);
  assert.deepEqual(readFileSync(statePath), stateBeforeRejection, "incompatibility preserves lease state bytes");
  assert.equal(git(["show-ref"], repo), refsBeforeRejection, "incompatibility preserves branch refs");
  assert.deepEqual(snapshot(), before, "canonical checkout unchanged");
  assert.equal(existsSync(join(root, "ambient-invoked")), false, "hostile PATH binary was never invoked");
  console.log(JSON.stringify({ result: "pass", version: SUPPORTED_TREEHOUSE_VERSION, binary: process.env.PA_TREEHOUSE_BINARY, empty: true, free: true, allocation: true, reuse: true, mixed: true, unsupportedPreservesState: true, orchestratorAdmission: true, adapterSpawns: spawnCount, providerLaunch: false }));
} finally {
  closeDb();
}
process.exit(0);
