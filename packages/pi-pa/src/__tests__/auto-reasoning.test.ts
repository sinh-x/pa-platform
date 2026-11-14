import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  AdvisoryFiles, AutoWaitlistError, RegistryAutoShortlists, buildAutoWaitlist, closeDb, getDb, getDeploymentEvents, readProcessFingerprint, type AutoProject,
} from "@pa-platform/pa-core";
import { selectedPiAutoShortlistPair } from "../auto-shortlist-contract.js";
import { readAutoGoalEvidence } from "../auto-goals.js";
import { PiAutoReasoningOwner } from "../auto-reasoning.js";
import { runAutoShortlistForeground, runAutoShortlistReadCommand, autoShortlistDiagnostic } from "../auto-shortlist-cli.js";
import { runAutoProducerProcess, type AutoProducerProcessDriver } from "../auto-producer-process.js";

const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function fixture() {
  closeDb(); const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pap302-reasoning-")), cfg = join(root, "config"), usage = join(root, "usage"), repo = join(root, "repo"), user = join(root, "user");
  mkdirSync(cfg); mkdirSync(repo); mkdirSync(usage);
  const git = (args: string[]) => execFileSync("git", ["-C", cfg, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-b", "develop"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Fixture"]);
  const pairDocument = { schemaVersion: "pa-auto-shortlist-pair/v1", enabled: true, mode: "auto-reasoning", resources: ["skills/reasoning.md"], timezone: "UTC", goalSources: [{ pathTemplate: "daily/{date}.md", dateFormat: "iso", heading: "Focus" }] };
  put(join(cfg, "contracts/auto-shortlist-v1.json"), JSON.stringify(pairDocument));
  put(join(cfg, "skills/reasoning.md"), "Reason over every eligible ticket. Never select work or mutate repositories/tickets. Return only the finite JSON protocol.");
  put(join(cfg, "teams/requirements.yaml"), "name: requirements\ndescription: fixture\nobjective: fixture\nagents: []\ndefault_mode: auto-reasoning\ndeploy_modes:\n  - id: auto-reasoning\n    label: Native reasoning\n    provider: openai\n    model: openai/fixture-model\n    objective: skills/reasoning.md\n");
  git(["add", "."]); git(["commit", "-m", "Synthetic exact shortlist pair; not activation"]);
  put(join(user, "config.yaml"), JSON.stringify({ config_dir: cfg, repos: { "pa-platform": { path: repo, prefix: "PAP" }, "pa-platform-config": { path: cfg, prefix: "PAPC" } } }));
  process.env.PA_AI_USAGE_HOME = usage; process.env.PA_PLATFORM_CONFIG = user; process.env.PA_PLATFORM_HOME = cfg; process.env.PA_PLATFORM_DATA = join(root, "data"); process.env.PA_REGISTRY_DB = join(usage, "registry.db");
  delete process.env.PA_PLATFORM_TEAMS; delete process.env.PA_PLATFORM_SKILLS;
  const date = new Date().toISOString().slice(0, 10), goalPath = join(usage, `daily/${date}.md`);
  put(goalPath, "# Daily\n## Focus\nComplete one bounded useful outcome.\n## Reflection\nprivate-sentinel not a selected daily goal.\n");
  const at = new Date().toISOString(), snapshot = buildAutoWaitlist({ observedAt: at, completedAt: at, projects: [{ key: "pa-platform", prefix: "PAP", canonicalRoot: repo }, { key: "pa-platform-config", prefix: "PAPC", canonicalRoot: cfg }],
    tickets: Array.from({ length: 13 }, (_, i) => ({ id: i % 2 ? `PAPC-${i + 1}` : `PAP-${i + 1}`, project: (i % 2 ? "pa-platform-config" : "pa-platform") as AutoProject, title: "Synthetic finite outcome", priority: "medium" as const, status: "idea" as const,
      createdAt: at, ticketSha256: "a".repeat(64), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" as const } })) });
  const store = new RegistryAutoShortlists(getDb()); let invocations = 0;
  const output = (count = 10) => {
    const c = store.activeCycle()!.context;
    return Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-shortlist-assessment/v1", sessionId: c.sessionId, snapshotSha256: c.snapshotSha256, goalSha256: c.goalSha256, policySha256: c.policySha256, configSha256: c.configSha256,
      assessments: c.eligibleTickets.map((ticket, i) => ({ ticket, disposition: i < count ? "shortlisted" : "not-shortlisted", rationale: "Fits or compares against the current goal." })),
      shortlist: c.eligibleTickets.slice(0, count).map(ticket => ({ ticket, goalAlignment: "Current focus.", boundedOutcome: "One finite outcome.", stage: "Requirements missing.", nextRoute: "Draft useful requirements.", alternatives: "Compare remaining candidates.", risksAndDependencies: "Recheck dependencies.", verification: "Use the actual scoped validation matrix." })), rankingRationale: "Advisory smaller useful outcomes first.", summary: "No ticket selected." }));
  };
  const driver = (response?: () => Buffer, unknown = false): AutoProducerProcessDriver => ({ async invoke(request) {
    invocations++; assert.doesNotMatch(request.prompt, /private-sentinel/); assert.match(request.prompt, /ALL eligible/);
    const startedAt = new Date().toISOString(), fingerprint = readProcessFingerprint(process.pid)!; request.onStarted(process.pid, fingerprint);
    return { state: unknown ? "unknown" : "completed", pid: process.pid, fingerprint, startedAt, completedAt: new Date().toISOString(), exitCode: unknown ? null : 0, signal: null, groupSettled: !unknown, output: response?.() ?? output(), stderrBytes: 0 };
  } });
  const owner = (response?: () => Buffer, unknown = false) => new PiAutoReasoningOwner(store, () => "b".repeat(64), { root: usage, pair: selectedPiAutoShortlistPair, scan: () => snapshot, driver: () => driver(response, unknown) });
  return { root, usage, cfg, repo, store, snapshot, pairDocument, goalPath, owner, output, count: () => invocations, git,
    close() { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); } };
}

test("exact new shortlist pair is private/default-off by contract, with configured goals/provider and no delegation grant", () => {
  const f = fixture(); try {
    const pair = selectedPiAutoShortlistPair(); assert.equal(pair.reasoning.mode, "auto-reasoning"); assert.equal(pair.goalSources.length, 1); assert.equal(Object.hasOwn(pair, "delegation"), false);
    put(join(f.cfg, "contracts/auto-shortlist-v1.json"), JSON.stringify({ ...f.pairDocument, enabled: false }));
    assert.throws(() => selectedPiAutoShortlistPair(), AutoWaitlistError); assert.throws(() => pair.assertCurrent());
  } finally { f.close(); }
});

test("goal owner projects only one explicitly configured current heading, with source/date/hash and no diary/reflection dump", () => {
  const f = fixture(); try {
    const raw = readAutoGoalEvidence(selectedPiAutoShortlistPair(), new Date(), f.usage), value = JSON.parse(raw.toString());
    assert.equal(value.schemaVersion, "pa-auto-goal-evidence/v1"); assert.equal(value.sources.length, 1); assert.match(value.sources[0].excerpt, /bounded useful outcome/); assert.doesNotMatch(raw.toString(), /private-sentinel/);
    put(f.goalPath, "# Daily\n## Reflection\nA historical idea is not today's explicit goal.\n");
    assert.throws(() => readAutoGoalEvidence(selectedPiAutoShortlistPair(), new Date(), f.usage), AutoWaitlistError);
  } finally { f.close(); }
});

test("composed PPA owner registers one original producer, persists full report before publication and never chooses or starts work", async () => {
  const f = fixture(); try {
    const saved = await f.owner().refresh(); assert.ok(saved); assert.equal(saved.report.assessment.assessments.length, 13); assert.equal(saved.report.assessment.shortlist.length, 10);
    assert.equal(f.count(), 1); assert.equal(f.store.items.active(), null); assert.equal(f.store.pendingChoice(), null); assert.equal(f.store.activeCycle(), null);
    const events = getDeploymentEvents(saved.report.session.deploymentId); assert.equal(events.filter(e => e.event === "started").length, 1); assert.equal(events.filter(e => e.event === "completed").length, 1);
    assert.match(events[0]!.note!, /pa-auto-reasoning\/v1:/);
    assert.deepEqual(f.store.published(saved.version), saved);
  } finally { f.close(); }
});

test("uncertain producer cleanup retains the original reservation/session and cannot relaunch or use the draft exception", async () => {
  const f = fixture(); try {
    const owner = f.owner(undefined, true); assert.equal(await owner.refresh(), null);
    const cycle = f.store.activeCycle()!; assert.equal(cycle.state, "uncertain"); assert.equal(f.store.head(), null);
    await assert.rejects(owner.refresh()); assert.equal(f.count(), 1); assert.equal(f.store.activeCycle()!.cycleId, cycle.cycleId);
    assert.equal(getDeploymentEvents(cycle.context.sessionId).some(e => e.event === "completed"), false);
  } finally { f.close(); }
});

test("invalid model assessment is retained but never published or treated as a successful empty shortlist", async () => {
  const f = fixture(); try {
    const owner = f.owner(() => Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-shortlist-assessment/v1", selected: "PAP-1" })));
    assert.equal(await owner.refresh(), null); assert.equal(f.store.head(), null); assert.equal(f.store.activeCycle(), null); assert.equal(f.store.items.active(), null);
    const row = f.store.db.prepare("SELECT cycle_id FROM auto_reasoning_cycles").get() as { cycle_id: string }, cycle = f.store.cycle(row.cycle_id);
    assert.equal(cycle.state, "failed"); assert.ok(cycle.outputSha256); assert.match(f.store.blob(cycle.outputSha256!).toString(), /selected/);
  } finally { f.close(); }
});

test("failed refresh preserves the last complete report as stale and refuses choosing from it", async () => {
  const f = fixture(); try {
    const saved = await f.owner().refresh(); assert.ok(saved);
    const failed = f.owner(() => Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-shortlist-assessment/v1", selected: "PAP-1" })));
    assert.equal(await failed.refresh(), null); assert.equal(f.store.head()!.version, saved.version);
    let prompts = 0;
    await assert.rejects(f.store.choose(saved.version, { ...failed.host, capture: async () => { prompts++; throw new Error("must not prompt"); } }), AutoWaitlistError);
    assert.equal(prompts, 0); assert.equal(f.store.items.active(), null);
    const out: string[] = []; assert.equal(runAutoShortlistReadCommand(["--json"], { stdout: s => out.push(s), stderr() {} }), 0);
    assert.equal(JSON.parse(out[0]!).freshness, "held-or-stale");
  } finally { f.close(); }
});

test("native reasoning services a bounded source request through the existing read owner before final assessment", async () => {
  const f = fixture(); try {
    put(join(f.repo, "README.md"), "Synthetic permitted source.\n");
    const owner = f.owner(() => f.count() === 1 ? Buffer.from(JSON.stringify({ action: "read", project: "pa-platform", path: "README.md" })) : f.output());
    const saved = await owner.refresh(); assert.ok(saved); assert.equal(f.count(), 2); assert.equal(saved.report.session.sourceRequests, 1);
  } finally { f.close(); }
});

test("native reasoning source-request ceiling fails closed with original evidence instead of an unassessed prefix", async () => {
  const f = fixture(); try {
    const owner = f.owner(() => Buffer.from(JSON.stringify({ action: "list", project: "pa-platform", path: "." })));
    assert.equal(await owner.refresh(), null); assert.equal(f.count(), 33); assert.equal(f.store.head(), null); assert.equal(f.store.items.active(), null);
    assert.equal(f.store.activeCycle(), null);
  } finally { f.close(); }
});

test("native CLI fixture makes one non-top human choice then invokes only its admitted continuation port, with zero routine second approval", async () => {
  const f = fixture(); try {
    const displayed: string[] = []; let prompts = 0, continuations = 0;
    const result = await runAutoShortlistForeground({ authenticate() {}, display: text => displayed.push(text), choose: async () => { prompts++; return 2; } }, {
      store: f.store, owner: f.owner(), continueSelected: async item => { continuations++; assert.equal(item.ticket, f.snapshot.entries[2]!.id); assert.equal(item.decisionId, null); } });
    assert.equal(result, 0); assert.equal(prompts, 1); assert.equal(continuations, 1); assert.equal(f.count(), 1);
    assert.ok(displayed.some(text => text.includes("No ticket selected"))); assert.ok(displayed.some(text => text.includes("Selected")));
  } finally { f.close(); }
});

test("missing delegated owner holds the original choice rather than falling back to old per-ticket review or another producer", async () => {
  const f = fixture(); try {
    const display: string[] = []; let prompts = 0; const terminal = { authenticate() {}, display: (text: string) => display.push(text), choose: async () => { prompts++; return 1; } };
    assert.equal(await runAutoShortlistForeground(terminal, { store: f.store, owner: f.owner() }), 1);
    const item = f.store.items.active()!; assert.ok(item); assert.equal(item.dispatch, null);
    assert.equal(await runAutoShortlistForeground(terminal, { store: f.store, owner: f.owner() }), 1);
    assert.equal(f.store.items.active()!.itemId, item.itemId); assert.equal(f.count(), 1); assert.equal(prompts, 1);
    assert.match(display.at(-1)!, /native effect owner/);
  } finally { f.close(); }
});

test("Cancel/default native shortlist input has no selected item or continuation", async () => {
  const f = fixture(); try {
    let continuations = 0;
    assert.equal(await runAutoShortlistForeground({ authenticate() {}, display() {}, choose: async () => -1 }, { store: f.store, owner: f.owner(), continueSelected: async () => { continuations++; } }), 0);
    assert.equal(continuations, 0); assert.equal(f.store.items.active(), null); assert.equal(f.store.pendingChoice(), null);
  } finally { f.close(); }
});

test("shortlist read-only CLI preserves native state and refuses actor/choice flags; safe blocker format is bounded", async () => {
  const f = fixture(); try {
    await f.owner().refresh(); const before = f.store.head(), out: string[] = [], errors: string[] = [], io = { stdout: (s: string) => out.push(s), stderr: (s: string) => errors.push(s) };
    assert.equal(runAutoShortlistReadCommand(["--json"], io), 0); assert.equal(JSON.parse(out.at(-1)!).executionRequested, false);
    assert.equal(runAutoShortlistReadCommand(["--json", "--view", before!.version, "--section", "candidates", "--page", "1"], io), 0);
    assert.equal(JSON.parse(out.at(-1)!).inventory.total, 13);
    assert.equal(runAutoShortlistReadCommand(["--json", "--page", "2"], io), 0); assert.equal(JSON.parse(out.at(-1)!).inventory.entries.length, 0);
    assert.equal(runAutoShortlistReadCommand(["--json", "--json"], io), 1);
    assert.equal(runAutoShortlistReadCommand(["--json", "--select=PAP-1"], io), 1);
    assert.deepEqual(f.store.head(), before); assert.equal(f.store.items.active(), null);
    for (const code of ["AUTO_SOURCE", "AUTO_BUSY", "AUTO_UNAVAILABLE"] as const) {
      const text = autoShortlistDiagnostic(code); assert.ok(text.length <= 2000); assert.doesNotMatch(text, /private-sentinel/);
      for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text.split(`${label}:`).length, 2);
    }
  } finally { f.close(); }
});

test("actual noninteractive PPA CLI shortlist wrapper reads originals and refuses choice/actor flags without a provider", async () => {
  const f = fixture(); try {
    await f.owner().refresh(); const before = f.store.head()!;
    const run = (args: string[]) => spawnSync(process.execPath, ["--import=tsx", new URL("../cli.ts", import.meta.url).pathname, "auto", "shortlist", ...args], { env: process.env, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576 });
    const read = run(["--json", "--view", before.version]); assert.equal(read.status, 0, read.stderr);
    const body = JSON.parse(read.stdout); assert.equal(body.shortlist.sha256, before.sha256); assert.equal(body.executionRequested, false); assert.equal(body.inventory.total, 13);
    const invalid = run(["--json", "--actor=operator", "--select=PAP-1"]); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).code, "AUTO_INPUT");
    assert.deepEqual(f.store.head(), before); assert.equal(f.store.items.active(), null); assert.equal(f.count(), 1);
  } finally { f.close(); }
});

