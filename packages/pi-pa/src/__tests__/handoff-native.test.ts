import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { spawn as spawnPty } from "node-pty";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  closeDb, createAgentApiApp, createModeCapabilityBinding, documentPackageSha, emitCompletedEvent, emitPidEvent, emitStartedEvent, ensureDeployDir,
  executeLocalReview, openDurableRegistryDatabase, RegistryHandoffReviewJournal, nativeHandoffTicketVersion, withLocalHandoffRepository,
  withPreparedTicketCapacity, preparedRepositoryTicketReservationPath, RegistryHandoffBranchJournal, handoffBranchOperationId,
  getDb, getDeploymentEvents, MODE_CAPABILITY_SESSION, parseModeCapabilityPolicy, RegistryDocumentJournal, TicketStore, workflowDigest, type DocumentPackage,
} from "@pa-platform/pa-core";
import { authenticatePiHandoffCaller, handoffFailure, type PiHandoffContext } from "../handoff-native.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { registerDocumentModule } from "../pi-extension/document-tool.js";
import { createHandoffTool } from "../pi-extension/handoff-tool.js";
import { createPiSessionLifecycle, registerPiSessionModules, type PiRuntime, type PiToolDefinition } from "../pi-extension/index.js";
import { runDocumentCommand } from "../document-cli.js";
import { startLocalReviewServer } from "../local-review-server.js";

function fixture(capabilities = ["document.handoff", "document.package"], supplied = false, outcome = "approved", prefix = "feature") {
  const env = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap312-native-"));
  try {
  const repo = join(root, "repo"), usage = join(root, "usage"), config = join(root, "config"); closeDb();
  for (const key of Object.keys(process.env)) if (key.startsWith("PA_") && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY; // never open a real desktop during source tests
  for (const path of [repo, usage, config]) mkdirSync(path);
  Object.assign(process.env, { PA_AI_USAGE_HOME: usage, PA_PLATFORM_CONFIG: config, PA_REGISTRY_DB: join(root, "registry.db") });
  writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n${prefix === "feature" ? "" : `  featureBranchPattern: ${prefix}/<ticket>-<topic>\n`}`);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "develop"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  process.chdir(repo);
  const deploymentId = "d-312001", directory = ensureDeployDir(deploymentId);
  if (supplied) {
    const tickets = new TicketStore();
    writeFileSync(join(usage, "tickets", "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Supplied native fixture", status: "idea", assignee: "sinh", doc_refs: [], comments: [], createdAt: "2026-11-15T06:00:00.000Z", updatedAt: "2026-11-15T06:00:00.000Z" }));
    assert.ok(tickets.get("EX-1"));
  }
  const binding = createModeCapabilityBinding("a".repeat(40), Buffer.from("synthetic selected committed resource"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: capabilities }));
  emitStartedEvent({ deploymentId, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo,
    note: MODE_CAPABILITY_SESSION, ...(supplied ? { ticketId: "EX-1" } : {}), modeCapabilityBinding: JSON.stringify(binding) });
  emitPidEvent({ deploymentId, team: "requirements", pid: process.pid });
  assert.equal(recordPiProcessIdentity(deploymentId, directory, process.pid), true);
  Object.assign(process.env, { PA_DEPLOYMENT_ID: deploymentId, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "requirements", PA_MODE: "analyze", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground", ...(supplied ? { PA_TICKET_ID: "EX-1" } : {}) });
  assert.equal(getDb().pragma("synchronous", { simple: true }), 1, "retained singleton stays NORMAL; the handoff opens its own FULL connection");
  let prompts = 0;
  const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "native-process-synthetic-ui-not-human" }, ui: {
    select: async () => { throw Error("legacy paged review forbidden"); },
    custom: (factory: any) => new Promise<any>(resolve => {
      prompts++;
      const component = factory({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_c: string, value: string) => value }, {}, resolve);
      const rendered = component.render(140).join("\n");
      assert.match(rendered, /one final decision/);
      if (capabilities.includes("document.local-review")) assert.match(rendered, /Local unverified confirmation: no authentication is provided/);
      const up = outcome === "approved" ? 3 : outcome === "changes-requested" ? 2 : outcome === "rejected" ? 1 : 0;
      for (let i = 0; i < up; i++) component.handleInput("\u001b[A");
      component.handleInput("\r");
    }),
  } };
  const tools = new Map<string, PiToolDefinition>(), handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, { handler: (args: string, context: unknown) => unknown }>();
  const runtime: PiRuntime = { registerCommand: (name, command) => { commands.set(name, command); }, registerTool: tool => tools.set(tool.name, tool), setActiveTools() {}, on: ((name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler])) as any };
  const lifecycle = createPiSessionLifecycle(() => {}), continuations: ReturnType<typeof createPiSessionLifecycle>[] = [];
  registerPiSessionModules(runtime, lifecycle, [registerDocumentModule]);
  for (const handler of handlers.get("session_start") ?? []) handler({}, context);
  const execute = async (tool: string, request: unknown, ctx: PiHandoffContext = context, signal?: AbortSignal) => {
    const result = await tools.get(tool)!.execute("native-fixture", { request: JSON.stringify(request) }, signal, undefined, ctx);
    return JSON.parse(result.content[0].text) as { ok: boolean; code?: string; result: Record<string, any> };
  };
  const handoff = (input: Record<string, unknown>) => execute("pa_handoff", { schemaVersion: capabilities.includes("document.local-review") ? "pa-handoff-native/v2" : "pa-handoff-native/v1", ...input });
  const checked = async (input: Record<string, unknown>) => { const result = await handoff(input); assert.equal(result.ok, true, JSON.stringify(result)); return result.result; };
  const freezeDocument = async (ticket: string, predecessor: string | null = null, revision = 1, quality = false) => {
    const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "native-fixture", revision, predecessor, repository: { key: "example", root: repo }, ticket,
      members: (["brief", "requirements", "uat"] as const).map(role => {
        const content = quality ? role === "brief" ? "Quality judgment: not-ready. Export scope contradicts UAT; request changes. Semantic review is authored, not a runtime grant."
          : role === "requirements" ? "# FR-1\nExport all filtered rows.\n# AC-1\nEvery filtered row must be exported; test TS-1.\n"
          : "# TS-1\nInput: 100 filtered rows, current page 10. Action: export. Expected: only the current page, 10 rows. Covers FR-1 and AC-1.\n"
          : role === "brief" ? "A synthetic decision brief." : `# Full ${role}\nComplete synthetic text, not human acceptance.\n`;
        const bytes = Buffer.from(content), source = quality ? `deployments/${deploymentId}/artifacts/requirements/r${revision}/${role}.md` : `agent-teams/requirements/artifacts/drafts/${deploymentId}/r${revision}/${role}.md`;
        mkdirSync(dirname(join(usage, source)), { recursive: true }); writeFileSync(join(usage, source), bytes);
        return { id: role, role, mediaType: "text/markdown", source, description: role, bytes: bytes.length, sha256: workflowDigest(bytes) };
      }), references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
    if (quality) {
      const findings = `# Quality judgment\nReadiness: not-ready\nFinding Q-07: requirements FR-1 / AC-1 require all filtered rows; UAT TS-1 expects only the current page.\nEvidence: requirements SHA-256 ${subject.members[1]!.sha256}; UAT SHA-256 ${subject.members[2]!.sha256}.\nConsequence: a ten-row export would silently omit ninety required rows.\nNext action: Analyst must reconcile scope and expected result before final approval.\nReviewer coverage: synthetic author review of brief, requirements and UAT; not independent, not installed or human UAT.\nUnknown: actual product behavior is untested.\n`;
      const source = `deployments/${deploymentId}/artifacts/requirements/r${revision}/quality.md`;
      writeFileSync(join(usage, source), findings);
      subject.members.push({ id: "quality", role: "specification", mediaType: "text/markdown", source, description: "PAPC-authored semantic findings; not native eligibility or approval", bytes: Buffer.byteLength(findings), sha256: workflowDigest(findings) });
    }
    const result = await execute("pa_document", { action: "freeze", package: subject, expectedRevision: new RegistryDocumentJournal(getDb()).events("example", ticket).length }); assert.equal(result.ok, true, JSON.stringify(result));
    return { subject, sha: documentPackageSha(subject), checks: result.result.checks };
  };
  return { root, repo, usage, prefix, context, tools, commands, execute, handoff, checked, git, freezeDocument, prompts: () => prompts, shutdown: () => lifecycle.shutdown(),
    async continueInFreshSession(ticketId: string, options: { liveOrigin?: boolean; contender?: boolean } = {}) {
      if (!options.liveOrigin) {
        // Synthetic process-boundary fixture: use a real child incarnation and
        // its observed exit, not a fabricated PID/death result.
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
        await once(child, "spawn");
        if (!child.pid) throw Error("fixture child missing PID");
        emitPidEvent({ deploymentId, team: "requirements", pid: child.pid });
        assert.equal(recordPiProcessIdentity(deploymentId, directory, child.pid), true);
        child.kill("SIGTERM"); await once(child, "exit");
        emitCompletedEvent({ deploymentId, team: "requirements", status: "success" });
      }
      const fresh = "d-314002", freshDirectory = ensureDeployDir(fresh);
      emitStartedEvent({ deploymentId: fresh, team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo,
        ticketId, note: MODE_CAPABILITY_SESSION, modeCapabilityBinding: JSON.stringify(binding) });
      emitPidEvent({ deploymentId: fresh, team: "requirements", pid: process.pid });
      assert.equal(recordPiProcessIdentity(fresh, freshDirectory, process.pid), true);
      if (options.contender) emitStartedEvent({ deploymentId: "d-314003", team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo,
        ticketId, note: MODE_CAPABILITY_SESSION, modeCapabilityBinding: JSON.stringify(binding) });
      Object.assign(process.env, { PA_DEPLOYMENT_ID: fresh, PA_DEPLOYMENT_DIR: freshDirectory, PA_TICKET_ID: ticketId });
      const freshContext = { ...context, sessionManager: { getSessionId: () => "fresh-selected-continuation" } };
      // A new runtime registration, not an environment edit widening the old
      // runtime's captured deployment or tool identity.
      const freshTools = new Map<string, PiToolDefinition>();
      const freshHandlers: ((event: unknown, context: unknown) => unknown)[] = [];
      const freshRuntime: PiRuntime = { registerTool: tool => freshTools.set(tool.name, tool), setActiveTools() {},
        on: (name, handler) => { if (name === "session_start") freshHandlers.push(handler); } };
      const freshLifecycle = createPiSessionLifecycle(() => {}); continuations.push(freshLifecycle);
      registerPiSessionModules(freshRuntime, freshLifecycle, [registerDocumentModule]);
      for (const handler of freshHandlers) handler({}, freshContext);
      const handoff = async (input: Record<string, unknown>) => {
        const result = await freshTools.get("pa_handoff")!.execute("fresh-native-fixture", { request: JSON.stringify({ schemaVersion: "pa-handoff-native/v2", ...input }) }, undefined, undefined, freshContext);
        return JSON.parse(result.content[0].text) as Awaited<ReturnType<typeof execute>>;
      };
      return { context: freshContext, checked: async (input: Record<string, unknown>) => {
        const result = await handoff(input); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
      }, handoff };
    },
    async close() { for (const continuation of continuations) await continuation.shutdown(); await lifecycle.shutdown(); closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { closeDb(); process.chdir(cwd); process.env = env; rmSync(root, { recursive: true, force: true }); throw error; }
}

test("registered content-only document/handoff/manual entries sign without plan or effect authority", async () => {
  const f = fixture(["document.handoff", "document.package", "document.local-review"], true);
  try {
    const doc = await f.freezeDocument("EX-1", null, 1, true);
    const ticketBefore = readFileSync(join(f.usage, "tickets/EX-1.json")), refs = f.git("show-ref");
    const prepared = await f.execute("pa_document", { action: "review-prepare", sha256: doc.sha });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const reference = prepared.result.reference;
    assert.match(reference, /^review:[a-f0-9]{64}$/);
    const listed = await f.execute("pa_handoff", { schemaVersion: "pa-content-review/v1", action: "list", ticket: "EX-1" });
    assert.equal(listed.ok, true); assert.equal(listed.result.reviews[0].reference, reference);
    const result = await f.execute("pa_handoff", { schemaVersion: "pa-content-review/v1", action: "review", reference });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.outcome, "approved");
    assert.equal(result.result.publication, "not-published"); assert.equal(f.prompts(), 1);
    assert.ok(f.commands.has("pa-review"));
    const manual = await f.commands.get("pa-review")!.handler(reference, f.context);
    assert.deepEqual(manual, result.result); assert.equal(f.prompts(), 1);
    const output: string[] = [];
    assert.equal(await runDocumentCommand(["review", reference], { stdout: text => { output.push(text); }, stderr: text => { output.push(text); } }), 0);
    assert.match(output.join("\n"), /Approved · Not published/); assert.equal(f.prompts(), 1);
    for (const action of ["publish", "complete-branch", "queue"]) {
      const denied = await f.handoff({ action, subjectSha256: reference.slice(7), decisionId: result.result.decisionId });
      assert.equal(denied.ok, false);
    }
    assert.equal(f.git("show-ref"), refs); assert.deepEqual(readFileSync(join(f.usage, "tickets/EX-1.json")), ticketBefore);
    assert.equal(getDb().prepare("SELECT count(*) n FROM handoff_review_effects").get()?.n, 0);
    assert.equal(getDb().prepare("SELECT count(*) n FROM handoff_review_subjects WHERE intent <> 'null'").get()?.n, 0);
  } finally { await f.close(); }
});

