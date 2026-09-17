import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acquireRepositoryTicketSlot, releaseRepositoryTicketSlot, repositoryTicketSlotPath, type ProcessFingerprint } from "../deploy/index.js";
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
