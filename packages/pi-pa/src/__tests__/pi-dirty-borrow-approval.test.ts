import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PA_PI_EXECUTION_MODE_ENV, captureRepositoryGitSnapshot, type RepositoryDirtyBorrowApproval, type RepositoryEvidenceInspection } from "@pa-platform/pa-core";
import { createDirtyBorrowApprovalTool, isForegroundPiOrchestratorEnvironment } from "../pi-extension/dirty-borrow-approval.js";

function fixture(): { root: string; parentDirectory: string; snapshot: ReturnType<typeof captureRepositoryGitSnapshot>; inspection: RepositoryEvidenceInspection } {
  const root = mkdtempSync(join(tmpdir(), "pi-dirty-approval-"));
  mkdirSync(join(root, ".git"));
  const parentDirectory = join(root, "parent");
  const head = "a".repeat(40);
  const captureSnapshot = (status: string) => captureRepositoryGitSnapshot(root, (args) => {
    if (args[0] === "symbolic-ref") return "feature/PAP-191-dirty-approval\n";
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "status") return status;
    throw new Error(`unexpected Git command ${args.join(" ")}`);
  });
  const snapshot = captureSnapshot(`1 .M N... 100644 100644 100644 ${"b".repeat(40)} ${"b".repeat(40)} existing.ts\0? untracked.ts\0`);
  const preLaunchGitSnapshot = captureSnapshot("");
  const processFingerprint = { pid: 1234, startTimeTicks: "55", bootId: "boot" } as const;
  const inspection: RepositoryEvidenceInspection = {
    state: "live",
    reason: "fixture",
    leasePath: join(root, ".git", "lease"),
    evidenceIdentity: `v1-${"c".repeat(64)}`,
    lease: {
      schemaVersion: 1,
      ownershipToken: "parent-secret",
      canonicalRepoKey: "pa-platform",
      canonicalRepoRoot: root,
      deploymentId: "d-parent",
      deploymentDirectory: parentDirectory,
      runtime: "pi",
      mode: "orchestrator",
      team: "builder",
      launchMode: "foreground",
      processFingerprint,
      acquiredAt: "2026-09-12T00:00:00.000Z",
      preLaunchGitSnapshot,
    },
  };
  return { root, parentDirectory, snapshot, inspection };
}

function environment(root: string, parentDirectory: string): NodeJS.ProcessEnv {
  return {
    [PA_PI_EXECUTION_MODE_ENV]: "foreground",
    PA_TEAM: "builder",
    PA_MODE: "orchestrator",
    PA_DEPLOYMENT_ID: "d-parent",
    PA_DEPLOYMENT_DIR: parentDirectory,
    PA_REPO: root,
    PA_TICKET_ID: "PAP-191",
  };
}

const approvedInput = {
  classifications: [
    { path: "existing.ts", classification: "active-ticket-preserved" as const },
    { path: "untracked.ts", classification: "active-ticket-produced" as const },
  ],
  plannedNewPaths: ["planned.ts"],
};

test("approval tool exists only for the exact interactive foreground orchestrator environment", () => {
  const fixtureState = fixture();
  try {
    const exact = environment(fixtureState.root, fixtureState.parentDirectory);
    assert.equal(isForegroundPiOrchestratorEnvironment(exact), true);
    for (const patch of [
      { [PA_PI_EXECUTION_MODE_ENV]: "background" },
      { PA_TEAM: "requirements" },
      { PA_MODE: "implement" },
      { PA_DEPLOYMENT_ID: "" },
      { PA_TICKET_ID: "" },
    ]) assert.equal(isForegroundPiOrchestratorEnvironment({ ...exact, ...patch }), false);
  } finally {
    rmSync(fixtureState.root, { recursive: true, force: true });
  }
});

test("a clean-launch parent can explicitly approve one complete dirty current snapshot without protected output", async () => {
  const fixtureState = fixture();
  let published: RepositoryDirtyBorrowApproval | undefined;
  try {
    const tool = createDirtyBorrowApprovalTool({
      env: environment(fixtureState.root, fixtureState.parentDirectory),
      captureSnapshot: () => fixtureState.snapshot,
      inspectLease: () => fixtureState.inspection,
      isDeploymentRunning: () => true,
      now: () => new Date("2026-09-12T01:00:00.000Z"),
      createToken: () => "protected-receipt-id",
      publishApproval: (approval) => { published = approval; return join(fixtureState.parentDirectory, "repository-dirty-borrow.approval.json"); },
    });
    assert.equal(tool.name, "pa_dirty_borrow_approval");
    let prompt = "";
    const output = await tool.execute("protected-approval-reference", approvedInput, undefined, undefined, {
      mode: "tui",
      ui: { select: async (title: string) => { prompt = title; return "Approve preserve-and-continue"; } },
    });
    assert.equal(output.details.outcome, "approved");
    assert.deepEqual(output.details.approvedPaths, ["existing.ts", "planned.ts", "untracked.ts"]);
    assert.match(prompt, /1\. \.M "existing\.ts" — active-ticket-preserved/);
    assert.match(prompt, /2\. \?\? "untracked\.ts" — active-ticket-produced/);
    assert.match(prompt, /\+ "planned\.ts"/);
    assert.ok(published);
    assert.equal(fixtureState.inspection.lease?.preLaunchGitSnapshot.statusRecordCount, 0);
    assert.deepEqual(published.snapshot, fixtureState.snapshot);
    assert.equal(published.snapshot.statusRecordCount, 2);
    assert.equal(published.classifications.length, 2);
    assert.doesNotMatch(output.content[0]!.text, /protected-receipt-id|protected-approval-reference|parent-secret|[0-9a-f]{64}/);
  } finally {
    rmSync(fixtureState.root, { recursive: true, force: true });
  }
});

test("cancel, rejection, UI absence, and invalid classification create no receipt", async () => {
  const fixtureState = fixture();
  try {
    let publications = 0;
    const make = () => createDirtyBorrowApprovalTool({
      env: environment(fixtureState.root, fixtureState.parentDirectory),
      captureSnapshot: () => fixtureState.snapshot,
      inspectLease: () => fixtureState.inspection,
      isDeploymentRunning: () => true,
      publishApproval: () => { publications += 1; return "unused"; },
    });
    const cancelled = await make().execute("call-cancel", approvedInput, undefined, undefined, { mode: "tui", ui: { select: async () => undefined } });
    assert.equal(cancelled.details.outcome, "cancelled");
    const rejected = await make().execute("call-reject", approvedInput, undefined, undefined, { mode: "tui", ui: { select: async () => "Reject and create no receipt" } });
    assert.equal(rejected.details.outcome, "rejected");
    const unavailable = await make().execute("call-print", approvedInput, undefined, undefined, { mode: "print", ui: { select: async () => "Approve preserve-and-continue" } });
    assert.equal(unavailable.details.outcome, "ui_unavailable");
    const partial = await make().execute("call-partial", { classifications: approvedInput.classifications.slice(0, 1), plannedNewPaths: [] }, undefined, undefined, { mode: "tui", ui: { select: async () => "Approve preserve-and-continue" } });
    assert.equal(partial.details.outcome, "validation_error");
    const globbed = await make().execute("call-glob", { ...approvedInput, plannedNewPaths: ["src/*.ts"] }, undefined, undefined, { mode: "tui", ui: { select: async () => "Approve preserve-and-continue" } });
    assert.equal(globbed.details.outcome, "validation_error");
    assert.equal(publications, 0);
  } finally {
    rmSync(fixtureState.root, { recursive: true, force: true });
  }
});