test("separate-terminal source PPA guided approval settles the same pending native Pi adapter", { timeout: 60000 }, async () => {
  const f = fixture(["document.handoff", "document.package", "document.local-review"], true), controller = new AbortController();
  let foreground: ReturnType<typeof f.execute> | undefined;
  try {
    const doc = await f.freezeDocument("EX-1");
    const prepared = await f.execute("pa_document", { action: "review-prepare", sha256: doc.sha });
    assert.equal(prepared.ok, true);
    const reference: string = prepared.result.reference;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let prompts = 0;
    const context: PiHandoffContext = { ...f.context, ui: { ...f.context.ui,
      custom: factory => new Promise(resolve => {
        prompts++;
        const component = factory({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_color: string, text: string) => text }, {}, resolve);
        assert.match(component.render(120).join("\n"), /Sign only/); entered();
      }),
    } };
    foreground = f.execute("pa_handoff", { schemaVersion: "pa-content-review/v1", action: "review", reference }, context, controller.signal);
    await Promise.race([waiting, foreground.then(result => { throw Error(`foreground ended before UI: ${JSON.stringify(result)}`); })]);
    const duplicate = f.execute("pa_document", { action: "review-sign", reference }, context, controller.signal);
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const child = spawnPty(process.execPath, [`--import=${import.meta.resolve("tsx")}`, cli, "document", "review", reference], { cwd: f.repo, env: { ...process.env, NO_COLOR: "1", TZ: "Asia/Saigon", LANG: "en_US.UTF-8" }, cols: 100, rows: 30 });
    let output = "", sent = false;
    const data = child.onData(value => { output += value; if (!sent && output.includes("Choose:")) { sent = true; child.write("a\r"); } });
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error("source PPA fixture did not settle within 30s")); }, 30000);
      child.onExit(event => { clearTimeout(timer); resolve(event.exitCode); });
    });
    data.dispose();
    assert.equal(code, 0, output); assert.equal(sent, true); assert.match(output, /Approved · Not published/);
    const result = await foreground;
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.outcome, "approved");
    assert.deepEqual((await duplicate).result, result.result); assert.equal(prompts, 1);
    const db = openDurableRegistryDatabase();
    try {
      const events = new RegistryHandoffReviewJournal(db, false).events(reference.slice(7));
      assert.deepEqual(events.map(event => event.kind), ["requested", "issued"]);
      assert.equal(events[0]?.kind === "requested" && events[0].request.decisionId, result.result.decisionId);
    } finally { db.close(); }
    assert.equal(getDb().prepare("SELECT count(*) n FROM handoff_review_effects").get()?.n, 0);
  } finally { controller.abort(); try { await foreground; } finally { await f.close(); } }
});

test("manual content review detaches on session shutdown without shared Cancel or stranded registry access", { timeout: 10000 }, async () => {
  const f = fixture(["document.handoff", "document.package", "document.local-review"], true);
  try {
    const doc = await f.freezeDocument("EX-1"), prepared = await f.execute("pa_document", { action: "review-prepare", sha256: doc.sha });
    assert.equal(prepared.ok, true);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const context: PiHandoffContext = { ...f.context, ui: { ...f.context.ui, custom: factory => new Promise(resolve => {
      factory({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_color: string, text: string) => text }, {}, resolve); entered();
    }) } };
    const review = f.commands.get("pa-review")!.handler(prepared.result.reference, context);
    await waiting;
    await f.shutdown();
    const result = await review;
    assert.ok(result && typeof result === "object" && "status" in result); assert.equal(result.status, "pending");
    const db = openDurableRegistryDatabase();
    try { assert.deepEqual(new RegistryHandoffReviewJournal(db, false).events(prepared.result.reference.slice(7)).map(event => event.kind), ["requested"]); }
    finally { db.close(); }
  } finally { await f.close(); }
});

test("content discovery before a subject stays empty; imported intent, authority and bare-ticket signing are rejected", async () => {
  const f = fixture(["document.handoff", "document.package", "document.local-review"], true);
  try {
    const list = await f.execute("pa_handoff", { schemaVersion: "pa-content-review/v1", action: "list", ticket: "EX-1" });
    assert.equal(list.ok, true); assert.deepEqual(list.result.reviews, []); assert.equal(f.prompts(), 0);
    for (const request of [
      { action: "review", reference: "EX-1" },
      { action: "prepare", sha256: "a".repeat(64), planRequestId: "fake-plan" },
      { action: "prepare", sha256: "a".repeat(64), effects: { publish: false, branchRef: false, queue: false } },
      { action: "decide", reference: `review:${"a".repeat(64)}`, outcome: "approved", principal: "human" },
    ]) assert.equal((await f.execute("pa_handoff", { schemaVersion: "pa-content-review/v1", ...request })).code, "DOCUMENT_INPUT");
    assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("content review cannot activate an omitted immutable local-review capability", async () => {
  const f = fixture(["document.handoff", "document.package"], true);
  try {
    const doc = await f.freezeDocument("EX-1");
    const result = await f.execute("pa_document", { action: "review-prepare", sha256: doc.sha });
    assert.equal(result.code, "DOCUMENT_AUTHORITY"); assert.equal(f.commands.has("pa-review"), false); assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("registered public v2 plan and original plan-status accept the selected feat convention", async () => {
  const f = fixture(["document.handoff", "document.package", "document.local-review"], true);
  try {
    writeFileSync(join(f.root, "config", "config.yaml"), `repos:\n example:\n  path: ${f.repo}\n  prefix: EX\n  featureBranchPattern: feat/<ticket>-<topic>\n`);
    const intake = await f.checked({ action: "intake", ticket: "EX-1" });
    const request = { action: "plan", ticket: "EX-1", requestId: "original-feat-plan", branch: "feat/EX-1-global-meta-recents", expectedTicketVersion: intake.ticketVersion };
    assert.equal((await f.checked({ ...request, action: "plan-status" })).disposition, "absent");
    const plan = await f.checked(request);
    assert.equal(plan.intent.branch, request.branch);
    assert.deepEqual((await f.checked(request)).intent, plan.intent);
    assert.equal((await f.checked({ ...request, action: "plan-status" })).disposition, "complete");
    assert.equal(f.prompts(), 0); assert.equal(f.git("for-each-ref", `refs/heads/${request.branch}`), "");
  } finally { await f.close(); }
});

test("registered original plan observation is read-only before a subject and preserves stale no-intent coordinates", async () => {
  const f = fixture(["document.handoff", "document.package", "document.local-review"], true);
  try {
    const intake = await f.checked({ action: "intake", ticket: "EX-1" });
    const request = { action: "plan-status", ticket: "EX-1", requestId: "original-observation", branch: "feature/EX-1-observation", expectedTicketVersion: intake.ticketVersion };
    const tickets = join(f.usage, "tickets"), before = readdirSync(tickets).sort();
    const first = await f.checked(request);
    assert.equal(first.disposition, "absent"); assert.equal(first.ticketMatchesExpectedVersion, true);
    assert.equal(first.authorityGranted, false); assert.equal(first.launchReady, false);
    assert.deepEqual(readdirSync(tickets).sort(), before);
    new TicketStore().comment("EX-1", "fixture", "Later unrelated comment");
    const stale = await f.checked(request);
    assert.equal(stale.disposition, "absent"); assert.equal(stale.ticketMatchesExpectedVersion, false);
    assert.equal(stale.nextOwner, "original-plan-owner");
    assert.equal(stale.original.expectedTicketVersion, intake.ticketVersion);
    const planned = await f.checked({ ...request, action: "plan", expectedTicketVersion: nativeHandoffTicketVersion(new TicketStore().get("EX-1")!) });
    const complete = await f.checked({ ...request, expectedTicketVersion: planned.intent.expectedTicketVersion });
    assert.equal(complete.disposition, "complete"); assert.deepEqual(complete.intent, planned.intent);
    const wrong = await f.handoff({ ...request, expectedTicketVersion: "f".repeat(64) });
    assert.equal(wrong.code, "DOCUMENT_CONFLICT");
    for (const extra of [{ originDeploymentId: "d-ffffff" }, { root: f.repo }, { actor: "operator" }]) {
      assert.equal((await f.handoff({ ...request, ...extra })).code, "DOCUMENT_INPUT");
    }
    assert.equal(f.prompts(), 0); assert.equal(f.git("for-each-ref", `refs/heads/${request.branch}`), "");
  } finally { await f.close(); }
});

test("registered plan observation never opens a writable registry or initializes missing evidence", async () => {
  const f = fixture(["document.handoff", "document.package", "document.local-review"], true);
  try {
    const intake = await f.checked({ action: "intake", ticket: "EX-1" });
    closeDb();
    // Public authentication and core observation must both avoid Git probes.
    renameSync(join(f.repo, ".git"), join(f.repo, "disabled-git"));
    const before = readdirSync(f.root).sort(), bytes = readFileSync(join(f.root, "registry.db"));
    const request = { action: "plan-status", ticket: "EX-1", requestId: "readonly-probe", branch: "feature/EX-1-readonly", expectedTicketVersion: intake.ticketVersion };
    assert.equal((await f.checked(request)).disposition, "absent");
    assert.deepEqual(readdirSync(f.root).sort(), before, "observation must not allocate registry WAL/SHM files");
    assert.deepEqual(readFileSync(join(f.root, "registry.db")), bytes);
    closeDb(); rmSync(join(f.root, "registry.db"));
    const missing = readdirSync(f.root).sort();
    await assert.rejects(() => f.handoff(request), /registry-missing/);
    assert.deepEqual(readdirSync(f.root).sort(), missing, "missing registry must remain missing");
  } finally { await f.close(); }
});

test("registered plan preserves established repository custody cause without echoing private marker", async () => {
  const f = fixture(["document.handoff", "document.package", "document.local-review"], true);
  try {
    const intake = await f.checked({ action: "intake", ticket: "EX-1" });
    // Use the actual exported custody marker, not an exception-text mock.
    const { REPOSITORY_MUTATION_LEASE_FILE } = await import("@pa-platform/pa-core");
    const path = join(f.repo, ".git", REPOSITORY_MUTATION_LEASE_FILE);
    writeFileSync(path, "PRIVATE_CUSTODY_SENTINEL");
    const result = await f.handoff({ action: "plan", ticket: "EX-1", requestId: "blocked-original", branch: "feature/EX-1-blocked", expectedTicketVersion: intake.ticketVersion });
    assert.equal(result.ok, false); assert.equal(result.code, "DOCUMENT_CONFLICT");
    const output = JSON.stringify(result);
    assert.match(output, /retained repository custody/); assert.doesNotMatch(output, /PRIVATE_CUSTODY_SENTINEL/);
    assert.equal(readFileSync(path, "utf8"), "PRIVATE_CUSTODY_SENTINEL");
    assert.equal(new TicketStore().get("EX-1")!.linkedBranches.length, 0);
    assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

for (const prefix of ["feature", "feat"]) for (const supplied of [false, true]) test(`registered native ${prefix} policy handoff completes ${supplied ? "supplied" : "ticketless"} intake, real plan/publication/ref/link with one synthetic UI and no checkout`, async () => {
  const f = fixture(undefined, supplied, "approved", prefix);
  try {
    const before = authenticatePiHandoffCaller(f.context), intakeInput = supplied ? { action: "intake", ticket: "EX-1" } : { action: "intake", title: "Native handoff", content: "Synthetic complete requirements intake" };
    const intake = await f.checked(intakeInput), caller = authenticatePiHandoffCaller(f.context);
    assert.equal(before.identitySha256, caller.identitySha256, "native session identity survives independent ticketless association");
    assert.equal((await f.checked(intakeInput)).ticket.id, intake.ticket.id);
    let ticketVersion = intake.ticketVersion;
    if (supplied) {
      const staged = await f.checked({ action: "stage", ticket: intake.ticket.id, requestId: "analysis", expectedTicketVersion: ticketVersion, stage: "analysis" }); ticketVersion = staged.ticketVersion;
    }
    const planRequest = { action: "plan", ticket: intake.ticket.id, requestId: "native-plan", branch: `${prefix}/${intake.ticket.id}-native`, expectedTicketVersion: ticketVersion };
    const planned = await f.checked(planRequest); assert.deepEqual((await f.checked(planRequest)).intent, planned.intent);
    const doc = await f.freezeDocument(intake.ticket.id);
    const prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: doc.sha, planRequestId: "native-plan", effects: { publish: true, branchRef: true, queue: false } });
    const opening = await f.checked({ action: "open", subjectSha256: prepared.subjectSha256, deliverySha256: prepared.subject.deliverySha256 });
    assert.equal(opening.state, "unavailable"); assert.equal(opening.openingMode, "system-default-browser-fallback");
    assert.equal(opening.networkIsolation, "not-provided"); assert.equal(opening.viewing, "not-established");
    const request = { action: "review", subjectSha256: prepared.subjectSha256, expectedRevision: 0 };
    const decision = await f.checked(request); assert.deepEqual(await f.checked(request), decision); assert.equal(f.prompts(), 1);
    const coordinates = { subjectSha256: prepared.subjectSha256, decisionId: decision.decisionId };
    assert.equal((await f.checked({ action: "publish", ...coordinates })).publication, "verified");
    assert.equal((await f.checked({ action: "complete-branch", ...coordinates })).completion, "verified");
    assert.equal((await f.checked({ action: "complete-branch", ...coordinates })).completion, "verified");
    assert.equal((await f.handoff({ action: "queue", ...coordinates })).code, "DOCUMENT_AUTHORITY");
    assert.equal(f.git("rev-parse", planRequest.branch), planned.intent.base.sha);
    assert.equal(f.git("branch", "--show-current"), "develop"); assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    assert.equal(new TicketStore().get(intake.ticket.id)!.linkedBranches[0]!.state, "materialized");
    assert.equal(new RegistryDocumentJournal(getDb()).events("example", intake.ticket.id).filter(event => event.data.kind !== "frozen").length, 0, "new native decisions do not forge retained grants");
    assert.equal(getDeploymentEvents("d-312001").filter(event => event.event === "ticket-associated").length, supplied ? 0 : 1);
    const status = await f.checked({ action: "status", subjectSha256: prepared.subjectSha256 }); assert.equal(status.reviewRevision, 2);
    assert.equal(status.latestRequest.expectedRevision, 0); assert.equal(status.latestDecision.outcome, "approved");
    const alternate = { ...f.context, sessionManager: { getSessionId: () => "other-session" } };
    assert.equal((await f.execute("pa_handoff", { schemaVersion: "pa-handoff-native/v1", action: "status", subjectSha256: prepared.subjectSha256 }, alternate)).code, "DOCUMENT_AUTHORITY");
    assert.equal(f.prompts(), 1);
  } finally { await f.close(); }
});

test("retained v1 issuance reauthenticates physical Git binding after the asynchronous review UI", async () => {
  const f = fixture();
  try {
    const intake = await f.checked({ action: "intake", title: "Physical binding", content: "Synthetic review-time repository rebind" });
    await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "rebind-plan", branch: `feature/${intake.ticket.id}-rebind`, expectedTicketVersion: intake.ticketVersion });
    const doc = await f.freezeDocument(intake.ticket.id);
    const prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: doc.sha, planRequestId: "rebind-plan", effects: { publish: true, branchRef: true, queue: false } });
    const other = join(f.root, "other"), linked = join(f.root, "linked"); mkdirSync(other);
    f.git("-C", other, "init", "-b", "develop");
    f.git("-C", other, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "foreign base");
    f.git("-C", other, "worktree", "add", "--detach", linked);
    const pointer = readFileSync(join(linked, ".git")), custom = f.context.ui.custom;
    f.context.ui.custom = factory => {
      const outcome = custom(factory);
      renameSync(join(f.repo, ".git"), join(f.repo, "original-git"));
      writeFileSync(join(f.repo, ".git"), pointer);
      return outcome;
    };
    assert.equal((await f.handoff({ action: "review", subjectSha256: prepared.subjectSha256, expectedRevision: 0 })).code, "DOCUMENT_AUTHORITY");
    const db = openDurableRegistryDatabase();
    try { assert.equal(new RegistryHandoffReviewJournal(db, false).events(prepared.subjectSha256).some(event => event.kind === "issued"), false); }
    finally { db.close(); }
    assert.equal(f.prompts(), 1); assert.equal(new TicketStore().get(intake.ticket.id)!.doc_refs.length, 0);
  } finally { await f.close(); }
});

for (const outcome of ["cancelled", "rejected", "changes-requested"]) test(`registered handoff ${outcome} denies all effects and never repeats the unchanged prompt`, async () => {
  const f = fixture(undefined, false, outcome);
  try {
    const intake = await f.checked({ action: "intake", title: "Nonapproval fixture", content: "Synthetic package" });
    await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "native-plan", branch: `feature/${intake.ticket.id}-native`, expectedTicketVersion: intake.ticketVersion });
    const doc = await f.freezeDocument(intake.ticket.id), prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: doc.sha, planRequestId: "native-plan", effects: { publish: true, branchRef: true, queue: true } });
    const request = { action: "review", subjectSha256: prepared.subjectSha256, expectedRevision: 0 }, d = await f.checked(request);
    assert.equal(d.outcome, outcome); await f.checked(request);
    for (const action of ["publish", "complete-branch", "queue"]) assert.equal((await f.handoff({ action, subjectSha256: prepared.subjectSha256, decisionId: d.decisionId })).ok, false);
    assert.equal(f.prompts(), 1); assert.equal(f.git("for-each-ref", "refs/heads/feature"), "");
  } finally { await f.close(); }
});

