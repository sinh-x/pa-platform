import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { withRepositoryRefAdmission, REPOSITORY_MUTATION_LEASE_FILE } from "../deploy/repository-admission.js";
import { withPreparedTicketCapacity, withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { RegistryHandoffGitOwner, type NativeHandoffGit } from "../documents/handoff-git.js";
import { completeNativeHandoffBranch } from "../documents/handoff-native-branch.js";
import { documentPackageSha } from "../documents/package-contract.js";
import { creationDigest } from "../tickets/create-intent.js";
import { handoffBranchIntentSha, type HandoffReviewSubject } from "../documents/handoff-contract.js";
import type { HandoffBranchIntent } from "../documents/handoff-contract.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";
const operationId = "d".repeat(64);
function fixture() {
  const f = documentRuntimeFixture();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: f.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  git("init", "-b", "develop"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const physicalIdentitySha256 = withRepositoryRefTicketExclusion("example", f.repo, exclusion => withRepositoryRefAdmission(f.repo, exclusion, id => id));
  const intent: HandoffBranchIntent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: "original", callerIdentitySha256: "a".repeat(64), expectedTicketVersion: "b".repeat(64), repository: { key: "example", root: f.repo, physicalIdentitySha256 }, ticket: "EX-1", branch: "feature/EX-1-handoff", action: "create",
    base: { ref: "refs/heads/develop", sha: base, observedDevelopSha: base, observedAt: "2026-11-14T16:00:00.000Z", provenance: "local-develop-ref", remoteFreshness: "not-established" }, plannedLinkSha256: "c".repeat(64), lineage: null };
  f.db.pragma("synchronous = FULL"); // New owner requires an explicitly qualified durable connection.
  const owner = new RegistryHandoffGitOwner(f.db);
  return { ...f, git, base, intent, owner, run: <T>(run: (port: NativeHandoffGit) => T) => owner.withRepository(intent, operationId, run) };
}

test("native owner creates only one pinned ref with durable original correlation and shared exclusion, not checkout/capacity", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "unrelated.txt"), "preserve dirt");
    const before = f.git("status", "--porcelain=v2", "--untracked-files=all");
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "develop moved");
    const observation = f.run(port => { assert.deepEqual(port.observe(), { state: "absent", history: "never-created" }); port.create(); return port.observe(); });
    assert.equal(observation.state, "present");
    if (observation.state !== "present") throw Error("missing");
    assert.deepEqual(observation.owner, { kind: "operation", id: operationId }); assert.equal(observation.headSha, f.base);
    assert.deepEqual(f.run(port => port.observe()), observation);
    assert.throws(() => f.run(port => port.create()), /DOCUMENT_UNCERTAIN/);
    assert.equal(f.git("status", "--porcelain=v2", "--untracked-files=all"), before);
    assert.equal(f.git("branch", "--show-current"), "develop");
    assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    const capacity = join(f.repo, ".git", "pa-ticket-builder-slots");
    assert.equal(readdirSync(capacity).filter(name => name.endsWith(".json")).length, 0);
    assert.equal(existsSync(join(f.repo, ".git", REPOSITORY_MUTATION_LEASE_FILE)), false);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() && (f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

for (const point of ["intent", "ref", "synced"] as const) test(`native Git recovery after ${point} interruption never treats matching SHA or uncertain absence as permission`, () => {
  const f = fixture();
  try {
    assert.throws(() => f.owner.withRepository(f.intent, operationId, port => port.create(), stage => { if (stage === point) throw Error("reply lost"); }), /reply lost/);
    const result = f.run(port => port.observe());
    if (point === "intent") { assert.deepEqual(result, { state: "absent", history: "uncertain" }); assert.throws(() => f.run(port => port.create()), /DOCUMENT_UNCERTAIN/); }
    else { assert.equal(result.state, "present"); if (result.state === "present") assert.deepEqual(result.owner, { kind: "operation", id: operationId }); }
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("foreign same-name/SHA, symbolic refs, replaced/deleted results and forged reflog fail closed", () => {
  for (const kind of ["foreign", "symbolic", "deleted", "forged"] as const) {
    const f = fixture();
    try {
      if (kind === "foreign") f.git("update-ref", `refs/heads/${f.intent.branch}`, f.base);
      else if (kind === "symbolic") f.git("symbolic-ref", `refs/heads/${f.intent.branch}`, "refs/heads/develop");
      else {
        f.run(port => port.create());
        if (kind === "deleted") f.git("update-ref", "-d", `refs/heads/${f.intent.branch}`);
        else writeFileSync(join(f.repo, ".git", "logs", "refs", "heads", f.intent.branch), `${"0".repeat(40)} ${f.base} Fixture <fixture@example.invalid> 0 +0000\tpa-handoff:${operationId}:${"0".repeat(64)}\n`);
      }
      const result = f.run(port => port.observe());
      if (kind === "foreign") { assert.equal(result.state, "present"); if (result.state === "present") assert.equal(result.owner.kind, "unproven"); }
      else if (kind === "deleted") assert.deepEqual(result, { state: "absent", history: "uncertain" });
      else assert.equal(result.state, "unknown");
      assert.throws(() => f.run(port => port.create()));
    } finally { f.close(); }
  }
});

test("symlinked Git storage and foreign leftover reflogs cannot receive a new ref or correlation marker", () => {
  for (const kind of ["symlink", "leftover"] as const) {
    const f = fixture();
    try {
      const outside = join(f.root, "outside"); mkdirSync(outside);
      if (kind === "symlink") symlinkSync(outside, join(f.repo, ".git", "refs", "heads", "feature"));
      else { const parent = join(f.repo, ".git", "logs", "refs", "heads", "feature"); mkdirSync(parent); writeFileSync(join(parent, "EX-1-handoff"), "foreign history\n"); }
      assert.equal(f.run(port => port.observe()).state, "unknown");
      assert.throws(() => f.run(port => port.create()), /DOCUMENT_UNCERTAIN/);
      assert.deepEqual(readdirSync(outside), []);
      assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});

test("opaque exclusion and Git ports expire; every retained primary/linked custody blocks without cleanup", () => {
  const f = fixture();
  try {
    let saved: NativeHandoffGit | undefined;
    f.run(port => { saved = port; }); assert.throws(() => saved!.observe(), /DOCUMENT_AUTHORITY/);
    assert.throws(() => withRepositoryRefAdmission(f.repo, {} as never, () => undefined), /absent/);
    const linked = join(f.root, "linked"); f.git("worktree", "add", "--detach", linked, f.base);
    const linkedGitDir = f.git("-C", linked, "rev-parse", "--absolute-git-dir");
    for (const directory of [join(f.repo, ".git"), linkedGitDir]) {
      const path = join(directory, REPOSITORY_MUTATION_LEASE_FILE); writeFileSync(path, "malformed retained custody");
      assert.throws(() => f.run(port => port.create()), /retained repository custody/);
      assert.equal(readFileSync(path, "utf8"), "malformed retained custody"); rmSync(path);
    }
  } finally { f.close(); }
});

test("exclusion-only ref owner does not consume or reconcile idle capacity, but unknown ticket writers block", () => {
  const f = fixture();
  try {
    withPreparedTicketCapacity({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo }, tx => {
      const result = tx.reserve({ ticket: "EX-2", operationId: "e".repeat(64), reservationId: "f".repeat(64), retainedAt: "2026-11-14T16:00:00.000Z" }); assert.equal(result.status, "reserved");
    });
    const directory = join(f.repo, ".git", "pa-ticket-builder-slots"), names = readdirSync(directory).filter(name => name.endsWith(".json")), original = names.map(name => readFileSync(join(directory, name)));
    f.run(port => port.create());
    assert.deepEqual(names.map(name => readFileSync(join(directory, name))), original);
    const unknown = join(directory, "unknown.json"); writeFileSync(unknown, "{}"); chmodSync(unknown, 0o600);
    assert.throws(() => f.run(port => port.observe()), /live or uncertain ticket ownership/); assert.equal(readFileSync(unknown, "utf8"), "{}");
  } finally { f.close(); }
});

test("actual child-process death after Git create recovers the original marker, with no duplicate ref or checkout", async () => {
  const f = fixture();
  const script = `import {getDb} from ${JSON.stringify(fileURLToPath(new URL("../registry/db.ts", import.meta.url)))}; import {RegistryHandoffGitOwner} from ${JSON.stringify(fileURLToPath(new URL("../documents/handoff-git.ts", import.meta.url)))};
    const db=getDb(process.argv[1]); db.pragma('synchronous = FULL'); new RegistryHandoffGitOwner(db).withRepository(JSON.parse(process.argv[2]),process.argv[3],port=>port.create(),point=>{if(point==='ref')process.kill(process.pid,'SIGKILL');});`;
  try {
    const result = await new Promise<{ code: unknown; signal: unknown }>(resolve => execFile(process.execPath, ["--import=tsx", "--input-type=module", "-e", script, join(f.root, "registry.db"), JSON.stringify(f.intent), operationId], { env: process.env, timeout: 15000 }, error => resolve({ code: error?.code, signal: error?.signal })));
    assert.equal(result.signal, "SIGKILL");
    const observed = f.run(port => port.observe()); assert.equal(observed.state, "present");
    if (observed.state === "present") assert.deepEqual(observed.owner, { kind: "operation", id: operationId });
    assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), f.base);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

for (const stop of ["none", "intent", "ticket", "audit"] as const) test(`combined real Git/journal/TicketStore adapter recovers ${stop} ticket boundary without ref/publication/queue replay`, () => {
  const f = fixture();
  try {
    // Actual source owners, synthetic authority ONLY. Not a human decision,
    // selected native review consumer, installed qualification or product UAT.
    const ticket = f.store.update("EX-1", { summary: "Stable complete fixture" }, "fixture");
    f.intent.expectedTicketVersion = creationDigest(ticket); f.intent.plannedLinkSha256 = creationDigest(null);
    const planIdentity = { scope: "a".repeat(64), requestId: "original" };
    f.store.applyHandoffWithIntent("EX-1", creationDigest(ticket), { kind: "plan", intent: f.intent }, "documents/handoff", planIdentity, { assertCurrent() {}, assertSnapshot() {} });
    const subject: HandoffReviewSubject = { schemaVersion: "pa-handoff-review/v1", documentSubjectSha256: documentPackageSha(f.subject), branchIntentSha256: handoffBranchIntentSha(f.intent), deliverySha256: "e".repeat(64), selectionSha256: "f".repeat(64), callerIdentitySha256: "a".repeat(64), effects: { publish: true, branchRef: true, queue: false } };
    const authority = { authenticate: () => ({ identitySha256: subject.callerIdentitySha256, selectionSha256: subject.selectionSha256 }), assertAvailable() {}, assertDecision() {}, assertPublished() {} };
    const run = (fault = false) => completeNativeHandoffBranch(f.db, f.store, authority, subject, f.intent, f.subject, "decision-fixture", planIdentity, stage => { if (fault && stage === stop) throw Error("ticket reply lost"); });
    if (stop !== "none") assert.throws(() => run(true), /ticket reply lost/);
    const result = run(); assert.equal(result.completion, "verified");
    const link = f.store.get("EX-1")!.linkedBranches[0]!;
    assert.equal(link.state, "materialized"); assert.equal(link.baseSha, f.base); assert.equal(link.headSha, f.base);
    assert.deepEqual(run(), result);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 1);
    assert.equal(f.store.readAudit().filter(row => row.changes.handoffIntent).length, 2);
    assert.equal(f.store.get("EX-1")!.status, "requirement-review"); assert.equal(f.store.get("EX-1")!.assignee, "requirements/team-manager");
    assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), f.base);
  } finally { f.close(); }
});

test("shared native capacity mutex excludes a real second process while the ref owner is active", async () => {
  const f = fixture();
  const marker = join(f.root, "inside"), script = `import {writeFileSync} from 'node:fs'; import {withPreparedTicketCapacity} from ${JSON.stringify(fileURLToPath(new URL("../deploy/ticket-concurrency.ts", import.meta.url)))};
    withPreparedTicketCapacity({canonicalRepoKey:'example',canonicalRepoRoot:process.argv[1]},()=>writeFileSync(process.argv[2],'entered'));`;
  let child: ReturnType<typeof execFile> | undefined;
  try {
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    f.run(() => {
      child = execFile(process.execPath, ["--import=tsx", "--input-type=module", "-e", script, f.repo, marker], { env: process.env, timeout: 10000 }, error => { if (error) finished(); else finished(); });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
      assert.equal(existsSync(marker), false);
    });
    await done; assert.equal(readFileSync(marker, "utf8"), "entered");
  } finally { child?.kill(); f.close(); }
});

function reuseFixture() {
  const f = fixture();
  const ticket = f.store.update("EX-1", { summary: "Stable original native fixture" }, "fixture");
  f.intent.expectedTicketVersion = creationDigest(ticket); f.intent.plannedLinkSha256 = creationDigest(null);
  const originalPlan = { scope: "a".repeat(64), requestId: "original" };
  const hooks = { assertCurrent() {}, assertSnapshot() {} }; // Synthetic authority; not selected/native review acceptance.
  f.store.applyHandoffWithIntent("EX-1", creationDigest(ticket), { kind: "plan", intent: f.intent }, "documents/handoff", originalPlan, hooks);
  const originalSubject: HandoffReviewSubject = { schemaVersion: "pa-handoff-review/v1", documentSubjectSha256: documentPackageSha(f.subject), branchIntentSha256: handoffBranchIntentSha(f.intent), deliverySha256: "e".repeat(64), selectionSha256: "f".repeat(64), callerIdentitySha256: "a".repeat(64), effects: { publish: true, branchRef: true, queue: false } };
  let allowed = true;
  const authority = { authenticate: () => ({ identitySha256: originalSubject.callerIdentitySha256, selectionSha256: originalSubject.selectionSha256 }), assertAvailable() {}, assertDecision() { if (!allowed) throw Error("revoked fixture decision"); }, assertPublished() {} };
  const originalResult = completeNativeHandoffBranch(f.db, f.store, authority, originalSubject, f.intent, f.subject, "decision-original", originalPlan);
  const originalLink = f.store.get("EX-1")!.linkedBranches[0]!;
  const advanced = f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", f.git("rev-parse", `${f.base}^{tree}`), "-p", f.base, "-m", "advanced branch history");
  f.git("update-ref", `refs/heads/${f.intent.branch}`, advanced, f.base);
  const current = f.store.get("EX-1")!;
  const intent: HandoffBranchIntent = { ...structuredClone(f.intent), requestId: "reuse", action: "reuse", expectedTicketVersion: creationDigest(current), plannedLinkSha256: creationDigest(originalLink),
    base: { ...f.intent.base, provenance: "native-original-base" }, lineage: { operationSha256: originalResult.operationId as string, originalBaseSha: f.base, observedHeadSha: advanced } };
  const planIdentity = { scope: "b".repeat(64), requestId: "reuse" };
  const plan = f.store.applyHandoffWithIntent("EX-1", creationDigest(current), { kind: "plan", intent }, "documents/handoff", planIdentity, hooks);
  assert.deepEqual(plan.ticket.linkedBranches[0], originalLink, "planning must not reset/downgrade/refresh the materialized link");
  const reviewSubject = { ...originalSubject, branchIntentSha256: handoffBranchIntentSha(intent) };
  const run = (boundary?: (stage: "intent" | "ticket" | "audit") => void) => completeNativeHandoffBranch(f.db, f.store, authority, reviewSubject, intent, f.subject, "decision-reuse", planIdentity, boundary);
  return { ...f, reuseIntent: intent, originalResult, originalLink, advanced, reviewSubject, runReuse: run, revoke() { allowed = false; } };
}

for (const point of ["none", "intent", "ticket", "audit"] as const) test(`actual advanced lineage reuse preserves original base/ref/history/dirt and recovers ${point} linkage boundary`, () => {
  const f = reuseFixture();
  try {
    const develop = f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", f.git("rev-parse", `${f.base}^{tree}`), "-p", f.base, "-m", "develop moved after frozen reuse intent");
    f.git("update-ref", "refs/heads/develop", develop, f.base);
    writeFileSync(join(f.repo, "staged.bin"), Buffer.from([0, 1, 255])); f.git("add", "staged.bin");
    writeFileSync(join(f.repo, "unrelated.txt"), "preserve unrelated untracked work");
    const status = f.git("status", "--porcelain=v2", "--untracked-files=all");
    const logPath = join(f.repo, ".git", "logs", "refs", "heads", f.intent.branch), log = readFileSync(logPath);
    if (point !== "none") assert.throws(() => f.runReuse(stage => { if (stage === point) throw Error("reuse reply lost"); }), /reuse reply lost/);
    const result = f.runReuse(), link = f.store.get("EX-1")!.linkedBranches[0]!;
    assert.equal(result.completion, "verified"); assert.notEqual(result.operationId, f.originalResult.operationId);
    assert.deepEqual(link, { ...f.originalLink, headSha: f.advanced, sha: f.advanced });
    assert.equal(link.baseSha, f.base); assert.notEqual(link.baseSha, link.headSha);
    assert.notEqual(link.baseSha, f.git("rev-parse", "refs/heads/develop"));
    assert.deepEqual(f.runReuse(), result);
    assert.deepEqual(readFileSync(logPath), log, "reuse must perform no ref/reflog write");
    assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), f.advanced);
    assert.equal(f.git("branch", "--show-current"), "develop");
    assert.equal(f.git("status", "--porcelain=v2", "--untracked-files=all"), status);
    assert.deepEqual(readFileSync(join(f.repo, "staged.bin")), Buffer.from([0, 1, 255]));
    assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    assert.equal(readdirSync(join(f.repo, ".git", "pa-ticket-builder-slots")).filter(name => name.endsWith(".json")).length, 0);
    assert.equal(existsSync(join(f.repo, ".git", REPOSITORY_MUTATION_LEASE_FILE)), false);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_creation_sources").get() as { n: number }).n, 1);
    assert.equal(f.store.readAudit().filter(row => row.changes.handoffIntent).length, 4);
  } finally { f.close(); }
});

test("lineage reuse is observation-only at the Git port and has no create capability", () => {
  const f = reuseFixture();
  try {
    f.owner.withRepository(f.reuseIntent, "9".repeat(64), port => {
      const observed = port.observe(); assert.equal(observed.state, "present");
      if (observed.state === "present") assert.deepEqual(observed.owner, { kind: "lineage", sha256: f.originalResult.operationId });
      assert.throws(() => port.create(), /DOCUMENT_AUTHORITY/);
    });
    f.revoke(); const before = f.store.get("EX-1");
    assert.throws(() => f.runReuse(), /revoked fixture decision/);
    assert.deepEqual(f.store.get("EX-1"), before); assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), f.advanced);
  } finally { f.close(); }
});

