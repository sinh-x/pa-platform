import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { acquireRepositoryTicketSlot, authenticateRepositoryTicketSlot, MAX_REPOSITORY_TICKET_SLOT_BYTES, releaseRepositoryTicketSlot, repositoryTicketSlotPath, withVacantPreparationWorktree, type ProcessFingerprint } from "../deploy/index.js";
import { materializeTicketBranch } from "../tickets/materialization.js";
import { TicketStore } from "../tickets/store.js";
import { observeReadonlyRepositoryTicketSlot, transferRepositoryTicketSlot, preparedRepositoryTicketReservationPath, withPreparedRepositoryTicketOwner, withPreparedTicketCapacity, type PreparedTicketCapacityTransaction } from "../deploy/ticket-concurrency.js";
import { parseIdlePreparationReservation } from "../deploy/execution-custody.js";

// Ticket/materialization fixtures must never inherit the invoking deployment's
// mutation principal, task snapshot or activity writer.
const inheritedDeployment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PA_(DEPLOYMENT|TICKET|ACTIVITY|TASK|TEAM|MODE)|PI_)/.test(key)));
for (const key of Object.keys(inheritedDeployment)) delete process.env[key];
after(() => Object.assign(process.env, inheritedDeployment));

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

test("read-only capacity observation neither creates missing storage nor repairs insecure directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-readonly-slot-")); const repo = initializeRepo(root);
  const directory = join(repo, ".git", "pa-ticket-builder-slots"); const fp = fingerprint(31_999);
  try {
    assert.throws(() => observeReadonlyRepositoryTicketSlot(repo, "PAP-1", () => fp)); assert.equal(existsSync(directory), false);
    const acquired = acquireRepositoryTicketSlot({ canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-1", deploymentId: "d-readonly", deploymentDirectory: join(root, "deployment"), pid: fp.pid, processFingerprint: fp, dependencies: { getProcessFingerprint: () => fp } });
    assert.equal(acquired.status, "acquired"); chmodSync(directory, 0o755);
    assert.throws(() => observeReadonlyRepositoryTicketSlot(repo, "PAP-1", () => fp)); assert.equal(statSync(directory).mode & 0o777, 0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("sparse planned ticket branch materializes once at exact local develop and preserves canonical bytes", () => {
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
  const sparseBefore = JSON.parse(readFileSync(join(tickets, "PAP-1.json"), "utf8")) as Record<string, unknown>;
  assert.equal(Object.hasOwn(sparseBefore, "createdAt"), false);
  assert.equal(Object.hasOwn(sparseBefore, "updatedAt"), false);
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


test("AC3/AC4: independent preparation/test processes share four retained tickets after requester exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-prepared-capacity-race-"));
  const repo = initializeRepo(root);
  const moduleUrl = new URL("../deploy/ticket-concurrency.ts", import.meta.url).href;
  const script = `
    const api = await import(process.env.PA_SLOT_MODULE_URL);
    const number = Number(process.env.PA_SLOT_NUMBER);
    const result = api.withPreparedTicketCapacity({ canonicalRepoKey: "registered", canonicalRepoRoot: process.env.PA_SLOT_REPO }, tx => tx.reserve({
      ticket: "PAP-" + number, operationId: number.toString(16).padStart(64, "0"), reservationId: (number + 100).toString(16).padStart(64, "0"), retainedAt: "2026-10-17T00:00:00.000Z",
      ...(number % 2 ? { purpose: "requirements-test-workflow/v1" } : {})
    }));
    process.stdout.write(JSON.stringify(result) + "\\n");
  `;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<{ status: string }>((resolveAttempt, rejectAttempt) => {
      const child = spawn(process.execPath, ["--import=tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, PA_SLOT_MODULE_URL: moduleUrl, PA_SLOT_REPO: repo, PA_SLOT_NUMBER: String(index + 1) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", rejectAttempt);
      child.once("exit", (code) => {
        if (code !== 0) rejectAttempt(new Error(`contender exited ${code}: ${stderr}`));
        else { try { resolveAttempt(JSON.parse(stdout) as { status: string }); } catch (error) { rejectAttempt(error); } }
      });
    })));
    assert.equal(results.filter((row) => row.status === "reserved").length, 4);
    assert.equal(results.filter((row) => row.status === "capacity").length, 4);
    assert.equal(withPreparedTicketCapacity({ canonicalRepoKey: "registered", canonicalRepoRoot: repo }, (tx) => tx.inventory()).length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC3/AC6 integration: concurrent services reconcile one journal/reservation/ready transfer under the existing capacity mutex", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-prepared-service-race-"));
  const repo = initializeRepo(root);
  const protectedRoot = join(root, "protected"); const resources = join(root, "resources");
  mkdirSync(protectedRoot, { mode: 0o700 }); mkdirSync(resources, { mode: 0o700 });
  const capacityModule = new URL("../deploy/ticket-concurrency.ts", import.meta.url).href;
  const serviceModule = new URL("../deploy/prepared-workflow.ts", import.meta.url).href;
  const script = `
    const capacity = await import(process.env.PA_SLOT_MODULE_URL);
    const api = await import(process.env.PA_SERVICE_MODULE_URL);
    const fs = await import("node:fs"); const path = await import("node:path");
    const repo = process.env.PA_SLOT_REPO; const root = process.env.PA_SLOT_ROOT;
    const time = "2026-10-17T00:00:00.000Z"; const sha = "a".repeat(40); const digest = "b".repeat(64);
    const source = ref => ({ ref, version: "fixture", sha256: digest });
    const contract = api.parsePreparationContract({ schemaVersion: "prepared-workflow/v1", policyVersion: "prepared-autonomy/v1", repoKey: "registered", repoRoot: repo,
      ticket: "PAP-256", branch: "feature/PAP-256-fixture", integrationTarget: "origin/develop", approvalBaseSha: sha,
      requirements: source("requirements:fixture"), uat: source("uat:fixture"), promotionEvidence: "promotion:fixture", signoffEvidence: "signoff:fixture",
      finalChecks: source("checks:fixture"), finalCheckCount: 13, matrix: source("requirements:fixture"), matrixApprovalEvidence: "matrix:fixture" });
    let transaction;
    const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo };
    const result = step => ({ state: "observed", evidence: source("result:" + step) });
    const current = () => transaction.inventory().find(row => row.ticket === contract.ticket);
    const host = {
      locks: { repository: run => capacity.withPreparedTicketCapacity(options, tx => { transaction = tx; try { return run(); } finally { transaction = undefined; } }), worktree: run => run() },
      authorize() {}, // isolated fake authority, NOT a production resolver
      inspect(step, context) {
        if (step === "reservation") return current() ? result(step) : { state: "absent" };
        if (step === "ready") return current().occupancy === "idle-ready" && current().receiptId === context.receipt.receiptId ? result(step) : { state: "absent" };
        const marker = path.join(root, "resources", step);
        return fs.existsSync(marker) ? result(step) : { state: "absent" };
      },
      perform(step, context) {
        if (step === "reservation") {
          const reserved = transaction.reserve({ ticket: contract.ticket, operationId: context.operationId, reservationId: digest, retainedAt: time });
          if (reserved.status !== "reserved") throw new Error("unexpected capacity");
        } else if (step === "ready") {
          const before = current(); transaction.update(before, { ...before, occupancy: "idle-ready", receiptId: context.receipt.receiptId });
        } else fs.writeFileSync(path.join(root, "resources", step), context.operationId, { flag: "wx", mode: 0o600 });
        return result(step);
      },
      resolveReceipt(context) { return api.parsePreparedReceipt({ schemaVersion: "prepared-receipt/v1", operationId: context.operationId, receiptId: digest, state: "ready", contract,
        preparationBaseSha: sha, preparedHeadSha: sha, worktreeRoot: path.join(root, "fake-checkout"), leaseRef: "lease:fixture", capacityRef: "capacity:fixture", custodyRef: "custody:fixture",
        ticketReread: context.results["ticket-reread"], observedAt: time, nextOwner: "builder" }); },
      now: () => time,
    };
    const service = new api.PreparedWorkflowService(new api.ProtectedWorkflowStore(path.join(root, "protected")), host);
    process.stdout.write(JSON.stringify(service.request(contract)) + "\\n");
  `;
  try {
    const results = await Promise.all([1, 2].map(() => new Promise<{ state: string; operationId: string }>((resolveAttempt, rejectAttempt) => {
      const child = spawn(process.execPath, ["--import=tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, PA_SLOT_MODULE_URL: capacityModule, PA_SERVICE_MODULE_URL: serviceModule, PA_SLOT_REPO: repo, PA_SLOT_ROOT: root }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", rejectAttempt); child.once("exit", (code) => {
        if (code !== 0) rejectAttempt(new Error(`service contender exited ${code}: ${stderr}`));
        else { try { resolveAttempt(JSON.parse(stdout) as { state: string; operationId: string }); } catch (error) { rejectAttempt(error); } }
      });
    })));
    assert.equal(results.every((row) => row.state === "ready"), true);
    assert.equal(results[0]!.operationId, results[1]!.operationId);
    const inventory = withPreparedTicketCapacity({ canonicalRepoKey: "registered", canonicalRepoRoot: repo }, (tx) => tx.inventory());
    assert.equal(inventory.length, 1); assert.equal("occupancy" in inventory[0]! && inventory[0].occupancy, "idle-ready");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const retainedAt = "2026-10-17T00:00:00.000Z";
const preparedInput = (number: number) => ({ ticket: `PAP-${number}`, operationId: number.toString(16).padStart(64, "0"), reservationId: (number + 100).toString(16).padStart(64, "0"), retainedAt });
function preparedFixture(action: (repo: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-prepared-capacity-"));
  try { action(initializeRepo(root), root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("AC4/AC6: idle reservations share the four-permit namespace with legacy builders and survive requester death/force", () => preparedFixture((repo, root) => {
  const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo };
  for (let index = 1; index <= 3; index += 1) {
    const first = withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(index)));
    assert.equal(first.status, "reserved");
    assert.deepEqual(withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(index))), first);
  }
  const fp = fingerprint(45000);
  const legacy = acquireRepositoryTicketSlot({ ...options, ticket: "PAP-4", deploymentId: "d-legacy", deploymentDirectory: root,
    pid: fp.pid, processFingerprint: fp, dependencies: { getProcessFingerprint: () => fp } });
  assert.equal(legacy.status, "acquired");
  assert.equal(legacy.status === "acquired" && legacy.slot.repositoryPermit, 4);
  assert.deepEqual(withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(5))), { status: "capacity" });
  for (const force of [false, true]) {
    const duplicate = acquireRepositoryTicketSlot({ ...options, ticket: "PAP-1", deploymentId: "d-other", deploymentDirectory: root, force });
    assert.equal(duplicate.status, "rejected");
    assert.equal(duplicate.status === "rejected" && duplicate.reason, "duplicate-ticket");
  }
  assert.equal(withPreparedTicketCapacity(options, (tx) => tx.inventory()).length, 3); // legacy stale slot reconciled by its existing owner
  assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.reserve({ ...preparedInput(1), operationId: "f".repeat(64) })));
}));

