import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { planNativeHandoffTicket, type NativeHandoffPlanningHost } from "../documents/handoff-planning.js";
import { HANDOFF_SESSION_VERSION } from "../documents/handoff-intake.js";
import { appendRegistryEvent, closeDb, getDb } from "../registry/index.js";
import { creationDigest } from "../tickets/create-intent.js";
import { TicketStore } from "../tickets/store.js";
import { REPOSITORY_MUTATION_LEASE_FILE } from "../deploy/repository-admission.js";

// Synthetic native host/selection; these real Git/store tests are NOT genuine
// foreground capture, installed selection, independent review or human UAT.
for (const key of Object.keys(process.env)) if (key.startsWith("PA_") && key !== "PA_SQLITE_NATIVE_BINDING") delete process.env[key];
function fixture(note = HANDOFF_SESSION_VERSION) {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "handoff-planning-")), repo = join(root, "repo"), config = join(root, "config");
  mkdirSync(repo); mkdirSync(config); mkdirSync(join(root, "usage", "tickets"), { recursive: true });
  writeFileSync(join(config, "config.yaml"), `repos:\n  example:\n    path: ${repo}\n    prefix: EX\n`);
  process.env.PA_AI_USAGE_HOME = join(root, "usage"); process.env.PA_PLATFORM_CONFIG = config; process.env.PA_REGISTRY_DB = join(root, "registry.db");
  closeDb(); getDb();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  git("init", "-b", "develop"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD"), dir = join(root, "usage", "tickets"), store = new TicketStore();
  writeFileSync(join(dir, "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Supplied ticket", status: "idea", assignee: "sinh", doc_refs: [], comments: [], createdAt: "2026-11-15T06:00:00.000Z", updatedAt: "2026-11-15T06:00:00.000Z" }));
  const start = { deployment_id: "d-abcdef", event: "started" as const, team: "requirements", mode: "analyze", runtime: "pi" as const, binary: "ppa" as const,
    timestamp: "2026-11-15T06:00:00.000Z", repo_root: repo, repo, worktree_root: repo, note, ticket_id: "EX-1" };
  appendRegistryEvent(start);
  const caller = { deploymentId: "d-abcdef", sessionId: "synthetic-session", repoKey: "example", repoRoot: repo, selectionSha256: "a".repeat(64), identitySha256: "b".repeat(64), ticket: "EX-1" };
  const host: NativeHandoffPlanningHost = { authenticate: () => structuredClone(caller), assertAvailable() {} };
  const request = { schemaVersion: "pa-handoff-request/v1", action: "plan", ticket: "EX-1", requestId: "original", branch: "feature/EX-1-handoff", expectedTicketVersion: creationDigest(store.get("EX-1")) };
  const run = (value = request) => planNativeHandoffTicket(store, host, JSON.stringify(value));
  const advance = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "develop moved");
  return { root, repo, config, dir, store, git, base, host, caller, start, request, run, advance,
    plans: () => readdirSync(dir).filter(name => name.startsWith(".ticket-handoff-")),
    close() { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); } };
}

test("actual registered observer pins develop and persists/rereads one SHA-free planned link, with no ref/resource effect", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "staged.bin"), Buffer.from([0, 255, 1])); f.git("add", "staged.bin");
    writeFileSync(join(f.repo, "untracked.txt"), "unrelated work");
    const status = f.git("status", "--porcelain=v2", "--untracked-files=all"), head = f.git("rev-parse", "HEAD");
    const result = f.run(), link = result.ticket.linkedBranches[0]!;
    assert.equal(result.intent.base.sha, f.base); assert.equal(result.intent.base.observedDevelopSha, f.base);
    assert.equal(result.intent.base.remoteFreshness, "not-established"); assert.equal(result.intent.base.provenance, "local-develop-ref");
    assert.match(result.intent.base.observedAt, /^\d{4}-\d\d-\d\dT.*Z$/); assert.match(result.intent.repository.physicalIdentitySha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(link).sort(), ["repo", "branch", "state", "linkedAt", "linkedBy"].sort());
    assert.equal(link.state, "planned"); assert.equal(result.ticket.status, "idea"); assert.equal(result.ticket.assignee, "sinh");
    assert.equal(result.approval, "not-issued"); assert.equal(result.branchRef, "not-created"); assert.equal(result.launchReady, false);
    assert.equal(f.git("for-each-ref", `refs/heads/${f.request.branch}`), "");
    assert.equal(f.git("status", "--porcelain=v2", "--untracked-files=all"), status); assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.deepEqual(readFileSync(join(f.repo, "staged.bin")), Buffer.from([0, 255, 1]));
    assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    assert.equal(existsSync(join(f.repo, ".git", REPOSITORY_MUTATION_LEASE_FILE)), false);
    assert.equal(readdirSync(join(f.repo, ".git", "pa-ticket-builder-slots")).filter(name => name.endsWith(".json")).length, 0);
    assert.equal(f.plans().length, 1); assert.equal(f.store.readAudit().length, 1);
    const record = JSON.parse(readFileSync(join(f.dir, f.plans()[0]!), "utf8"));
    assert.deepEqual(record.change.intent, result.intent);
    assert.deepEqual(f.run(), { ...result, reused: true });
  } finally { f.close(); }
});

