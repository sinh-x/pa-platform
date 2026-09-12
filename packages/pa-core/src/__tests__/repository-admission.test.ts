import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_REPOSITORY_BORROWER_BYTES,
  MAX_REPOSITORY_DIAGNOSTIC_CHARS,
  MAX_REPOSITORY_DIRTY_APPROVAL_BYTES,
  MAX_GIT_STATUS_SUMMARY_CHARS,
  MAX_REPOSITORY_LEASE_BYTES,
  acquireRepositoryMutationLease,
  captureRepositoryGitSnapshot,
  classifyRepositoryAccess,
  finalizeRepositoryMutationBorrower,
  finalizeRepositoryMutationLease,
  formatRepositoryAdmissionDiagnostic,
  inspectRepositoryMutationBorrower,
  inspectRepositoryMutationLease,
  publishRepositoryDirtyBorrowApproval,
  quarantineRepositoryMutationLease,
  readProcessFingerprint,
  registerRepositoryMutationBorrower,
  releaseRepositoryMutationBorrower,
  releaseRepositoryMutationLease,
  repositoryDirtyBorrowApprovalPath,
  repositoryGitSnapshotsEqual,
  repositoryMutationBorrowerPath,
  repositoryMutationLeasePath,
  transferRepositoryMutationBorrower,
  transferRepositoryMutationLease,
  updateRepositoryMutationLeaseGitSnapshot,
  type ProcessFingerprint,
  type RepositoryAdmissionDependencies,
  type RepositoryDirtyBorrowApproval,
  type RepositoryGitSnapshot,
} from "../index.js";
import { installGitStateRecorder } from "../../../../test/helpers/git-state-recorder.js";

const snapshot: RepositoryGitSnapshot = Object.freeze({
  branch: "feature/PAP-191-ppa-parent-lease-inheritance",
  head: "a".repeat(40),
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  dirty: false,
  statusSummary: "",
});

function completeSnapshot(root: string, path = "ticket-work.ts", xy = ".M", head = "d".repeat(40), branch = snapshot.branch): RepositoryGitSnapshot {
  return captureRepositoryGitSnapshot(root, (args) => {
    if (args[0] === "symbolic-ref") return `${branch}\n`;
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "status") return `1 ${xy} N... 100644 100644 100644 ${"e".repeat(40)} ${"e".repeat(40)} ${path}\0`;
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  });
}

function fixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pa-repository-admission-${name}-`));
  mkdirSync(join(root, ".git"));
  return root;
}

function fingerprint(pid = 41001, startTimeTicks = "123456"): ProcessFingerprint {
  return Object.freeze({ pid, startTimeTicks, bootId: "test-boot-id" });
}

function dependencies(live?: ProcessFingerprint): RepositoryAdmissionDependencies {
  let token = 0;
  return {
    getProcessFingerprint: (pid) => live?.pid === pid ? live : undefined,
    runGit: () => { throw new Error("unexpected Git call"); },
    now: () => new Date("2026-09-05T13:00:00.000Z"),
    createToken: () => `token-${++token}`,
    isDeploymentRunning: () => true,
  };
}

function familyDependencies(live: readonly ProcessFingerprint[]): RepositoryAdmissionDependencies {
  let token = 0;
  return {
    getProcessFingerprint: (pid) => live.find((candidate) => candidate.pid === pid),
    runGit: () => { throw new Error("unexpected Git call"); },
    now: () => new Date("2026-09-11T13:00:00.000Z"),
    createToken: () => `family-token-${++token}`,
    isDeploymentRunning: () => true,
  };
}

function acquire(root: string, owner: ProcessFingerprint, extra: { force?: boolean; token?: string; deps?: RepositoryAdmissionDependencies } = {}) {
  const deps = extra.deps ?? dependencies(owner);
  return acquireRepositoryMutationLease({
    canonicalRepoKey: "fixture",
    canonicalRepoRoot: root,
    deploymentId: `d-${owner.pid}`,
    deploymentDirectory: join(root, "deployment"),
    runtime: "pi",
    mode: "implement",
    pid: owner.pid,
    processFingerprint: owner,
    ownershipToken: extra.token,
    gitSnapshot: snapshot,
    force: extra.force,
    dependencies: deps,
  });
}

test("repository access classification is deterministic and requirements need no Git or lease operation", () => {
  assert.equal(classifyRepositoryAccess("requirements", "analyze"), "read-only");
  assert.equal(classifyRepositoryAccess("requirements/reviewer", "review"), "read-only");
  assert.equal(classifyRepositoryAccess("builder", "orchestrator"), "exclusive-builder");
  assert.equal(classifyRepositoryAccess("builder/team-manager", "implement"), "exclusive-builder");
  assert.equal(classifyRepositoryAccess("maintenance", "fix"), "non-locking");
  assert.equal(classifyRepositoryAccess("requirements-helper", "analyze"), "non-locking");
});

test("snapshot capture preserves porcelain-v2 NUL bytes for rename and odd or long paths", () => {
  const root = fixture("snapshot-odd-paths");
  const odd = "space tab\tline\nbreak.ts";
  const renamed = "renamed target\n.ts";
  const source = "source\told.ts";
  const longPath = `${"long-".repeat(230)}.ts`;
  const raw = Buffer.concat([
    Buffer.from(`1 .M N... 100644 100644 100644 ${"1".repeat(40)} ${"1".repeat(40)} ${odd}\0`),
    Buffer.from(`2 R. N... 100644 100644 100644 ${"2".repeat(40)} ${"2".repeat(40)} R100 ${renamed}\0${source}\0`),
    Buffer.from(`? ${longPath}\0`),
  ]);
  try {
    const result = captureRepositoryGitSnapshot(root, (args) => {
      if (args[0] === "symbolic-ref") return "feature/PAP-191-odd-paths\n";
      if (args[0] === "rev-parse") return `${"f".repeat(40)}\n`;
      if (args[0] === "status") return raw;
      throw new Error("unexpected command");
    });
    assert.deepEqual(result.statusEntries?.map((entry) => [entry.path, entry.sourcePath]), [[odd, undefined], [renamed, source], [longPath, undefined]]);
    assert.deepEqual(Buffer.from(result.statusPorcelainV2Base64!, "base64"), raw);
    assert.equal(result.statusRecordCount, 3);
    assert.equal(result.statusSummary.length, MAX_GIT_STATUS_SUMMARY_CHARS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git snapshot captures bounded staged, unstaged, and untracked evidence with read-only commands", () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const outputs = new Map<string, string>([
    ["symbolic-ref --quiet --short HEAD", "feature/PAP-174\n"],
    ["rev-parse HEAD", `${"b".repeat(40)}\n`],
    ["status --porcelain=v2 --untracked-files=all -z", `1 M. N... 100644 100644 100644 ${"a".repeat(40)} ${"a".repeat(40)} staged.ts\u00001 .M N... 100644 100644 100644 ${"b".repeat(40)} ${"b".repeat(40)} unstaged.ts\u0000? untracked.ts\u00002 R. N... 100644 100644 100644 ${"c".repeat(40)} ${"c".repeat(40)} R100 renamed.ts\u0000old.ts\u0000`],
  ]);
  const result = captureRepositoryGitSnapshot("/tmp/repository", (args) => {
    mutableCalls.push([...args]);
    const value = outputs.get(args.join(" "));
    if (value === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
    return value;
  });
  assert.deepEqual({ staged: result.stagedCount, unstaged: result.unstagedCount, untracked: result.untrackedCount, dirty: result.dirty }, { staged: 2, unstaged: 1, untracked: 1, dirty: true });
  assert.ok(result.statusSummary.length <= 1_024);
  assert.equal(result.statusRecordCount, 4);
  assert.equal(result.statusEntries?.[3]?.sourcePath, "old.ts");
  assert.match(result.digestSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(result.statusPorcelainV2Base64 ?? "", "base64").includes(0), true);
  assert.deepEqual(calls.map((args) => args[0]), ["symbolic-ref", "rev-parse", "status"]);
  const prohibited = /^(stash|commit|reset|clean|restore|checkout|branch|worktree)$/;
  assert.equal(calls.some((args) => prohibited.test(args[0] ?? "")), false);
});

test("admission captures authoritative post-plan status inside ownership critical section", () => {
  const root = fixture("authoritative-reread");
  const owner = fingerprint(40501);
  const finalHead = "c".repeat(40);
  const deps: RepositoryAdmissionDependencies = {
    ...dependencies(owner),
    runGit: (args) => {
      if (args[0] === "symbolic-ref") return "feature/drifted\n";
      if (args[0] === "rev-parse") return `${finalHead}\n`;
      if (args[0] === "status") return "? arrived-after-plan.txt\0";
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    },
  };
  try {
    const background = acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      deploymentId: "d-background-drift",
      deploymentDirectory: join(root, "background"),
      runtime: "pi",
      mode: "implement",
      launchMode: "background",
      team: "builder",
      pid: owner.pid,
      processFingerprint: owner,
      dependencies: deps,
    });
    assert.equal(background.status, "rejected");
    assert.equal(background.evidenceState, "dirty-background");
    assert.match(background.diagnostic, /branch=feature\/drifted/);
    assert.ok(background.diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
    assert.equal(existsSync(repositoryMutationLeasePath(root)), false);

    const foreground = acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      deploymentId: "d-foreground-drift",
      deploymentDirectory: join(root, "foreground"),
      runtime: "opencode",
      mode: "implement",
      launchMode: "foreground",
      team: "builder",
      pid: owner.pid,
      processFingerprint: owner,
      dependencies: deps,
    });
    assert.equal(foreground.status, "acquired");
    if (foreground.status === "acquired") {
      assert.deepEqual({
        branch: foreground.lease.preLaunchGitSnapshot.branch,
        head: foreground.lease.preLaunchGitSnapshot.head,
        stagedCount: foreground.lease.preLaunchGitSnapshot.stagedCount,
        unstagedCount: foreground.lease.preLaunchGitSnapshot.unstagedCount,
        untrackedCount: foreground.lease.preLaunchGitSnapshot.untrackedCount,
        dirty: foreground.lease.preLaunchGitSnapshot.dirty,
      }, {
        branch: "feature/drifted",
        head: finalHead,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 1,
        dirty: true,
      });
      assert.equal(foreground.lease.preLaunchGitSnapshot.statusEntries?.[0]?.path, "arrived-after-plan.txt");
      assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: root, ownershipToken: foreground.lease.ownershipToken }).status, "released");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("50 simultaneous cross-process ppa/opa contenders yield exactly one owner while different roots remain independent", async () => {
  const root = fixture("concurrency");
  const otherRoot = fixture("independent");
  const moduleUrl = new URL("../deploy/repository-admission.ts", import.meta.url).href;
  const childScript = `
    import { acquireRepositoryMutationLease } from ${JSON.stringify(moduleUrl)};
    const root = process.argv[1];
    const index = Number(process.argv[2]);
    const result = acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      deploymentId: "d-contender-" + index,
      deploymentDirectory: root + "/deployment-" + index,
      runtime: index % 2 === 0 ? "pi" : "opencode",
      mode: "implement",
      ownershipToken: "contender-" + index,
      gitSnapshot: ${JSON.stringify(snapshot)},
    });
    process.stdout.write(JSON.stringify({ status: result.status, evidenceState: result.evidenceState }) + "\\n");
    // Keep the winner alive long enough for all 50 tsx processes to finish startup
    // even while the full test suite is saturating the host.
    if (result.status === "acquired") setTimeout(() => {}, 10000);
  `;
  try {
    const attempts = await Promise.all(Array.from({ length: 50 }, (_, index) => new Promise<{ status: string; evidenceState: string }>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript, root, String(index)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code !== 0) rejectPromise(new Error(`contender ${index} exited ${code}: ${stderr}`));
        else {
          try { resolvePromise(JSON.parse(stdout.trim()) as { status: string; evidenceState: string }); }
          catch (error) { rejectPromise(new Error(`contender ${index} returned invalid output ${JSON.stringify(stdout)}: ${String(error)}`)); }
        }
      });
    })));
    assert.equal(attempts.filter((attempt) => attempt.status === "acquired").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && attempt.evidenceState === "live").length, 49);
    const independent = acquire(otherRoot, fingerprint(41002));
    assert.equal(independent.status, "acquired");
    assert.notEqual(repositoryMutationLeasePath(root), repositoryMutationLeasePath(otherRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("PID reuse is stale, force quarantines exact bytes, and lease mode is 0600", () => {
  const root = fixture("pid-reuse");
  const original = fingerprint(42001, "old-start");
  try {
    const first = acquire(root, original, { token: "original-token" });
    assert.equal(first.status, "acquired");
    const leasePath = repositoryMutationLeasePath(root);
    const exactBytes = readFileSync(leasePath);
    const reused = fingerprint(original.pid, "new-start");
    const staleDeps = dependencies(reused);
    const inspection = inspectRepositoryMutationLease(root, staleDeps);
    assert.equal(inspection.state, "stale");
    const rejected = acquire(root, reused, { deps: staleDeps });
    assert.equal(rejected.status, "rejected");
    const recovered = acquire(root, reused, { force: true, token: "replacement-token", deps: staleDeps });
    assert.equal(recovered.status, "acquired");
    assert.ok(recovered.quarantinedPath);
    assert.deepEqual(readFileSync(recovered.quarantinedPath!), exactBytes);
    assert.equal(statSync(leasePath).mode & 0o777, 0o600);
    assert.ok(statSync(leasePath).size <= MAX_REPOSITORY_LEASE_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed, oversized, and root-conflicting evidence reject without force and recover with force", () => {
  for (const evidenceCase of ["malformed", "oversized", "root-conflicting"] as const) {
    const root = fixture(evidenceCase);
    const leasePath = repositoryMutationLeasePath(root);
    const owner = fingerprint(43000 + evidenceCase.length);
    const replacement = fingerprint(53000 + evidenceCase.length);
    try {
      let bytes: Buffer;
      if (evidenceCase === "malformed") bytes = Buffer.from("{ definitely-not-json\n");
      else if (evidenceCase === "oversized") bytes = Buffer.alloc(MAX_REPOSITORY_LEASE_BYTES + 1, 0x78);
      else {
        const seeded = acquire(root, owner, { token: "wrong-root-token" });
        assert.equal(seeded.status, "acquired");
        const value = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
        value["canonicalRepoRoot"] = `${root}-other`;
        bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      }
      writeFileSync(leasePath, bytes);
      const replacementDeps = dependencies(replacement);
      const rejected = acquire(root, replacement, { deps: replacementDeps });
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.evidenceState, evidenceCase);
      assert.deepEqual(readFileSync(leasePath), bytes);
      const recovered = acquire(root, replacement, { force: true, token: "recovered", deps: replacementDeps });
      assert.equal(recovered.status, "acquired");
      assert.ok(recovered.quarantinedPath);
      assert.deepEqual(readFileSync(recovered.quarantinedPath!), bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("abrupt owner death releases the advisory mutex so force recovery can proceed", { timeout: 15_000 }, async () => {
  const root = fixture("abrupt-mutex-owner");
  const leasePath = repositoryMutationLeasePath(root);
  const mutexPath = join(root, ".git", "pa-repository-mutation.lease.lock");
  const moduleUrl = new URL("../deploy/repository-admission.ts", import.meta.url).href;
  writeFileSync(leasePath, "{ malformed before abrupt recovery\n");
  const childScript = `
    import { acquireRepositoryMutationLease } from ${JSON.stringify(moduleUrl)};
    acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: ${JSON.stringify(root)},
      deploymentId: "d-abrupt",
      deploymentDirectory: ${JSON.stringify(join(root, "deployment"))},
      runtime: "pi",
      mode: "implement",
      force: true,
      dependencies: { runGit: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100000); return ""; } },
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    let held = false;
    while (Date.now() < deadline && !held) {
      if (existsSync(mutexPath)) {
        try { execFileSync("flock", ["--nonblock", mutexPath, "true"], { stdio: "ignore" }); }
        catch { held = true; }
      }
      if (!held) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.equal(held, true, "child never acquired the advisory mutex");
    child.kill("SIGKILL");
    await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));

    const owner = fingerprint(43500);
    const recovered = acquire(root, owner, { force: true, token: "post-crash-owner", deps: dependencies(owner) });
    assert.equal(recovered.status, "acquired");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("an orphaned mutex file cannot block inspection or forced stale recovery", () => {
  const root = fixture("orphaned-mutex");
  const oldOwner = fingerprint(43501);
  const replacement = fingerprint(43502);
  try {
    assert.equal(acquire(root, oldOwner, { token: "old-owner" }).status, "acquired");
    writeFileSync(join(root, ".git", "pa-repository-mutation.lease.lock"), "orphaned-owner-bytes\n", { mode: 0o600 });
    const staleDeps = dependencies(replacement);
    assert.equal(inspectRepositoryMutationLease(root, staleDeps).state, "stale");
    const recovered = acquire(root, replacement, { force: true, token: "replacement", deps: staleDeps });
    assert.equal(recovered.status, "acquired");
    assert.ok(recovered.quarantinedPath);
    assert.equal(readFileSync(join(root, ".git", "pa-repository-mutation.lease.lock"), "utf8"), "orphaned-owner-bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("safe manual quarantine rejects replacement and verified-live races", () => {
  const root = fixture("quarantine-race");
  const oldOwner = fingerprint(43601);
  const liveReplacement = fingerprint(43602);
  try {
    assert.equal(acquire(root, oldOwner, { token: "old-owner" }).status, "acquired");
    const staleInspection = inspectRepositoryMutationLease(root, dependencies(liveReplacement));
    assert.equal(staleInspection.state, "stale");
    assert.ok(staleInspection.evidenceIdentity);

    const leasePath = repositoryMutationLeasePath(root);
    const replacementLease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    replacementLease["ownershipToken"] = "live-replacement";
    replacementLease["deploymentId"] = "d-live-replacement";
    replacementLease["processFingerprint"] = liveReplacement;
    writeFileSync(leasePath, `${JSON.stringify(replacementLease)}\n`);
    const liveResult = quarantineRepositoryMutationLease({
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      expectedEvidenceIdentity: staleInspection.evidenceIdentity!,
      dependencies: dependencies(liveReplacement),
    });
    assert.equal(liveResult.status, "rejected");
    if (liveResult.status === "rejected") assert.equal(liveResult.evidenceState, "live");
    assert.equal((JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>)["ownershipToken"], "live-replacement");

    writeFileSync(leasePath, "{ replacement-malformed\n");
    const mismatch = quarantineRepositoryMutationLease({
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      expectedEvidenceIdentity: staleInspection.evidenceIdentity!,
      dependencies: dependencies(),
    });
    assert.equal(mismatch.status, "rejected");
    if (mismatch.status === "rejected") assert.equal(mismatch.evidenceState, "identity-mismatch");
    assert.equal(readFileSync(leasePath, "utf8"), "{ replacement-malformed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("safe manual quarantine uses the mutex and a unique no-clobber destination", () => {
  const root = fixture("quarantine-no-clobber");
  const owner = fingerprint(43701);
  try {
    assert.equal(acquire(root, owner, { token: "stale-owner" }).status, "acquired");
    const inspection = inspectRepositoryMutationLease(root, dependencies());
    assert.ok(inspection.evidenceIdentity);
    const leasePath = repositoryMutationLeasePath(root);
    const collision = `${leasePath}.quarantine.2026-09-05T13-00-00-000Z.manual-token`;
    writeFileSync(collision, "preserve existing quarantine\n");
    const result = quarantineRepositoryMutationLease({
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      expectedEvidenceIdentity: inspection.evidenceIdentity!,
      dependencies: {
        ...dependencies(),
        createToken: () => "manual-token",
      },
    });
    assert.equal(result.status, "quarantined");
    if (result.status === "quarantined") assert.equal(result.quarantinePath, `${collision}-1`);
    assert.equal(readFileSync(collision, "utf8"), "preserve existing quarantine\n");
    assert.equal(existsSync(leasePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified process evidence is authoritative even when schema is malformed and force never quarantines it", () => {
  const root = fixture("malformed-live");
  const owner = fingerprint(44001);
  const leasePath = repositoryMutationLeasePath(root);
  try {
    writeFileSync(leasePath, JSON.stringify({ deploymentId: "d-live", runtime: "pi", mode: "implement", processFingerprint: owner }));
    const liveDeps = dependencies(owner);
    const result = acquire(root, owner, { force: true, deps: liveDeps });
    assert.equal(result.status, "rejected");
    assert.equal(result.evidenceState, "live");
    assert.equal(readdirSync(join(root, ".git")).some((name) => name.includes("quarantine")), false);
    assert.doesNotMatch(result.diagnostic, /--force|manual quarantine|\bmv\b/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transfer and release are atomic, token-owned, and preserve replacement ownership", () => {
  const root = fixture("token");
  const owner = fingerprint(45001);
  const supervisor = fingerprint(45002);
  try {
    const first = acquire(root, owner, { token: "owner-token" });
    assert.equal(first.status, "acquired");
    const changedSnapshot = Object.freeze({ ...snapshot, branch: "feature/changed", head: "b".repeat(40) });
    assert.deepEqual(updateRepositoryMutationLeaseGitSnapshot({ canonicalRepoRoot: root, ownershipToken: "intruder", gitSnapshot: changedSnapshot }), { status: "token-mismatch" });
    const updated = updateRepositoryMutationLeaseGitSnapshot({ canonicalRepoRoot: root, ownershipToken: "owner-token", gitSnapshot: changedSnapshot });
    assert.equal(updated.status, "updated");
    if (updated.status === "updated") {
      assert.equal(repositoryGitSnapshotsEqual(updated.lease!.preLaunchGitSnapshot, changedSnapshot), true);
      assert.deepEqual(updated.lease!.processFingerprint, owner);
    }
    assert.deepEqual(transferRepositoryMutationLease({ canonicalRepoRoot: root, ownershipToken: "intruder", nextProcessFingerprint: supervisor, dependencies: dependencies(supervisor) }), { status: "token-mismatch" });
    const transferred = transferRepositoryMutationLease({ canonicalRepoRoot: root, ownershipToken: "owner-token", nextProcessFingerprint: supervisor, dependencies: dependencies(supervisor) });
    assert.equal(transferred.status, "transferred");
    if (transferred.status === "transferred") assert.deepEqual(transferred.lease?.processFingerprint, supervisor);
    assert.deepEqual(releaseRepositoryMutationLease({ canonicalRepoRoot: root, ownershipToken: "old-launcher-token" }), { status: "token-mismatch" });
    assert.ok(statSync(repositoryMutationLeasePath(root)).isFile());
    assert.deepEqual(releaseRepositoryMutationLease({ canonicalRepoRoot: root, ownershipToken: "owner-token" }), { status: "released" });
    const replacement = acquire(root, owner, { token: "replacement-token" });
    assert.equal(replacement.status, "acquired");
    assert.deepEqual(releaseRepositoryMutationLease({ canonicalRepoRoot: root, ownershipToken: "owner-token" }), { status: "token-mismatch" });
    assert.ok(statSync(repositoryMutationLeasePath(root)).isFile());
    assert.deepEqual(releaseRepositoryMutationLease({ canonicalRepoRoot: root, ownershipToken: "replacement-token" }), { status: "released" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated direct child registration is separate, bounded, mode 0600, and launch-failure rollback preserves parent bytes", () => {
  const root = fixture("borrow-register");
  const parent = fingerprint(45501);
  const child = fingerprint(45502);
  const deps = familyDependencies([parent, child]);
  try {
    const parentLease = acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      deploymentId: "d-parent",
      deploymentDirectory: join(root, "parent"),
      runtime: "pi",
      mode: "orchestrator",
      pid: parent.pid,
      processFingerprint: parent,
      ownershipToken: "private-parent-capability",
      gitSnapshot: snapshot,
      dependencies: deps,
    });
    assert.equal(parentLease.status, "acquired");
    const leaseBytes = readFileSync(repositoryMutationLeasePath(root));
    const registration = registerRepositoryMutationBorrower({
      capability: "private-parent-capability",
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      parentDeploymentId: "d-parent",
      deploymentId: "d-child",
      deploymentDirectory: join(root, "child"),
      runtime: "pi",
      team: "builder",
      mode: "implement",
      launchMode: "background",
      ticket: "PAP-191",
      branch: snapshot.branch,
      timeoutSeconds: 60,
      pid: child.pid,
      processFingerprint: child,
      gitSnapshot: snapshot,
      dependencies: deps,
    });
    assert.equal(registration.status, "registered");
    if (registration.status !== "registered") return;
    const borrowerPath = repositoryMutationBorrowerPath(root);
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), leaseBytes);
    assert.equal(statSync(borrowerPath).mode & 0o777, 0o600);
    assert.ok(statSync(borrowerPath).size <= MAX_REPOSITORY_BORROWER_BYTES);
    assert.doesNotMatch(readFileSync(borrowerPath, "utf8"), /private-parent-capability/);
    assert.equal(inspectRepositoryMutationBorrower(root, deps).state, "live");
    assert.deepEqual(releaseRepositoryMutationBorrower({ canonicalRepoRoot: root, borrowerToken: "wrong" }), { status: "token-mismatch" });
    assert.equal(releaseRepositoryMutationBorrower({ canonicalRepoRoot: root, borrowerToken: registration.borrower.borrowerToken }).status, "released");
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), leaseBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classified dirty receipt is private, consume-once, scope-bound, and leaves parent bytes unchanged", () => {
  const root = fixture("dirty-receipt");
  const parent = fingerprint(45511);
  const child = fingerprint(45512);
  const deps = familyDependencies([parent, child]);
  const dirty = completeSnapshot(root);
  const parentDirectory = join(root, "parent");
  try {
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture", canonicalRepoRoot: root, deploymentId: "d-parent", deploymentDirectory: parentDirectory,
      runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", pid: parent.pid, processFingerprint: parent,
      ownershipToken: "dirty-parent-capability", gitSnapshot: dirty, dependencies: deps,
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    const leaseBytes = readFileSync(repositoryMutationLeasePath(root));
    const inspection = inspectRepositoryMutationLease(root, deps);
    assert.ok(inspection.evidenceIdentity);
    const approval: RepositoryDirtyBorrowApproval = {
      schemaVersion: 1,
      receiptId: "private-receipt-id",
      approvalReference: "private-tool-call-reference",
      approvedAt: "2026-09-11T13:00:00.000Z",
      action: "preserve-and-continue",
      parentDeploymentId: "d-parent",
      parentDeploymentDirectory: parentDirectory,
      parentProcessFingerprint: parent,
      parentLeaseEvidenceIdentity: inspection.evidenceIdentity!,
      canonicalRepoKey: "fixture",
      canonicalRepoRoot: root,
      ticket: "PAP-191",
      branch: dirty.branch,
      snapshot: dirty,
      classifications: [{ path: "ticket-work.ts", classification: "active-ticket-preserved" }],
      plannedNewPaths: ["new-approved.ts"],
    };
    const approvalPath = publishRepositoryDirtyBorrowApproval(approval, deps);
    assert.equal(approvalPath, repositoryDirtyBorrowApprovalPath(parentDirectory));
    assert.equal(statSync(approvalPath).mode & 0o777, 0o600);
    assert.ok(statSync(approvalPath).size <= MAX_REPOSITORY_DIRTY_APPROVAL_BYTES);
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), leaseBytes);

    const registered = registerRepositoryMutationBorrower({
      capability: "dirty-parent-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
      deploymentId: "d-child", deploymentDirectory: join(root, "child"), runtime: "pi", team: "builder", mode: "implement",
      launchMode: "background", ticket: "PAP-191", branch: dirty.branch, timeoutSeconds: 60,
      pid: child.pid, processFingerprint: child, expectedGitSnapshot: dirty, gitSnapshot: dirty, dirtyApprovalPath: approvalPath, dependencies: deps,
    });
    assert.equal(registered.status, "registered");
    if (registered.status !== "registered") return;
    assert.equal(existsSync(approvalPath), false);
    assert.deepEqual(registered.borrower.approvedMutationPaths, ["new-approved.ts", "ticket-work.ts"]);
    assert.doesNotMatch(registered.diagnostic, /private-receipt-id|private-tool-call-reference|dirty-parent-capability|[0-9a-f]{64}/);
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), leaseBytes);

    const escaped = captureRepositoryGitSnapshot(root, (args) => {
      if (args[0] === "symbolic-ref") return `${dirty.branch}\n`;
      if (args[0] === "rev-parse") return `${dirty.head}\n`;
      if (args[0] === "status") return `${Buffer.from(dirty.statusPorcelainV2Base64!, "base64").toString("utf8")}? outside.ts\0`;
      throw new Error("unexpected command");
    });
    const finalization = finalizeRepositoryMutationBorrower({
      canonicalRepoRoot: root, borrowerToken: registered.borrower.borrowerToken, deploymentId: "d-child",
      finalGitSnapshot: escaped, dependencies: deps,
    });
    assert.equal(finalization.status, "finalized");
    if (finalization.status === "finalized") {
      assert.equal(finalization.scopeCompliant, false);
      assert.equal(finalization.parentLease, "retained");
      assert.equal(finalization.finalGitSnapshot.statusEntries?.at(-1)?.path, "outside.ts");
    }
    const replay = registerRepositoryMutationBorrower({
      capability: "dirty-parent-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
      deploymentId: "d-replay", deploymentDirectory: join(root, "replay"), runtime: "pi", team: "builder", mode: "implement",
      launchMode: "background", ticket: "PAP-191", branch: dirty.branch, timeoutSeconds: 60,
      pid: child.pid, processFingerprint: child, expectedGitSnapshot: dirty, gitSnapshot: dirty, dirtyApprovalPath: approvalPath, dependencies: deps,
    });
    assert.equal(replay.status, "rejected");
    if (replay.status === "rejected") assert.equal(replay.category, "dirty-approval");

    const external = join(root, "external-receipt-target");
    writeFileSync(external, "protected target\n", { mode: 0o600 });
    for (const attack of ["symlink", "hardlink", "oversized"] as const) {
      if (attack === "symlink") symlinkSync(external, approvalPath);
      else if (attack === "hardlink") linkSync(external, approvalPath);
      else writeFileSync(approvalPath, "x".repeat(MAX_REPOSITORY_DIRTY_APPROVAL_BYTES + 1), { mode: 0o600 });
      const rejected = registerRepositoryMutationBorrower({
        capability: "dirty-parent-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
        deploymentId: `d-${attack}`, deploymentDirectory: join(root, attack), runtime: "pi", team: "builder", mode: "implement",
        launchMode: "background", ticket: "PAP-191", branch: dirty.branch, timeoutSeconds: 60,
        pid: child.pid, processFingerprint: child, expectedGitSnapshot: dirty, gitSnapshot: dirty, dirtyApprovalPath: approvalPath, dependencies: deps,
      });
      assert.equal(rejected.status, "rejected");
      if (rejected.status === "rejected") assert.equal(rejected.category, "dirty-approval");
      assert.equal(readFileSync(external, "utf8"), "protected target\n");
      assert.equal(existsSync(approvalPath), false);
    }
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), leaseBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty receipt drift in path, XY, full HEAD, or branch consumes authority and admits no borrower", () => {
  const cases = [
    { name: "path", candidate: (root: string) => completeSnapshot(root, "other.ts") },
    { name: "xy", candidate: (root: string) => completeSnapshot(root, "ticket-work.ts", "M.") },
    { name: "head", candidate: (root: string) => completeSnapshot(root, "ticket-work.ts", ".M", "f".repeat(40)) },
    { name: "branch", candidate: (root: string) => completeSnapshot(root, "ticket-work.ts", ".M", "d".repeat(40), "feature/PAP-191-drifted") },
  ];
  for (const item of cases) {
    const root = fixture(`dirty-drift-${item.name}`);
    const parent = fingerprint(45601);
    const child = fingerprint(45602);
    const deps = familyDependencies([parent, child]);
    const approvedSnapshot = completeSnapshot(root);
    const parentDirectory = join(root, "parent");
    try {
      const acquired = acquireRepositoryMutationLease({
        canonicalRepoKey: "fixture", canonicalRepoRoot: root, deploymentId: "d-parent", deploymentDirectory: parentDirectory,
        runtime: "pi", team: "builder", mode: "orchestrator", launchMode: "foreground", pid: parent.pid,
        processFingerprint: parent, ownershipToken: "drift-capability", gitSnapshot: approvedSnapshot, dependencies: deps,
      });
      assert.equal(acquired.status, "acquired");
      if (acquired.status !== "acquired") continue;
      const inspection = inspectRepositoryMutationLease(root, deps);
      const approval: RepositoryDirtyBorrowApproval = {
        schemaVersion: 1, receiptId: `receipt-${item.name}`, approvalReference: `call-${item.name}`,
        approvedAt: "2026-09-11T13:00:00.000Z", action: "preserve-and-continue", parentDeploymentId: "d-parent",
        parentDeploymentDirectory: parentDirectory, parentProcessFingerprint: parent, parentLeaseEvidenceIdentity: inspection.evidenceIdentity!,
        canonicalRepoKey: "fixture", canonicalRepoRoot: root, ticket: "PAP-191", branch: approvedSnapshot.branch,
        snapshot: approvedSnapshot, classifications: [{ path: "ticket-work.ts", classification: "active-ticket-produced" }], plannedNewPaths: [],
      };
      const approvalPath = publishRepositoryDirtyBorrowApproval(approval, deps);
      const parentBytes = readFileSync(repositoryMutationLeasePath(root));
      const candidate = item.candidate(root);
      const result = registerRepositoryMutationBorrower({
        capability: "drift-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
        deploymentId: "d-child", deploymentDirectory: join(root, "child"), runtime: "pi", team: "builder", mode: "implement",
        launchMode: "background", ticket: "PAP-191", branch: approvedSnapshot.branch, timeoutSeconds: 60,
        pid: child.pid, processFingerprint: child, expectedGitSnapshot: candidate, gitSnapshot: candidate,
        dirtyApprovalPath: approvalPath, dependencies: deps,
      });
      assert.equal(result.status, "rejected", item.name);
      assert.equal(existsSync(approvalPath), false, `${item.name}: matching attempt must consume the receipt`);
      assert.equal(existsSync(repositoryMutationBorrowerPath(root)), false);
      assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), parentBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("borrow rejection matrix fails closed with bounded redacted diagnostics and no parent mutation", () => {
  const cases = [
    { name: "capability", patch: { capability: "wrong-secret" } },
    { name: "parent", patch: { parentDeploymentId: "d-unrelated" } },
    { name: "repository", patch: { canonicalRepoKey: "unrelated" } },
    { name: "child", patch: { deploymentId: "d-parent" } },
    { name: "runtime", patch: { runtime: "opencode" as const } },
    { name: "team", patch: { team: "requirements" } },
    { name: "mode", patch: { mode: "orchestrator" } },
    { name: "launch", patch: { launchMode: "foreground" as const } },
    { name: "ticket", patch: { ticket: "PAP-192" } },
    { name: "branch", patch: { branch: "feature/PAP-191-other" } },
    { name: "snapshot", patch: { expectedGitSnapshot: { ...snapshot, head: "f".repeat(40) } } },
    { name: "timeout", patch: { timeoutSeconds: 59 } },
  ] as const;
  for (const rejection of cases) {
    const root = fixture(`borrow-reject-${rejection.name}`);
    const parent = fingerprint(45600 + rejection.name.length);
    const child = fingerprint(45700 + rejection.name.length);
    const deps = familyDependencies([parent, child]);
    try {
      assert.equal(acquireRepositoryMutationLease({
        canonicalRepoKey: "fixture",
        canonicalRepoRoot: root,
        deploymentId: "d-parent",
        deploymentDirectory: join(root, "parent"),
        runtime: "pi",
        mode: "orchestrator",
        pid: parent.pid,
        processFingerprint: parent,
        ownershipToken: "matrix-private-capability",
        gitSnapshot: snapshot,
        dependencies: deps,
      }).status, "acquired");
      const exactLease = readFileSync(repositoryMutationLeasePath(root));
      const result = registerRepositoryMutationBorrower({
        capability: "matrix-private-capability",
        canonicalRepoKey: "fixture",
        canonicalRepoRoot: root,
        parentDeploymentId: "d-parent",
        deploymentId: "d-child",
        deploymentDirectory: join(root, "child"),
        runtime: "pi",
        team: "builder",
        mode: "implement",
        launchMode: "background",
        ticket: "PAP-191",
        branch: snapshot.branch,
        timeoutSeconds: 60,
        pid: child.pid,
        processFingerprint: child,
        gitSnapshot: snapshot,
        dependencies: deps,
        ...rejection.patch,
      });
      assert.equal(result.status, "rejected", rejection.name);
      if (result.status === "rejected") {
        assert.ok(result.diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
        assert.match(result.diagnostic, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
        assert.doesNotMatch(result.diagnostic, /matrix-private-capability|wrong-secret/);
      }
      assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), exactLease);
      assert.equal(existsSync(repositoryMutationBorrowerPath(root)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("forbidden parent runtime/mode and stale parent fingerprints reject before borrower publication", () => {
  for (const parentCase of [
    { name: "runtime", runtime: "opencode" as const, mode: "orchestrator", parentLive: true },
    { name: "mode", runtime: "pi" as const, mode: "implement", parentLive: true },
    { name: "stale", runtime: "pi" as const, mode: "orchestrator", parentLive: false },
  ]) {
    const root = fixture(`borrow-parent-${parentCase.name}`);
    const parent = fingerprint(45750 + parentCase.name.length);
    const child = fingerprint(45780 + parentCase.name.length);
    const acquireDeps = familyDependencies([parent, child]);
    try {
      const acquired = acquireRepositoryMutationLease({
        canonicalRepoKey: "fixture", canonicalRepoRoot: root, deploymentId: "d-parent", deploymentDirectory: join(root, "parent"),
        runtime: parentCase.runtime, mode: parentCase.mode, pid: parent.pid, processFingerprint: parent,
        ownershipToken: "parent-matrix-capability", gitSnapshot: snapshot, dependencies: acquireDeps,
      });
      assert.equal(acquired.status, "acquired");
      const parentBytes = readFileSync(repositoryMutationLeasePath(root));
      const admissionDeps = familyDependencies(parentCase.parentLive ? [parent, child] : [child]);
      const result = registerRepositoryMutationBorrower({
        capability: "parent-matrix-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
        deploymentId: "d-child", deploymentDirectory: join(root, "child"), runtime: "pi", team: "builder", mode: "implement",
        launchMode: "background", ticket: "PAP-191", branch: snapshot.branch, timeoutSeconds: 60,
        pid: child.pid, processFingerprint: child, gitSnapshot: snapshot, dependencies: admissionDeps,
      });
      assert.equal(result.status, "rejected", parentCase.name);
      if (result.status === "rejected") {
        assert.equal(result.category, parentCase.name === "stale" ? "parent-state" : "parent-identity");
        assert.match(result.diagnostic, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
      }
      assert.equal(existsSync(repositoryMutationBorrowerPath(root)), false);
      assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), parentBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("every dirty Git category rejects borrowing with and without force before evidence publication", () => {
  for (const dirtyField of ["stagedCount", "unstagedCount", "untrackedCount"] as const) {
    for (const force of [false, true]) {
      const root = fixture(`borrow-dirty-${dirtyField}-${force}`);
      const parent = fingerprint(45801);
      const child = fingerprint(45802);
      const deps = familyDependencies([parent, child]);
      try {
        assert.equal(acquireRepositoryMutationLease({
          canonicalRepoKey: "fixture", canonicalRepoRoot: root, deploymentId: "d-parent", deploymentDirectory: join(root, "parent"),
          runtime: "pi", mode: "orchestrator", pid: parent.pid, processFingerprint: parent, ownershipToken: "dirty-capability", gitSnapshot: snapshot, dependencies: deps,
        }).status, "acquired");
        const leaseBytes = readFileSync(repositoryMutationLeasePath(root));
        const dirty = Object.freeze({ ...snapshot, [dirtyField]: 1, dirty: true, statusSummary: `${dirtyField}=1` });
        const result = registerRepositoryMutationBorrower({
          capability: "dirty-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
          deploymentId: "d-child", deploymentDirectory: join(root, "child"), runtime: "pi", team: "builder", mode: "implement",
          launchMode: "background", ticket: "PAP-191", branch: snapshot.branch, timeoutSeconds: 60, pid: child.pid, processFingerprint: child,
          gitSnapshot: dirty, force, dependencies: deps,
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.equal(result.category, "dirty-approval");
        assert.equal(existsSync(repositoryMutationBorrowerPath(root)), false);
        assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), leaseBytes);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("live siblings and abnormal-parent borrowers gate release and force while fingerprint-stale evidence is recoverable", () => {
  const root = fixture("borrow-lifecycle");
  const parent = fingerprint(45901);
  const launcher = fingerprint(45902);
  const child = fingerprint(45903);
  const liveFamily = familyDependencies([parent, launcher, child]);
  try {
    assert.equal(acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture", canonicalRepoRoot: root, deploymentId: "d-parent", deploymentDirectory: join(root, "parent"),
      runtime: "pi", mode: "orchestrator", pid: parent.pid, processFingerprint: parent, ownershipToken: "family-capability", gitSnapshot: snapshot, dependencies: liveFamily,
    }).status, "acquired");
    const parentBytes = readFileSync(repositoryMutationLeasePath(root));
    const first = registerRepositoryMutationBorrower({
      capability: "family-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
      deploymentId: "d-first", deploymentDirectory: join(root, "first"), runtime: "pi", team: "builder", mode: "implement",
      launchMode: "background", ticket: "PAP-191", branch: snapshot.branch, timeoutSeconds: 60, pid: launcher.pid, processFingerprint: launcher,
      gitSnapshot: snapshot, dependencies: liveFamily,
    });
    assert.equal(first.status, "registered");
    if (first.status !== "registered") return;
    const second = registerRepositoryMutationBorrower({
      capability: "family-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
      deploymentId: "d-second", deploymentDirectory: join(root, "second"), runtime: "pi", team: "builder", mode: "implement",
      launchMode: "background", ticket: "PAP-191", branch: snapshot.branch, timeoutSeconds: 60, pid: child.pid, processFingerprint: child,
      gitSnapshot: snapshot, force: true, dependencies: liveFamily,
    });
    assert.equal(second.status, "rejected");
    assert.equal(releaseRepositoryMutationLease({ canonicalRepoRoot: root, ownershipToken: "family-capability", dependencies: liveFamily }).status, "borrower-live");
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), parentBytes);

    assert.equal(transferRepositoryMutationBorrower({ canonicalRepoRoot: root, borrowerToken: first.borrower.borrowerToken, nextProcessFingerprint: child, dependencies: liveFamily }).status, "transferred");
    const childOnly = familyDependencies([child]);
    assert.equal(inspectRepositoryMutationLease(root, childOnly).state, "stale");
    assert.equal(inspectRepositoryMutationBorrower(root, childOnly).state, "live");
    const blocked = acquire(root, fingerprint(45904), { force: true, deps: familyDependencies([child, fingerprint(45904)]) });
    assert.equal(blocked.status, "rejected");
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), parentBytes);

    const replacement = fingerprint(45905);
    const recovered = acquire(root, replacement, { force: true, deps: familyDependencies([replacement]) });
    assert.equal(recovered.status, "acquired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matching borrower finalization publishes final Git state, preserves live parent bytes, and admits the next clean child", () => {
  const root = fixture("borrow-finalization");
  const parent = fingerprint(45911);
  const firstProcess = fingerprint(45912);
  const secondProcess = fingerprint(45913);
  const liveFamily = familyDependencies([parent, firstProcess, secondProcess]);
  const finalSnapshot = Object.freeze({ ...snapshot, head: "b".repeat(40) });
  try {
    const acquired = acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture", canonicalRepoRoot: root, deploymentId: "d-parent", deploymentDirectory: join(root, "parent"),
      runtime: "pi", mode: "orchestrator", pid: parent.pid, processFingerprint: parent, ownershipToken: "finalize-capability",
      gitSnapshot: snapshot, dependencies: liveFamily,
    });
    assert.equal(acquired.status, "acquired");
    const parentBytes = readFileSync(repositoryMutationLeasePath(root));
    const first = registerRepositoryMutationBorrower({
      capability: "finalize-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
      deploymentId: "d-first", deploymentDirectory: join(root, "first"), runtime: "pi", team: "builder", mode: "implement",
      launchMode: "background", ticket: "PAP-191", branch: snapshot.branch, timeoutSeconds: 60,
      pid: firstProcess.pid, processFingerprint: firstProcess, gitSnapshot: snapshot, dependencies: liveFamily,
    });
    assert.equal(first.status, "registered");
    if (first.status !== "registered") return;
    const finalized = finalizeRepositoryMutationBorrower({
      canonicalRepoRoot: root, borrowerToken: first.borrower.borrowerToken, deploymentId: "d-first",
      finalGitSnapshot: finalSnapshot, dependencies: liveFamily,
    });
    assert.deepEqual(finalized, { status: "finalized", parentLease: "retained", finalGitSnapshot: finalSnapshot });
    assert.deepEqual(finalizeRepositoryMutationBorrower({
      canonicalRepoRoot: root, borrowerToken: first.borrower.borrowerToken, deploymentId: "d-first",
      finalGitSnapshot: finalSnapshot, dependencies: liveFamily,
    }), { status: "absent" });
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(root)), parentBytes);
    assert.equal(inspectRepositoryMutationBorrower(root, liveFamily).state, "absent");

    const second = registerRepositoryMutationBorrower({
      capability: "finalize-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
      deploymentId: "d-second", deploymentDirectory: join(root, "second"), runtime: "pi", team: "builder", mode: "implement",
      launchMode: "background", ticket: "PAP-191", branch: snapshot.branch, timeoutSeconds: 60,
      pid: secondProcess.pid, processFingerprint: secondProcess, gitSnapshot: finalSnapshot, dependencies: liveFamily,
    });
    assert.equal(second.status, "registered");
    if (second.status !== "registered") return;
    const terminalParent = familyDependencies([secondProcess]);
    const terminal = finalizeRepositoryMutationBorrower({
      canonicalRepoRoot: root, borrowerToken: second.borrower.borrowerToken, deploymentId: "d-second",
      finalGitSnapshot: finalSnapshot, dependencies: terminalParent,
    });
    assert.equal(terminal.status, "finalized");
    if (terminal.status === "finalized") assert.equal(terminal.parentLease, "released");
    assert.equal(inspectRepositoryMutationLease(root, terminalParent).state, "absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent finalization waits until borrower mismatch and stops at timeout plus 5000ms without releasing live family authority", async () => {
  const setup = (name: string) => {
    const root = fixture(name);
    const parent = fingerprint(name === "borrow-wait-release" ? 45921 : 45931);
    const child = fingerprint(name === "borrow-wait-release" ? 45922 : 45932);
    const deps = familyDependencies([parent, child]);
    assert.equal(acquireRepositoryMutationLease({
      canonicalRepoKey: "fixture", canonicalRepoRoot: root, deploymentId: "d-parent", deploymentDirectory: join(root, "parent"),
      runtime: "pi", mode: "orchestrator", pid: parent.pid, processFingerprint: parent, ownershipToken: "wait-capability",
      gitSnapshot: snapshot, dependencies: deps,
    }).status, "acquired");
    const registration = registerRepositoryMutationBorrower({
      capability: "wait-capability", canonicalRepoKey: "fixture", canonicalRepoRoot: root, parentDeploymentId: "d-parent",
      deploymentId: "d-child", deploymentDirectory: join(root, "child"), runtime: "pi", team: "builder", mode: "implement",
      launchMode: "background", ticket: "PAP-191", branch: snapshot.branch, timeoutSeconds: 60,
      pid: child.pid, processFingerprint: child, gitSnapshot: snapshot, dependencies: deps,
    });
    assert.equal(registration.status, "registered");
    return { root, parent, child, registeredAt: Date.parse("2026-09-11T13:00:00.000Z") };
  };

  const released = setup("borrow-wait-release");
  let releaseClock = released.registeredAt;
  let childLive = true;
  try {
    const result = await finalizeRepositoryMutationLease({
      canonicalRepoRoot: released.root,
      ownershipToken: "wait-capability",
      dependencies: {
        now: () => releaseClock,
        sleep: async (milliseconds) => { releaseClock += milliseconds; childLive = false; },
        getProcessFingerprint: (pid) => pid === released.parent.pid ? released.parent : childLive && pid === released.child.pid ? released.child : undefined,
      },
    });
    assert.equal(result.status, "released");
    assert.equal(result.waitedMs, 100);
    assert.equal(inspectRepositoryMutationLease(released.root).state, "absent");
  } finally {
    rmSync(released.root, { recursive: true, force: true });
  }

  const retained = setup("borrow-wait-retain");
  let retainedClock = retained.registeredAt;
  try {
    const parentBytes = readFileSync(repositoryMutationLeasePath(retained.root));
    const result = await finalizeRepositoryMutationLease({
      canonicalRepoRoot: retained.root,
      ownershipToken: "wait-capability",
      dependencies: {
        now: () => retainedClock,
        sleep: async () => { retainedClock += 65_000; },
        getProcessFingerprint: (pid) => pid === retained.parent.pid ? retained.parent : pid === retained.child.pid ? retained.child : undefined,
      },
    });
    assert.equal(result.status, "borrower-live");
    assert.equal(result.waitedMs, 65_000);
    assert.match(result.diagnostic ?? "", /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
    assert.ok((result.diagnostic ?? "").length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
    assert.deepEqual(readFileSync(repositoryMutationLeasePath(retained.root)), parentBytes);
    assert.equal(inspectRepositoryMutationBorrower(retained.root, familyDependencies([retained.child])).state, "live");
  } finally {
    rmSync(retained.root, { recursive: true, force: true });
  }
});

test("all evidence diagnostics are bounded and expose only applicable recovery commands", () => {
  const root = fixture("diagnostics");
  try {
    for (const state of ["absent", "live", "stale", "malformed", "oversized", "root-conflicting"] as const) {
      const diagnostic = formatRepositoryAdmissionDiagnostic({
        canonicalRepoKey: `repo-${"k".repeat(1_000)}`,
        canonicalRepoRoot: root,
        inspection: {
          state,
          reason: "r".repeat(3_000),
          leasePath: repositoryMutationLeasePath(root),
          ...(!["live", "absent"].includes(state) ? { evidenceIdentity: `v1-${"a".repeat(64)}` } : {}),
          ...(state === "live" ? { observedOwner: { deploymentId: "d-live", runtime: "pi", mode: "implement", processFingerprint: fingerprint(46001) } } : {}),
        },
      });
      assert.ok(diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS, `${state}: ${diagnostic.length}`);
      assert.match(diagnostic, new RegExp(`state=${state}`));
      if (state === "live") assert.doesNotMatch(diagnostic, /--force|manual quarantine|\bmv\b/i);
      if (!["live", "absent"].includes(state)) {
        assert.match(diagnostic, /--force.*Safe manual quarantine/s);
        assert.match(diagnostic, /ppa.*repository.*quarantine.*--expected-evidence/s);
        assert.doesNotMatch(diagnostic, /\bmv\b/);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git-state recorder covers every NFR-7 mutation category and preserves allowed reads", () => {
  const root = mkdtempSync(join(tmpdir(), "git-state-recorder-self-"));
  try {
    mkdirSync(join(root, "repo"));
    execFileSync("git", ["init", "-q"], { cwd: join(root, "repo") });
    const recorder = installGitStateRecorder(root);
    const env = { ...process.env, PATH: `${recorder.binDir}:${process.env["PATH"] ?? ""}` };
    const commands = [
      ["stash", "list"],
      ["commit", "--dry-run"],
      ["reset", "--", "missing"],
      ["clean", "-n"],
      ["restore", "--", "missing"],
      ["checkout", "--", "missing"],
      ["branch", "-D", "missing"],
      ["worktree", "list"],
      ["symbolic-ref", "--quiet", "HEAD"],
      ["rev-parse", "--git-dir"],
      ["status", "--porcelain=v1"],
    ];
    for (const args of commands) {
      try { execFileSync("git", args, { cwd: join(root, "repo"), env, stdio: "ignore" }); } catch { /* failing mutations are still observed before Git executes */ }
    }
    assert.deepEqual(recorder.readOperations().map((args) => args[0]), ["stash", "commit", "reset", "clean", "restore", "checkout", "branch", "worktree"]);
    assert.deepEqual(recorder.readCommands().slice(-3).map((args) => args[0]), ["symbolic-ref", "rev-parse", "status"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux process fingerprint includes PID, boot ID, and process start ticks", () => {
  const observed = readProcessFingerprint(process.pid);
  assert.ok(observed);
  assert.equal(observed.pid, process.pid);
  assert.match(observed.startTimeTicks, /^\d+$/);
  assert.ok(observed.bootId.length > 0);
});