test("missing foreground custom UI retains the original pending review and never reopens it", async () => {
  const f = fixture();
  try {
    const intake = await f.checked({ action: "intake", title: "Missing UI fixture", content: "Synthetic requirements" });
    await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "native-plan", branch: `feature/${intake.ticket.id}-native`, expectedTicketVersion: intake.ticketVersion });
    const doc = await f.freezeDocument(intake.ticket.id), prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: doc.sha, planRequestId: "native-plan", effects: { publish: true, branchRef: true, queue: false } });
    const request = { schemaVersion: "pa-handoff-native/v1", action: "review", subjectSha256: prepared.subjectSha256, expectedRevision: 0 };
    const result = await f.execute("pa_handoff", request, { ...f.context, ui: undefined });
    assert.equal(result.code, "DOCUMENT_UNAVAILABLE");
    assert.equal((await f.handoff(request)).code, "DOCUMENT_UNCERTAIN");
    const status = await f.checked({ action: "status", subjectSha256: prepared.subjectSha256 });
    assert.equal(status.pendingReview, true); assert.equal(status.latestRequest.expectedRevision, 0); assert.equal(status.latestDecision, null);
    assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("omitted native handoff remains unregistered and direct invocation cannot widen a session", async () => {
  const f = fixture(["document.package"]);
  try {
    assert.equal(f.tools.has("pa_handoff"), false);
    assert.throws(() => authenticatePiHandoffCaller(f.context), /DOCUMENT_AUTHORITY/);
    const direct = createHandoffTool("a".repeat(64));
    const result = await direct.execute("omitted", { request: '{"schemaVersion":"pa-handoff-native/v1","action":"intake","title":"x","content":"x"}' }, undefined, undefined, f.context);
    assert.equal(JSON.parse(result.content[0].text).code, "DOCUMENT_AUTHORITY"); assert.equal(new TicketStore().list().length, 0);
  } finally { await f.close(); }
});

test("pre-cancelled native intake performs no ticket, association or handoff-journal mutation", async () => {
  const f = fixture(), controller = new AbortController();
  try {
    controller.abort(); const before = getDb().prepare("SELECT name FROM sqlite_master ORDER BY name").all();
    const result = await f.tools.get("pa_handoff")!.execute("cancelled", { request: JSON.stringify({ schemaVersion: "pa-handoff-native/v1", action: "intake", title: "Cancelled intake", content: "Must not create" }) }, controller.signal, undefined, f.context);
    assert.equal(JSON.parse(result.content[0].text).code, "DOCUMENT_AUTHORITY");
    assert.equal(new TicketStore().list().length, 0);
    assert.equal(getDeploymentEvents("d-312001").filter(event => event.event === "ticket-associated").length, 0);
    assert.deepEqual(getDb().prepare("SELECT name FROM sqlite_master ORDER BY name").all(), before);
    assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("strict handoff request rejects imported grants/paths, extra or duplicate fields before ticket effects", async () => {
  const f = fixture();
  try {
    for (const request of [
      { action: "intake", title: "Synthetic", content: "Content", outcome: "approved" },
      { action: "open", subjectSha256: "a".repeat(64), deliverySha256: "b".repeat(64), path: "/tmp/forged" },
      { action: "prepare-review", documentSubjectSha256: "a".repeat(64), planRequestId: "x", effects: { publish: false, branchRef: true, queue: false } },
      { action: "plan", ticket: "EX-1", requestId: "x", branch: "feature/EX-1-native", expectedTicketVersion: "a".repeat(64), base: "b".repeat(40) },
    ]) assert.equal((await f.handoff(request)).ok, false);
    const duplicate = await f.tools.get("pa_handoff")!.execute("duplicate", { request: '{"schemaVersion":"pa-handoff-native/v1","action":"intake","action":"intake","title":"Synthetic","content":"Content"}' }, undefined, undefined, f.context);
    assert.equal(JSON.parse(duplicate.content[0].text).code, "DOCUMENT_INPUT");
    const tablesBefore = getDb().prepare("SELECT name FROM sqlite_master ORDER BY name").all();
    assert.equal((await f.handoff({ action: "status", subjectSha256: "a".repeat(64) })).ok, false);
    assert.deepEqual(getDb().prepare("SELECT name FROM sqlite_master ORDER BY name").all(), tablesBefore, "missing status cannot create handoff journals");
    assert.equal(new TicketStore().list().length, 0); assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("selected native v2 shares pending/decide/revoke owner and preserves the local-unverified trust label", async () => {
  const f = fixture(["document.handoff", "document.local-review", "document.package"]);
  try {
    const intake = await f.checked({ action: "intake", title: "Local review", content: "Synthetic local-review fixture, not human acceptance" });
    await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "local-plan", expectedTicketVersion: intake.ticketVersion, branch: `feature/${intake.ticket.id}-local` });
    const doc = await f.freezeDocument(intake.ticket.id);
    const prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: doc.sha, planRequestId: "local-plan", effects: { publish: false, branchRef: false, queue: false } });
    assert.equal(prepared.subject.schemaVersion, "pa-handoff-review/v2");
    assert.equal(prepared.subject.origin.sessionId, f.context.sessionManager.getSessionId());
    assert.equal(prepared.authentication, "not-provided");
    const request = await f.checked({ action: "request", subjectSha256: prepared.subjectSha256, expectedRevision: 0 });
    assert.equal(f.prompts(), 0);
    const decisionRequest = { action: "decide", subjectSha256: prepared.subjectSha256, expectedRevision: 0, requestKey: request.requestKey, outcome: "approved" };
    const d = await f.checked(decisionRequest); assert.equal(d.principal, "local-unverified"); assert.deepEqual(await f.checked(decisionRequest), d);
    assert.equal((await f.handoff({ ...decisionRequest, outcome: "rejected" })).code, "DOCUMENT_CONFLICT");
    const revoke = await f.checked({ action: "revoke", subjectSha256: prepared.subjectSha256, expectedRevision: 2, decisionId: d.decisionId });
    assert.equal((await f.checked({ action: "status", subjectSha256: prepared.subjectSha256 })).pendingReview, true);
    await f.checked({ action: "decide", subjectSha256: prepared.subjectSha256, expectedRevision: 2, requestKey: revoke.requestKey, outcome: "approved" });
    assert.equal(f.prompts(), 0);
    const foreground = await f.checked({ action: "review", subjectSha256: prepared.subjectSha256, expectedRevision: 4 });
    assert.equal(foreground.principal, "local-unverified"); assert.equal(f.prompts(), 1);
    assert.equal((await f.checked({ action: "show", subjectSha256: prepared.subjectSha256 })).documents.length, doc.subject.members.length);
    assert.equal((await f.handoff({ action: "publish", subjectSha256: prepared.subjectSha256, decisionId: foreground.decisionId })).code, "DOCUMENT_AUTHORITY", "content-only v2 grants no publication");
    const v1 = await f.execute("pa_handoff", { schemaVersion: "pa-handoff-native/v1", action: "status", subjectSha256: prepared.subjectSha256 });
    assert.equal(v1.code, "DOCUMENT_AUTHORITY");
  } finally { await f.close(); }
});

test("v2 invocation cannot upgrade an omitted local-review selection", async () => {
  const f = fixture();
  try {
    const result = await f.execute("pa_handoff", { schemaVersion: "pa-handoff-native/v2", action: "intake", title: "Denied", content: "Must not create" });
    assert.equal(result.code, "DOCUMENT_AUTHORITY"); assert.equal(new TicketStore().list().length, 0);
  } finally { await f.close(); }
});

const localCapabilities = ["document.handoff", "document.local-review", "document.package"];
async function prepareLocal(f: ReturnType<typeof fixture>, effects = { publish: true, branchRef: true, queue: true }) {
  const intake = await f.checked({ action: "intake", title: "PAP-314 finite fixture", content: "Complete synthetic local handoff; not human UAT" });
  const plan = await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "p3-plan", expectedTicketVersion: intake.ticketVersion, branch: `${f.prefix}/${intake.ticket.id}-local` });
  const document = await f.freezeDocument(intake.ticket.id);
  const prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: document.sha, planRequestId: "p3-plan", effects });
  return { intake, plan, document, prepared, subjectSha256: prepared.subjectSha256 };
}
async function approveLocal(f: ReturnType<typeof fixture>, subjectSha256: string) {
  const request = await f.checked({ action: "request", subjectSha256, expectedRevision: 0 });
  const decision = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256, expectedRevision: 0, requestKey: request.requestKey, outcome: "approved" }));
  assert.equal(decision.outcome, "approved");
  return { request, decision, coordinates: { subjectSha256, decisionId: decision.decisionId } };
}

