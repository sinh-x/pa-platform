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

test("builder orchestrator mode requires exact canonical and authenticated execution identities", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.match(modeDoc, /`repo_key`: the registry-bound canonical repository key/);
  assert.match(modeDoc, /`repo_root`: the canonical registry root/);
  assert.match(modeDoc, /`worktree_root`: the distinct launch-time authenticated Treehouse ticket checkout/);
  assert.match(modeDoc, /`PA_REPO`, runtime CWD, Git top-level[\s\S]{0,240}must equal authenticated `worktree_root`/);
  assert.match(modeDoc, /unmatched checkout fails closed before project reads, project-file or branch mutation, and builder child\/runtime spawn/);
  assert.match(modeDoc, /diagnostic is at most 2,000 JavaScript characters/);
});

test("builder orchestrator mode encodes PPA planned/materialized and non-Pi branch gates", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.match(modeDoc, /Requirements supplies only the approved canonical\/ticket\/base\/branch plan/);
  assert.match(modeDoc, /trusted PPA launcher reserves capacity and acquires or reuses and authenticates the ticket checkout/);
  assert.match(modeDoc, /\| `planned` \|[\s\S]{0,480}action is `create`[\s\S]{0,320}ordinary Git to create the exact branch/);
  assert.match(modeDoc, /\| `materialized` \|[\s\S]{0,480}action is `select`[\s\S]{0,320}ordinary Git to select that exact branch/);
  assert.match(modeDoc, /Any mismatch, dirty state, duplicate lineage, or exhausted capacity[\s\S]{0,240}Reject before project-file mutation, branch mutation, and child\/runtime spawn/);
  assert.match(modeDoc, /OPA\/OpenCode and CPA\/Claude Code only[\s\S]{0,240}supported non-Treehouse seven-state branch behavior/);
  assert.match(modeDoc, /Never create\/select a substitute branch, relocate, stash, reset, repair, or perform checkout return/);
});

test("builder orchestrator mode passes stable authenticated checkout context to report-only children", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.match(modeDoc, /Every child receives the same canonical key\/root, authenticated worktree root, ticket, exact feature branch/);
  assert.match(modeDoc, /Launch against the registry key with authenticated runtime evidence selecting `worktree_root`; never derive or substitute a child path from CWD/);
  assert.match(modeDoc, /--repo "<repo_key>"[\s\S]*--ticket <ticket_id>/);
  assert.match(modeDoc, /Implement children are report-only\.[^\n]*edit requirements checkboxes, change ticket status/);
});

test("builder orchestrator mode keeps review fixes on the same branch and records evidence", (t) => {
  const modeDoc = readMode(t);
  if (!modeDoc) return;

  assert.match(modeDoc, /compose one fix objective per feedback bundle with `Goal`, `Requirements`, `Verification`, `Context`, and `Guardrails`/i);
  assert.match(modeDoc, /Delegate the fix to `builder\/implement` on the same repository, ticket, and branch/);
  assert.match(modeDoc, /persist the accepted review bracket and finding decisions before checklist or lifecycle mutation/i);
  assert.match(modeDoc, /Do not create another branch for review feedback/);
  assert.match(modeDoc, /Critical\/Major objectives require Sinh confirmation before launch/);
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
