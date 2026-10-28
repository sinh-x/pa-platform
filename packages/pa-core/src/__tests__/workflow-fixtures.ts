import { digest, type ReviewBundle, type WorkflowDefinition, type WorkflowStep } from "../workflows/contracts.js";
export const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
export const sha = "a".repeat(64);
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