test("AC6: preparing -> ready -> active transfer retains one permit, rejects replay/CAS drift and never expires", () => preparedFixture((repo) => {
  const fp = { pid: 45001, startTimeTicks: "123", bootId: "fixture" };
  const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo, dependencies: { getProcessFingerprint: () => fp } };
  const first = withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(1)));
  assert.equal(first.status, "reserved"); if (first.status !== "reserved") throw new Error("fixture failed");
  const ready = parseIdlePreparationReservation({ ...first.reservation, occupancy: "idle-ready", receiptId: "b".repeat(64) });
  withPreparedTicketCapacity(options, (tx) => tx.update(first.reservation, ready));
  const active = parseIdlePreparationReservation({ ...ready, occupancy: "active", lineageId: "lineage:one",
    custody: { state: "orchestrator-direct", holder: { deploymentId: "d-000001", process: fp }, inFlightOperation: null } });
  assert.throws(() => withPreparedTicketCapacity({ ...options, dependencies: { getProcessFingerprint: () => undefined } }, (tx) => tx.update(ready, active)));
  withPreparedTicketCapacity(options, (tx) => tx.update(ready, active));
  assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.update(ready, { ...active, lineageId: "lineage:two" })));
  assert.deepEqual(withPreparedTicketCapacity(options, (tx) => tx.update(active, active)), active);
  assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.update(active, ready)));
  assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.update(active, { ...active, repositoryPermit: 2 })));
  assert.equal(withPreparedTicketCapacity({ ...options, dependencies: { getProcessFingerprint: () => undefined } }, (tx) => tx.inventory()).length, 1);
  const blocked = parseIdlePreparationReservation({ ...active, occupancy: "uncertain-retained", custody: { state: "uncertain-blocked", holder: active.custody.holder, inFlightOperation: null } });
  withPreparedTicketCapacity(options, (tx) => tx.update(active, blocked));
  assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.update(blocked, active)));
  assert.equal(withPreparedTicketCapacity(options, (tx) => tx.inventory()).length, 1);
}));

