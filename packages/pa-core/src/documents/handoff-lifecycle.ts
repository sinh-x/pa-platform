import { isDeepStrictEqual } from "node:util";
import { creationDigest } from "../tickets/create-intent.js";
import type { TicketStore } from "../tickets/store.js";
import { ID, object, oneOf, SHA256, text, workflowTicket } from "../workflows/contracts.js";
import { intakeNativeHandoffTicket } from "./handoff-intake.js";
import type { NativeHandoffPlanningHost } from "./handoff-planning.js";
import { documentGuard, documentReject } from "./package-contract.js";

/** Internal finite lifecycle composition, not public tool grammar or a grant.
 * Uses the same fresh native intake/association owner and complete-ticket CAS.
 * No arbitrary assignment/status/ref data, terminal transition or queue port. */
export function stageNativeHandoffTicket(store: TicketStore, host: NativeHandoffPlanningHost, input: unknown) {
  const request = documentGuard(() => {
    const row = object(input, ["ticket", "requestId", "expectedTicketVersion", "stage"]);
    return { ticket: workflowTicket(row.ticket), requestId: text(row.requestId, ID), expectedTicketVersion: text(row.expectedTicketVersion, SHA256),
      stage: oneOf(row.stage, ["analysis", "review", "changes-requested"]) };
  });
  const initial = structuredClone(host.authenticate());
  text(initial.identitySha256, SHA256);
  if (initial.ticket !== request.ticket) documentReject("DOCUMENT_AUTHORITY");
  const identity = { scope: creationDigest({ domain: "pa-handoff-stage/v1", ...initial }), requestId: request.requestId };
  return store.withWorkflowTransaction(() => {
    const current = () => {
      if (!isDeepStrictEqual(initial, host.authenticate())) documentReject("DOCUMENT_STALE");
      return intakeNativeHandoffTicket(store, host, { ticket: request.ticket }).ticket;
    };
    current();
    const result = store.applyHandoffWithIntent(request.ticket, request.expectedTicketVersion, { kind: "stage", stage: request.stage }, "requirements/analyze", identity, {
      assertCurrent() { current(); },
      assertSnapshot(before) { current(); if (before.project !== initial.repoKey) documentReject("DOCUMENT_AUTHORITY"); },
      afterPersist(stage) {
        const value: unknown = host.afterPersist?.(stage);
        if (value instanceof Promise) void value.catch(() => {});
        if (value !== undefined) documentReject("DOCUMENT_UNCERTAIN");
      },
    });
    const readback = store.inspectHandoffWithIntent(identity);
    if (!readback?.complete || !isDeepStrictEqual(readback.record.change, { kind: "stage", stage: request.stage })) documentReject("DOCUMENT_UNCERTAIN");
    return { schemaVersion: "pa-handoff-stage-result/v1" as const, identity, ticket: result.ticket, reused: result.reused,
      approval: "not-issued", publication: "not-performed", branchRef: "not-performed", queue: "not-performed", launchReady: false };
  });
}
