import { randomUUID } from "node:crypto";
import { inspectPiDocumentBranch } from "./document-branch.js";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { userInfo } from "node:os";
import {
  DocumentPackageError, DocumentPackageService, RegistryDocumentJournal, TicketStore, getAiUsageDir, getDb, getTicketsDir,
  observeReadonlyRepositoryTicketSlot, preparedRepositoryTicketReservationPath, readTicketWorkflow, resolveTrustedTicketMutationContext, workflowDigest,
  type DocumentPackageHost,
} from "@pa-platform/pa-core";
import { createPiDocumentConfirmation, type PiDocumentConfirmationContext } from "./document-confirmation-native.js";
import { authenticatePiDocumentCaller, assertSameDocumentCaller, DOCUMENT_CONFIRMATION_SESSION_VERSION, workspaceDocumentCaller } from "./document-session.js";
import { nativeReviewPages, type PiWorkflowContext } from "./workflow-native.js";

/** Native foreground consent. Model JSON has no outcome, actor or permission field. */
export function createPiDocumentCapture(context: PiWorkflowContext, authenticate = () => authenticatePiDocumentCaller(context), signal?: AbortSignal): DocumentPackageHost["capture"] {
  return async request => {
    const before = authenticate();
    if (context.mode !== "tui" || !context.ui?.select || signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const transcript: { page: string; choice: string | null }[] = [];
    const ask = async (page: string, choices: string[]) => {
      if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
      const choice = await context.ui!.select(page, choices, signal ? { signal } : undefined);
      if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
      transcript.push({ page, choice: choices.includes(choice ?? "") ? choice! : null });
      return choices.includes(choice ?? "") ? choice : undefined;
    };
    const p = request.subject;
    const lines = [
      `${p.ticket}: ${request.action === "revoke" ? "revoke an issued document decision" : "final requirements package review"}`,
      `Repository: ${p.repository.key} (${p.repository.root})`,
      `Package: ${p.packageId}, revision ${p.revision}`,
      "Decision brief:", request.brief,
      "All required approval-relevant members:", ...p.members.map(m => `${m.id} (${m.role}, ${m.mediaType}): ${m.description}\n${m.source}`),
      "Full text is accessible with pa_document read on this immutable snapshot; source files are also available for manual review. Images remain opaque, not executed or automatically viewed.",
      "Informative references (not approved specifications, not fetched):", ...p.references.map(r => `${r.locator} (${r.version}): ${r.description}`),
      "Finite effects: publish ALL exact members and promote requirements only after the full set.",
      p.effects.queue ? "Then queue this ticket for builder/orchestrator (pending-implementation, builder/team-manager)." : "No queue effect requested.",
      "No source edit, command execution, checkout allocation/return, builder launch, install, push, merge or product acceptance is granted.",
      "A successor never silently replaces an active implementation. Retained owners and unknown effects remain protected.",
      ...(request.action === "revoke" ? [`Revoke ${request.decisionId}. Completed effects are not undone.`] : []),
    ];
    let cancelled = false;
    const review = nativeReviewPages(lines);
    for (let i = 0; i < review.length; i++) if (await ask(`Package review ${i + 1}/${review.length}\n${review[i]}`, ["Continue review", "Cancel"]) !== "Continue review") { cancelled = true; break; }
    const approve = request.action === "revoke" ? "Revoke this exact decision" : "Approve exact package and displayed publication/queue effects";
    let choice: string | undefined;
    if (!cancelled) for (let attempt = 0; attempt < 16; attempt++) {
      choice = await ask(`${p.ticket}: decide on the reviewed package. Approval is not test completion or human product acceptance.`, [approve, ...(request.action === "capture" ? ["Request changes", "Reject exact package"] : []), "Cancel", "View technical bindings"]);
      if (choice !== "View technical bindings") break;
      choice = undefined;
      const detail = nativeReviewPages(JSON.stringify({ sha256: request.sha256, package: p }, null, 2).split("\n"));
      for (const page of detail) if (await ask(page, ["Continue review", "Cancel"]) !== "Continue review") { cancelled = true; break; }
      if (cancelled) break;
    }
    assertSameDocumentCaller(before, authenticate());
    const outcome = cancelled ? "cancelled" : choice === approve ? "approved" : choice === "Request changes" ? "changes-requested" : choice === "Reject exact package" ? "rejected" : "cancelled";
    const captureId = randomUUID();
    const principal = `local-uid:${userInfo().uid}`;
    const nativeEvidence = Buffer.from(JSON.stringify({ schemaVersion: "pa-native-document-review/v1", captureId, principal, caller: before.identitySha256, request, review, transcript, outcome }));
    return { outcome, principal, evidenceSha256: workflowDigest(nativeEvidence), nativeEvidence };
  };
}
export async function mutatePiDocument(request: string, context: PiWorkflowContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const authenticate = () => { if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY"); return authenticatePiDocumentCaller(context); };
  const caller = authenticate(), artifactRoot = getAiUsageDir();
  const artifactBase = join(artifactRoot, "agent-teams/requirements/artifacts");
  const inside = (root: string, path: string) => { const r = relative(root, path); return r === "" || (!r.startsWith("../") && r !== ".." && !isAbsolute(r)); };
  if (realpathSync(artifactRoot) !== artifactRoot || inside(caller.repoRoot, artifactRoot) || inside(artifactBase, caller.repoRoot)) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
  try { if (realpathSync(getTicketsDir()) !== getTicketsDir()) throw new DocumentPackageError("DOCUMENT_AUTHORITY"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const tickets = new TicketStore(undefined, resolveTrustedTicketMutationContext({ deploymentId: caller.deploymentId }, false));
  const host: DocumentPackageHost = { artifactRoot, tickets, authenticate, workspaceProfile: workspaceDocumentCaller(caller),
    confirmationProfile: caller.profile === DOCUMENT_CONFIRMATION_SESSION_VERSION,
    ...(caller.profile === DOCUMENT_CONFIRMATION_SESSION_VERSION ? { inspectBranch: (ticket: string) => inspectPiDocumentBranch(authenticate(), ticket, tickets) } : {}),
    ...(caller.profile === DOCUMENT_CONFIRMATION_SESSION_VERSION && (context as PiDocumentConfirmationContext).ui?.custom ? { confirm: createPiDocumentConfirmation(context as PiDocumentConfirmationContext, authenticate, signal) } : {}),
    capture: createPiDocumentCapture(context, authenticate, signal),
    assertEffectAvailable(subject) {
      authenticate();
      // A retained controller is sticky even if its decision is cancelled or revoked.
      // Independent freeze/check/discussion is deliberately not gated by this.
      if (readTicketWorkflow(subject.ticket)) throw new DocumentPackageError("DOCUMENT_CONFLICT");
      try { observeReadonlyRepositoryTicketSlot(subject.repository.root, subject.ticket); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { lstatSync(preparedRepositoryTicketReservationPath(subject.repository.root, subject.ticket)); }
        catch (reservationError) { if ((reservationError as NodeJS.ErrnoException).code === "ENOENT") return; throw new DocumentPackageError("DOCUMENT_UNCERTAIN"); }
      } else throw new DocumentPackageError("DOCUMENT_UNCERTAIN"); }
      throw new DocumentPackageError("DOCUMENT_CONFLICT");
    },
  };
  return new DocumentPackageService(new RegistryDocumentJournal(getDb()), host).execute(request);
}
