import { isDeepStrictEqual } from "node:util";
import { associateDeploymentTicket, getDb, getDeploymentEvents, hasOtherTicketDeploymentAssociation, queryDeploymentStatus } from "../registry/index.js";
import { creationDigest } from "../tickets/create-intent.js";
import type { TicketStore } from "../tickets/store.js";
import type { Ticket } from "../tickets/types.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";
import { MODE_CAPABILITY_SESSION, parseModeCapabilityBinding } from "../mode-capabilities.js";
import { workflowDigest } from "../deploy/prepared-workflow.js";
import { ID, object, SHA256, text, workflowTicket } from "../workflows/contracts.js";
import { documentGuard, documentReject } from "./package-contract.js";

/** Candidate fresh-session boundary. Not registered/selected by any retained
 * profile. A native adapter must prove process/session and immutable selection;
 * ordinary request data cannot supply this caller or enable this owner. */
export const HANDOFF_SESSION_VERSION = "requirements-handoff/v1";
export interface HandoffIntakeCaller {
  deploymentId: string; sessionId: string; repoKey: string; repoRoot: string;
  selectionSha256: string; ticket: string | null;
}
export interface HandoffIntakeHost {
  authenticate(): HandoffIntakeCaller;
  /** Actual selected capability and physical repository owners, synchronous. */
  assertAvailable(caller: HandoffIntakeCaller): void;
  afterPersist?(stage: "intent" | "ticket" | "audit" | "association"): void;
}
export type HandoffIntakeInput = { ticket: string } | { title: string; content: string };
const actor = "requirements/analyze";
function sync(value: unknown): void {
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== undefined) documentReject("DOCUMENT_AUTHORITY");
}
function binding(caller: HandoffIntakeCaller): string {
  text(caller.deploymentId, /^d-[a-f0-9]{6}$/); text(caller.sessionId, undefined, 256);
  text(caller.repoKey, ID); text(caller.repoRoot); text(caller.selectionSha256, SHA256);
  if (caller.ticket !== null) workflowTicket(caller.ticket);
  return creationDigest({ domain: "pa-handoff-intake/v1", deploymentId: caller.deploymentId, sessionId: caller.sessionId,
    repoKey: caller.repoKey, repoRoot: caller.repoRoot, selectionSha256: caller.selectionSha256 });
}
/** Actual TicketStore creation + independent registry association composition.
 * Stable ONE intake per native session, no model-selected idempotency namespace.
 * Creation and association are separate durable effects, never claimed atomic.
 * Internal until the new selection/foreground consumer is independently reviewed. */
