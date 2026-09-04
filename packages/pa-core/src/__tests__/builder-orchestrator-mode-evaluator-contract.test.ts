import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { buildDecisionPayload } from "../decision-payload.js";

const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
const modePath = configRoot ? join(configRoot, "teams", "builder", "modes", "orchestrator.md") : "";

function readMode(t: TestContext): string | undefined {
  if (!existsSync(modePath)) {
    t.skip("external pa-platform-config fixture not available");
    return undefined;
  }
  return readFileSync(modePath, "utf-8");
}

test("builder orchestrator mode excludes evaluator child coverage contract", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.doesNotMatch(modeDoc, /Child coverage contract/);
  assert.doesNotMatch(modeDoc, /Evaluator Launch=in-flight/);
  assert.doesNotMatch(modeDoc, /Post-Deploy Evaluator/);
});

test("builder orchestrator mode hard-fails without a ticket before startup", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.match(modeDoc, /\*\*Ticket required\.\*\*/);
  assert.match(modeDoc, /orchestrator requires ticket_id; none provided/);
  assert.match(modeDoc, /exit before any report, ticket, Git, or child-deployment mutation/);

  const noTicketRuleIndex = modeDoc.indexOf("- **Ticket required.**");
  const startupIndex = modeDoc.indexOf("## Startup and Resume");
  assert.ok(noTicketRuleIndex >= 0 && startupIndex > noTicketRuleIndex);
});

test("builder orchestrator mode requires one exact registered repository identity", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.match(modeDoc, /`repo_key`: the resolved repository-registry key/);
  assert.match(modeDoc, /`repo_root`: the exact configured project path/);
  assert.match(modeDoc, /Every available identity source[\s\S]*must agree with the canonical pair and exact root/);
  assert.match(modeDoc, /fails closed before project reads, mutations, or child\/runtime spawn/);
  assert.match(modeDoc, /diagnostic no longer than 2,000 characters/);
});

test("builder orchestrator mode encodes all seven direct branch-gate outcomes", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;
  const outcomes = [
    "| Already on the exact ticket branch | Proceed. |",
    "| On zero-entry `develop`, `develop` equals `origin/develop`, exact ticket branch is absent | Create the exact ticket branch from `develop`, then proceed. |",
    "| On zero-entry `develop`, `develop` equals `origin/develop`, exact ticket branch exists | Check out the exact ticket branch, then proceed. |",
    "| Dirty `develop` | Stop unchanged. |",
    "| `develop` is ahead, behind, or diverged from `origin/develop` | Stop unchanged. |",
    "| On the release branch or any unrelated branch | Stop unchanged. |",
    "| Detached HEAD | Stop unchanged. |",
  ];
  for (const outcome of outcomes) assert.ok(modeDoc.includes(outcome), `missing branch outcome: ${outcome}`);

  assert.match(modeDoc, /Use `opa branch create`/);
  assert.match(modeDoc, /a direct checkout only for the existing exact branch outcome/);
  assert.match(modeDoc, /Every stop occurs before project-file mutation or child launch/);
  assert.match(modeDoc, /Never stash, reset, repair, relocate, or select a substitute checkout/);
});

test("builder orchestrator mode passes stable direct-checkout context to report-only children", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.match(modeDoc, /Every child receives the same `repo_key`, `repo_root`, ticket, exact feature branch/);
  assert.match(modeDoc, /Launch against the registry key or exact root; never derive a child path from CWD/);
  assert.match(modeDoc, /--repo "<repo_key>"[\s\S]*--ticket <ticket_id>/);
  assert.match(modeDoc, /Implement children are report-only\. They must not edit requirements checkboxes or change ticket status\./);
});

test("builder orchestrator mode keeps review fixes on the same branch and records evidence", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.match(modeDoc, /Compose one fix objective per feedback bundle with `Goal`, `Requirements`, `Verification`, `Context`, and `Guardrails`/);
  assert.match(modeDoc, /Launch builder\/implement with the same repository key\/root, branch, and ticket/);
  assert.match(modeDoc, /Record the feedback source, objective artifact, child IDs\/statuses, verification, confirmation, and cycle count/);
  assert.match(modeDoc, /Do not create another branch for review feedback/);
  assert.match(modeDoc, /Never launch while confirmation is pending, rejected, or stopped/);
});

test("decision payload builder renders unrelated tickets exactly and stays bounded", () => {
  const fixtures = [
    {
      ticketId: "PAP-101",
      objective: "Refresh the import boundary",
      findings: "The loader bypasses the documented adapter at src/import.ts:42",
      verification: "Focused import tests pass",
      question: "Proceed with this fix",
      options: "Proceed applies the patch; Reject re-scopes it; Stop preserves the ticket",
    },
    {
      ticketId: "OPS-202",
      objective: "Rotate the staging credential",
      findings: "The deployment manifest still references the expired secret at deploy.yaml:8",
      verification: "Config validation and dry-run pass",
      question: "Accept this completed change",
      options: "Approve permits handoff; Reject requests changes; Stop preserves status",
    },
  ];
  const expected = [
    "Ticket: PAP-101 Proposal: Refresh the import boundary Evidence/Findings: The loader bypasses the documented adapter at src/import.ts:42 Verification: Focused import tests pass. Options: Proceed applies the patch; Reject re-scopes it; Stop preserves the ticket Decision: Proceed with this fix?",
    "Ticket: OPS-202 Proposal: Rotate the staging credential Evidence/Findings: The deployment manifest still references the expired secret at deploy.yaml:8 Verification: Config validation and dry-run pass. Options: Approve permits handoff; Reject requests changes; Stop preserves status Decision: Accept this completed change?",
  ];
  fixtures.forEach((fixture, index) => {
    const payload = buildDecisionPayload(fixture);
    assert.equal(payload, expected[index]);
    assert.ok(payload.length <= 1500);
    assert.equal((payload.match(/\?/g) ?? []).length, 1);
  });

  for (const step of ["Step 3.5", "Step 6.5"]) {
    const payload = buildDecisionPayload({
      ticketId: "PAP-999",
      objective: `${step} ${"objective ".repeat(300)}`,
      findings: "finding evidence",
      verification: "verification evidence",
      question: "Proceed with this bounded decision",
      options: "Proceed applies the fix; Reject requests changes; Stop preserves status",
    });
    assert.ok(payload.length <= 1500);
    assert.match(payload, /Options: Proceed applies the fix; Reject requests changes; Stop preserves status/);
    assert.match(payload, /Decision: Proceed with this bounded decision\?$/);
    assert.equal((payload.match(/\?/g) ?? []).length, 1);
  }
});