test("PAP-316 bound quality contradiction and own-deployment sources agree across Pi, CLI and both real APIs", async () => {
  const f = fixture(localCapabilities);
  const api = createAgentApiApp({ enableLocalReview: true, enableLiveUpdates: false });
  assert.ok(api.createServer);
  const general = api.createServer((_request, response) => { response.writeHead(404); response.end(); });
  let dedicated: Awaited<ReturnType<typeof startLocalReviewServer>> | undefined;
  try {
    const intake = await f.checked({ action: "intake", title: "Quality transport", content: "Synthetic shape-valid contradiction, not acceptance" });
    await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "quality-plan", branch: `feature/${intake.ticket.id}-quality`, expectedTicketVersion: intake.ticketVersion });
    const document = await f.freezeDocument(intake.ticket.id, null, 1, true);
    assert.equal(document.checks.structuralPass, true); assert.equal(document.checks.semanticCompleteness, "not-assessed");
    const prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: document.sha, planRequestId: "quality-plan", effects: { publish: false, branchRef: false, queue: false } });
    const subjectSha256 = prepared.subjectSha256;
    const request = { schemaVersion: "pa-local-review/v1", action: "show", subjectSha256 };
    const native = await f.checked({ action: "show", subjectSha256 });
    const output: string[] = [];
    assert.equal(await runDocumentCommand(["review", "--request-stdin"], { stdout: text => { output.push(text); }, stderr: () => {} }, { stdin: Readable.from([Buffer.from(JSON.stringify(request))]) }), 0);
    assert.deepEqual(JSON.parse(output.join("")), native);
    const post = (port: number, path: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } }, response => {
        let text = ""; response.on("data", chunk => { text += chunk; }); response.once("error", reject);
        response.once("end", () => { try { assert.equal(response.statusCode, 200); resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      req.once("error", reject); req.end(JSON.stringify(request));
    });
    dedicated = await startLocalReviewServer({ port: 0 });
    await new Promise<void>(resolve => { general.listen(0, "127.0.0.1", resolve); });
    const d = dedicated.address(), g = general.address(); assert.ok(d && typeof d !== "string" && g && typeof g !== "string");
    assert.deepEqual(await post(d.port, "/v1/review"), native);
    assert.deepEqual(await post(g.port, "/api/documents/local-review"), native);
    const quality = native.documents.find((member: { id: string }) => member.id === "quality");
    assert.match(quality.content, /Readiness: not-ready/); assert.match(quality.content, /not independent/);
    assert.equal(workflowDigest(quality.content), quality.sha256);
    assert.equal(quality.sha256, document.subject.members.at(-1)!.sha256);
    assert.match(readFileSync(join(f.usage, "agent-teams/requirements/artifacts/presentations", document.sha, prepared.subject.deliverySha256, "members/member-4.html"), "utf8"), /Readiness: not-ready/);
    const changed = structuredClone(document.subject); changed.members.at(-1)!.sha256 = workflowDigest(`${quality.content}Changed judgment`);
    assert.notEqual(documentPackageSha(changed), document.sha, "changed findings are a different review subject");
    let shown = false;
    f.context.ui.custom = factory => new Promise(resolve => {
      const component = factory({ requestRender() {}, terminal: { rows: 50 } }, { fg: (_c: string, value: string) => value }, {}, resolve);
      for (let i = 0; i < native.documents.length + 2; i++) {
        const text = component.render(220).join("\n");
        if (text.includes("Readiness: not-ready")) { shown = true; assert.match(text, /Next action: Analyst/); }
        component.handleInput("\t");
      }
      component.handleInput("\u001b[A"); component.handleInput("\u001b[A"); component.handleInput("\r");
    });
    const decision = await f.checked({ action: "review", subjectSha256, expectedRevision: 0 });
    assert.equal(shown, true); assert.equal(decision.outcome, "changes-requested");
    assert.deepEqual(decision.effects, { publish: false, branchRef: false, queue: false });
    assert.equal(new TicketStore().get(intake.ticket.id)!.doc_refs.length, 0);
    assert.equal(f.git("for-each-ref", "refs/heads/feature"), "");
  } finally {
    general.closeAllConnections(); await new Promise<void>(resolve => { general.close(() => resolve()); }); api.cleanup();
    if (dedicated) { dedicated.closeAllConnections(); await new Promise<void>(resolve => { dedicated!.close(() => resolve()); }); }
    await f.close();
  }
});

