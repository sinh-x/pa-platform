import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDeploymentEvents, repositoryMutationLeasePath, repositoryTicketSlotPath, workflowDigest, TicketStore, type RuntimeAdapter } from "@pa-platform/pa-core";
import { deployWithPi } from "../deploy.js";
import { PiNativeExecutionAdapter } from "../execution-native.js";
import { PiPreparedNativeAuthority } from "../prepared-native.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { TreehouseClient } from "../treehouse.js";
import { seedOrdinaryTaskBaseline } from "./ordinary-task-fixture.js";
import { createPiExecutionModule } from "../pi-extension/prepared-workflow.js";
import type { PiRuntime, PiToolDefinition } from "../pi-extension/index.js";

/** Actual source-built deploy/native adapter, real Git and native owner storage.
 * Provider spawn and Treehouse status are simulated; no installed-runtime,
 * real-service, independent-review, or full AC1–AC8 acceptance is claimed. */
async function fixture(variant: "matching" | "stale" | "missing" | "source-drift" | "dirty" | "project-commands" | "project-no-progress" | "project-blocked-reporting" | "project-output-limit" | "publication-interruption") {
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
    writeFileSync(join(repo, "README.md"), "A\n");
    let commandPin = "";
    if (variant.startsWith("project-")) {
      mkdirSync(join(repo, "scripts"));
      const testScript = variant === "project-output-limit" ? "console.log('partial-output-sentinel'+'x'.repeat(4096));\n" : `const fs = require('node:fs');\nconsole.log('project-test', process.env.TEST_PRIVATE_TOKEN || 'no-ambient-secret');\nconsole.error('attempt clock',Date.now());\ntry { fs.writeFileSync('host-effect.txt','forbidden'); throw new Error('writable project'); } catch (e) { if (e.message === 'writable project') throw e; }\ntry { fs.readFileSync('unlisted.txt'); throw new Error('unlisted project input visible'); } catch(e) { if(e.message === 'unlisted project input visible') throw e; }\ntry { fs.readFileSync(${JSON.stringify(join(root, "host-secret"))}); throw new Error('host visible'); } catch(e) { if(e.message === 'host visible') throw e; }\nprocess.exit(fs.readFileSync('README.md','utf8').includes('repaired') ? 0 : 2);\n`;
      const buildScript = "const fs = require('node:fs'); const source = fs.readFileSync('README.md','utf8'); fs.writeFileSync('/tmp/build.txt',source.toUpperCase()); console.log('project-build',fs.readFileSync('/tmp/build.txt','utf8'));\n";
      writeFileSync(join(repo, "scripts/test.cjs"), testScript); writeFileSync(join(repo, "scripts/build.cjs"), buildScript);
      writeFileSync(join(root, "host-secret"), "HOST-SECRET-SENTINEL");
      writeFileSync(join(repo, "unlisted.txt"), "unlisted fixture input must remain hidden from checks\n");
      const manifest = JSON.stringify({ schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: [
        { id: "project-test", executable: realpathSync(process.execPath), argv: ["scripts/test.cjs"], environment: {}, readPaths: ["README.md"], prerequisites: [{ path: "scripts/test.cjs", sha256: variant === "project-blocked-reporting" ? "f".repeat(64) : workflowDigest(testScript) }], timeoutSeconds: 20, maximumOutputBytes: variant === "project-output-limit" ? 128 : 1048576 },
        { id: "project-build", executable: realpathSync(process.execPath), argv: ["scripts/build.cjs"], environment: {}, readPaths: ["README.md"], prerequisites: [{ path: "scripts/build.cjs", sha256: workflowDigest(buildScript) }], timeoutSeconds: 20, maximumOutputBytes: 1048576 },
      ] });
      writeFileSync(join(repo, "checks.json"), manifest); commandPin = `    projectCommands:\n      manifest: checks.json\n      sha256: ${workflowDigest(manifest)}\n`;
      git(["add", "checks.json", "scripts/test.cjs", "scripts/build.cjs", "unlisted.txt"]);
    }
    git(["add", "README.md"]); git(["commit", "-qm", "base A"]);
    const base = git(["rev-parse", "HEAD"]); git(["worktree", "add", "--detach", checkout, base]);
    writeFileSync(join(root, "config/config.yaml"), `repos:\n  fixture:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n${commandPin}`);
    writeFileSync(join(root, "teams/builder.yaml"), "name: builder\ndescription: Fixture\nobjective: Implement\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    require_ticket: true\n");
    const ticketPath = join(root, "tickets/PAP-268.json");
    writeFileSync(ticketPath, JSON.stringify({ id: "PAP-268", project: "fixture", title: "Disposable", status: "implementing", linkedBranches: [{ repo: "fixture", branch, state: "planned" }] }));
    const source = seedOrdinaryTaskBaseline({ ai: root, repo, repoKey: "fixture", ticket: "PAP-268", branch, base });
    if (variant === "stale") { writeFileSync(join(repo, "README.md"), "B\n"); git(["commit", "-am", "base B"]); }
    if (variant === "missing") { const ticket = JSON.parse(readFileSync(ticketPath, "utf8")); ticket.doc_refs = []; writeFileSync(ticketPath, JSON.stringify(ticket)); }
    if (variant === "dirty") writeFileSync(join(checkout, "unknown.txt"), "preserve\n");
    const canonical = { head: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain=v2", "--untracked-files=all"]) };
    const ticketBefore = readFileSync(ticketPath); let spawns = 0, treehouseCalls = 0, forbidden = 0, branchEffects = 0;
    let bodyFailure: unknown;
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
          const native = new PiNativeExecutionAdapter({ authority, helperDependencies: { treehouse } });
          const session = native.resolve({ cwd: checkout })!;
          assert.ok(session); assert.equal(session.contract.initialHeadSha, base);
          const plan = { phaseId: "A", scope: "Characterization only", paths: ["README.md"], requirements: ["AC3"], prerequisites: [], checks: ["diff-check"], size: "S", complexity: "bounded", rationale: "No source effects in this baseline slice." };
          if (variant.startsWith("project-")) await exerciseProjectCommands(native, checkout, () => new PiNativeExecutionAdapter({ authority, helperDependencies: { treehouse } }), variant === "project-no-progress", variant === "project-blocked-reporting", variant === "project-output-limit");
          else {
            session.service.apply(session.actor, { action: "plan", plan });
            // Explicit debt characterization, NOT full AC1–AC8 acceptance:
            assert.throws(() => session.service.apply(session.actor, { action: "plan", plan: { ...plan, phaseId: "B" } }), "phase continuation remains unsupported");
            assert.throws(() => session.service.apply(session.actor, { action: "plan", plan: { ...plan, checks: ["npm run test"] } }), "unregistered project contracts remain unsupported");
          }
          assert.equal(session.service.status(session.actor).custody.state, "idle");
          assert.equal(existsSync(join(directory, "prepared-consumption.json")), false);
          assert.equal(getDeploymentEvents(opts.deployId).filter((event) => event.event === "started").length, 1);
        } catch (error) { bodyFailure = error; throw error; }
        finally { process.chdir(repo); process.env = previous; }
        return { sessionId: opts.sessionId!, exitCode: variant === "project-no-progress" || variant === "project-blocked-reporting" || variant === "project-output-limit" ? 1 : 0, metadata: { sessionId: opts.sessionId! } };
      } };
    process.chdir(repo);
    const originalUpdate = TicketStore.prototype.update;
    if (variant === "publication-interruption") TicketStore.prototype.update = function (...args: Parameters<TicketStore["update"]>) {
      if (args[0] === "PAP-268" && args[1].add_linked_branch) throw new Error("fixture publication interruption");
      return originalUpdate.apply(this, args);
    };
    let result;
    try { result = await deployWithPi({ team: "builder", mode: "orchestrator", ticket: "PAP-268", repo: "fixture", timeout: 1800,
      provider: "openai-codex", model: "gpt-6.1-sol" }, adapter, undefined, { treehouse, preparedAuthority: authority, observeOperation: (operation) => { if (operation === "branch") branchEffects++; } }); }
    finally { TicketStore.prototype.update = originalUpdate; }
    if (bodyFailure) throw bodyFailure;
    assert.equal(forbidden, 0);
    assert.deepEqual({ head: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain=v2", "--untracked-files=all"]) }, canonical);
    if (variant === "matching" || variant.startsWith("project-")) {
      assert.equal(result.status, variant === "project-no-progress" || variant === "project-blocked-reporting" || variant === "project-output-limit" ? "failed" : "success", result.reason); assert.equal(spawns, 1); assert.equal(branchEffects, 1);
      assert.equal(JSON.parse(readFileSync(ticketPath, "utf8")).linkedBranches[0].baseSha, base);
      assert.equal(existsSync(repositoryMutationLeasePath(checkout)), false);
    } else if (variant === "publication-interruption") {
      assert.equal(result.status, "failed"); assert.equal(spawns, 0); assert.deepEqual(readFileSync(ticketPath), ticketBefore);
      assert.equal(git(["rev-parse", `refs/heads/${branch}`]), base);
      const retained = JSON.parse(readFileSync(repositoryTicketSlotPath(repo, "PAP-268"), "utf8"));
      assert.equal(retained.materializationIntent.branch, branch); assert.equal(retained.materializationIntent.baseSha, base);
    } else {
      assert.equal(result.status, "failed"); assert.equal(spawns, 0); assert.deepEqual(readFileSync(ticketPath), ticketBefore);
      assert.equal(git(["branch", "--list", branch]), "");
      if (variant === "stale" || variant === "missing") { assert.equal(treehouseCalls, 0); assert.equal(branchEffects, 0); }
      assert.match(result.reason ?? "", /ORDINARY_BASELINE_/);
    }
    assert.equal(existsSync(repositoryTicketSlotPath(repo, "PAP-268")), variant === "source-drift" || variant === "dirty" || variant === "publication-interruption",
      "post-acquisition denials retain existing custody for owning reconciliation; no forced release");
    if (existsSync(join(root, "authority/native"))) assert.deepEqual(readdirSync(join(root, "authority/native")), []);
  } finally { process.chdir(cwd); closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); }
}