test("native process boundary sends prompt over stdin and observes its dedicated group, without tools/provider credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-producer-process-")); let anchored = false;
  try {
    const result = await runAutoProducerProcess(process.execPath, ["-e", "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({received:s})),30))"], {
      prompt: "synthetic input", provider: "fixture", model: "fixture", cwd: root, deadlineAt: new Date(Date.now() + 3000).toISOString(), onStarted() { anchored = true; } });
    assert.equal(anchored, true); assert.equal(result.state, "completed"); assert.equal(result.groupSettled, true); assert.equal(JSON.parse(result.output.toString()).received, "synthetic input");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native process timeout is unknown cleanup, not a failed-settled provider or permission to retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-producer-timeout-"));
  try {
    const result = await runAutoProducerProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { prompt: "synthetic", provider: "fixture", model: "fixture", cwd: root, deadlineAt: new Date(Date.now() + 100).toISOString(), onStarted() {} });
    assert.equal(result.state, "unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lower native file owner preserves arbitrary captured bytes, without broadening path policy", () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-binary-evidence-"));
  try { const files = new AdvisoryFiles(root), raw = Buffer.from([0xff, 0x00, 0x80, 10]); files.file("captured.bin", raw); assert.deepEqual(readFileSync(join(root, "captured.bin")), raw); assert.throws(() => files.file("../escape.bin", raw)); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