test("PAP-314 P4 inert client uses default CLI/API shared state, stale native refresh and original revocation coordinates", async () => {
  const f = fixture(localCapabilities);
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return Object.fromEntries(Object.entries(value));
  };
  try {
    const client = record(JSON.parse(readFileSync(new URL("./fixtures/local-review-client.json", import.meta.url), "utf8")));
    const local = record(client.localRequests), native = record(client.nativeRequests);
    const wire = (name: string, subjectSha256: string, fields: Record<string, unknown> = {}) => ({ ...record(local[name]), subjectSha256, ...fields });
    const cli = async (value: Record<string, unknown>, exit = 0) => {
      const stdout: string[] = [], stderr: string[] = [];
      assert.equal(await runDocumentCommand(["review", "--request-stdin"], {
        stdout: text => { stdout.push(text); }, stderr: text => { stderr.push(text); },
      }, { stdin: Readable.from([Buffer.from(JSON.stringify(value))]) }), exit);
      assert.equal(stdout.length, 1); assert.deepEqual(stderr, []);
      return record(JSON.parse(stdout[0]!));
    };
    const p = await prepareLocal(f);
    assert.equal((await f.execute("pa_handoff", { ...record(native.preflight), subjectSha256: p.subjectSha256 })).result.status, "eligible");
    for (const action of ["preflight", "refresh"]) {
      const invalid = await f.execute("pa_handoff", { ...record(native[action]), subjectSha256: p.subjectSha256, baseSha: "a".repeat(40) });
      assert.equal(invalid.code, "DOCUMENT_INPUT", "native examples cannot accept supplied base pins");
    }
    // No injected handler: both transports lazily call executeLocalReview against
    // the disposable registry, tickets and real native plan/delivery above.
    const server = await startLocalReviewServer({ port: 0 });
    try {
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const api = async (value: Record<string, unknown>, status = 200) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: address.port, method: "POST", path: "/v1/review", headers: { "Content-Type": "application/json" } }, res => {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          res.once("error", reject);
          res.once("end", () => {
            try { assert.equal(res.statusCode, status); resolve(record(JSON.parse(body))); }
            catch (error) { reject(error); }
          });
        });
        req.once("error", reject); req.setTimeout(10_000, () => req.destroy(new Error("Disposable local review request timed out")));
        req.end(JSON.stringify(value));
      });
      const original = await cli(wire("request", p.subjectSha256));
      assert.equal(original.expectedRevision, 0);
      const pending = await api(wire("show", p.subjectSha256));
      assert.equal(pending.reviewRevision, 1); assert.equal(pending.pendingReview, true);
      assert.equal(record(pending.latestRequest).requestKey, original.requestKey);
      assert.ok(Array.isArray(pending.documents)); assert.equal(pending.documents.length, p.document.subject.members.length);
      const ticketBefore = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`));
      f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "client stale boundary");
      const approveOld = wire("decide", p.subjectSha256, { requestKey: original.requestKey });
      const stale = await api(approveOld);
      assert.deepEqual(Object.keys(stale).sort(), Object.keys(record(client.staleResponse)).sort());
      assert.equal(stale.requestKey, original.requestKey);
      assert.equal(typeof stale.observedAt, "string");
      assert.equal(new Date(stale.observedAt).toISOString(), stale.observedAt);
      for (const field of ["schemaVersion", "status", "approval", "effects", "nextOwner", "trust", "authentication"]) {
        assert.equal(stale[field], record(client.staleResponse)[field]);
      }
      assert.equal(stale.oldDevelopSha, p.plan.intent.base.observedDevelopSha); assert.equal(stale.newDevelopSha, f.git("rev-parse", "develop"));
      assert.deepEqual(await cli(approveOld), stale, "reply-loss stale replay does not mint another outcome");
      assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), ticketBefore);
      assert.equal(f.git("for-each-ref", "refs/heads/feature"), "");
      const old = await api(wire("show", p.subjectSha256));
      assert.equal(old.approval, "stale"); assert.equal(old.reviewRevision, 2);
      assert.equal((await api({ ...approveOld, action: "refresh" }, 400)).code, "DOCUMENT_INPUT", "API cannot plan");
      const refresh = { ...record(native.refresh), subjectSha256: p.subjectSha256, expectedRevision: old.reviewRevision, expectedTicketVersion: old.ticketVersion };
      const nextResult = await f.execute("pa_handoff", refresh); assert.equal(nextResult.ok, true);
      const next = record(nextResult.result); assert.equal(typeof next.subjectSha256, "string");
      const nextSha = next.subjectSha256; assert.notEqual(nextSha, p.subjectSha256);
      assert.equal((await cli(wire("show", nextSha))).approval, "not-requested");
      const request = await cli(wire("request", nextSha));
      assert.deepEqual(await api(wire("request", nextSha)), request);
      const approve = wire("decide", nextSha, { requestKey: request.requestKey });
      const decision = await api(approve); assert.equal(decision.principal, "local-unverified");
      assert.equal(decision.authentication, "not-provided"); assert.equal(decision.method, "unauthenticated-local-confirmation");
      assert.deepEqual(await cli(approve), decision);
      assert.equal((await cli({ ...approve, outcome: "rejected" }, 1)).code, "DOCUMENT_CONFLICT");
      const approved = await f.checked({ action: "show", subjectSha256: nextSha });
      assert.equal(approved.approval, "approved");
      for (const effect of ["publish", "branchRef", "queue"]) assert.equal(approved.effects[0][effect].state, "not-started");
      const revokeInput = wire("revoke", nextSha, { decisionId: decision.decisionId });
      const revoke = await cli(revokeInput); assert.equal(revoke.expectedRevision, 2);
      assert.notEqual(revoke.requestKey, request.requestKey);
      const revocationPending = await api(wire("show", nextSha));
      assert.equal(revocationPending.reviewRevision, 3); assert.equal(revocationPending.revoked, false);
      const revokeDecision = wire("decideRevocation", nextSha, { requestKey: revoke.requestKey });
      assert.equal((await api({ ...revokeDecision, expectedRevision: 3 }, 409)).code, "DOCUMENT_CONFLICT");
      const revoked = await api(revokeDecision); assert.equal(revoked.operation, "revoke");
      assert.equal(revoked.targetDecisionId, decision.decisionId);
      assert.deepEqual(await cli(revokeDecision), revoked);
      assert.deepEqual(await api(revokeInput), revoke, "revoke replay retains the original pre-request revision");
      const status = await cli(wire("show", nextSha));
      assert.equal(status.revoked, true); assert.equal(status.approval, "revoked");
      assert.equal(status.reviewRevision, 4); assert.equal(status.launchReady, false); assert.equal(status.productUat, "not-asserted");
      assert.equal((await f.handoff({ action: "publish", subjectSha256: nextSha, decisionId: decision.decisionId })).code, "DOCUMENT_AUTHORITY");
      assert.equal(new TicketStore().get(p.intake.ticket.id)!.doc_refs.length, 0);
      assert.equal(f.git("for-each-ref", "refs/heads/feature"), ""); assert.equal(f.prompts(), 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally { await f.close(); }
});

for (const prefix of ["feature", "feat"]) test(`PAP-314 P3 registered ${prefix} v2 completes actual publication, every attachment, correlated ref/link and queue while preserving canonical dirt`, async () => {
  const f = fixture(localCapabilities, false, "approved", prefix);
  try {
    const p = await prepareLocal(f); assert.equal(p.prepared.preflight.status, "eligible");
    writeFileSync(join(f.repo, "staged.txt"), "staged original"); f.git("add", "staged.txt"); writeFileSync(join(f.repo, "staged.txt"), "unstaged original"); writeFileSync(join(f.repo, "untracked.txt"), "untracked original");
    const dirt = f.git("status", "--porcelain=v2", "-z"), index = f.git("write-tree");
    const a = await approveLocal(f, p.subjectSha256);
    const update = TicketStore.prototype.update;
    let promoted = 0;
    TicketStore.prototype.update = function (...args) {
      if (args[1].doc_refs?.some(ref => ref.primary)) {
        const ticket = this.get(p.intake.ticket.id)!;
        assert.equal(ticket.doc_refs.filter(ref => /presentations/.test(ref.path)).length, p.document.subject.members.length * 2 + 2);
        assert.equal(ticket.doc_refs.filter(ref => /handoff-approvals/.test(ref.path)).length, 1);
        assert.equal(p.document.subject.members.every(member => ticket.doc_refs.some(ref => ref.path.endsWith(`/${member.id}.md`))), true);
        promoted++;
      }
      return update.apply(this, args);
    };
    try { assert.equal((await f.checked({ action: "publish", ...a.coordinates })).publication, "verified"); }
    finally { TicketStore.prototype.update = update; }
    assert.equal(promoted, 1);
    assert.equal((await f.checked({ action: "publish", ...a.coordinates })).publication, "verified", "lost-reply replay observes original publication");
    assert.equal((await f.handoff({ action: "queue", ...a.coordinates })).ok, false, "queue cannot bypass physical completion");
    assert.equal((await f.checked({ action: "complete-branch", ...a.coordinates })).completion, "verified");
    assert.equal((await f.checked({ action: "queue", ...a.coordinates })).queue, "verified");
    assert.equal((await f.checked({ action: "queue", ...a.coordinates })).queue, "verified");
    const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.equal(status.nextOwner, "none");
    for (const effect of ["publish", "branchRef", "queue"]) assert.equal(status.effects[0][effect].state, "verified");
    assert.equal(f.git("rev-parse", p.plan.intent.branch), p.plan.intent.base.sha);
    assert.equal(f.git("status", "--porcelain=v2", "-z"), dirt); assert.equal(f.git("write-tree"), index);
    assert.equal(f.git("branch", "--show-current"), "develop"); assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    const ticket = new TicketStore().get(p.intake.ticket.id)!; assert.equal(ticket.status, "pending-implementation"); assert.equal(ticket.assignee, "builder/team-manager");
    assert.equal(ticket.linkedBranches[0]!.linkedAt, p.plan.ticket.linkedBranches[0].linkedAt); assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("policy drift after completed handoff preserves physically verified effects and original authority", async () => {
  const f = fixture(localCapabilities, false, "approved", "feat");
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates }); await f.checked({ action: "complete-branch", ...a.coordinates }); await f.checked({ action: "queue", ...a.coordinates });
    const before = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    const ticket = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), refs = f.git("show-ref");
    writeFileSync(join(f.root, "config", "config.yaml"), `repos:\n example:\n  path: ${f.repo}\n  prefix: EX\n  featureBranchPattern: feature/<ticket>-<topic>\n`);
    const after = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.deepEqual(after.effects, before.effects); assert.equal(after.nextOwner, "none");
    assert.deepEqual(after.intent, before.intent); assert.deepEqual(after.history, before.history);
    assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), ticket); assert.equal(f.git("show-ref"), refs);
    assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

for (const boundary of ["prepare", "approval", "publish", "complete-branch", "queue"] as const) test(`registered policy drift at ${boundary} preserves feat history and blocks incompatible new effects`, async () => {
  const f = fixture(localCapabilities, false, "approved", "feat");
  try {
    const p = await prepareLocal(f);
    let a: Awaited<ReturnType<typeof approveLocal>> | undefined;
    if (!["prepare", "approval"].includes(boundary)) a = await approveLocal(f, p.subjectSha256);
    if (boundary === "complete-branch" || boundary === "queue") await f.checked({ action: "publish", ...a!.coordinates });
    if (boundary === "queue") await f.checked({ action: "complete-branch", ...a!.coordinates });
    const before = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`));
    const refs = f.git("show-ref"), audit = readFileSync(join(f.usage, "tickets/audit.jsonl"));
    const configure = (prefix: string) => writeFileSync(join(f.root, "config", "config.yaml"), `repos:\n example:\n  path: ${f.repo}\n  prefix: EX\n  featureBranchPattern: ${prefix}/<ticket>-<topic>\n`);
    configure("feature");
    const history = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.deepEqual(history.intent, p.plan.intent);
    assert.equal(history.subject.branchIntentSha256, p.prepared.subject.branchIntentSha256);
    if (boundary === "prepare") {
      assert.equal((await f.handoff({ action: "prepare-review", documentSubjectSha256: p.document.sha, planRequestId: "p3-plan", effects: { publish: true, branchRef: true, queue: true } })).code, "DOCUMENT_AUTHORITY");
    } else if (boundary === "approval") {
      const result = await f.checked({ action: "request", subjectSha256: p.subjectSha256, expectedRevision: 0 });
      assert.equal(result.status, "blocked"); assert.equal(result.approval, "not-issued");
    } else assert.equal((await f.handoff({ action: boundary, ...a!.coordinates })).code, "DOCUMENT_AUTHORITY");
    assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), before);
    assert.deepEqual(readFileSync(join(f.usage, "tickets/audit.jsonl")), audit); assert.equal(f.git("show-ref"), refs);
    configure("feat");
    const approved = a ?? await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...approved.coordinates });
    await f.checked({ action: "complete-branch", ...approved.coordinates });
    await f.checked({ action: "queue", ...approved.coordinates });
    const complete = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.equal(complete.nextOwner, "none"); assert.deepEqual(complete.intent, p.plan.intent);
    assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("PAP-314 P3 independent MVM-shaped preflight blocks final review without erasing primary or changing lifecycle", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true });
    store.update(p.intake.ticket.id, { status: "idea", assignee: "sinh", add_doc_ref: { type: "attachment", path: "agent-teams/requirements/artifacts/intake.md", primary: true } });
    const before = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`));
    const preflight = await f.checked({ action: "preflight", subjectSha256: p.subjectSha256 });
    assert.equal(preflight.status, "blocked"); assert.ok(preflight.eligibility.causes.includes("lifecycle-assignment")); assert.ok(preflight.eligibility.causes.includes("primary-predecessor"));
    const final = await f.checked({ action: "review", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    assert.equal(final.status, "blocked"); assert.equal(f.prompts(), 0);
    assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), before);
    const db = openDurableRegistryDatabase(); try { assert.equal(new RegistryHandoffReviewJournal(db, false).events(p.subjectSha256).length, 0); } finally { db.close(); }
    for (const raw of [
      { schemaVersion: "pa-handoff-native/v1", action: "preflight", subjectSha256: p.subjectSha256 },
      { schemaVersion: "pa-handoff-native/v2", action: "refresh", subjectSha256: p.subjectSha256, expectedRevision: 0, expectedTicketVersion: p.intake.ticketVersion, baseSha: "a".repeat(40) },
    ]) assert.equal((await f.execute("pa_handoff", raw)).code, "DOCUMENT_INPUT");
  } finally { await f.close(); }
});

for (const prefix of ["feature", "feat"]) test(`PAP-314 P3 ${prefix} approval drift, stale reply loss, exact refresh replay, repeated drift and postissuance pin`, async () => {
  const f = fixture(localCapabilities, false, "approved", prefix);
  try {
    const p = await prepareLocal(f), oldLink = new TicketStore().get(p.intake.ticket.id)!.linkedBranches;
    const original = await f.checked({ action: "request", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    const decide = { schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: p.subjectSha256, expectedRevision: 0, requestKey: original.requestKey, outcome: "approved" };
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "develop B"); const b = f.git("rev-parse", "HEAD");
    const stale = await executeLocalReview(JSON.stringify(decide)); assert.equal(stale.status, "stale"); assert.equal(stale.oldDevelopSha, p.plan.intent.base.sha); assert.equal(stale.newDevelopSha, b);
    assert.deepEqual(await executeLocalReview(JSON.stringify(decide)), stale);
    let history = (await f.checked({ action: "show", subjectSha256: p.subjectSha256 })).history;
    assert.deepEqual(history.map((event: { kind: string }) => event.kind), ["requested", "stale"]);
    const refresh = { action: "refresh", subjectSha256: p.subjectSha256, expectedRevision: history.length, expectedTicketVersion: nativeHandoffTicketVersion(new TicketStore().get(p.intake.ticket.id)!) };
    const apply = TicketStore.prototype.applyHandoffWithIntent;
    TicketStore.prototype.applyHandoffWithIntent = function (...args) {
      if (args[2].kind !== "plan" || !args[2].predecessorPlanKey) return apply.apply(this, args);
      const original = args[5];
      return apply.call(this, args[0], args[1], args[2], args[3], args[4], { ...original, afterPersist(stage) { original.afterPersist?.(stage); if (stage === "intent") throw Error("refresh intent persisted, reply lost"); } });
    };
    try { assert.equal((await f.handoff(refresh)).ok, false); } finally { TicketStore.prototype.applyHandoffWithIntent = apply; }
    const next = await f.checked(refresh), replay = await f.checked(refresh); assert.equal(next.subjectSha256, replay.subjectSha256); assert.deepEqual(next.intent, replay.intent);
    assert.deepEqual(new TicketStore().get(p.intake.ticket.id)!.linkedBranches, oldLink);
    assert.notEqual(next.subjectSha256, p.subjectSha256); assert.equal(next.intent.base.sha, b);
    const r = await f.checked({ action: "request", subjectSha256: next.subjectSha256, expectedRevision: 0 });
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "develop C"); const c = f.git("rev-parse", "HEAD");
    const driftAgain = await f.checked({ action: "decide", subjectSha256: next.subjectSha256, expectedRevision: 0, requestKey: r.requestKey, outcome: "approved" }); assert.equal(driftAgain.newDevelopSha, c);
    const latestRefresh = { action: "refresh", subjectSha256: next.subjectSha256, expectedRevision: 2, expectedTicketVersion: nativeHandoffTicketVersion(new TicketStore().get(p.intake.ticket.id)!) };
    const latest = await f.checked(latestRefresh);
    const a = await approveLocal(f, latest.subjectSha256);
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "develop D after issuance");
    const saved = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: latest.subjectSha256, expectedRevision: 0, requestKey: a.request.requestKey, outcome: "approved" })); assert.deepEqual(saved, a.decision);
    await f.checked({ action: "publish", ...a.coordinates }); await f.checked({ action: "complete-branch", ...a.coordinates }); await f.checked({ action: "queue", ...a.coordinates });
    assert.equal(f.git("rev-parse", p.plan.intent.branch), c); assert.equal(f.prompts(), 0);
    const audit = readFileSync(join(f.usage, "tickets/audit.jsonl"));
    const completedRefreshReplay = await f.checked(latestRefresh);
    assert.equal(completedRefreshReplay.subjectSha256, latest.subjectSha256); assert.equal(completedRefreshReplay.intent.base.sha, c);
    assert.equal(completedRefreshReplay.nextOwner, "same-operation-status");
    assert.equal((await f.checked(refresh)).intent.base.sha, b, "historical refresh does not repin even after later successors finish");
    assert.deepEqual(readFileSync(join(f.usage, "tickets/audit.jsonl")), audit);
  } finally { await f.close(); }
});

test("PAP-314 P3 prepare observes local develop again and read-only preflight does not append history", async () => {
  const f = fixture(localCapabilities);
  try {
    const intake = await f.checked({ action: "intake", title: "Preparation drift", content: "Observe canonical local branch" });
    const plan = await f.checked({ action: "plan", ticket: intake.ticket.id, requestId: "p3-plan", expectedTicketVersion: intake.ticketVersion, branch: `feature/${intake.ticket.id}-local` });
    const document = await f.freezeDocument(intake.ticket.id);
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "before preparation");
    const prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: document.sha, planRequestId: "p3-plan", effects: { publish: true, branchRef: true, queue: true } });
    assert.equal(prepared.preflight.status, "stale"); assert.equal(prepared.preflight.oldDevelopSha, plan.intent.base.sha);
    const db = openDurableRegistryDatabase(); try {
      const journal = new RegistryHandoffReviewJournal(db, false), before = journal.events(prepared.subjectSha256);
      const result = await f.checked({ action: "preflight", subjectSha256: prepared.subjectSha256 }); assert.equal(result.status, "stale");
      assert.deepEqual(journal.events(prepared.subjectSha256), before);
    } finally { db.close(); }
  } finally { await f.close(); }
});

test("PAP-314 P3 ended-origin external decision and fresh selected continuation retain actual caller and original operation", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), request = await f.checked({ action: "request", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    const next = await f.continueInFreshSession(p.intake.ticket.id);
    const caller = authenticatePiHandoffCaller(next.context); assert.equal(caller.deploymentId, "d-314002"); assert.notEqual(caller.identitySha256, p.prepared.subject.callerIdentitySha256);
    const d = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: p.subjectSha256, expectedRevision: 0, requestKey: request.requestKey, outcome: "approved" }));
    assert.equal(d.principal, "local-unverified"); const coordinates = { subjectSha256: p.subjectSha256, decisionId: d.decisionId };
    await next.checked({ action: "publish", ...coordinates }); await next.checked({ action: "complete-branch", ...coordinates }); await next.checked({ action: "queue", ...coordinates });
    const status = await next.checked({ action: "status", subjectSha256: p.subjectSha256 }); assert.equal(status.nextOwner, "none");
    assert.equal(status.subject.origin.deploymentId, "d-312001"); assert.equal(status.latestRequest.deploymentId, "d-312001");
    assert.equal(authenticatePiHandoffCaller(next.context).deploymentId, "d-314002"); assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

test("PAP-314 P3 fresh selected caller recovers an origin partial publication using its original effect identity", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256), update = TicketStore.prototype.update;
    TicketStore.prototype.update = function (...args) { if (args[1].doc_refs?.some(ref => ref.primary)) throw Error("origin interrupted before primary"); return update.apply(this, args); };
    try { assert.equal((await f.handoff({ action: "publish", ...a.coordinates })).ok, false); } finally { TicketStore.prototype.update = update; }
    const before = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "show", subjectSha256: p.subjectSha256 }));
    const next = await f.continueInFreshSession(p.intake.ticket.id);
    const publication = await next.checked({ action: "publish", ...a.coordinates });
    const after = await next.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.ok(Array.isArray(before.effects)); assert.equal(publication.operationId, before.effects[0].publish.operationId);
    assert.equal(after.effects[0].publish.state, "verified");
    await next.checked({ action: "complete-branch", ...a.coordinates }); await next.checked({ action: "queue", ...a.coordinates });
    assert.equal((await next.checked({ action: "status", subjectSha256: p.subjectSha256 })).nextOwner, "none"); assert.equal(f.prompts(), 0);
  } finally { await f.close(); }
});

for (const denial of ["live-origin", "uncertain-resource", "unrelated-history", "contender"] as const) test(`PAP-314 P3 continuation rejects ${denial}`, async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    const next = await f.continueInFreshSession(p.intake.ticket.id, { liveOrigin: denial === "live-origin", contender: denial === "contender" });
    if (denial === "uncertain-resource") writeFileSync(join(f.repo, ".git", "pa-repository-mutation.lease.json"), "uncertain retained custody");
    if (denial === "unrelated-history") {
      emitStartedEvent({ deploymentId: "d-314099", team: "requirements", mode: "analyze", runtime: "pi", binary: "ppa", repo: f.repo, repoRoot: f.repo, worktreeRoot: f.repo, ticketId: p.intake.ticket.id });
      emitCompletedEvent({ deploymentId: "d-314099", team: "requirements", status: "success" });
    }
    assert.equal((await next.handoff({ action: "publish", ...a.coordinates })).ok, false);
    assert.equal(f.git("for-each-ref", "refs/heads/feature"), "");
    assert.equal(new TicketStore().get(p.intake.ticket.id)!.doc_refs.length, 0);
  } finally { await f.close(); }
});

test("PAP-314 P3 partial publication revocation fences missing writes and preserves completed attachments", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256), update = TicketStore.prototype.update;
    TicketStore.prototype.update = function (...args) { if (args[1].doc_refs?.some(ref => ref.primary)) throw Error("injected interruption before primary"); return update.apply(this, args); };
    try { assert.equal((await f.handoff({ action: "publish", ...a.coordinates })).ok, false); } finally { TicketStore.prototype.update = update; }
    const before = new TicketStore().get(p.intake.ticket.id)!; assert.ok(before.doc_refs.length > 0); assert.equal(before.doc_refs.some(ref => ref.primary), false);
    const rev = await f.checked({ action: "revoke", subjectSha256: p.subjectSha256, expectedRevision: 2, decisionId: a.decision.decisionId });
    await f.checked({ action: "decide", subjectSha256: p.subjectSha256, expectedRevision: 2, requestKey: rev.requestKey, outcome: "approved" });
    assert.equal((await f.handoff({ action: "publish", ...a.coordinates })).ok, false); assert.equal((await f.handoff({ action: "complete-branch", ...a.coordinates })).ok, false);
    assert.deepEqual(new TicketStore().get(p.intake.ticket.id)!.doc_refs, before.doc_refs);
    const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 }); assert.equal(status.effects[0].publish.state, "partial"); assert.equal(status.nextOwner, "finite-effect-owner-reconciliation");
  } finally { await f.close(); }
});

for (const prefix of ["feature", "feat"]) test(`PAP-314 P3 ${prefix} created ref and missing audit resume the same link operation after reply loss`, async () => {
  const f = fixture(localCapabilities, false, "approved", prefix);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256); await f.checked({ action: "publish", ...a.coordinates });
    const apply = TicketStore.prototype.applyHandoffWithIntent;
    TicketStore.prototype.applyHandoffWithIntent = function (...args) {
      if (args[2].kind !== "materialize") return apply.apply(this, args);
      const original = args[5];
      return apply.call(this, args[0], args[1], args[2], args[3], args[4], { ...original, afterPersist(stage) { original.afterPersist?.(stage); if (stage === "ticket") throw Error("injected lost reply"); } });
    };
    try { assert.equal((await f.handoff({ action: "complete-branch", ...a.coordinates })).ok, false); } finally { TicketStore.prototype.applyHandoffWithIntent = apply; }
    const ref = f.git("rev-parse", p.plan.intent.branch), log = f.git("reflog", "show", p.plan.intent.branch);
    assert.equal((await f.checked({ action: "complete-branch", ...a.coordinates })).completion, "verified");
    assert.equal((await f.checked({ action: "complete-branch", ...a.coordinates })).completion, "verified");
    assert.equal(f.git("rev-parse", p.plan.intent.branch), ref); assert.equal(f.git("reflog", "show", p.plan.intent.branch), log);
    await f.checked({ action: "queue", ...a.coordinates });
  } finally { await f.close(); }
});

for (const prefix of ["feature", "feat"]) test(`PAP-314 P3 ${prefix} advanced native reuse refreshes observed develop without changing the original base or descendant head`, async () => {
  const f = fixture(localCapabilities, false, "approved", prefix);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates }); await f.checked({ action: "complete-branch", ...a.coordinates }); await f.checked({ action: "queue", ...a.coordinates });
    const base = p.plan.intent.base.sha, link = new TicketStore().get(p.intake.ticket.id)!.linkedBranches[0]!;
    const head = f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", f.git("write-tree"), "-p", base, "-m", "advanced native descendant");
    f.git("update-ref", `refs/heads/${p.plan.intent.branch}`, head, base);
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "develop B");
    const store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true }); store.update(p.intake.ticket.id, { status: "requirement-review", assignee: "requirements/team-manager" });
    const reuse = await f.checked({ action: "plan", ticket: p.intake.ticket.id, requestId: "advanced-plan", expectedTicketVersion: nativeHandoffTicketVersion(store.get(p.intake.ticket.id)!), branch: p.plan.intent.branch });
    assert.equal(reuse.intent.action, "reuse"); assert.equal(reuse.intent.base.sha, base); assert.notEqual(reuse.intent.base.observedDevelopSha, base); assert.equal(reuse.intent.lineage.observedHeadSha, head);
    const document = await f.freezeDocument(p.intake.ticket.id, p.document.sha, 2);
    const prepared = await f.checked({ action: "prepare-review", documentSubjectSha256: document.sha, planRequestId: "advanced-plan", effects: { publish: true, branchRef: true, queue: true } }); assert.equal(prepared.preflight.status, "eligible");
    const request = await f.checked({ action: "request", subjectSha256: prepared.subjectSha256, expectedRevision: 0 });
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "develop C");
    const stale = await f.checked({ action: "decide", subjectSha256: prepared.subjectSha256, expectedRevision: 0, requestKey: request.requestKey, outcome: "approved" }); assert.equal(stale.oldDevelopSha, reuse.intent.base.observedDevelopSha);
    const refresh = await f.checked({ action: "refresh", subjectSha256: prepared.subjectSha256, expectedRevision: 2, expectedTicketVersion: nativeHandoffTicketVersion(store.get(p.intake.ticket.id)!) });
    assert.equal(refresh.intent.base.sha, base); assert.equal(refresh.intent.lineage.observedHeadSha, head);
    const approved = await approveLocal(f, refresh.subjectSha256);
    await f.checked({ action: "publish", ...approved.coordinates }); await f.checked({ action: "complete-branch", ...approved.coordinates }); await f.checked({ action: "queue", ...approved.coordinates });
    const completed = store.get(p.intake.ticket.id)!; assert.equal(completed.linkedBranches[0]!.baseSha, base); assert.equal(completed.linkedBranches[0]!.headSha, head);
    assert.equal(completed.linkedBranches[0]!.linkedAt, link.linkedAt); assert.equal(completed.linkedBranches[0]!.linkedBy, link.linkedBy); assert.equal(f.git("rev-parse", p.plan.intent.branch), head);
  } finally { await f.close(); }
});

test("PAP-314 P3 preflight retains independent source, target and pending causes and approval rechecks mutable lifecycle", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), request = await f.checked({ action: "request", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    const store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true }); store.update(p.intake.ticket.id, { status: "idea", assignee: "sinh" });
    const blocked = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: p.subjectSha256, expectedRevision: 0, requestKey: request.requestKey, outcome: "approved" }));
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.approval, "not-issued");
    const delivery = join(f.usage, "agent-teams/requirements/artifacts/presentations", p.document.sha, p.prepared.subject.deliverySha256, "members/member-2.html"); writeFileSync(delivery, "tampered output");
    f.git("update-ref", `refs/heads/${p.plan.intent.branch}`, p.plan.intent.base.sha);
    const target = join(f.usage, "agent-teams/requirements/artifacts/packages", p.intake.ticket.id, "native-fixture/r001/requirements.md");
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "conflicting publication target");
    const db = openDurableRegistryDatabase(); try {
      const journal = new RegistryHandoffReviewJournal(db, false), event = journal.events(p.subjectSha256)[0]; if (event.kind !== "requested") throw Error("invalid fixture request");
      // An unrelated retained native intent blocks the new grant, without any
      // effect execution or invented completion record.
      db.prepare("INSERT INTO handoff_review_effects(operation_id,body) VALUES(?,?)").run(journal.effect(p.subjectSha256, event.request.decisionId, "publish").operationId, JSON.stringify({ subjectSha256: p.subjectSha256, decisionId: event.request.decisionId, operation: "publish" }));
      const preflight = await f.checked({ action: "preflight", subjectSha256: p.subjectSha256 });
      for (const cause of ["lifecycle-assignment", "source-delivery-integrity", "publication-target", "branch-target", "pending-native-effects"]) {
        assert.ok(preflight.eligibility.causes.includes(cause), cause);
      }
      assert.equal(journal.events(p.subjectSha256).some(event => event.kind === "issued"), false);
      const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
      assert.equal(status.presentation.status, "unverified"); assert.equal(status.effects[0].publish.state, "partial"); assert.equal(status.approval, "pending");
      const guidance = preflight.guidance; assert.ok(typeof guidance === "string"); assert.ok(guidance.length <= 2000);
      for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(guidance.split(label).length, 2);
    } finally { db.close(); }
  } finally { await f.close(); }
});

test("PAP-314 P3 registered foreground review has no repository lock across UI and catches UI-time drift", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), custom = f.context.ui.custom;
    f.context.ui.custom = factory => {
      withLocalHandoffRepository(p.plan.intent, () => {});
      f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "moved during human reading");
      return custom(factory);
    };
    const stale = await f.checked({ action: "review", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    assert.equal(stale.status, "stale"); assert.equal(stale.approval, "not-issued"); assert.equal(f.prompts(), 1);
    f.context.ui.custom = custom;
    const refreshed = await f.checked({ action: "refresh", subjectSha256: p.subjectSha256, expectedRevision: 2, expectedTicketVersion: nativeHandoffTicketVersion(new TicketStore().get(p.intake.ticket.id)!) });
    const review = { action: "review", subjectSha256: refreshed.subjectSha256, expectedRevision: 0 };
    const approved = await f.checked(review); assert.equal(approved.principal, "local-unverified");
    assert.deepEqual(await f.checked(review), approved); assert.equal(f.prompts(), 2);
    const before = f.prompts(), history = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.deepEqual(history.history.map((event: { kind: string }) => event.kind), ["requested", "stale"]); assert.equal(f.prompts(), before);
  } finally { await f.close(); }
});

test("PAP-314 P3 stopped foreground UI leaves the original v2 request decidable externally without reopening", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), review = { schemaVersion: "pa-handoff-native/v2", action: "review", subjectSha256: p.subjectSha256, expectedRevision: 0 };
    const missing = await f.execute("pa_handoff", review, { ...f.context, ui: undefined }); assert.equal(missing.code, "DOCUMENT_UNAVAILABLE");
    const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 }); assert.equal(status.pendingReview, true);
    const decision = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: p.subjectSha256, expectedRevision: 0, requestKey: status.latestRequest.requestKey, outcome: "approved" }));
    assert.deepEqual(await f.checked(review), decision); assert.equal(f.prompts(), 0);
    await f.checked({ action: "publish", subjectSha256: p.subjectSha256, decisionId: decision.decisionId });
  } finally { await f.close(); }
});

for (const medium of ["cli", "api"] as const) for (const outcome of ["approved", "rejected", "changes-requested", "cancelled"] as const) test(`PAP-316 original ${medium} ${outcome} automatically settles an open Pi review without another input`, async () => {
  const f = fixture(localCapabilities);
  let release: (() => void) | undefined;
  let server: Awaited<ReturnType<typeof startLocalReviewServer>> | undefined;
  let pending: ReturnType<typeof f.handoff> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = await prepareLocal(f);
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    let prompts = 0;
    f.context.ui.custom = factory => new Promise(resolve => {
      prompts++;
      const component = factory({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_c: string, value: string) => value }, {}, resolve);
      component.render(140);
      release = () => component.handleInput("\u001b");
      opened();
    });
    pending = f.handoff({ action: "review", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    await ready;
    const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    const request = { schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: p.subjectSha256,
      expectedRevision: 0, requestKey: status.latestRequest.requestKey, outcome };
    let canonical: Record<string, unknown>;
    if (medium === "cli") {
      const output: string[] = [];
      const exit = await runDocumentCommand(["review", "--request-stdin"], { stdout: text => { output.push(text); }, stderr: () => {} },
        { stdin: Readable.from([Buffer.from(JSON.stringify(request))]) });
      assert.equal(exit, 0); canonical = JSON.parse(output.join(""));
    } else {
      server = await startLocalReviewServer({ port: 0 });
      const address = server.address(); assert.ok(address && typeof address !== "string");
      canonical = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: address.port, method: "POST", path: "/v1/review", headers: { "Content-Type": "application/json" } }, res => {
          let body = ""; res.on("data", chunk => { body += chunk; }); res.once("error", reject);
          res.once("end", () => { try { assert.equal(res.statusCode, 200); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
        });
        req.once("error", reject); req.end(JSON.stringify(request));
      });
    }
    const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Pi remained waiting after canonical external issuance; no second input is allowed")), 1500);
    })]);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.result, canonical);
    assert.equal(prompts, 1);
    const after = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.equal(after.reviewRevision, 2); assert.equal(after.latestDecision.outcome, outcome);
    assert.deepEqual(await f.checked({ action: "review", subjectSha256: p.subjectSha256, expectedRevision: 0 }), canonical);
    assert.equal(prompts, 1); assert.equal(after.effects[0].publish.state, "not-started", "decision is not an effect runner");
  } finally {
    if (timer) clearTimeout(timer);
    release?.(); await pending?.catch(() => {});
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => { server!.close(() => resolve()); }); }
    await f.close();
  }
});

test("PAP-316 first external issuance wins a conflicting foreground input without false failure", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f);
    let canonical: Record<string, unknown> | undefined;
    f.context.ui.custom = factory => new Promise(resolve => {
      const component = factory({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_c: string, value: string) => value }, {}, resolve);
      void (async () => {
        const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
        canonical = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: p.subjectSha256,
          expectedRevision: 0, requestKey: status.latestRequest.requestKey, outcome: "approved" }));
        component.handleInput("\u001b[A"); component.handleInput("\r"); // Reject loses to saved approval.
      })();
    });
    const result = await f.checked({ action: "review", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    assert.deepEqual(result, canonical);
    assert.equal((await f.checked({ action: "status", subjectSha256: p.subjectSha256 })).reviewRevision, 2);
  } finally { await f.close(); }
});

test("PAP-316 client abort detaches without recording shared Cancel and original request remains decidable", async () => {
  const f = fixture(localCapabilities), controller = new AbortController();
  try {
    const p = await prepareLocal(f);
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    f.context.ui.custom = factory => new Promise(resolve => {
      factory({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_c: string, value: string) => value }, {}, resolve);
      opened();
    });
    const pending = f.tools.get("pa_handoff")!.execute("detach", { request: JSON.stringify({ schemaVersion: "pa-handoff-native/v2", action: "review", subjectSha256: p.subjectSha256, expectedRevision: 0 }) }, controller.signal, undefined, f.context);
    await ready; controller.abort(); await pending;
    const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.equal(status.pendingReview, true); assert.equal(status.reviewRevision, 1); assert.equal(status.latestDecision, null);
    const canonical = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: p.subjectSha256,
      expectedRevision: 0, requestKey: status.latestRequest.requestKey, outcome: "approved" }));
    assert.equal(canonical.outcome, "approved");
  } finally { await f.close(); }
});

// Permanent counterparts of the seven independent P3 review probes. These use
// the registered tool and real disposable owners, not substituted admissions.
function retainUncertain(f: ReturnType<typeof fixture>, ticket: string) {
  withPreparedTicketCapacity({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo }, tx => {
    const result = tx.reserve({ ticket, operationId: "1".repeat(64), reservationId: "2".repeat(64), retainedAt: new Date().toISOString() });
    if (result.status !== "reserved") throw Error("fixture has no capacity");
    tx.update(result.reservation, { ...result.reservation, occupancy: "uncertain-retained", custody: { state: "uncertain-blocked", holder: null, inFlightOperation: null } });
  });
  const path = preparedRepositoryTicketReservationPath(f.repo, ticket);
  return { path, bytes: readFileSync(path) };
}
function branchEvidence(f: ReturnType<typeof fixture>, subjectSha256: string, decisionId: string) {
  const db = openDurableRegistryDatabase();
  try {
    const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    return { refs: f.git("for-each-ref", "refs/heads/feature"),
      events: exists("handoff_branch_events") ? new RegistryHandoffBranchJournal(db, false).events(handoffBranchOperationId(subjectSha256, decisionId)) : [],
      gitIntents: exists("handoff_git_intents") ? db.prepare("SELECT * FROM handoff_git_intents ORDER BY operation_id").all() : [],
      gitSources: exists("handoff_git_creation_sources") ? db.prepare("SELECT * FROM handoff_git_creation_sources ORDER BY operation_id").all() : [] };
  } finally { db.close(); }
}

test("P3 R2 probe: lifecycle drift rejects before ref, reflog or native effect history", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates });
    const store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true });
    store.update(p.intake.ticket.id, { status: "implementing", assignee: "builder/team-manager" });
    const before = branchEvidence(f, p.subjectSha256, a.decision.decisionId);
    assert.equal((await f.handoff({ action: "complete-branch", ...a.coordinates })).ok, false);
    assert.deepEqual(branchEvidence(f, p.subjectSha256, a.decision.decisionId), before, "reject before any native branch effect");
    assert.throws(() => readFileSync(join(f.repo, ".git/logs/refs/heads", p.plan.intent.branch)), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("P3 R2 probe: replaced planned attribution rejects before ref, reflog or native effect history", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates });
    const store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true });
    store.update(p.intake.ticket.id, { remove_linked_branch: `example:${p.plan.intent.branch}` }, "foreign-owner");
    store.update(p.intake.ticket.id, { add_linked_branch: { repo: "example", branch: p.plan.intent.branch } }, "foreign-owner");
    const before = branchEvidence(f, p.subjectSha256, a.decision.decisionId);
    assert.equal((await f.handoff({ action: "complete-branch", ...a.coordinates })).ok, false);
    assert.deepEqual(branchEvidence(f, p.subjectSha256, a.decision.decisionId), before, "reject foreign original plan before any native branch effect");
    assert.throws(() => readFileSync(join(f.repo, ".git/logs/refs/heads", p.plan.intent.branch)), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("P3 R4 probe: queue write, reply loss, revocation then original observational settlement", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates }); await f.checked({ action: "complete-branch", ...a.coordinates });
    const complete = RegistryHandoffReviewJournal.prototype.completeEffect;
    RegistryHandoffReviewJournal.prototype.completeEffect = function (...args) {
      if (args[2] === "queue") throw Error("interrupted after real queue write");
      return complete.apply(this, args);
    };
    try { assert.equal((await f.handoff({ action: "queue", ...a.coordinates })).ok, false); }
    finally { RegistryHandoffReviewJournal.prototype.completeEffect = complete; }
    assert.equal(new TicketStore().get(p.intake.ticket.id)!.status, "pending-implementation");
    const rev = await f.checked({ action: "revoke", subjectSha256: p.subjectSha256, expectedRevision: 2, decisionId: a.decision.decisionId });
    await f.checked({ action: "decide", subjectSha256: p.subjectSha256, expectedRevision: 2, requestKey: rev.requestKey, outcome: "approved" });
    const ticket = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), audit = readFileSync(join(f.usage, "tickets/audit.jsonl"));
    const before = branchEvidence(f, p.subjectSha256, a.decision.decisionId), reflog = f.git("reflog", "show", p.plan.intent.branch);
    assert.equal((await f.handoff({ action: "queue", ...a.coordinates })).ok, true, "settle only the already-applied original operation");
    const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.equal(status.effects[0].queue.state, "verified"); assert.equal(status.revoked, true);
    assert.equal((await f.checked({ action: "queue", ...a.coordinates })).queue, "verified");
    assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), ticket);
    assert.deepEqual(readFileSync(join(f.usage, "tickets/audit.jsonl")), audit);
    assert.deepEqual(branchEvidence(f, p.subjectSha256, a.decision.decisionId), before); assert.equal(f.git("reflog", "show", p.plan.intent.branch), reflog);
  } finally { await f.close(); }
});

for (const fresh of [false, true]) test(`P3 R1 probe: ${fresh ? "fresh" : "origin"} caller cannot cross same-ticket retained uncertain custody`, async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates });
    const caller = fresh ? await f.continueInFreshSession(p.intake.ticket.id) : f;
    const retained = retainUncertain(f, p.intake.ticket.id), ticket = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`));
    assert.throws(() => withLocalHandoffRepository(p.plan.intent, () => {}));
    const branch = await caller.handoff({ action: "complete-branch", ...a.coordinates });
    const queue = await caller.handoff({ action: "queue", ...a.coordinates });
    assert.equal(branch.ok, false, "uncertain custody must fence ref/link"); assert.equal(queue.ok, false, "uncertain custody must fence queue");
    assert.equal(f.git("for-each-ref", "refs/heads/feature"), "");
    assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), ticket);
    assert.deepEqual(readFileSync(retained.path), retained.bytes);
  } finally { await f.close(); }
});

