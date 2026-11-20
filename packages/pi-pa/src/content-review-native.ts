import { isDeepStrictEqual } from "node:util";
import { ContentReviewService, DocumentPackageError, RegistryHandoffReviewJournal, TicketStore, contentReviewLocalHost, contentReviewReferenceSha,
  getAiUsageDir, isModeCapabilitySession, openDurableRegistryDatabase, openReadonlyRegistryDatabase, parseContentReviewRequest, parseWorkflowRequest, presentFullDocumentReader,
  workflowDigest, workflowObject, type ContentReviewHost } from "@pa-platform/pa-core";
import { authenticatePiDocumentPlanObserver } from "./document-session.js";
import { showHandoffReview } from "./pi-extension/handoff-review-ui.js";
import type { PiHandoffContext } from "./handoff-native.js";

const activeReviews = new Map<string, { reference: string; result: Promise<Record<string, unknown>> }>();

/** All three clients enter ContentReviewService. Native entry authenticates the
 * selected session, not a human; it cannot widen the content-only purpose. */
export async function mutatePiContentReview(raw: string, context: PiHandoffContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
  let row: Record<string, unknown>;
  try {
    const value: unknown = parseWorkflowRequest(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocumentPackageError("DOCUMENT_INPUT");
    row = workflowObject(value, Object.keys(value));
    if (row.schemaVersion !== "pa-content-review/v1") throw new DocumentPackageError("DOCUMENT_INPUT");
    if (row.action === "prepare") {
      workflowObject(row, ["schemaVersion", "action", "sha256"]);
      if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new DocumentPackageError("DOCUMENT_INPUT");
    } else if (row.action === "review") {
      workflowObject(row, ["schemaVersion", "action", "reference"]); contentReviewReferenceSha(row.reference);
    } else parseContentReviewRequest(raw);
  } catch { throw new DocumentPackageError("DOCUMENT_INPUT"); }
  const authenticate = () => {
    const caller = authenticatePiDocumentPlanObserver(context);
    if (!isModeCapabilitySession(caller.profile) || !caller.sessionId || !caller.ticket || !caller.capabilities
      || !["document.local-review", "document.handoff", "document.package"].every(id => caller.capabilities!.policy.allow.includes(id))) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    return caller;
  };
  const caller = authenticate();
  const readonly = row.action === "list" || row.action === "show";
  const db = readonly ? openReadonlyRegistryDatabase(true) : openDurableRegistryDatabase();
  try {
    const journal = new RegistryHandoffReviewJournal(db, !readonly), tickets = new TicketStore(), artifactRoot = getAiUsageDir();
    const local = contentReviewLocalHost(db, tickets, journal, artifactRoot);
    const host: ContentReviewHost = { ...local, assertDocument(document) {
      if (!isDeepStrictEqual(caller, authenticate())) throw new DocumentPackageError("DOCUMENT_STALE");
      if (document.ticket !== caller.ticket || document.repository.key !== caller.repoKey || document.repository.root !== caller.repoRoot) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
      local.assertDocument(document);
    } };
    const service = new ContentReviewService(journal, host);
    if (row.action === "prepare") {
      // Validated above; re-read with the document owner, not an arbitrary path.
      if (typeof row.sha256 !== "string") throw new DocumentPackageError("DOCUMENT_INPUT");
      const document = journal.documents.subject(row.sha256); host.assertDocument(document);
      const delivery = await presentFullDocumentReader(document, artifactRoot, sha => journal.documents.snapshot(sha), { signal });
      if (typeof delivery.deliverySha256 !== "string") throw new DocumentPackageError("DOCUMENT_UNCERTAIN");
      const reference = await service.prepare(row.sha256, delivery.deliverySha256, { callerIdentitySha256: caller.identitySha256,
        selectionSha256: workflowDigest(JSON.stringify(caller.capabilities)), deploymentId: caller.deploymentId, sessionId: caller.sessionId! });
      return { schemaVersion: "pa-content-review-prepared/v1", reference, ticket: document.ticket, packageId: document.packageId, revision: document.revision,
        purpose: "sign-content-only", approval: "not-issued", publication: "not-published", trust: "local-unverified", authentication: "not-provided" };
    }
    if (row.action === "review") {
      if (typeof row.reference !== "string") throw new DocumentPackageError("DOCUMENT_INPUT");
      const active = activeReviews.get(caller.identitySha256);
      if (active) {
        if (active.reference !== row.reference) throw new DocumentPackageError("DOCUMENT_CONFLICT");
        return await active.result;
      }
      const result = service.review(row.reference, async (request, view, settled) => {
        if (context.mode !== "tui" || !context.ui?.custom) throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
        return showHandoffReview(context.ui, request, view, settled, "detached");
      }, signal);
      activeReviews.set(caller.identitySha256, { reference: row.reference, result });
      try { return await result; }
      finally { if (activeReviews.get(caller.identitySha256)?.result === result) activeReviews.delete(caller.identitySha256); }
    }
    const request = parseContentReviewRequest(raw);
    if (request.action === "list") {
      if (request.ticket !== caller.ticket) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_review_subjects'").get();
      return { schemaVersion: "pa-content-review-list/v1", ticket: request.ticket, reviews: exists ? await service.list(caller.repoKey, request.ticket) : [], selection: "explicit-reference-required", trust: "local-unverified", authentication: "not-provided" };
    }
    if (request.action === "show") return { ...await service.show(request.reference) };
    if (request.action === "request") return await service.request(request.reference);
    return await service.decide(request.reference, request.outcome);
  } finally { db.close(); }
}