test("prepared capacity rejects duplicate operation/reservation identity across tickets", () => preparedFixture((repo) => {
  const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo };
  withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(1)));
  for (const patch of [{ operationId: preparedInput(1).operationId }, { reservationId: preparedInput(1).reservationId }]) {
    assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.reserve({ ...preparedInput(2), ...patch })));
  }
  assert.equal(withPreparedTicketCapacity(options, (tx) => tx.inventory()).length, 1);
}));

test("capacity/worktree owner handles are live, root-bound and unforgeable; preparation cannot invert lock order", () => preparedFixture((repo, root) => {
  const checkout = join(root, "checkout"); git(["worktree", "add", "--detach", checkout, "HEAD"], repo);
  let escaped: PreparedTicketCapacityTransaction | undefined;
  withPreparedTicketCapacity({ canonicalRepoKey: "registered", canonicalRepoRoot: repo }, (tx) => {
    escaped = tx;
    assert.equal(withPreparedRepositoryTicketOwner(tx, repo, () => 7), 7);
    assert.throws(() => withPreparedRepositoryTicketOwner(tx, root, () => 8));
    assert.throws(() => withPreparedRepositoryTicketOwner(tx, repo, () => Promise.resolve(9)));
    assert.equal(withVacantPreparationWorktree(repo, checkout, tx, () => 10), 10);
    assert.throws(() => withVacantPreparationWorktree(repo, repo, tx, () => 11));
  });
  assert.throws(() => withPreparedRepositoryTicketOwner(escaped!, repo, () => 12));
  assert.throws(() => withVacantPreparationWorktree(repo, checkout, escaped!, () => 13));
  assert.throws(() => withPreparedRepositoryTicketOwner({} as PreparedTicketCapacityTransaction, repo, () => 14));
}));

