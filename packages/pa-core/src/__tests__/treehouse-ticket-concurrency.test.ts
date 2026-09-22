import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acquireRepositoryTicketSlot, authenticateRepositoryTicketSlot, MAX_REPOSITORY_TICKET_SLOT_BYTES, releaseRepositoryTicketSlot, repositoryTicketSlotPath, type ProcessFingerprint } from "../deploy/index.js";
import { materializeTicketBranch } from "../tickets/materialization.js";
import { TicketStore } from "../tickets/store.js";

function git(args: string[], cwd: string, encoding: BufferEncoding | null = "utf8"): string | Buffer {
  return execFileSync("git", args, { cwd, encoding, stdio: ["ignore", "pipe", "pipe"] });
}

function initializeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-b", "develop"], repo);
  git(["config", "user.name", "Test"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  return repo;
}

function fingerprint(pid: number): ProcessFingerprint { return { pid, startTimeTicks: `ticks-${pid}`, bootId: "boot" }; }

test("ticket slots reject duplicate and fifth live tickets in one repository transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-ticket-slots-"));
  const repo = initializeRepo(root);
  const live = new Map<number, ProcessFingerprint>();
  const acquired: Array<ReturnType<typeof acquireRepositoryTicketSlot> & { status: "acquired" }> = [];
  try {
    for (let index = 1; index <= 4; index += 1) {
      const fp = fingerprint(10_000 + index);
      live.set(fp.pid, fp);
      const result = acquireRepositoryTicketSlot({
        canonicalRepoKey: "registered",
        canonicalRepoRoot: repo,
        ticket: `PAP-${index}`,
        deploymentId: `d-${index}`,
        deploymentDirectory: join(root, `d-${index}`),
        pid: fp.pid,
        processFingerprint: fp,
        dependencies: { getProcessFingerprint: (pid) => live.get(pid), createToken: () => `token-${index}`, now: () => new Date("2026-09-17T00:00:00.000Z") },
      });
      assert.equal(result.status, "acquired");
      if (result.status === "acquired") acquired.push(result);
      assert.equal(result.status === "acquired" ? result.slot.repositoryPermit : 0, index);
    }
    const duplicate = acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-1", deploymentId: "d-duplicate", deploymentDirectory: join(root, "duplicate"), pid: 20_001, processFingerprint: fingerprint(20_001), dependencies: { getProcessFingerprint: (pid) => pid === 20_001 ? fingerprint(pid) : live.get(pid) } });
    assert.equal(duplicate.status, "rejected");
    assert.match(duplicate.diagnostic, /duplicate|already has/i);
    assert.ok(duplicate.diagnostic.length <= 2_000);

    const fifthFp = fingerprint(20_005);
    const fifth = acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-5", deploymentId: "d-fifth", deploymentDirectory: join(root, "fifth"), pid: fifthFp.pid, processFingerprint: fifthFp, dependencies: { getProcessFingerprint: (pid) => pid === fifthFp.pid ? fifthFp : live.get(pid) } });
    assert.equal(fifth.status, "rejected");
    assert.match(fifth.diagnostic, /maximum is 4/);

    const path = repositoryTicketSlotPath(repo, "PAP-1");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  } finally {
    for (const result of acquired) releaseRepositoryTicketSlot({ canonicalRepoKey: result.slot.canonicalRepoKey, canonicalRepoRoot: result.slot.canonicalRepoRoot, ticket: result.slot.ticket, slotToken: result.slot.slotToken, slotId: result.slot.slotId, repositoryPermit: result.slot.repositoryPermit });
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only ticket-slot authentication rejects absent, malformed, replaced, stale, and permit-drift evidence without exposing its token", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-ticket-slot-auth-"));
  const repo = initializeRepo(root);
  const fp = fingerprint(31_001);
  const deploymentDirectory = join(root, "d-parent");
  const getProcessFingerprint = (pid: number) => pid === fp.pid ? fp : undefined;
  const acquired = acquireRepositoryTicketSlot({
    canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-1", deploymentId: "d-parent", deploymentDirectory,
    pid: fp.pid, processFingerprint: fp, dependencies: { getProcessFingerprint, createToken: () => "DISTINCTIVE-SLOT-TOKEN", now: () => new Date("2026-09-17T00:00:00.000Z") },
  });
  assert.equal(acquired.status, "acquired");
  if (acquired.status !== "acquired") return;
  const path = acquired.slotPath;
  const options = {
    canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-1", deploymentId: "d-parent", deploymentDirectory,
    slotId: acquired.slot.slotId, repositoryPermit: acquired.slot.repositoryPermit, processFingerprint: fp,
  } as const;
  try {
    const initial = authenticateRepositoryTicketSlot({ ...options, dependencies: { getProcessFingerprint } });
    assert.equal(initial.status, "authenticated");
    assert.doesNotMatch(JSON.stringify(initial), /DISTINCTIVE-SLOT-TOKEN/);
    if (initial.status !== "authenticated") return;

    writeFileSync(path, `${JSON.stringify({ ...acquired.slot, slotToken: "REPLACEMENT-TOKEN" })}\n`, { mode: 0o600 });
    assert.deepEqual(authenticateRepositoryTicketSlot({ ...options, expectedEvidenceIdentity: initial.evidenceIdentity, dependencies: { getProcessFingerprint } }), { status: "rejected", reason: "replaced" });

    writeFileSync(path, `${JSON.stringify({ ...acquired.slot, repositoryPermit: acquired.slot.repositoryPermit === 1 ? 2 : 1 })}\n`, { mode: 0o600 });
    assert.deepEqual(authenticateRepositoryTicketSlot({ ...options, dependencies: { getProcessFingerprint } }), { status: "rejected", reason: "identity-mismatch" });

    writeFileSync(path, `${JSON.stringify(acquired.slot)}\n`, { mode: 0o600 });
    assert.deepEqual(authenticateRepositoryTicketSlot({ ...options, dependencies: { getProcessFingerprint: () => undefined } }), { status: "rejected", reason: "stale-process" });

    writeFileSync(path, "{bad-json\n", { mode: 0o600 });
    assert.deepEqual(authenticateRepositoryTicketSlot({ ...options, dependencies: { getProcessFingerprint } }), { status: "rejected", reason: "malformed" });

    rmSync(path);
    assert.deepEqual(authenticateRepositoryTicketSlot({ ...options, dependencies: { getProcessFingerprint } }), { status: "rejected", reason: "absent" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ticket-slot reads reject malformed and oversized persisted evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-ticket-slot-invalid-"));
  const repo = initializeRepo(root);
  const path = repositoryTicketSlotPath(repo, "PAP-bad");
  try {
    for (const body of ["{not-json\n", "x".repeat(MAX_REPOSITORY_TICKET_SLOT_BYTES + 1)]) {
      writeFileSync(path, body, { mode: 0o600 });
      const result = acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-new", deploymentId: "d-new", deploymentDirectory: join(root, "d-new") });
      assert.equal(result.status, "rejected");
      assert.equal(result.status === "rejected" ? result.reason : "", "invalid-evidence");
      assert.ok(result.diagnostic.length <= 2_000);
      rmSync(path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent ticket-slot contenders atomically admit four distinct tickets", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-ticket-slot-race-"));
  const repo = initializeRepo(root);
  const moduleUrl = new URL("../deploy/ticket-concurrency.ts", import.meta.url).href;
  const script = `
    const api = await import(process.env.PA_SLOT_MODULE_URL);
    const result = api.acquireRepositoryTicketSlot({
      canonicalRepoKey: "registered",
      canonicalRepoRoot: process.env.PA_SLOT_REPO,
      ticket: process.env.PA_SLOT_TICKET,
      deploymentId: process.env.PA_SLOT_DEPLOYMENT,
      deploymentDirectory: process.env.PA_SLOT_DEPLOYMENT_DIR,
    });
    process.stdout.write(JSON.stringify({ status: result.status, reason: result.reason, diagnostic: result.diagnostic }) + "\\n");
    if (result.status === "acquired") setInterval(() => {}, 1_000);
  `;
  const children: ChildProcess[] = [];
  try {
    const attempts = Array.from({ length: 8 }, (_, index) => new Promise<{ status: string; reason?: string; diagnostic: string }>((resolveAttempt, rejectAttempt) => {
      const number = index + 1;
      const child = spawn(process.execPath, ["--import=tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, PA_SLOT_MODULE_URL: moduleUrl, PA_SLOT_REPO: repo, PA_SLOT_TICKET: `PAP-${number}`, PA_SLOT_DEPLOYMENT: `d-race-${number}`, PA_SLOT_DEPLOYMENT_DIR: join(root, `d-race-${number}`) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline >= 0) resolveAttempt(JSON.parse(stdout.slice(0, newline)) as { status: string; reason?: string; diagnostic: string });
      });
      child.once("error", rejectAttempt);
      child.once("exit", (code) => { if (!stdout.includes("\n")) rejectAttempt(new Error(`contender exited ${code}: ${stderr}`)); });
    }));
    const results = await Promise.all(attempts);
    assert.equal(results.filter((entry) => entry.status === "acquired").length, 4);
    const rejected = results.filter((entry) => entry.status === "rejected");
    assert.equal(rejected.length, 4);
    assert.equal(rejected.every((entry) => entry.reason === "repository-capacity"), true);
    assert.equal(results.every((entry) => entry.diagnostic.length <= 2_000), true);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()))));
    rmSync(root, { recursive: true, force: true });
  }
});

