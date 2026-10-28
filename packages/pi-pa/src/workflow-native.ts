import { randomUUID, createHash } from "node:crypto";
import { userInfo } from "node:os";
import { JsonWorkflowError, MAX_WORKFLOW_RECORD_BYTES, type WorkflowCaller, type WorkflowHost } from "@pa-platform/pa-core";
import { authenticatePiPreparationCaller, type PiPreparationContext } from "./pi-extension/prepared-workflow.js";

export interface PiWorkflowContext extends PiPreparationContext {
  readonly ui?: { select(title: string, choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined> };
}
export function authenticatePiWorkflowCaller(context: PiWorkflowContext, env: NodeJS.ProcessEnv = process.env): WorkflowCaller {
  // Reuse existing registry/process-incarnation/canonical-root/foreground authentication, not environment identity alone.
  const caller = authenticatePiPreparationCaller(context, env);
  return { deploymentId: caller.deploymentId, repoKey: caller.repoKey, repoRoot: caller.repoRoot, ticket: caller.ticket,
    team: "requirements", mode: "analyze", identitySha256: caller.callerIdentity };
}
const CHOICES = ["Approve exact package and displayed permissions", "Reject exact package", "Request changes", "Cancel"];
/** Native-only port. The public tool never takes a principal, outcome, permissions or capture receipt. */
export function createPiWorkflowCapture(context: PiWorkflowContext, authenticate: () => WorkflowCaller = () => authenticatePiWorkflowCaller(context)): WorkflowHost["capture"] {
  return async request => {
    if (context.mode !== "tui" || !context.ui?.select) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "native-foreground", "operator");
    const before = authenticate();
    const view = JSON.stringify({ action: request.action, runId: request.runId, expectedRevision: request.revision, subjectSha256: request.subjectSha256,
      ...(request.decisionId ? { decisionId: request.decisionId } : {}), subject: request.subject }, null, 2);
    // Never truncate an authority view. Oversized decision requests must be reduced by the producer, not silently hidden.
    if (Buffer.byteLength(view, "utf8") > MAX_WORKFLOW_RECORD_BYTES) throw new JsonWorkflowError("WORKFLOW_CONTRACT", "decision-request-size", "package-owner");
    const choices = request.action === "revoke" ? ["Revoke this exact decision", "Cancel"] : CHOICES;
    const selected = await context.ui.select(view, choices);
    const after = authenticate();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "stale-native-caller", "launcher-owner");
    const outcome = request.action === "revoke" ? selected === choices[0] ? "approved" : "cancelled"
      : selected === CHOICES[0] ? "approved" : selected === CHOICES[1] ? "rejected" : selected === CHOICES[2] ? "changes-requested" : "cancelled";
    const captureId = randomUUID();
    const sha256 = createHash("sha256").update(JSON.stringify({ captureId, caller: before.identitySha256, view, outcome })).digest("hex");
    return { outcome, principal: `local-uid:${userInfo().uid}`, evidence: { schemaVersion: "pa-workflow-evidence-ref/v1", ref: `native-workflow-capture:${captureId}`, version: "v1", sha256 } };
  };
}
