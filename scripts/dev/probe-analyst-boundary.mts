// PAP-334 P1 disposable-fixture investigation. NOT a qualified Analyst launcher.
// --characterize observes current behavior; --expect-protected fails on actual
// boundary violations. --expect-ticket-administration asserts ONLY the seven
// generic status fixtures, never filesystem enforcement or installed availability.
// Setup/import failures are never behavioral reds.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRegistryEvent, closeDb, resolveTrustedTicketMutationContext, TicketStore } from "../../packages/pa-core/src/index.js";
import { createSecureLocalBashTool } from "../../packages/pi-pa/src/pi-extension/local-source-tools.js";

const mode = process.argv[2];
if (!["--characterize", "--expect-protected", "--expect-ticket-administration"].includes(mode ?? "")) throw new Error("Use --characterize, --expect-protected or --expect-ticket-administration");
const originalEnvironment = { ...process.env };
const root = mkdtempSync(join(tmpdir(), "pap334-boundary-"));
const shared = join(root, "usage"), repoA = join(root, "repo-a"), repoB = join(shared, "repo-b");
const gitB = join(root, "external-git"), worktree = join(root, "linked"), config = join(root, "config");
const results: Record<string, unknown>[] = [];
const digest = (file: string) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("PA_")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
async function run(program: string, args: string[]): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-2000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
  });
}
try {
  for (const path of [shared, repoA, repoB, config]) mkdirSync(path, { recursive: true });
  git(repoA, "init", "--initial-branch=main");
  git(repoB, "init", "--initial-branch=main", `--separate-git-dir=${gitB}`);
  for (const repo of [repoA, repoB]) {
    writeFileSync(join(repo, "product.txt"), "original product\n");
    git(repo, "add", "product.txt");
    git(repo, "-c", "user.name=PAP334 Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture baseline");
  }
  git(repoA, "worktree", "add", "-b", "fixture-linked", worktree);
  writeFileSync(join(config, "repos.yaml"), `repos:\n  repo-a:\n    path: ${repoA}\n    prefix: AAA\n  repo-b:\n    path: ${repoB}\n    prefix: BBB\n`);
  closeDb();
  process.env = { ...environment, PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: shared, PA_REGISTRY_DB: join(root, "registry.db") };
  // This calls the actual local bash implementation, not a foreground session.
  // No fabricated process/launch authentication is used to claim qualification.
  const tool = createSecureLocalBashTool();
  const context = { cwd: root, mode: "tui", sessionManager: { getSessionId: () => "pap334-disposable-probe", getSessionFile: () => undefined } };
  const targets = [join(repoA, "product.txt"), join(repoB, "product.txt"), join(worktree, "product.txt"), join(gitB, "config")];
  for (const target of targets) {
    const before = digest(target);
    const code = `require('node:fs').appendFileSync(${JSON.stringify(target)}, 'fixture effect\\n')`;
    const command = `${quote(process.execPath)} -e ${quote(code)}`;
    const result = await tool.execute("pap334-fixture", { command }, undefined, undefined, context);
    results.push({ case: "actual-local-bash-protected-write", target: target.replace(root, "$FIXTURE"), command: command.replaceAll(root, "$FIXTURE"), before, after: digest(target), toolError: result.isError === true, boundaryViolation: digest(target) !== before });
  }
  const ordinary = join(shared, "ordinary.txt");
  const ordinaryResult = await tool.execute("pap334-positive", { command: `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(ordinary)}, 'ordinary shared write')`)}` }, undefined, undefined, context);
  if (ordinaryResult.isError || readFileSync(ordinary, "utf8") !== "ordinary shared write") throw new Error("Ordinary shared-file positive baseline did not succeed");
  results.push({ case: "actual-local-bash-shared-positive", passed: true, after: digest(ordinary) });

  // Real disposable registry rows: test generic lifecycle admission separately
  // from any selected native status profile and without touching live records.
  for (const [index, [team, mode]] of [
    ["analyst", "analyze"], ["builder", "implement"], ["coordinator", "coordinate"],
    ["instruction-lab", "develop"], ["review", "verify"], ["rogue-one", "rogue-one"], ["rollout", "rollout"],
  ].entries()) {
    const id = `d-33400${index}`;
    appendRegistryEvent({ deployment_id: id, team, mode, runtime: "pi", event: "started", timestamp: "2026-11-24T12:00:00Z" });
    const context = resolveTrustedTicketMutationContext({ deploymentId: id }, false);
    const store = new TicketStore(join(shared, "tickets"), context);
    const ticket = store.create({ project: "repo-b", title: "Cross-project fixture", summary: "", description: "", type: "task", status: "idea", priority: "medium", assignee: "sinh", estimate: "S", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, "fixture");
    let reason = "";
    try { store.update(ticket.id, { status: "requirement-review", title: "Modified fixture" }, "fixture"); }
    catch (error) { reason = error instanceof Error ? error.message : "Unknown ticket result"; }
    const observed = store.get(ticket.id)!;
    results.push({ case: "generic-cross-project-status", team, mode, persisted: observed.status === "requirement-review", reason, boundaryViolation: observed.status !== "requirement-review" });
  }

  // Candidate-mechanism counterexamples, NOT selected runtime enforcement.
  // No writable root mount: only the disposable shared directory is writable.
  const sandbox = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--bind", shared, shared, "--ro-bind", repoB, repoB, "--proc", "/proc", "--dev", "/dev", "--"];
  const probe = await run("bwrap", [...sandbox, process.execPath, "--version"]);
  if (probe.code !== 0) throw new Error(`Bubblewrap prerequisite unavailable (${probe.code}): ${probe.stderr}`);
  const protectedFile = join(repoA, "mount-protected.txt");
  writeFileSync(protectedFile, "protected baseline");
  const before = digest(protectedFile);
  const direct = await run("bwrap", [...sandbox, process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(protectedFile)}, 'forbidden')`]);
  if (direct.code === 0 || digest(protectedFile) !== before) throw new Error("Read-only mount negative control failed");
  const positive = join(shared, "sandbox-positive.txt");
  const positiveRun = await run("bwrap", [...sandbox, process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(positive)}, 'allowed')`]);
  if (positiveRun.code !== 0 || readFileSync(positive, "utf8") !== "allowed") throw new Error("Sandbox shared-file positive control failed");
  results.push({ case: "bubblewrap-direct-denial-and-shared-positive", passed: true, before, after: digest(protectedFile), deniedExit: direct.code });

  const alias = join(shared, "ordinary-looking-alias.txt"); linkSync(protectedFile, alias);
  const aliasRun = await run("bwrap", [...sandbox, process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(alias)}, 'changed through hard link')`]);
  results.push({ case: "bubblewrap-hardlink-alias", before, after: digest(protectedFile), exit: aliasRun.code, boundaryViolation: digest(protectedFile) !== before });

  const source = join(repoA, "move-source.txt"), destination = join(shared, "move-destination.txt");
  writeFileSync(source, "protected move source"); writeFileSync(destination, "ordinary existing destination");
  const sourceBefore = digest(source), destinationBefore = digest(destination);
  const move = await run("bwrap", [...sandbox, "mv", "--", source, destination]);
  results.push({ case: "bubblewrap-cross-boundary-move", exit: move.code, stderr: move.stderr.replaceAll(root, "$FIXTURE"), sourceBefore, sourceAfter: digest(source), destinationBefore, destinationAfter: digest(destination), boundaryViolation: digest(destination) !== destinationBefore });

  const delegated = join(repoA, "host-delegated.txt"), socket = join(root, "host.sock");
  writeFileSync(delegated, "host baseline"); const delegatedBefore = digest(delegated);
  const server = createServer(connection => { connection.on("error", () => {}); connection.once("data", () => { writeFileSync(delegated, "host service effect"); connection.end("done"); }); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    const bridge = await run("bwrap", [...sandbox, process.execPath, "-e", `const s=require('node:net').connect(${JSON.stringify(socket)},()=>s.write('effect')); s.on('error',()=>process.exit(2)); s.on('data',()=>s.end());`]);
    results.push({ case: "bubblewrap-pathname-host-bridge", exit: bridge.code, before: delegatedBefore, after: digest(delegated), boundaryViolation: digest(delegated) !== delegatedBefore });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  const violations = results.filter(row => row.boundaryViolation === true).length;
  const statusCases = results.filter(row => row.case === "generic-cross-project-status");
  const ticketAssertion = statusCases.length === 7 && statusCases.every(row => row.persisted === true);
  const assertion = mode === "--expect-ticket-administration" ? { scope: "seven-generic-status-fixtures-only", passed: ticketAssertion }
    : mode === "--expect-protected" ? { scope: "observed-boundary-cases-only", passed: violations === 0 }
      : { scope: "observation-only", passed: null };
  console.log(JSON.stringify({ schemaVersion: "pap334-investigation/v1", mode, state: violations ? "behavioral-red" : "no-observed-violation", fixtureOnly: true,
    overallQualification: "not-qualified", foregroundJourney: "not-run", assertion, results, violations }, null, 2));
  if (assertion.passed === false) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ state: "setup-blocked", behavioralRed: false, reason: error instanceof Error ? error.message : "Unknown setup failure", completedResults: results }, null, 2));
  process.exitCode = 2;
} finally {
  closeDb(); process.env = originalEnvironment; rmSync(root, { recursive: true, force: true });
}
