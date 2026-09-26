import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requireTicketLinkedBranch, TicketStore } from "../index.js";
import type { CreateTicketInput, Ticket } from "../tickets/types.js";

function withLinkedBranchEnv(fn: (context: { root: string; repo: string; tickets: string; store: TicketStore }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-linked-branch-"));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const tickets = join(root, "tickets");
  mkdirSync(config, { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# linked branch test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(config, "repos.yaml"), `repos:\n  pa-platform:\n    path: ${repo}\n    prefix: PAP\n    develop_branch: develop\n    feature_branch_pattern: "feature/<ticket>-<topic>"\n  other:\n    path: ${repo}\n    prefix: OTH\n    develop_branch: develop\n`);

  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    fn({ root, repo, tickets, store: new TicketStore(tickets, { privileged: true }) });
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
}

function createTicket(store: TicketStore): Ticket {
  const input: CreateTicketInput = {
    project: "pa-platform",
    title: "Linked branch lifecycle",
    summary: "Phase 1",
    description: "",
    status: "implementing",
    priority: "high",
    type: "feature",
    assignee: "builder/team-manager",
    estimate: "M",
    from: "",
    to: "",
    tags: [],
    blockedBy: [],
    doc_refs: [],
    comments: [],
  };
  return store.create(input, "test");
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function assertBoundedFiveFieldDiagnostic(error: unknown, pattern: RegExp): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, pattern);
  assert.ok(error.message.length <= 2000, `diagnostic has ${error.message.length} JavaScript characters`);
  for (const field of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) {
    assert.match(error.message, new RegExp(field));
  }
  return true;
}

test("absent exact-ticket branch is stored as planned without Git mutation", () => {
  withLinkedBranchEnv(({ repo, store }) => {
    const ticket = createTicket(store);
    const beforeHead = git(repo, ["rev-parse", "HEAD"]);
    const beforeRefs = git(repo, ["show-ref"]);
    const beforeStatus = execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: repo });

    const updated = store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-planned" } }, "test");

    assert.deepEqual(updated.linkedBranches[0], {
      repo: "pa-platform",
      branch: "feature/PAP-001-planned",
      state: "planned",
      linkedAt: updated.linkedBranches[0]?.linkedAt,
      linkedBy: "test",
    });
    assert.equal(git(repo, ["rev-parse", "HEAD"]), beforeHead);
    assert.equal(git(repo, ["show-ref"]), beforeRefs);
    assert.deepEqual(execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: repo }), beforeStatus);
    assert.equal(git(repo, ["branch", "--list", "feature/PAP-001-planned"]), "");
  });
});

test("planned entry promotes in place and later refresh preserves immutable baseSha", () => {
  withLinkedBranchEnv(({ repo, store }) => {
    const ticket = createTicket(store);
    const planned = store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-work" } }, "planner").linkedBranches[0]!;
    const baseSha = git(repo, ["rev-parse", "develop"]);
    execFileSync("git", ["branch", "feature/PAP-001-work", baseSha], { cwd: repo, stdio: "ignore" });

    const materialized = store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-work" } }, "materializer").linkedBranches[0]!;
    assert.equal(materialized.state, "materialized");
    assert.equal(materialized.baseSha, baseSha);
    assert.equal(materialized.headSha, baseSha);
    assert.equal(materialized.sha, baseSha);
    assert.equal(materialized.linkedAt, planned.linkedAt);
    assert.equal(materialized.linkedBy, "planner");

    const tree = git(repo, ["rev-parse", `${baseSha}^{tree}`]);
    const nextHead = execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit-tree", tree, "-p", baseSha, "-m", "advance branch"], { cwd: repo, encoding: "utf-8" }).trim();
    execFileSync("git", ["update-ref", "refs/heads/feature/PAP-001-work", nextHead, baseSha], { cwd: repo, stdio: "ignore" });

    const refreshed = store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-work" } }, "refresher").linkedBranches[0]!;
    assert.equal(refreshed.baseSha, baseSha);
    assert.equal(refreshed.headSha, nextHead);
    assert.equal(refreshed.sha, nextHead);
    assert.equal(refreshed.linkedAt, planned.linkedAt);
    assert.equal(refreshed.linkedBy, "planner");
  });
});

