import { readFileSync } from "node:fs";
import { parseReviewMatrixPlan } from "../validation/review-contract.js";
import { digest, type ReviewBundle, type WorkflowDefinition, type WorkflowStep } from "../workflows/contracts.js";
export const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
export const sha = "a".repeat(64);
/** Real matrix grammar, synthetic bytes only; never executes its command. */
export function fixtureEvidence(b: ReviewBundle): Map<string, Buffer> {
  const template = readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url), "utf8");
  const originalSource = "requirements:agent-teams/requirements/artifacts/fixture-producer-node-pnpm.md";
  const original = parseReviewMatrixPlan(Buffer.from(template), originalSource).matrix;
  original.source = b.requirements.ref; original.repository = { ...b.repository, baseSha: b.handoff.baseSha, branch: b.handoff.branch };
  original.environment.PA_TICKET_ID = { literal: b.ticket };
  original.prerequisites = original.prerequisites.map(p => p.kind === "operatorGate" ? { ...p, ticket: b.ticket } : p);
  const requirements = Buffer.from(`# Synthetic package\n\n### Full Validation Matrix\n\nMatrix Source: ${b.requirements.ref}\n\n\`\`\`json\n${JSON.stringify(original)}\n\`\`\`\n\n## After\n`);
  const uat = Buffer.from("Synthetic UAT plan, not executed acceptance");
  b.requirements.sha256 = digest(requirements); b.uat.sha256 = digest(uat);
  b.matrix.sha256 = parseReviewMatrixPlan(requirements, b.requirements.ref).digest;
  return new Map([[b.requirements.ref, requirements], [b.uat.ref, uat]]);
}
export function decisionStep(id = "approve", order = 1): WorkflowStep {
  return { id, order, title: "Review exact package", kind: "decision", owner: "operator", dependsOn: [], when: true,
    inputs: [{ name: "package", schemaVersion: "pa-review-bundle/v1", source: "context", field: "bundle" }],
    operation: { id: "decision.package", version: "v1" }, authorization: [], effects: ["operator.capture"],
    outputs: [{ name: "decision", schemaVersion: "pa-decision/v1" }], verification: [{ id: "decision.issued", version: "v1", inputs: ["package"] }],
    transitions: { approved: "completed", rejected: "cancelled", "changes-requested": "blocked", cancelled: "cancelled" },
    failurePolicy: { strategy: "stop", correctionOwner: "operator" } };
}
export function definition(): WorkflowDefinition {
  return { schemaVersion: "pa-workflow-definition/v1", workflowId: "software", version: "r001", requiredCapabilities: ["operator.foreground"], steps: [decisionStep()] };
}
export function bundle(): ReviewBundle {
  const ref = (ref: string) => ({ schemaVersion: "pa-workflow-evidence-ref/v1" as const, ref, version: "r001", sha256: sha });
  return { schemaVersion: "pa-review-bundle/v1", subjectId: "package-one", revision: 1,
    requirements: ref("requirements:agent-teams/requirements/artifacts/example.md"), uat: ref("uat:agent-teams/requirements/artifacts/example-uat.md"), matrix: ref("requirements:agent-teams/requirements/artifacts/example.md"),
    repository: { key: "example", root: "/canonical/example" }, ticket: "EX-1", route: { team: "builder", mode: "orchestrator" },
    handoff: { type: "fresh", baseSha: "b".repeat(40), branch: "feature/EX-1-example", branchAction: "create" },
    workflow: { id: "software", version: "r001", sha256: digest(bytes(definition())) },
    scope: { requirements: ["FR-01"], acceptanceCriteria: ["AC-01"], files: ["src/a.ts"], directories: [], newPaths: [], checks: [], excludedEffects: ["remote.push", "checkout.return"] },
    requestedPermissions: ["artifact.publish-pair", "ticket.queue.advance", "source.edit-scoped", "check.execute-scoped", "repair.same-scope", "git.commit-local"] };
}