for (const point of ["intent", "ticket", "audit"] as const) test(`actual planner recovers original ${point} response loss and reviewed pin after develop drift`, () => {
  const f = fixture();
  try {
    f.host.afterPersist = stage => { if (stage === point) { f.advance(); throw Error("synthetic reply lost"); } };
    assert.throws(() => f.run(), /synthetic reply lost/); delete f.host.afterPersist;
    const result = f.run(); assert.equal(result.reused, true); assert.equal(result.intent.base.sha, f.base);
    assert.notEqual(result.currentDevelopSha, f.base); assert.equal(f.plans().length, 1); assert.equal(f.store.readAudit().length, 1);
    assert.equal(f.store.get("EX-1")!.linkedBranches.length, 1); assert.equal(f.git("for-each-ref", `refs/heads/${f.request.branch}`), "");
    assert.throws(() => f.run({ ...f.request, branch: "feature/EX-1-changed" }), /DOCUMENT_CONFLICT/);
    assert.throws(() => f.run({ ...f.request, expectedTicketVersion: "c".repeat(64) }), /DOCUMENT_CONFLICT/);
  } finally { f.close(); }
});

test("observed develop is not incidental HEAD/main, and later ticket edits are not discarded by original replay", () => {
  const f = fixture();
  try {
    f.git("checkout", "-b", "main"); f.advance();
    const main = f.git("rev-parse", "HEAD"), result = f.run();
    assert.notEqual(main, f.base); assert.equal(result.intent.base.sha, f.base);
    f.store.comment("EX-1", "fixture", "Later unrelated work");
    const current = f.store.get("EX-1")!;
    assert.deepEqual(f.run().ticket, current); assert.equal(f.git("rev-parse", "HEAD"), main);
    assert.equal(f.git("branch", "--show-current"), "main");
  } finally { f.close(); }
});

test("real competing processes serialize original plan identity without duplicate intent/link/audit", async () => {
  for (const competing of [false, true]) {
    const f = fixture();
    const script = `import {TicketStore} from ${JSON.stringify(fileURLToPath(new URL("../tickets/store.ts", import.meta.url)))};
      import {planNativeHandoffTicket} from ${JSON.stringify(fileURLToPath(new URL("../documents/handoff-planning.ts", import.meta.url)))};
      const caller=JSON.parse(process.argv[1]);
      try {const result=planNativeHandoffTicket(new TicketStore(),{authenticate:()=>structuredClone(caller),assertAvailable(){}},process.argv[2]);console.log(JSON.stringify({reused:result.reused}));}
      catch(error){console.error(error.code);process.exitCode=1;}`;
    const launch = (other: boolean) => new Promise<{ exit: number; out: string; err: string }>(resolve => {
      const request = other ? { ...f.request, requestId: "competing", branch: "feature/EX-1-competing" } : f.request;
      execFile(process.execPath, ["--import=tsx", "--input-type=module", "-e", script, JSON.stringify(f.caller), JSON.stringify(request)],
        { env: process.env, timeout: 15000 }, (error, out, err) => resolve({ exit: error ? 1 : 0, out, err }));
    });
    try {
      const results = await Promise.all([launch(false), launch(competing)]);
      assert.equal(f.plans().length, 1); assert.equal(f.store.get("EX-1")!.linkedBranches.length, 1); assert.equal(f.store.readAudit().length, 1);
      if (competing) {
        assert.equal(results.filter(result => result.exit === 0).length, 1);
        assert.match(results.find(result => result.exit !== 0)!.err, /DOCUMENT_STALE/);
      } else {
        assert.deepEqual(results.map(result => result.exit), [0, 0]);
        assert.deepEqual(results.map(result => JSON.parse(result.out).reused).sort(), [false, true]);
      }
    } finally { f.close(); }
  }
});

test("stale complete-ticket CAS and an intervening pre-intent develop move cannot save an intent", () => {
  const f = fixture();
  try {
    assert.throws(() => f.run({ ...f.request, expectedTicketVersion: "c".repeat(64) }), /DOCUMENT_STALE/);
    let checks = 0;
    // Each associated intake check performs three availability rechecks. Move
    // after the two initial checks (before the first TicketStore write check),
    // not during the observation that establishes the new pin.
    f.host.assertAvailable = () => { if (++checks === 7) f.advance(); };
    assert.throws(() => f.run(), /DOCUMENT_STALE/);
    assert.equal(f.plans().length, 0); assert.equal(f.store.get("EX-1")!.linkedBranches.length, 0);
  } finally { f.close(); }
});

