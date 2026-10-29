import { templateService, type TemplateHost, type TemplateConsumerPort } from "../templates/service.js";
import { digest, object, parseReviewBundle, reject, strictJson, MAX_WORKFLOW_RECORD_BYTES, type ReviewBundle } from "./contracts.js";
import type { WorkflowSelection } from "./selected.js";

/** Shared structural consumer; registration enables unsigned drafts only, not
 * workflow selection, capture or effects. Never a callback in public JSON. */
export const reviewBundleTemplateConsumer: TemplateConsumerPort = Object.freeze({ schemaVersion: "pa-review-bundle/v1", validate: parseReviewBundle });

/** Invoke the shared PAP-270 producer afresh. A caller-supplied receipt is never an admission input. */
export function produceWorkflowSubject(selection: WorkflowSelection, request: Uint8Array, host: TemplateHost): { raw: Uint8Array; subject: ReviewBundle; provenance: Uint8Array } {
  const input = object(strictJson(request, MAX_WORKFLOW_RECORD_BYTES), ["action", "id", "version", "bindings"]);
  if (input.action !== "render" || input.id !== "review-bundle") reject("WORKFLOW_SOURCE");
  const result = templateService(request, { ...host, reviewBundleConsumer: reviewBundleTemplateConsumer });
  if (!result.ok || typeof result.candidate !== "string") reject("WORKFLOW_SOURCE");
  const registry = result.registry as { root: string; configRevision: string };
  if (registry.root !== selection.configRoot || registry.configRevision !== selection.configRevision) reject("WORKFLOW_SOURCE");
  const raw = Buffer.from(result.candidate); const subject = parseReviewBundle(raw);
  const provenance = Buffer.from(JSON.stringify({ schemaVersion: "pa-workflow-producer-provenance/v1", unsigned: true, requestSha256: digest(request), producer: result.producer }));
  return { raw, subject, provenance };
}