export function intakeNativeHandoffTicket(store: TicketStore, host: HandoffIntakeHost, input: HandoffIntakeInput) {
  const initial = structuredClone(host.authenticate()), scope = binding(initial);
  let title: string | undefined, content: string | undefined, supplied: string | undefined;
  if (Object.hasOwn(input, "ticket")) supplied = documentGuard(() => workflowTicket(object(input, ["ticket"]).ticket));
  else {
    const row = documentGuard(() => object(input, ["title", "content"]));
    title = text(row.title, undefined, 256);
    if (typeof row.content !== "string" || !row.content.trim() || Buffer.byteLength(row.content) > 32768
      || /[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(row.content)) documentReject("DOCUMENT_INPUT");
    content = row.content;
    try { assertNoSensitiveMatch("content", JSON.stringify(input)); } catch { documentReject("DOCUMENT_INPUT"); }
  }
  const reason = `Native requirements intake ${scope}`;
  const current = (): HandoffIntakeCaller => {
    const caller = host.authenticate();
    if (binding(caller) !== scope) documentReject("DOCUMENT_STALE");
    sync(host.assertAvailable(structuredClone(caller)));
    const events = getDeploymentEvents(caller.deploymentId), starts = events.filter(e => e.event === "started"), start = starts[0];
    const status = queryDeploymentStatus(caller.deploymentId);
    if (starts.length !== 1 || !start || !status || status.status !== "running" || ![HANDOFF_SESSION_VERSION, MODE_CAPABILITY_SESSION].includes(start.note ?? "")
      || start.team !== "requirements" || start.mode !== "analyze" || start.runtime !== "pi" || start.binary !== "ppa"
      || status.team !== start.team || status.mode !== start.mode || status.runtime !== start.runtime
      || start.repo_root !== caller.repoRoot || start.repo !== caller.repoRoot || start.worktree_root !== caller.repoRoot
      || status.repo_root !== caller.repoRoot || status.repo !== caller.repoRoot || status.worktree_root !== caller.repoRoot
      || [start, status].some(e => e.rogue_one || e.builder_authority || e.treehouse_path || e.ticket_slot_id || e.repository_permit || e.parent_deployment_id)
      || start.resumed_from_deployment_id || start.fallback || (status.ticket_id || null) !== caller.ticket) documentReject("DOCUMENT_AUTHORITY");
    if (start.note === MODE_CAPABILITY_SESSION) {
      try {
        if (!start.mode_capability_binding || start.mode_capability_binding !== status.mode_capability_binding) documentReject("DOCUMENT_AUTHORITY");
        const selected = parseModeCapabilityBinding(JSON.parse(start.mode_capability_binding!));
        if (JSON.stringify(selected) !== start.mode_capability_binding || !selected.policy.allow.includes("document.handoff")
          || workflowDigest(JSON.stringify(selected)) !== caller.selectionSha256) documentReject("DOCUMENT_AUTHORITY");
      } catch { documentReject("DOCUMENT_AUTHORITY"); }
    }
    let ticket = start.ticket_id || null;
    const edges = events.filter(e => e.event === "ticket-associated");
    // This fresh finite route can attach once, never replace or adopt another
    // context owner's history. The immutable launch/environment is not rewritten.
    if (edges.length > 1) documentReject("DOCUMENT_AUTHORITY");
    for (const edge of edges) {
      if (ticket !== null || (edge.previous_ticket_id || null) !== null || edge.actor !== actor || edge.reason !== reason || !edge.ticket_id) documentReject("DOCUMENT_AUTHORITY");
      ticket = edge.ticket_id;
    }
    if (ticket !== caller.ticket || initial.ticket !== null && initial.ticket !== ticket) documentReject("DOCUMENT_STALE");
    return structuredClone(caller);
  };
  return store.withWorkflowTransaction(() => {
    let caller = current(), ticket: Ticket, reused = true;
    const checkTicket = (id: string) => {
      const value = store.get(id);
      if (!value || value.project !== initial.repoKey) documentReject("DOCUMENT_AUTHORITY");
      if (hasOtherTicketDeploymentAssociation(id, initial.deploymentId)) documentReject("DOCUMENT_CONFLICT");
      return value!;
    };
    if (supplied) {
      if (caller.ticket !== null && caller.ticket !== supplied) documentReject("DOCUMENT_CONFLICT");
      ticket = checkTicket(supplied);
    } else {
      const identity = { scope, requestId: "native-intake" };
      // An associated session must prove its ORIGINAL creation before entering
      // creation recovery. A missing record is not permission to reserve an ID.
      if (caller.ticket !== null) {
        const original = store.inspectCreationWithIntent(identity);
        if (!original || original.record.ticket.id !== caller.ticket) documentReject("DOCUMENT_UNCERTAIN");
        checkTicket(caller.ticket);
      }
      const created = store.createWithIntent({ project: initial.repoKey, title: title!, description: content!, type: "feature", priority: "medium",
        status: "requirement-review", assignee: "requirements/team-manager", summary: "", estimate: "M", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] }, actor, identity, {
        requestBinding: creationDigest(input), assertCurrent() { current(); },
        afterPersist(stage) { sync(host.afterPersist?.(stage)); },
      });
      ticket = checkTicket(created.ticket.id); reused = created.reused;
      caller = current();
      if (caller.ticket !== null && caller.ticket !== ticket.id) documentReject("DOCUMENT_CONFLICT");
    }
    const before = structuredClone(ticket);
    current();
    if (caller.ticket === null) {
      // The existing registry owner CASes null -> exact ticket and appends its
      // independent native edge in ONE SQLite transaction. No result import.
      getDb().transaction(() => {
        // Lock order: TicketStore -> short registry transaction. Recheck other
        // current/HISTORICAL association owners under registry write exclusion.
        const locked = current(); checkTicket(ticket.id);
        if (locked.ticket !== null) documentReject("DOCUMENT_CONFLICT");
        associateDeploymentTicket({ deploymentId: initial.deploymentId, ticketId: ticket.id, expectedTicketId: null, actor, reason });
      }).immediate();
      sync(host.afterPersist?.("association"));
    }
    const associated = current(), readback = checkTicket(ticket.id);
    if (associated.ticket !== ticket.id || !isDeepStrictEqual(before, readback)) documentReject("DOCUMENT_UNCERTAIN");
    return { schemaVersion: "pa-handoff-intake-result/v1" as const, ticket: readback, reused,
      association: { deploymentId: associated.deploymentId, ticket: associated.ticket, verified: true as const },
      intakeScopeSha256: scope, approval: "not-issued", queue: "not-performed", launchReady: false };
  });
}