for (const fault of ["missing-source", "corrupt-source", "incomplete-origin", "moved-head", "foreign-marker"] as const) test(`advanced reuse blocks ${fault} without native-history backfill, ref rewrite or ticket relink`, () => {
  const f = reuseFixture();
  try {
    const origin = f.originalResult.operationId as string, logPath = join(f.repo, ".git", "logs", "refs", "heads", f.intent.branch);
    if (fault === "missing-source") f.db.prepare("DELETE FROM handoff_git_creation_sources WHERE operation_id = ?").run(origin);
    else if (fault === "corrupt-source") f.db.prepare("UPDATE handoff_git_creation_sources SET payload = '{}' WHERE operation_id = ?").run(origin);
    else if (fault === "incomplete-origin") f.db.prepare("DELETE FROM handoff_branch_events WHERE operation_id = ? AND sequence = 5").run(origin);
    else if (fault === "moved-head") {
      const next = f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", f.git("rev-parse", `${f.base}^{tree}`), "-p", f.advanced, "-m", "moved after review");
      f.git("update-ref", `refs/heads/${f.intent.branch}`, next, f.advanced);
    } else writeFileSync(logPath, `${"0".repeat(40)} ${f.base} Fixture <fixture@example.invalid> 0 +0000\tforeign marker\n`);
    const ticket = f.store.get("EX-1"), head = f.git("rev-parse", `refs/heads/${f.intent.branch}`), log = readFileSync(logPath);
    assert.throws(() => f.runReuse(), /DOCUMENT_UNCERTAIN|DOCUMENT_CONFLICT/);
    assert.deepEqual(f.store.get("EX-1"), ticket); assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), head);
    assert.deepEqual(readFileSync(logPath), log);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 1);
    if (fault === "missing-source") assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_creation_sources").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("same SHA/name metadata or a different branch cannot substitute for the original completed creation", () => {
  const f = fixture();
  try {
    f.run(port => port.create()); // Ref exists but no completed original branch/link operation.
    const reuse: HandoffBranchIntent = { ...f.intent, action: "reuse", base: { ...f.intent.base, provenance: "native-original-base" }, lineage: { operationSha256: operationId, originalBaseSha: f.base, observedHeadSha: f.base } };
    assert.notEqual(f.owner.withRepository(reuse, "e".repeat(64), port => port.observe()).state, "present");
  } finally { f.close(); }
  const complete = reuseFixture();
  try {
    const foreign = "feature/EX-1-foreign"; complete.git("update-ref", `refs/heads/${foreign}`, complete.advanced);
    assert.throws(() => complete.owner.withRepository({ ...complete.reuseIntent, branch: foreign }, "e".repeat(64), port => port.observe()), /DOCUMENT_UNCERTAIN/);
    assert.equal(complete.git("rev-parse", `refs/heads/${foreign}`), complete.advanced);
  } finally { complete.close(); }
});