test("legacy sha records normalize to materialized head evidence without inventing baseSha", () => {
  withLinkedBranchEnv(({ tickets, store }) => {
    const ticket = createTicket(store);
    const legacySha = "a".repeat(40);
    const path = join(tickets, `${ticket.id}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    raw["linkedBranches"] = [{ repo: "pa-platform", branch: "feature/PAP-001-legacy", sha: legacySha, linkedAt: ticket.createdAt, linkedBy: "legacy" }];
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const migrated = store.get(ticket.id)!;
    assert.deepEqual(migrated.linkedBranches[0], {
      repo: "pa-platform",
      branch: "feature/PAP-001-legacy",
      state: "materialized",
      headSha: legacySha,
      sha: legacySha,
      linkedAt: ticket.createdAt,
      linkedBy: "legacy",
    });
    assert.equal(migrated.title, ticket.title);
    assert.equal(migrated.linkedBranches[0]?.baseSha, undefined);
    assert.equal(requireTicketLinkedBranch(migrated, "pa-platform").headSha, legacySha);
  });
});

test("bare repository removal persists for planned, materialized, and legacy-normalized records", () => {
  withLinkedBranchEnv(({ repo, tickets, store }) => {
    const plannedTicket = createTicket(store);
    store.update(plannedTicket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-planned" } }, "planner");
    store.update(plannedTicket.id, { remove_linked_branch: "pa-platform" }, "remover");
    assert.deepEqual(new TicketStore(tickets, { privileged: true }).get(plannedTicket.id)?.linkedBranches, []);
    assert.equal(store.readAudit().filter((entry) => entry.ticket_id === plannedTicket.id && entry.action === "branch_link_removed").length, 1);

    const materializedTicket = createTicket(store);
    execFileSync("git", ["branch", "feature/PAP-002-materialized", "develop"], { cwd: repo, stdio: "ignore" });
    const materialized = store.update(materializedTicket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-002-materialized" } }, "materializer").linkedBranches[0]!;
    assert.ok(materialized.baseSha);
    assert.ok(materialized.headSha);
    assert.ok(materialized.sha);
    store.update(materializedTicket.id, { remove_linked_branch: "pa-platform" }, "remover");
    assert.deepEqual(new TicketStore(tickets, { privileged: true }).get(materializedTicket.id)?.linkedBranches, []);

    const legacyTicket = createTicket(store);
    const legacyPath = join(tickets, `${legacyTicket.id}.json`);
    const legacyRaw = JSON.parse(readFileSync(legacyPath, "utf-8")) as Record<string, unknown>;
    legacyRaw["linkedBranches"] = [{ repo: "pa-platform", branch: "feature/PAP-003-legacy", sha: "a".repeat(40), linkedAt: legacyTicket.createdAt, linkedBy: "legacy" }];
    writeFileSync(legacyPath, JSON.stringify(legacyRaw, null, 2));
    store.update(legacyTicket.id, { remove_linked_branch: "pa-platform" }, "remover");
    assert.deepEqual(new TicketStore(tickets, { privileged: true }).get(legacyTicket.id)?.linkedBranches, []);
  });
});

test("bare repository absence is disk-verified and emits no removal audit", () => {
  withLinkedBranchEnv(({ tickets, store }) => {
    const ticket = createTicket(store);
    const removalAuditsBefore = store.readAudit().filter((entry) => entry.action === "branch_link_removed").length;

    const updated = store.update(ticket.id, { remove_linked_branch: "pa-platform" }, "remover");

    assert.deepEqual(updated.linkedBranches, []);
    assert.deepEqual(new TicketStore(tickets, { privileged: true }).get(ticket.id)?.linkedBranches, []);
    assert.equal(store.readAudit().filter((entry) => entry.action === "branch_link_removed").length, removalAuditsBefore);
  });
});

test("ambiguous bare repository removal rejects before persistence with bounded diagnostic", () => {
  withLinkedBranchEnv(({ tickets, store }) => {
    const ticket = createTicket(store);
    const path = join(tickets, `${ticket.id}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    raw["linkedBranches"] = [
      { repo: "pa-platform", branch: "feature/PAP-001-one", state: "planned", linkedAt: ticket.createdAt, linkedBy: "test" },
      { repo: "pa-platform", branch: "feature/PAP-001-two", state: "planned", linkedAt: ticket.createdAt, linkedBy: "test" },
    ];
    writeFileSync(path, JSON.stringify(raw, null, 2));
    const ticketBefore = readFileSync(path, "utf-8");
    const auditBefore = store.readAudit();

    assert.throws(
      () => store.update(ticket.id, { remove_linked_branch: "pa-platform" }, "remover"),
      (error: unknown) => assertBoundedFiveFieldDiagnostic(error, /matched 2 normalized records/),
    );
    assert.equal(readFileSync(path, "utf-8"), ticketBefore);
    assert.deepEqual(store.readAudit(), auditBefore);
  });
});

test("bare removal and replacement persist atomically with truthful audits", () => {
  withLinkedBranchEnv(({ tickets, store }) => {
    const ticket = createTicket(store);
    store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-old" } }, "planner");
    const before = store.get(ticket.id)!;
    const auditBefore = store.readAudit();

    const replaced = store.update(ticket.id, {
      remove_linked_branch: "pa-platform",
      add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-replacement" },
    }, "replacer");

    assert.deepEqual(replaced.linkedBranches.map((branch) => branch.branch), ["feature/PAP-001-replacement"]);
    assert.deepEqual(new TicketStore(tickets, { privileged: true }).get(ticket.id)?.linkedBranches, replaced.linkedBranches);
    const { linkedBranches: _beforeBranches, updatedAt: _beforeUpdatedAt, ...beforeUnrelated } = before;
    const { linkedBranches: _afterBranches, updatedAt: _afterUpdatedAt, ...afterUnrelated } = replaced;
    assert.deepEqual(afterUnrelated, beforeUnrelated);
    const mutationAudits = store.readAudit().slice(auditBefore.length).filter((entry) => entry.action === "branch_link_removed" || entry.action === "branch_link_added");
    assert.deepEqual(mutationAudits.map((entry) => entry.action), ["branch_link_removed", "branch_link_added"]);
  });
});

test("replacement validation and readback failures restore prior state without mutation audits", () => {
  withLinkedBranchEnv(({ tickets, store }) => {
    const ticket = createTicket(store);
    store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-old" } }, "planner");
    const before = store.get(ticket.id)!;
    const auditBefore = store.readAudit();

    assert.throws(() => store.update(ticket.id, {
      remove_linked_branch: "pa-platform",
      add_linked_branch: { repo: "other", branch: "feature/PAP-001-invalid" },
    }, "replacer"), /Cross-project linked branch rejected/);
    assert.deepEqual(store.get(ticket.id), before);
    assert.deepEqual(store.readAudit(), auditBefore);

    const originalGet = store.get.bind(store);
    let getCalls = 0;
    store.get = (id: string): Ticket | undefined => {
      getCalls += 1;
      return getCalls === 2 ? before : originalGet(id);
    };
    assert.throws(
      () => store.update(ticket.id, {
        remove_linked_branch: "pa-platform",
        add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-replacement" },
      }, "replacer"),
      (error: unknown) => assertBoundedFiveFieldDiagnostic(error, /postcondition failed/),
    );
    assert.deepEqual(new TicketStore(tickets, { privileged: true }).get(ticket.id), before);
    assert.deepEqual(store.readAudit(), auditBefore);
  });
});

test("admission foundation rejects missing, ambiguous, invalid-pattern, and cross-project evidence with bounded diagnostics", () => {
  withLinkedBranchEnv(({ store }) => {
    const ticket = createTicket(store);
    const cases: Array<{ ticket: Ticket; repo: string; pattern: RegExp }> = [
      { ticket, repo: "pa-platform", pattern: /Missing linked-branch evidence/ },
      { ticket: { ...ticket, linkedBranches: [
        { repo: "pa-platform", branch: "feature/PAP-001-one", state: "planned", linkedAt: ticket.createdAt, linkedBy: "test" },
        { repo: "pa-platform", branch: "feature/PAP-001-two", state: "planned", linkedAt: ticket.createdAt, linkedBy: "test" },
      ] }, repo: "pa-platform", pattern: /Ambiguous linked-branch evidence/ },
      { ticket: { ...ticket, linkedBranches: [{ repo: "pa-platform", branch: "feature/PAP-999-wrong", state: "planned", linkedAt: ticket.createdAt, linkedBy: "test" }] }, repo: "pa-platform", pattern: /Invalid linked-branch evidence/ },
      { ticket, repo: "other", pattern: /Cross-project linked-branch evidence/ },
    ];

    for (const value of cases) {
      assert.throws(() => requireTicketLinkedBranch(value.ticket, value.repo), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, value.pattern);
        assert.ok(error.message.length <= 2000);
        assert.match(error.message, /Correction:/);
        return true;
      });
    }
  });
});