test("P3 R3 probe: queue rejects replaced materialized link attribution", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates }); await f.checked({ action: "complete-branch", ...a.coordinates });
    const store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true });
    store.update(p.intake.ticket.id, { remove_linked_branch: `example:${p.plan.intent.branch}` }, "foreign-owner");
    store.update(p.intake.ticket.id, { add_linked_branch: { repo: "example", branch: p.plan.intent.branch } }, "foreign-owner");
    assert.equal(store.get(p.intake.ticket.id)!.linkedBranches[0]!.linkedBy, "foreign-owner");
    const before = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`));
    assert.equal((await f.handoff({ action: "queue", ...a.coordinates })).ok, false, "do not adopt matching SHAs with foreign attribution");
    const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 });
    assert.equal(status.effects[0].branchRef.state, "conflict-or-unknown");
    assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), before);
  } finally { await f.close(); }
});

test("P3 R1 probe: foreign uncertain reservation fences approval and publication", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), request = await f.checked({ action: "request", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    const retained = retainUncertain(f, "EX-999");
    const decision = await executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "decide", subjectSha256: p.subjectSha256, expectedRevision: 0, requestKey: request.requestKey, outcome: "approved" }));
    const publication = decision.decisionId ? await f.handoff({ action: "publish", subjectSha256: p.subjectSha256, decisionId: decision.decisionId }) : null;
    assert.notEqual(decision.outcome, "approved", "foreign uncertain repository custody must block the grant");
    assert.equal(publication?.ok ?? false, false); assert.equal(new TicketStore().get(p.intake.ticket.id)!.doc_refs.length, 0);
    assert.deepEqual(readFileSync(retained.path), retained.bytes);
  } finally { await f.close(); }
});

for (const fresh of [false, true]) test(`P3 R1 foreign custody fences remaining publication and queue writes for ${fresh ? "fresh" : "origin"} caller`, async () => {
  for (const action of ["publish", "queue"]) {
    const f = fixture(localCapabilities);
    try {
      const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
      if (action === "queue") { await f.checked({ action: "publish", ...a.coordinates }); await f.checked({ action: "complete-branch", ...a.coordinates }); }
      const caller = fresh ? await f.continueInFreshSession(p.intake.ticket.id) : f;
      const retained = retainUncertain(f, "EX-999"), before = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`));
      assert.equal((await caller.handoff({ action, ...a.coordinates })).ok, false);
      assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), before);
      assert.deepEqual(readFileSync(retained.path), retained.bytes);
    } finally { await f.close(); }
  }
});