test("reuse never refreshes materialized metadata backwards even when the tip still descends from the original base", () => {
  const f = reuseFixture();
  try {
    f.runReuse(); f.git("update-ref", `refs/heads/${f.intent.branch}`, f.base, f.advanced);
    const before = f.store.get("EX-1")!, next: HandoffBranchIntent = { ...f.reuseIntent, requestId: "rewound", expectedTicketVersion: creationDigest(before), plannedLinkSha256: creationDigest(before.linkedBranches[0]), lineage: { ...f.reuseIntent.lineage!, observedHeadSha: f.base } };
    const identity = { scope: "c".repeat(64), requestId: "rewound" };
    f.store.applyHandoffWithIntent("EX-1", creationDigest(before), { kind: "plan", intent: next }, "documents/handoff", identity, { assertCurrent() {}, assertSnapshot() {} });
    const authority = { authenticate: () => ({ identitySha256: f.reviewSubject.callerIdentitySha256, selectionSha256: f.reviewSubject.selectionSha256 }), assertAvailable() {}, assertDecision() {}, assertPublished() {} };
    assert.throws(() => completeNativeHandoffBranch(f.db, f.store, authority, { ...f.reviewSubject, branchIntentSha256: handoffBranchIntentSha(next) }, next, f.subject, "decision-rewound", identity), /DOCUMENT_CONFLICT/);
    assert.equal(f.store.get("EX-1")!.linkedBranches[0]!.headSha, f.advanced);
    assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), f.base);
  } finally { f.close(); }
});