async function exerciseProjectCommands(adapter: PiNativeExecutionAdapter, checkout: string, fresh: () => PiNativeExecutionAdapter, stopAtNoProgress = false, blockedReporting = false, outputLimited = false) {
  const tools = new Map<string, PiToolDefinition>(); const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
  const context = { cwd: checkout };
  const pi = { registerTool(tool: PiToolDefinition) { tools.set(tool.name, tool); }, on(name: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as PiRuntime;
  const dispatch = async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) { const result = await handler(event, context); if (result !== undefined) return result; } };
  createPiExecutionModule({ nativeAdapter: adapter })(pi); await dispatch("session_start", {});
  let session = adapter.resolve(context)!;
  const reload = async () => {
    const before = session.service.status(session.actor); adapter = fresh(); tools.clear(); handlers.clear();
    createPiExecutionModule({ nativeAdapter: adapter })(pi); await dispatch("session_start", {}); session = adapter.resolve(context)!;
    assert.deepEqual(session.service.status(session.actor), before);
  };
  const control = (input: Record<string, unknown>) => tools.get("pa_execution")!.execute("control", input, undefined, undefined, context);
  const observe = async (kind: string, rationale?: string) => (await control({ action: "observe", kind, ...(rationale ? { rationale } : {}) })).details.evidence;
  const select = async () => { const holder = await observe("holder"); await control({ action: "select", executor: "orchestrator-direct", holder, handover: holder }); };
  const settle = async () => control({ action: "settle", evidence: await observe("inventory") });
  let sequence = 0;
  const execute = async (name: string, input: Record<string, unknown>) => {
    const id = `project-${++sequence}`; assert.equal(await dispatch("tool_call", { toolName: name, toolCallId: id, input }), undefined);
    let result: unknown, failed = false; const updates: unknown[] = [];
    try { result = await tools.get(name)!.execute(id, input, undefined, (value: unknown) => updates.push(value), context); } catch (error) { failed = true; result = String(error); }
    await dispatch("tool_execution_end", { toolName: name, toolCallId: id, result, isError: failed }); return { result, failed, updates };
  };
  const deny = async (input: Record<string, unknown>) => {
    const response = await dispatch("tool_call", { toolName: "bash", toolCallId: `deny-${++sequence}`, input }) as { block: boolean; reason: string };
    assert.equal(response.block, true); assert.ok(response.reason.length <= 2000); assert.doesNotMatch(response.reason, /HOST-SECRET|TEST_PRIVATE_TOKEN|bootId/);
  };
  const plan = { phaseId: "A", scope: "Non-PA real project check/repair", paths: ["README.md"], requirements: ["AC1", "AC4", "AC5", "AC8"], prerequisites: [], checks: ["project-test", "project-build"], size: "S", complexity: "bounded", rationale: "Native approved contract and namespace-contained actual processes." };
  if (blockedReporting) {
    const before = session.service.status(session.actor);
    await assert.rejects(control({ action: "plan", plan }), /EXECUTION_PROJECT_CONTRACT_INVALID/);
    assert.equal((await execute("bash", { command: "ppa bulletin list" })).failed, false);
    assert.equal((await dispatch("tool_call", { toolName: "write", toolCallId: "blocked-source", input: { path: "README.md", content: "not authorized" } }) as { block: boolean }).block, true);
    const report = await control({ action: "report" });
    assert.match(String(report.details.markdown), /blocked\/unplanned; no source phase or checks admitted/);
    assert.equal(report.details.processState, "live"); assert.equal(report.details.terminalSettlement, false);
    assert.equal((await execute("write", { path: join(process.env.PA_AI_USAGE_HOME!, `sessions/2026/10/agent-team/2026-10-26-${session.actor.deploymentId}-builder--builder-agent--PAP-268--project-blocked.md`), content: String(report.details.markdown) })).failed, false);
    assert.deepEqual(session.service.status(session.actor), before, "source-contract denial cannot obstruct reporting or manufacture check/phase authority");
    // Simulated owning-config drift is not a protected record edit or a source
    // permission producer. Reload must retain the original admitted pointer,
    // still permit factual reporting, and deny source use of the changed pin.
    const configPath = join(process.env.PA_AI_USAGE_HOME!, "config/config.yaml");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/sha256: [0-9a-f]{64}/, `sha256: ${"0".repeat(64)}`));
    await reload();
    assert.equal((await control({ action: "report" })).details.terminalSettlement, false);
    await assert.rejects(control({ action: "plan", plan }), /EXECUTION_PROJECT_CONTRACT_INVALID/);
    assert.deepEqual(session.service.status(session.actor), before);
    return;
  }
  await control({ action: "plan", plan });
  await assert.rejects(control({ action: "observe", kind: "phase" }), "a plan is not completed work");
  await select();
  await deny({ command: "node 'scripts/test.cjs'; true" }); await deny({ command: "npm run unknown" });
  await deny({ command: "node 'scripts/test.cjs'", env: { NODE_OPTIONS: "--require evil" } });
  await deny({ command: "git commit -m 'feat: premature'" });
  if (outputLimited) {
    const result = await execute("bash", { command: "node 'scripts/test.cjs'", timeout: 20 });
    assert.equal(result.failed, true); assert.doesNotMatch(JSON.stringify(result), /partial-output-sentinel|EXECUTION_PRODUCT_CHECK_FAILED/);
    const last = session.reportFacts().checks.at(-1)!;
    const raw = session.evidence.read(last.output!, "tool-result") as { exitCode: number; process: { stdout: Parameters<typeof session.evidence.blob>[0]; outputLimitExceeded: boolean } };
    assert.equal(raw.process.outputLimitExceeded, true); assert.notEqual(raw.exitCode, 0);
    assert.match(session.evidence.blob(raw.process.stdout).toString(), /partial-output-sentinel/);
    assert.equal(session.service.status(session.actor).passedChecks["project-test"], undefined);
    const report = await control({ action: "report" });
    assert.match(String(report.details.markdown), /output-limit true/); assert.doesNotMatch(String(report.details.markdown), /partial-output-sentinel/);
    await settle(); return;
  }
  const firstCheck = await execute("bash", { command: "node 'scripts/test.cjs'", timeout: 20 });
  assert.equal(firstCheck.failed, true); assert.match(String(firstCheck.result), /EXECUTION_PRODUCT_CHECK_FAILED/);
  const failure = session.service.status(session.actor).originalFailure!; assert.equal(failure.exitCode, 2);
  await reload(); assert.deepEqual(session.service.status(session.actor).originalFailure, failure);
  await settle();
  await assert.rejects(control({ action: "advance", plan: { ...plan, phaseId: "B" }, evidence: failure.output }), "unresolved original failure prevents phase advance");
  await control({ action: "attempt", evidence: await observe("recovery", "The native exit2 and script output identify README's unrepaired marker; repair that source, not the check script.") });
  assert.equal(session.service.status(session.actor).bounds.consecutiveNoProgress, 0, "native diagnosis plus rationale is evidenced progress, not a prose-only retry");
  if (stopAtNoProgress) {
    const diagnostic = session.service.status(session.actor).diagnosticDigests[0];
    const deadline = session.service.status(session.actor).bounds.deadlineAt;
    for (let count = 1; count <= 3; count++) {
      await select(); assert.equal((await execute("bash", { command: "node 'scripts/test.cjs'", timeout: 20 })).failed, true); await settle();
      await control({ action: "attempt", evidence: await observe("recovery", `Relabelled prose ${count}, but the same actual failed output is not new diagnosis.`) });
      const current = session.service.status(session.actor);
      assert.equal(current.bounds.consecutiveNoProgress, count); assert.equal(current.diagnosticDigests.at(-1), diagnostic);
      const latest = session.reportFacts().checks.at(-1)!.output!;
      const latestResult = session.evidence.read(latest, "tool-result") as { process: { stderr: { sha256: string } } };
      const firstResult = session.evidence.read(failure.output, "tool-result") as { process: { stderr: { sha256: string } } };
      assert.notEqual(latestResult.process.stderr.sha256, firstResult.process.stderr.sha256, "changing log timestamps cannot manufacture semantic progress");
      assert.deepEqual(current.originalFailure, failure); assert.equal(current.bounds.deadlineAt, deadline); await reload();
    }
    await assert.rejects(select(), "three consecutive no-progress attempts stop source work");
    await assert.rejects(control({ action: "plan", plan }), "replan/reload cannot reset the stop");
    const before = session.service.status(session.actor);
    const report = await control({ action: "report" }); assert.match(String(report.details.markdown), /blocked by unresolved check failure/);
    assert.equal(report.details.processState, "live"); assert.equal(report.details.terminalSettlement, false);
    await execute("write", { path: join(process.env.PA_AI_USAGE_HOME!, `sessions/2026/10/agent-team/2026-10-26-${session.actor.deploymentId}-builder--builder-agent--PAP-268--no-progress.md`), content: `# Blocked\nOriginal failure: exit2 ${failure.output.ref}\nRepeated native output did not demonstrate progress. No checks passed, no commit or phase advance. Process remains live; preserve task evidence.\n` });
    assert.deepEqual(session.service.status(session.actor), before, "blocked reporting cannot reset caps or release authority");
    return;
  }
  await select();
  await execute("write", { path: "README.md", content: "repaired\n" });
  assert.equal((await execute("bash", { command: "node 'scripts/test.cjs'", timeout: 20 })).failed, false);
  assert.equal((await execute("bash", { command: "node 'scripts/build.cjs'", timeout: 20 })).failed, false);
  await settle();
  const facts = session.reportFacts(); assert.deepEqual(facts.checks.map((check) => check.exitCode), [2, 0, 0]);
  const passed = facts.checks[1]!.output!; await control({ action: "resolve", evidence: passed }); await select();
  await execute("bash", { command: "git add -- README.md" });
  assert.equal((await execute("bash", { command: "git commit -m 'feat: non-PA project repair'" })).failed, false);
  await settle(); await reload();
  const phaseA = session.service.status(session.actor), bounds = phaseA.bounds;
  const reportRoot = process.env.PA_AI_USAGE_HOME!;
  const phaseReport = await control({ action: "report" });
  const markdown = String(phaseReport.details.markdown);
  assert.match(markdown, /Original historical failure:.*exit 2/); assert.match(markdown, /Process: live/);
  assert.match(markdown, /project-test no-ambient-secret/); assert.match(markdown, /attempt clock/);
  assert.doesNotMatch(markdown, /HOST-SECRET-SENTINEL/);
  assert.equal(phaseReport.details.terminalSettlement, false);
  await execute("write", { path: join(reportRoot, `sessions/2026/10/agent-team/2026-10-26-${session.actor.deploymentId}-builder--builder-agent--PAP-268--phase-a.md`), content: markdown });
  const phaseEvidence = await observe("phase");
  await assert.rejects(control({ action: "plan", plan: { ...plan, phaseId: "B" } }), "a plan edit cannot change phases");
  await assert.rejects(control({ action: "advance", plan: { ...plan, phaseId: "B", paths: ["outside.txt"] }, evidence: phaseEvidence }), "phase advance cannot expand source scope");
  await control({ action: "advance", plan: { ...plan, phaseId: "B" }, evidence: phaseEvidence });
  assert.deepEqual(session.service.status(session.actor).bounds, bounds); await reload();
  await select(); await execute("write", { path: "README.md", content: "repaired phase B\n" });
  await deny({ command: "git commit -m 'feat: stale phase-A checks'" });
  assert.equal((await execute("bash", { command: "node 'scripts/test.cjs'", timeout: 20 })).failed, false);
  assert.equal((await execute("bash", { command: "node 'scripts/build.cjs'", timeout: 20 })).failed, false);
  await execute("bash", { command: "git add -- README.md" });
  assert.equal((await execute("bash", { command: "git commit -m 'feat: ordinary phase B'" })).failed, false);
  await settle();
  assert.notEqual(session.service.status(session.actor).candidateSha, phaseA.candidateSha);
  const final = session.reportFacts(); assert.deepEqual(final.checks.map((check) => check.exitCode), [2, 0, 0, 0, 0]);
  assert.equal(session.service.status(session.actor).bounds.deadlineAt, bounds.deadlineAt);
  await execute("write", { path: join(reportRoot, `sessions/2026/10/agent-team/2026-10-26-${session.actor.deploymentId}-builder--builder-agent--PAP-268--phase-b.md`), content: String((await control({ action: "report" })).details.markdown) });
  await assert.rejects(control({ action: "advance", plan, evidence: await observe("phase") }), "a completed phase ID cannot be relabelled/replayed");
  assert.equal(existsSync(join(checkout, "host-effect.txt")), false);
  const original = session.evidence.read(failure.output, "tool-result") as { process: { frame: Parameters<typeof session.evidence.read>[0] } };
  const frame = session.evidence.read(original.process.frame, "process-frame") as { cwd: string; program: { environment: Record<string, string>; argv: string[] } };
  assert.equal(frame.cwd, checkout); assert.equal(frame.program.environment.HOME, "/tmp/pa-check-home"); assert.ok(frame.program.argv.includes("--unshare-all"));
}

for (const variant of ["matching", "stale", "missing", "source-drift", "dirty", "project-commands", "project-no-progress", "project-blocked-reporting", "project-output-limit", "publication-interruption"] as const) {
  test(`PAP-268 actual ordinary launch: ${variant} intended baseline (simulated provider/Treehouse)`, () => fixture(variant));
}