test("store rejects duplicate and conflicting repository evidence and audits same-entry promotion", () => {
  withLinkedBranchEnv(({ repo, store }) => {
    const ticket = createTicket(store);
    store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-audit" } }, "planner");
    assert.throws(
      () => store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-audit" } }, "duplicate"),
      /Duplicate planned linked branch/,
    );
    assert.throws(
      () => store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-other" } }, "ambiguous"),
      /Ambiguous linked-branch evidence/,
    );
    assert.throws(
      () => store.update(ticket.id, { add_linked_branch: { repo: "other", branch: "feature/PAP-001-other" } }, "cross-project"),
      /Cross-project linked branch rejected/,
    );

    execFileSync("git", ["branch", "feature/PAP-001-audit", "develop"], { cwd: repo, stdio: "ignore" });
    store.update(ticket.id, { add_linked_branch: { repo: "pa-platform", branch: "feature/PAP-001-audit" } }, "materializer");
    const branchAudits = store.readAudit().filter((entry) => entry.action === "branch_link_added");
    assert.equal(branchAudits.length, 2);
    const [before, after] = branchAudits[1]?.changes["branch"] ?? [];
    assert.equal((before as { state?: string } | undefined)?.state, "planned");
    assert.equal((after as { state?: string } | undefined)?.state, "materialized");
    assert.equal(store.get(ticket.id)?.linkedBranches.length, 1);
  });
});