test("P3 R2 unsettled unrelated ticket intent fences ref and native effect history", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates });
    const store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true }), ticket = store.get(p.intake.ticket.id)!;
    assert.throws(() => store.setStatusWithIntent(ticket.id, nativeHandoffTicketVersion(ticket), ticket.status, "fixture-owner", { scope: p.subjectSha256, requestId: "unsettled-status" }, {
      assertCurrent() {}, afterPersist(stage) { if (stage === "intent") throw Error("unsettled supported status intent"); },
    }), /unsettled supported status intent/);
    assert.throws(() => store.assertHandoffSettled(ticket.id), /TICKET_HANDOFF_UNCERTAIN/, "prove the negative fixture actually persisted an unsettled intent");
    const before = branchEvidence(f, p.subjectSha256, a.decision.decisionId);
    assert.equal((await f.handoff({ action: "complete-branch", ...a.coordinates })).ok, false);
    assert.deepEqual(branchEvidence(f, p.subjectSha256, a.decision.decisionId), before);
  } finally { await f.close(); }
});

test("P3 R3 replacement after native link but before branch completion cannot be adopted", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates });
    const append = RegistryHandoffBranchJournal.prototype.append;
    RegistryHandoffBranchJournal.prototype.append = function (...args) {
      if (args[3] === "linked") throw Error("reply lost after native link/audit");
      return append.apply(this, args);
    };
    try { assert.equal((await f.handoff({ action: "complete-branch", ...a.coordinates })).ok, false); }
    finally { RegistryHandoffBranchJournal.prototype.append = append; }
    const store = new TicketStore(undefined, { team: "requirements", mode: "analyze", privileged: true });
    assert.equal(store.get(p.intake.ticket.id)!.linkedBranches[0]!.state, "materialized");
    store.update(p.intake.ticket.id, { remove_linked_branch: `example:${p.plan.intent.branch}` }, "foreign-owner");
    store.update(p.intake.ticket.id, { add_linked_branch: { repo: "example", branch: p.plan.intent.branch } }, "foreign-owner");
    const before = branchEvidence(f, p.subjectSha256, a.decision.decisionId), ticket = store.get(p.intake.ticket.id), log = f.git("reflog", "show", p.plan.intent.branch);
    for (const action of ["complete-branch", "queue"]) assert.equal((await f.handoff({ action, ...a.coordinates })).ok, false);
    assert.deepEqual(branchEvidence(f, p.subjectSha256, a.decision.decisionId), before);
    assert.deepEqual(store.get(p.intake.ticket.id), ticket); assert.equal(f.git("reflog", "show", p.plan.intent.branch), log);
  } finally { await f.close(); }
});

