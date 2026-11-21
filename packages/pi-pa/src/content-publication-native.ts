import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ContentPublicationService, DocumentPackageError, RegistryHandoffReviewJournal, TicketStore, assertContentPublicationCaller,
  assertNativeRestartProcessDead, contentReviewLocalHost, getAiUsageDir, getDeployPaths, getTicketsDir, isModeCapabilitySession,
  openDurableRegistryDatabase, openReadonlyRegistryDatabase, parseContentPublicationRequest, withContentPublicationBoundary, workflowDigest,
  type ContentPublicationHost } from "@pa-platform/pa-core";
import { authenticatePiReadonlyDocumentCaller, documentTicketMutationContext } from "./document-session.js";
import { readPiProcessIdentity } from "./process-identity.js";
import type { PiHandoffContext } from "./handoff-native.js";

/** Separately requested finite native publication consent. Public JSON contains
 * only exact references/actions, never a boolean, outcome, caller or grant. */
export async function mutatePiContentPublication(raw: string, context: PiHandoffContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const request = parseContentPublicationRequest(raw);
  const authenticate = () => {
    if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const caller = authenticatePiReadonlyDocumentCaller(context);
    if (!isModeCapabilitySession(caller.profile) || !caller.sessionId || !caller.ticket || !caller.capabilities
      || !["document.local-review", "document.handoff", "document.package"].every(id => caller.capabilities!.policy.allow.includes(id))) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    return caller;
  };
  const initial = authenticate(), root = getAiUsageDir();
  const inside = (parent: string, path: string) => { const part = relative(parent, path); return part === "" || part !== ".." && !part.startsWith("../") && !isAbsolute(part); };
  if (realpathSync(root) !== root || realpathSync(getTicketsDir()) !== getTicketsDir() || inside(initial.repoRoot, root)
    || inside(join(root, "agent-teams/requirements/artifacts"), initial.repoRoot)) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
  const db = request.action === "status" ? openReadonlyRegistryDatabase(true) : openDurableRegistryDatabase();
  try {
    const journal = new RegistryHandoffReviewJournal(db, false);
    const tickets = new TicketStore(undefined, documentTicketMutationContext(initial, "pa_handoff"));
    const local = contentReviewLocalHost(db, tickets, journal, root);
    const current = () => {
      const caller = authenticate();
      if (!isDeepStrictEqual(initial, caller)) throw new DocumentPackageError("DOCUMENT_STALE");
      return { callerIdentitySha256: caller.identitySha256, selectionSha256: workflowDigest(JSON.stringify(caller.capabilities)), deploymentId: caller.deploymentId, sessionId: caller.sessionId! };
    };
    const host: ContentPublicationHost = { ...local, tickets, authenticate: current, withPublicationBoundary: withContentPublicationBoundary,
      assertDocument(document) {
        current();
        if (document.ticket !== initial.ticket || document.repository.key !== initial.repoKey || document.repository.root !== initial.repoRoot) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
        local.assertDocument(document);
      },
      assertCaller(subject, document, authority) {
        const caller = current();
        assertContentPublicationCaller(db, subject, document, caller, authority);
        for (const saved of [subject, ...(authority ? [authority.caller] : [])]) if (saved.deploymentId !== caller.deploymentId) {
          assertNativeRestartProcessDead(readPiProcessIdentity(saved.deploymentId, getDeployPaths(saved.deploymentId).deployDir));
        }
      },
      async confirm(action, view) {
        const caller = current();
        if (context.mode !== "tui" || !context.ui?.select || signal?.aborted) throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
        const document = view.document;
        const title = action === "authorize"
          ? `Publish exact ${document.ticket} · ${document.packageId} revision ${document.revision} to agent-teams/requirements/artifacts/packages/${document.ticket}/${document.packageId}/r${String(document.revision).padStart(3, "0")} and attach its complete immutable reader. Reuse the saved content decision; this does not sign content again. No branch, link, queue, lifecycle, resource or launch effect. Local confirmation; human identity is not verified.`
          : `${action === "revoke" ? "Revoke" : "Supersede"} exact content approval for ${document.ticket} · ${document.packageId} revision ${document.revision}. Fence unperformed publication; preserve completed effects and history.${view.successorReference ? ` Successor: ${view.successorReference}.` : ""}`;
        const choice = action === "authorize" ? "Authorize only this exact publication" : action === "revoke" ? "Revoke this exact content approval" : "Supersede with this exact approved successor";
        const answer = await context.ui.select(title, ["Cancel", choice], signal ? { signal } : undefined);
        if (!isDeepStrictEqual(caller, current())) throw new DocumentPackageError("DOCUMENT_STALE");
        return answer === choice ? "confirmed" : "cancelled";
      },
    };
    const service = new ContentPublicationService(journal, host);
    if (request.action === "status") return await service.status(request.reference);
    if (request.action === "authorize") return await service.authorize(request.reference);
    if (request.action === "revoke") return await service.revoke(request.reference);
    if (request.action === "supersede") return await service.supersede(request.reference, request.successorReference);
    return await service.publish(request.reference);
  } finally { db.close(); }
}
