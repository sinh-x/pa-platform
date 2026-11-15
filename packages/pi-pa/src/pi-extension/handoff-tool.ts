import { Type } from "typebox";
import { DocumentPackageError } from "@pa-platform/pa-core";
import { authenticatePiHandoffCaller, handoffFailure, mutatePiHandoff, type PiHandoffContext } from "../handoff-native.js";
import type { PiToolDefinition } from "./index.js";

export function createHandoffTool(identitySha256: string): PiToolDefinition {
  return { name: "pa_handoff", label: "PA Requirements Handoff", executionMode: "sequential",
    description: "Opt-in native finite handoff owner, not a workflow controller. Send one strict pa-handoff-native/v1 raw JSON request. intake(ticket) reuses/associates a supplied ticket; intake(title,content) creates exactly one session-bound ticket. stage(ticket,requestId,expectedTicketVersion,stage=analysis|review|changes-requested) and plan(ticket,requestId,expectedTicketVersion,branch) retain original CAS/request coordinates. prepare-review(documentSubjectSha256,planRequestId,effects={publish,branchRef,queue}) derives the complete immutable reader and exact native intent subject; it issues no approval. review(subjectSha256,expectedRevision) requests ONE native foreground review with full text/exact branch/base/finite effects and default Cancel; revoke adds decisionId. Unchanged retries reuse ORIGINAL review revision and subject; an uncaptured pending review is uncertain, never reopened. publish/complete-branch/queue(subjectSha256,decisionId) verify their own new native finite authority; queue additionally requires exact ref/link completion. No old document decision import or source/resource/checkout/launch authority. status(subjectSha256) reads original review coordinates. open(subjectSha256,deliverySha256) requests the explicitly agreed SYSTEM-DEFAULT BROWSER FALLBACK on the verified local index only: no network isolation, browser lifecycle or viewing guarantee; launcher success is not viewing. Preserve original uncertain opening instead of retrying with new identities. New capability is unselected unless explicitly present in this fresh session's immutable policy. Source support is not installed qualification, independent review or human UAT.",
    parameters: Type.Object({ request: Type.String({ maxLength: 65536 }) }, { additionalProperties: false }),
    execute: async (_id, input, signal, _update, rawContext) => {
      let result: Record<string, unknown>;
      try {
        const context = rawContext as PiHandoffContext;
        if (authenticatePiHandoffCaller(context).identitySha256 !== identitySha256) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
        if (Object.keys(input).length !== 1 || typeof input.request !== "string" || Buffer.byteLength(input.request) > 65536) throw new DocumentPackageError("DOCUMENT_INPUT");
        result = { schemaVersion: "pa-handoff-result/v1", ok: true, result: await mutatePiHandoff(input.request, context, signal), executionAdmitted: false };
      } catch (error) { result = handoffFailure(error); }
      let output = JSON.stringify(result);
      if (Buffer.byteLength(output) > 50 * 1024) {
        const value = result.result as Record<string, unknown> | undefined;
        output = JSON.stringify({ schemaVersion: "pa-handoff-result/v1", ok: result.ok, output: "bounded-summary-use-status-and-document-read",
          subjectSha256: value?.subjectSha256, ticketVersion: value?.ticketVersion, deliverySha256: (value?.subject as Record<string, unknown> | undefined)?.deliverySha256,
          identity: value?.identity, operationId: value?.operationId, decisionId: value?.decisionId, originalExpectedRevision: value?.originalExpectedRevision,
          expectedRevision: value?.expectedRevision, reviewRevision: value?.reviewRevision, pendingReview: value?.pendingReview,
          latestRequest: value?.latestRequest, latestDecision: value?.latestDecision, approval: value?.approval, executionAdmitted: false });
      }
      return { content: [{ type: "text", text: output }], details: {}, ...(result.ok === true ? {} : { isError: true }) };
    } };
}
