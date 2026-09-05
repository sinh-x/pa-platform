import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_REPOSITORY_DIAGNOSTIC_CHARS,
  MAX_REPOSITORY_LEASE_BYTES,
  acquireRepositoryMutationLease,
  captureRepositoryGitSnapshot,
  classifyRepositoryAccess,
  formatRepositoryAdmissionDiagnostic,
  inspectRepositoryMutationLease,
  readProcessFingerprint,
  releaseRepositoryMutationLease,
  repositoryMutationLeasePath,
  transferRepositoryMutationLease,
  type ProcessFingerprint,
  type RepositoryAdmissionDependencies,
  type RepositoryGitSnapshot,
} from "../index.js";

const snapshot: RepositoryGitSnapshot = Object.freeze({
  branch: "feature/PAP-174-requirements-builder-admission",
  head: "a".repeat(40),
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  dirty: false,
  statusSummary: "",
});

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

test("Git snapshot captures bounded staged, unstaged, and untracked evidence with read-only commands", () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const outputs = new Map<string, string>([
    ["symbolic-ref --quiet --short HEAD", "feature/PAP-174\n"],
    ["rev-parse HEAD", `${"b".repeat(40)}\n`],
    ["status --porcelain=v1 --untracked-files=all -z", `M  staged.ts\0 M unstaged.ts\0?? untracked.ts\0R  renamed.ts\0old.ts\0`],
  ]);
  const result = captureRepositoryGitSnapshot("/tmp/repository", (args) => {
    mutableCalls.push([...args]);
    const value = outputs.get(args.join(" "));
    if (value === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
    return value;
  });
  assert.deepEqual({ staged: result.stagedCount, unstaged: result.unstagedCount, untracked: result.untrackedCount, dirty: result.dirty }, { staged: 2, unstaged: 1, untracked: 1, dirty: true });
  assert.ok(result.statusSummary.length <= 1_024);
  assert.deepEqual(calls.map((args) => args[0]), ["symbolic-ref", "rev-parse", "status"]);
  const prohibited = /^(stash|commit|reset|clean|restore|checkout|branch|worktree)$/;
  assert.equal(calls.some((args) => prohibited.test(args[0] ?? "")), false);
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
    if (result.status === "acquired") setTimeout(() => {}, 3000);
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
          ...(state === "live" ? { observedOwner: { deploymentId: "d-live", runtime: "pi", mode: "implement", processFingerprint: fingerprint(46001) } } : {}),
        },
      });
      assert.ok(diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS, `${state}: ${diagnostic.length}`);
      assert.match(diagnostic, new RegExp(`state=${state}`));
      if (state === "live") assert.doesNotMatch(diagnostic, /--force|manual quarantine|\bmv\b/i);
      if (!["live", "absent"].includes(state)) assert.match(diagnostic, /--force.*Manual quarantine/s);
    }
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