test("finite TicketStore materialization cannot substitute a head outside the exact native plan", () => {
  const f = reuseFixture();
  try {
    const before = f.store.get("EX-1")!, plan = f.store.inspectHandoffWithIntent({ scope: "b".repeat(64), requestId: "reuse" })!;
    const identity = { scope: "d".repeat(64), requestId: "unbound-head" };
    assert.throws(() => f.store.applyHandoffWithIntent("EX-1", creationDigest(before), { kind: "materialize", planKey: plan.record.key, operationId: "e".repeat(64), headSha: f.base }, "documents/handoff", identity, { assertCurrent() {}, assertSnapshot() {} }), /TICKET_HANDOFF_CONFLICT/);
    assert.deepEqual(f.store.get("EX-1"), before);
    assert.equal(f.store.inspectHandoffWithIntent(identity), undefined);
  } finally { f.close(); }
});

for (const point of ["intent", "ticket", "audit"] as const) test(`revoked advanced reuse after ${point} permits only already-complete observation, never remaining ticket writes`, () => {
  const f = reuseFixture();
  try {
    assert.throws(() => f.runReuse(stage => { if (stage === point) throw Error("lost reuse reply"); }), /lost reuse reply/);
    const ticket = f.store.get("EX-1"), audit = f.store.readAudit(), logPath = join(f.repo, ".git", "logs", "refs", "heads", f.intent.branch), log = readFileSync(logPath);
    f.revoke();
    if (point === "audit") assert.equal(f.runReuse().completion, "verified");
    else assert.throws(() => f.runReuse(), /revoked fixture decision/);
    assert.deepEqual(f.store.get("EX-1"), ticket); assert.deepEqual(f.store.readAudit(), audit);
    assert.deepEqual(readFileSync(logPath), log); assert.equal(f.git("rev-parse", `refs/heads/${f.intent.branch}`), f.advanced);
  } finally { f.close(); }
});