test("planned ticket branch materializes once at exact local develop and preserves canonical bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-ticket-materialize-"));
  const config = join(root, "config");
  const tickets = join(root, "tickets");
  const worktree = join(root, "treehouse-worktree");
  mkdirSync(config);
  mkdirSync(tickets);
  const repo = initializeRepo(root);
  git(["worktree", "add", "--detach", worktree, "develop"], repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n    feature_branch_pattern: feature/<ticket>-<topic>\n`);
  const store = new TicketStore(tickets);
  writeFileSync(join(tickets, "PAP-1.json"), JSON.stringify({
    id: "PAP-1", project: "registered", title: "fixture", linkedBranches: [{ repo: "registered", branch: "feature/PAP-1-work", state: "planned", linkedAt: "2026-09-17T00:00:00.000Z", linkedBy: "test" }],
  }));
  const previous = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    const before = Buffer.concat([
      Buffer.from(git(["branch", "--show-current"], repo) as string),
      Buffer.from(git(["rev-parse", "HEAD"], repo) as string),
      git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], repo, null) as Buffer,
    ]);
    const develop = (git(["rev-parse", "develop"], repo) as string).trim();
    const first = materializeTicketBranch({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, worktreeRoot: worktree, ticketId: "PAP-1", ticketStore: store });
    assert.equal(first.created, true);
    assert.equal(first.branch, "feature/PAP-1-work");
    assert.equal(first.baseSha, develop);
    assert.equal(first.headSha, develop);
    assert.equal((git(["branch", "--show-current"], worktree) as string).trim(), first.branch);

    const second = materializeTicketBranch({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, worktreeRoot: worktree, ticketId: "PAP-1", ticketStore: store });
    assert.equal(second.created, false);
    assert.equal(second.baseSha, first.baseSha);
    assert.equal(second.headSha, first.headSha);
    const after = Buffer.concat([
      Buffer.from(git(["branch", "--show-current"], repo) as string),
      Buffer.from(git(["rev-parse", "HEAD"], repo) as string),
      git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], repo, null) as Buffer,
    ]);
    assert.deepEqual(after, before);
    const persisted = JSON.parse(readFileSync(join(tickets, "PAP-1.json"), "utf8")) as { linkedBranches: Array<Record<string, unknown>> };
    assert.equal(persisted.linkedBranches[0]?.["baseSha"], develop);
    assert.equal(persisted.linkedBranches[0]?.["headSha"], develop);
  } finally {
    if (previous === undefined) delete process.env["PA_PLATFORM_CONFIG"]; else process.env["PA_PLATFORM_CONFIG"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
