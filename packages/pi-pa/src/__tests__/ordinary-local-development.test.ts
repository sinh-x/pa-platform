import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDeploymentEvents, repositoryMutationLeasePath, repositoryTicketSlotPath, type RuntimeAdapter } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";
import { PiNativeExecutionAdapter } from "../execution-native.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { TreehouseClient } from "../treehouse.js";
import { seedOrdinaryTaskBaseline } from "./ordinary-task-fixture.js";

/** Actual source-built deploy/native adapter, real Git and native owner storage.
 * Provider spawn and Treehouse status are simulated; no installed-runtime,
 * real-service, independent-review, or full AC1–AC8 acceptance is claimed. */
async function fixture(variant: "matching" | "stale" | "missing" | "source-drift" | "dirty") {
  const root = mkdtempSync(join(tmpdir(), "pap268-launch-")); const env = process.env, cwd = process.cwd();
  process.env = { ...env }; for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
  const repo = join(root, "repo"), checkout = join(root, "checkout"), branch = "feature/PAP-268-disposable";
  try {
    mkdirSync(repo); mkdirSync(join(root, "config")); mkdirSync(join(root, "teams")); mkdirSync(join(root, "tickets"));
    Object.assign(process.env, { PA_AI_USAGE_HOME: root, PA_PLATFORM_CONFIG: join(root, "config"), PA_PLATFORM_HOME: root,
      PA_PLATFORM_TEAMS: join(root, "teams"), PA_REGISTRY_DB: join(root, "registry.db"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    const git = (args: string[], at = repo) => execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "-q", "-b", "develop"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]); git(["config", "core.hooksPath", "/dev/null"]);
    writeFileSync(join(repo, "README.md"), "A\n"); git(["add", "README.md"]); git(["commit", "-qm", "base A"]);
    const base = git(["rev-parse", "HEAD"]); git(["worktree", "add", "--detach", checkout, base]);
    writeFileSync(join(root, "config/config.yaml"), `repos:\n  fixture:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n`);
    writeFileSync(join(root, "teams/builder.yaml"), "name: builder\ndescription: Fixture\nobjective: Implement\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
    const ticketPath = join(root, "tickets/PAP-268.json");
    writeFileSync(ticketPath, JSON.stringify({ id: "PAP-268", project: "fixture", title: "Disposable", status: "implementing", linkedBranches: [{ repo: "fixture", branch, state: "planned" }] }));
    const source = seedOrdinaryTaskBaseline({ ai: root, repo, repoKey: "fixture", ticket: "PAP-268", branch, base });
    if (variant === "stale") { writeFileSync(join(repo, "README.md"), "B\n"); git(["commit", "-am", "base B"]); }
    if (variant === "missing") { const ticket = JSON.parse(readFileSync(ticketPath, "utf8")); ticket.doc_refs = []; writeFileSync(ticketPath, JSON.stringify(ticket)); }
    if (variant === "dirty") writeFileSync(join(checkout, "unknown.txt"), "preserve\n");
    const canonical = { head: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain=v2", "--untracked-files=all"]) };
    const ticketBefore = readFileSync(ticketPath); let spawns = 0, treehouseCalls = 0, forbidden = 0, branchEffects = 0;
    const treehouse = new TreehouseClient({ run(args) {
      treehouseCalls++;
      if (args[0] === "--version") return { status: 0, stdout: Buffer.from("v3.1.3\n"), stderr: Buffer.alloc(0) };
      if (args[0] === "status") {
        if (variant === "source-drift") writeFileSync(source, readFileSync(source, "utf8") + "Changed during selection\n");
        return { status: 0, stdout: Buffer.from(JSON.stringify([{ path: checkout, leased: true, lease_id: "disposable-lease", lease_holder: "pa:fixture:PAP-268" }])), stderr: Buffer.alloc(0) };
      }
      forbidden++; throw new Error("no allocation/return allowed");
    } });
    const authority = new PiPreparedNativeAuthority({ root: join(root, "authority"), aiUsageRoot: root });
    const adapter: RuntimeAdapter & { preflight(): Promise<void> } = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "disposable-session",
      async preflight() {}, installHooks() {}, describeTools: () => ({ runtime: "pi", markdown: "simulated provider; real native adapter" }), extractActivity: () => [],
      async resume() { forbidden++; throw new Error("no authority migration"); },
      async spawn(opts) {
        spawns++; assert.equal(git(["rev-parse", "HEAD"], checkout), base); assert.equal(git(["branch", "--show-current"], checkout), branch);
        const previous = process.env; process.env = { ...previous, ...opts.env }; process.chdir(checkout);
        try {
          const directory = join(root, "deployments", opts.deployId); recordPiProcessIdentity(opts.deployId, directory, process.pid); opts.onPid?.(process.pid);
          const session = new PiNativeExecutionAdapter({ authority, helperDependencies: { treehouse } }).resolve({ cwd: checkout })!;
          assert.ok(session); assert.equal(session.contract.initialHeadSha, base);
          const plan = { phaseId: "A", scope: "Characterization only", paths: ["README.md"], requirements: ["AC3"], prerequisites: [], checks: ["diff-check"], size: "S", complexity: "bounded", rationale: "No source effects in this baseline slice." };
          session.service.apply(session.actor, { action: "plan", plan });
          // Explicit debt characterization, NOT the AC1/AC4 positive acceptance:
          assert.throws(() => session.service.apply(session.actor, { action: "plan", plan: { ...plan, phaseId: "B" } }), "phase continuation remains unsupported");
          assert.throws(() => session.service.apply(session.actor, { action: "plan", plan: { ...plan, checks: ["npm run test"] } }), "generic project contracts remain unsupported");
          assert.equal(session.service.status(session.actor).custody.state, "idle");
          assert.equal(existsSync(join(directory, "prepared-consumption.json")), false);
          assert.equal(getDeploymentEvents(opts.deployId).filter((event) => event.event === "started").length, 1);
        } finally { process.chdir(repo); process.env = previous; }
        return { sessionId: opts.sessionId!, exitCode: 0, metadata: { sessionId: opts.sessionId! } };
      } };
    process.chdir(repo);
    const result = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-268", repo: "fixture", timeout: 1800,
      provider: "openai-codex", model: "gpt-6.1-sol" }, adapter, undefined, { treehouse, preparedAuthority: authority, observeOperation: (operation) => { if (operation === "branch") branchEffects++; } });
    assert.equal(forbidden, 0);
    assert.deepEqual({ head: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain=v2", "--untracked-files=all"]) }, canonical);
    if (variant === "matching") {
      assert.equal(result.status, "success", result.reason); assert.equal(spawns, 1); assert.equal(branchEffects, 1);
      assert.equal(JSON.parse(readFileSync(ticketPath, "utf8")).linkedBranches[0].baseSha, base);
      assert.equal(existsSync(repositoryMutationLeasePath(checkout)), false);
    } else {
      assert.equal(result.status, "failed"); assert.equal(spawns, 0); assert.deepEqual(readFileSync(ticketPath), ticketBefore);
      assert.equal(git(["branch", "--list", branch]), "");
      if (variant === "stale" || variant === "missing") { assert.equal(treehouseCalls, 0); assert.equal(branchEffects, 0); }
      assert.match(result.reason ?? "", /ORDINARY_BASELINE_/);
    }
    assert.equal(existsSync(repositoryTicketSlotPath(repo, "PAP-268")), variant === "source-drift" || variant === "dirty",
      "post-acquisition denials retain existing custody for owning reconciliation; no forced release");
    if (existsSync(join(root, "authority/native"))) assert.deepEqual(readdirSync(join(root, "authority/native")), []);
  } finally { process.chdir(cwd); closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); }
}

for (const variant of ["matching", "stale", "missing", "source-drift", "dirty"] as const) {
  test(`PAP-268 actual ordinary launch: ${variant} intended baseline (simulated provider/Treehouse)`, () => fixture(variant));
}