test("P3 R4 revoked started queue with missing external write stays fenced", async () => {
  const f = fixture(localCapabilities);
  try {
    const p = await prepareLocal(f), a = await approveLocal(f, p.subjectSha256);
    await f.checked({ action: "publish", ...a.coordinates }); await f.checked({ action: "complete-branch", ...a.coordinates });
    const update = TicketStore.prototype.update;
    TicketStore.prototype.update = function (...args) {
      if (args[1].status === "pending-implementation") throw Error("interrupted before queue write");
      return update.apply(this, args);
    };
    try { assert.equal((await f.handoff({ action: "queue", ...a.coordinates })).ok, false); }
    finally { TicketStore.prototype.update = update; }
    const rev = await f.checked({ action: "revoke", subjectSha256: p.subjectSha256, expectedRevision: 2, decisionId: a.decision.decisionId });
    await f.checked({ action: "decide", subjectSha256: p.subjectSha256, expectedRevision: 2, requestKey: rev.requestKey, outcome: "approved" });
    const before = readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`));
    assert.equal((await f.handoff({ action: "queue", ...a.coordinates })).ok, false);
    assert.deepEqual(readFileSync(join(f.usage, "tickets", `${p.intake.ticket.id}.json`)), before);
    const status = await f.checked({ action: "status", subjectSha256: p.subjectSha256 }); assert.equal(status.effects[0].queue.state, "partial");
  } finally { await f.close(); }
});

test("P3 R4 retained v1 queue reply-loss recovery still requires live approval", async () => {
  const f = fixture();
  try {
    const p = await prepareLocal(f), decision = await f.checked({ action: "review", subjectSha256: p.subjectSha256, expectedRevision: 0 });
    const coordinates = { subjectSha256: p.subjectSha256, decisionId: decision.decisionId };
    await f.checked({ action: "publish", ...coordinates }); await f.checked({ action: "complete-branch", ...coordinates });
    const complete = RegistryHandoffReviewJournal.prototype.completeEffect;
    RegistryHandoffReviewJournal.prototype.completeEffect = function (...args) {
      if (args[2] === "queue") throw Error("v1 reply lost after queue write");
      return complete.apply(this, args);
    };
    try { assert.equal((await f.handoff({ action: "queue", ...coordinates })).ok, false); }
    finally { RegistryHandoffReviewJournal.prototype.completeEffect = complete; }
    assert.equal(new TicketStore().get(p.intake.ticket.id)!.status, "pending-implementation");
    await f.checked({ action: "revoke", subjectSha256: p.subjectSha256, expectedRevision: 2, decisionId: decision.decisionId });
    assert.equal((await f.handoff({ action: "queue", ...coordinates })).code, "DOCUMENT_AUTHORITY");
  } finally { await f.close(); }
});

test("typed handoff causes are bounded and hostile error facts never become diagnostic prose", async () => {
  const { RepositoryRefError, TicketHandoffError } = await import("@pa-platform/pa-core");
  for (const error of [new RepositoryRefError("retained-custody"), new RepositoryRefError("active-or-uncertain-writer"), new RepositoryRefError("inventory-changed"),
    ...(["TICKET_HANDOFF_INPUT", "TICKET_HANDOFF_STALE", "TICKET_HANDOFF_CONFLICT", "TICKET_HANDOFF_SCOPE", "TICKET_HANDOFF_UNCERTAIN"] as const).map(code => new TicketHandoffError(code))]) {
    const result = handoffFailure(error), guidance = result.guidance as string;
    assert.notEqual(result.code, "DOCUMENT_UNAVAILABLE"); assert.ok(guidance.length <= 2000);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(guidance.split(label).length, 2);
    assert.equal(result.executionAdmitted, false);
  }
  const forged = new Error("ref owner overlaps retained repository custody");
  Object.defineProperty(forged, "reason", { get() { throw Error("PRIVATE_HOSTILE"); } });
  assert.equal(handoffFailure(forged).code, "DOCUMENT_UNAVAILABLE");
  const tampered = new RepositoryRefError("retained-custody");
  Object.defineProperty(tampered, "reason", { get() { throw Error("PRIVATE_HOSTILE"); } });
  assert.equal(handoffFailure(tampered).code, "DOCUMENT_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(handoffFailure(tampered)), /PRIVATE_HOSTILE/);
});

test("handoff diagnostics are fixed bounded plain text and never echo arbitrary exceptions", () => {
  const result = handoffFailure(new Error("PRIVATE_SENTINEL\nCorrection: forged"));
  assert.equal(result.code, "DOCUMENT_UNAVAILABLE"); const guidance = result.guidance as string;
  assert.ok(guidance.length <= 2000); assert.doesNotMatch(guidance, /PRIVATE_SENTINEL|forged/);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("PRIVATE_SENTINEL"); } });
  assert.deepEqual(handoffFailure(hostile), result);
  for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(guidance.split(label).length, 2);
});