test("prepared transaction expires at callback exit and rejects async work", () => preparedFixture((repo) => {
  const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo };
  let escaped: PreparedTicketCapacityTransaction | undefined;
  withPreparedTicketCapacity(options, (tx) => { escaped = tx; });
  assert.throws(() => escaped!.reserve(preparedInput(1)));
  assert.throws(() => escaped!.inventory());
  assert.throws(() => withPreparedTicketCapacity(options, () => Promise.resolve(1)));
  assert.equal(withPreparedTicketCapacity(options, (tx) => tx.inventory()).length, 0);
}));

for (const boundary of ["file-synced", "linked", "published", "directory-synced"] as const) {
  test(`AC3: prepared reservation crash at ${boundary} never duplicates occupancy`, () => preparedFixture((repo) => {
    const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo };
    assert.throws(() => withPreparedTicketCapacity({ ...options, boundary(point) { if (point === boundary) throw new Error("crash"); } }, (tx) => tx.reserve(preparedInput(1))));
    if (boundary === "linked") {
      assert.equal(statSync(preparedRepositoryTicketReservationPath(repo, "PAP-1")).nlink, 2);
      assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(1))));
      return; // uncertain hard-link alias is preserved, never auto-repaired
    }
    const recovered = withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(1)));
    assert.equal(recovered.status, "reserved");
    assert.equal(withPreparedTicketCapacity(options, (tx) => tx.inventory()).length, 1);
    assert.equal(statSync(preparedRepositoryTicketReservationPath(repo, "PAP-1")).mode & 0o777, 0o600);
  }));
}