for (const kind of ["ref", "legacy-planned", "legacy-materialized", "leftover-log", "symbolic-ref"] as const) test(`unproven ${kind} is never adopted or reset`, () => {
  const f = fixture();
  try {
    if (kind === "ref") f.git("update-ref", `refs/heads/${f.request.branch}`, f.base);
    if (kind === "symbolic-ref") f.git("symbolic-ref", `refs/heads/${f.request.branch}`, "refs/heads/develop");
    if (kind === "leftover-log") { const parent = join(f.repo, ".git", "logs", "refs", "heads", "feature"); mkdirSync(parent); writeFileSync(join(parent, "EX-1-handoff"), "foreign retained history\n"); }
    if (kind === "legacy-planned" || kind === "legacy-materialized") {
      if (kind === "legacy-materialized") f.git("update-ref", `refs/heads/${f.request.branch}`, f.base);
      f.store.update("EX-1", { add_linked_branch: { repo: "example", branch: f.request.branch } });
      f.request.expectedTicketVersion = creationDigest(f.store.get("EX-1"));
    }
    const ticket = readFileSync(join(f.dir, "EX-1.json")), refs = f.git("show-ref");
    assert.throws(() => f.run(), /DOCUMENT_CONFLICT/);
    assert.deepEqual(readFileSync(join(f.dir, "EX-1.json")), ticket); assert.equal(f.git("show-ref"), refs); assert.equal(f.plans().length, 0);
  } finally { f.close(); }
});

for (const kind of ["missing", "symbolic", "symlink", "packed-symlink", "branch-parent-symlink"] as const) test(`unsafe or unknown ${kind} repository observation fails before planning`, () => {
  const f = fixture();
  try {
    if (kind === "missing") f.git("update-ref", "-d", "refs/heads/develop");
    if (kind === "symbolic") { f.git("update-ref", "refs/heads/main", f.base); f.git("symbolic-ref", "refs/heads/develop", "refs/heads/main"); }
    if (kind === "symlink") { const ref = join(f.repo, ".git", "refs", "heads", "develop"), outside = join(f.root, "outside"); writeFileSync(outside, `${f.base}\n`); rmSync(ref); symlinkSync(outside, ref); }
    if (kind === "packed-symlink") { const outside = join(f.root, "outside"); writeFileSync(outside, "# pack-refs with: peeled\n"); symlinkSync(outside, join(f.repo, ".git", "packed-refs")); }
    if (kind === "branch-parent-symlink") symlinkSync(f.root, join(f.repo, ".git", "refs", "heads", "feature"));
    assert.throws(() => f.run(), /DOCUMENT_(SOURCE|UNCERTAIN)/); assert.equal(f.plans().length, 0);
    assert.equal(f.store.get("EX-1")!.linkedBranches.length, 0);
  } finally { f.close(); }
});

for (const note of ["requirements-document-policy/v1", "requirements-document-confirmation/v3", "rogue-one"]) test(`retained/unselected start ${note} remains denied`, () => {
  const f = fixture(note);
  try { assert.throws(() => f.run(), /DOCUMENT_AUTHORITY/); assert.equal(f.plans().length, 0); }
  finally { f.close(); }
});

test("actual current/historical association owners, session drift, async admission and retained custody block without cleanup", () => {
  const f = fixture();
  try {
    f.host.assertAvailable = async () => {};
    assert.throws(() => f.run(), /DOCUMENT_AUTHORITY/);
    f.host.assertAvailable = () => { f.caller.sessionId = "changed-session"; };
    assert.throws(() => f.run(), /DOCUMENT_STALE/); f.caller.sessionId = "synthetic-session";
    f.host.assertAvailable = () => {};
    const custody = join(f.repo, ".git", REPOSITORY_MUTATION_LEASE_FILE); writeFileSync(custody, "uncertain custody");
    assert.throws(() => f.run(), /retained repository custody/); assert.equal(readFileSync(custody, "utf8"), "uncertain custody"); rmSync(custody);
    appendRegistryEvent({ ...f.start, deployment_id: "d-123456" });
    appendRegistryEvent({ deployment_id: "d-123456", team: "requirements", event: "completed", timestamp: "2026-11-15T06:01:00.000Z", status: "success" });
    assert.throws(() => f.run(), /DOCUMENT_CONFLICT/); assert.equal(f.plans().length, 0);
  } finally { f.close(); }
});

test("caller desired input cannot import observations, grants, identities, duplicate keys or foreign repository policy", () => {
  const f = fixture();
  try {
    for (const field of ["actor", "outcome", "root", "baseSha", "lineage", "provenance", "selectionSha256"]) {
      assert.throws(() => f.run({ ...f.request, [field]: "untrusted" } as typeof f.request), /DOCUMENT_INPUT/);
    }
    assert.throws(() => planNativeHandoffTicket(f.store, f.host, JSON.stringify(f.request).replace('"action":"plan"', '"action":"plan","action":"plan"')), /DOCUMENT_INPUT/);
    writeFileSync(join(f.config, "config.yaml"), `repos:\n  example:\n    path: ${f.repo}\n    prefix: EX\n    developBranch: main\n`);
    assert.throws(() => f.run(), /DOCUMENT_AUTHORITY/); assert.equal(f.plans().length, 0);
  } finally { f.close(); }
});