test("actual process death after advanced reuse ticket persistence resumes only its original missing audit", async () => {
  const f = reuseFixture();
  const script = `import {getDb} from ${JSON.stringify(fileURLToPath(new URL("../registry/db.ts", import.meta.url)))};
    import {TicketStore} from ${JSON.stringify(fileURLToPath(new URL("../tickets/store.ts", import.meta.url)))};
    import {completeNativeHandoffBranch} from ${JSON.stringify(fileURLToPath(new URL("../documents/handoff-native-branch.ts", import.meta.url)))};
    const [database,tickets,rawSubject,rawIntent,rawDocument]=process.argv.slice(1), subject=JSON.parse(rawSubject), intent=JSON.parse(rawIntent), db=getDb(database); db.pragma('synchronous = FULL');
    const authority={authenticate:()=>({identitySha256:subject.callerIdentitySha256,selectionSha256:subject.selectionSha256}),assertAvailable(){},assertDecision(){},assertPublished(){}};
    completeNativeHandoffBranch(db,new TicketStore(tickets,{team:'requirements',mode:'analyze',privileged:true}),authority,subject,intent,JSON.parse(rawDocument),'decision-reuse',{scope:'b'.repeat(64),requestId:'reuse'},stage=>{if(stage==='ticket')process.kill(process.pid,'SIGKILL');});`;
  try {
    const logPath = join(f.repo, ".git", "logs", "refs", "heads", f.intent.branch), log = readFileSync(logPath);
    const child = await new Promise<{ code: unknown; signal: unknown }>(resolve => execFile(process.execPath, ["--import=tsx", "--input-type=module", "-e", script, join(f.root, "registry.db"), join(f.root, "tickets"), JSON.stringify(f.reviewSubject), JSON.stringify(f.reuseIntent), JSON.stringify(f.subject)], { env: process.env, timeout: 15000 }, error => resolve({ code: error?.code, signal: error?.signal })));
    assert.equal(child.signal, "SIGKILL"); assert.equal(f.store.get("EX-1")!.linkedBranches[0]!.headSha, f.advanced);
    assert.equal(f.store.readAudit().filter(row => row.changes.handoffIntent).length, 3);
    assert.equal(f.runReuse().completion, "verified");
    assert.equal(f.store.readAudit().filter(row => row.changes.handoffIntent).length, 4);
    assert.deepEqual(readFileSync(logPath), log);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("native commit/ancestry observation never implicitly invokes a promisor remote helper", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "helpers"), marker = join(f.root, "promisor-invoked"); mkdirSync(bin);
    const helper = join(bin, "git-remote-sentinel");
    writeFileSync(helper, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    f.git("config", "core.repositoryFormatVersion", "1"); f.git("config", "extensions.partialClone", "sentinel");
    f.git("config", "remote.sentinel.promisor", "true"); f.git("config", "remote.sentinel.url", "sentinel::unused");
    f.git("config", "protocol.sentinel.allow", "always");
    const missing = "1".repeat(40);
    assert.throws(() => f.git("cat-file", "-t", missing));
    assert.equal(existsSync(marker), true, "inert baseline must actually exercise implicit lazy fetch"); rmSync(marker);
    assert.throws(() => f.owner.withRepository({ ...f.intent, base: { ...f.intent.base, sha: missing, observedDevelopSha: missing } }, operationId, port => port.create()));
    assert.equal(existsSync(marker), false, "owner must not invoke even a local inert remote helper");
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM handoff_git_intents").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