for (const transition of ["ready", "active"] as const) {
  for (const boundary of ["file-synced", "published", "directory-synced"] as const) {
    test(`AC3/AC6: ${transition} capacity replacement crash at ${boundary} retains one reconcilable permit`, () => preparedFixture((repo) => {
      const fp = { pid: 45002, startTimeTicks: "123", bootId: "fixture" };
      const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo, dependencies: { getProcessFingerprint: () => fp } };
      const first = withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(1)));
      if (first.status !== "reserved") throw new Error("fixture failed");
      const ready = parseIdlePreparationReservation({ ...first.reservation, occupancy: "idle-ready", receiptId: "b".repeat(64) });
      const before = transition === "ready" ? first.reservation : withPreparedTicketCapacity(options, (tx) => tx.update(first.reservation, ready));
      const next = transition === "ready" ? ready : parseIdlePreparationReservation({ ...ready, occupancy: "active", lineageId: "lineage:one",
        custody: { state: "orchestrator-direct", holder: { deploymentId: "d-000001", process: fp }, inFlightOperation: null } });
      assert.throws(() => withPreparedTicketCapacity({ ...options, boundary(point) { if (point === boundary) throw new Error("crash"); } }, (tx) => tx.update(before, next)));
      const rows = withPreparedTicketCapacity(options, (tx) => tx.inventory());
      assert.equal(rows.length, 1);
      if (boundary === "file-synced") {
        assert.deepEqual(rows[0], before);
        assert.deepEqual(withPreparedTicketCapacity(options, (tx) => tx.update(before, next)), next);
      } else {
        assert.deepEqual(rows[0], next);
        assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.update(before, next)));
        assert.deepEqual(withPreparedTicketCapacity(options, (tx) => tx.update(next, next)), next);
      }
      assert.equal(withPreparedTicketCapacity(options, (tx) => tx.inventory()).length, 1);
    }));
  }
}

test("AC5: malformed/oversized/insecure/aliased prepared evidence is never force-quarantined or reclaimed", () => preparedFixture((repo, root) => {
  const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo };
  const path = preparedRepositoryTicketReservationPath(repo, "PAP-1");
  const reject = () => {
    assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(2))));
    const result = acquireRepositoryTicketSlot({ ...options, ticket: "PAP-2", deploymentId: "d-force", deploymentDirectory: root, force: true });
    assert.equal(result.status === "rejected" && result.reason, "invalid-evidence");
  };
  for (const body of ["{bad-json", "x".repeat(MAX_REPOSITORY_TICKET_SLOT_BYTES + 1), JSON.stringify({ schemaVersion: "unsupported" })]) {
    writeFileSync(path, body, { mode: 0o600 }); reject(); assert.equal(readFileSync(path, "utf8"), body); rmSync(path);
  }
  symlinkSync(join(root, "missing"), path); reject(); rmSync(path);
  const reserved = withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(1)));
  assert.equal(reserved.status, "reserved");
  chmodSync(path, 0o644); reject(); chmodSync(path, 0o600);
  linkSync(path, join(root, "alias")); reject();
  assert.equal(statSync(path).nlink, 2); // no repair or delete by --force
}));

test("prepared inventory rejects mismatched path/root and duplicate permit; ordinary admission cannot allocate past it", () => preparedFixture((repo, root) => {
  const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo };
  const result = withPreparedTicketCapacity(options, (tx) => tx.reserve(preparedInput(1)));
  if (result.status !== "reserved") throw new Error("fixture failed");
  const path = preparedRepositoryTicketReservationPath(repo, "PAP-1");
  for (const patch of [{ repoRoot: root }, { ticket: "PAP-9" }]) {
    writeFileSync(path, JSON.stringify({ ...result.reservation, ...patch }), { mode: 0o600 });
    assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.inventory()));
    const next = acquireRepositoryTicketSlot({ ...options, ticket: "PAP-2", deploymentId: "d-other", deploymentDirectory: root, force: true });
    assert.equal(next.status === "rejected" && next.reason, "invalid-evidence");
  }
  writeFileSync(path, JSON.stringify(result.reservation), { mode: 0o600 });
  writeFileSync(preparedRepositoryTicketReservationPath(repo, "PAP-2"), JSON.stringify({ ...result.reservation, ...preparedInput(2) }), { mode: 0o600 });
  assert.throws(() => withPreparedTicketCapacity(options, (tx) => tx.inventory()));
}));

