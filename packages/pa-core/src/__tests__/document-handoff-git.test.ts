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