test("AC6: consumed reservation is the ordinary slot view; transfer and terminal release retain one occupied permit", () => preparedFixture((repo, root) => {
  const first = { pid: 12_001, startTimeTicks: "123", bootId: "fixture" };
  const next = { pid: 12_002, startTimeTicks: "456", bootId: "fixture" };
  const fingerprints = (pid: number) => pid === first.pid ? first : pid === next.pid ? next : undefined;
  const options = { canonicalRepoKey: "registered", canonicalRepoRoot: repo, dependencies: { getProcessFingerprint: fingerprints } };
  withPreparedTicketCapacity(options, (tx) => {
    const reserved = tx.reserve(preparedInput(1)); if (reserved.status !== "reserved") throw new Error("fixture capacity");
    const ready = tx.update(reserved.reservation, parseIdlePreparationReservation({ ...reserved.reservation, occupancy: "idle-ready", receiptId: "f".repeat(64) }));
    tx.update(ready, parseIdlePreparationReservation({ ...ready, occupancy: "active", lineageId: "d-123abc", custody: { state: "orchestrator-direct", holder: { deploymentId: "d-123abc", process: first }, inFlightOperation: null },
      launch: { slotToken: "PRIVATE-PREPARED-TOKEN", deploymentDirectory: root, acquiredAt: "2026-10-17T00:00:00.000Z" } }));
  });
  const observed = observeReadonlyRepositoryTicketSlot(repo, "PAP-1", fingerprints);
  const handoff = { canonicalRepoKey: "registered", canonicalRepoRoot: repo, ticket: "PAP-1", slotToken: observed.slot.slotToken, slotId: observed.slot.slotId, repositoryPermit: observed.slot.repositoryPermit };
  assert.equal(observed.slot.deploymentId, "d-123abc"); assert.equal(observed.slot.repositoryPermit, 1);
  assert.throws(() => statSync(repositoryTicketSlotPath(repo, "PAP-1"))); // no second slot file
  const authenticate = (processFingerprint: ProcessFingerprint) => authenticateRepositoryTicketSlot({ ...handoff, deploymentId: "d-123abc", deploymentDirectory: root, processFingerprint, dependencies: { getProcessFingerprint: fingerprints } });
  assert.equal(authenticate(first).status, "authenticated");
  assert.equal(transferRepositoryTicketSlot({ ...handoff, nextProcessFingerprint: next, dependencies: { getProcessFingerprint: fingerprints, createToken: () => "unused" } }).status, "transferred");
  assert.equal(authenticate(first).status, "rejected"); assert.equal(authenticate(next).status, "authenticated");
  assert.equal(withPreparedTicketCapacity(options, (tx) => tx.inventory()).length, 1);
  assert.equal(releaseRepositoryTicketSlot({ ...handoff, slotToken: "forged" }).status, "token-mismatch");
  assert.equal(releaseRepositoryTicketSlot(handoff).status, "released"); assert.equal(releaseRepositoryTicketSlot(handoff).status, "absent");
  const retained = withPreparedTicketCapacity(options, (tx) => tx.inventory());
  assert.equal(retained.length, 1); assert.equal("occupancy" in retained[0]! && retained[0].occupancy, "settled-retained");
  const retry = acquireRepositoryTicketSlot({ ...options, ticket: "PAP-1", deploymentId: "d-654abc", deploymentDirectory: root, force: true });
  assert.equal(retry.status, "rejected");
  assert.ok(statSync(preparedRepositoryTicketReservationPath(repo, "PAP-1")).isFile());
}));
