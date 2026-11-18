import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { userInfo } from "node:os";
import {
  DocumentPackageError, HandoffPublicationService, HandoffReviewService, LocalHandoffReviewService, isModeCapabilitySession, RegistryHandoffReviewJournal,
  RegistryReaderOpeningJournal, TicketStore, capabilityToolSelected, documentReject, getAiUsageDir, getDb, getTicketsDir,
  handoffBranchIntentSha, inspectFullDocumentReader, intakeNativeHandoffTicket, nativeHandoffPlanIdentity, nativeHandoffTicketVersion, openBoundDocumentReader, openDurableRegistryDatabase, parseWorkflowRequest,
  observeReadonlyRepositoryTicketSlot, preparedRepositoryTicketReservationPath, readTicketWorkflow,
  planNativeHandoffTicket, presentFullDocumentReader, readArtifactFile, stageNativeHandoffTicket,
  workflowDigest, executeLocalReview, getDeployPaths, assertNativeRestartProcessDead, localHandoffReviewHooks, refreshNativeHandoffTicket, withLocalHandoffRepository, type NativeHandoffPlanningHost, type NativeHandoffReviewHost, type LocalReviewOutcome,
} from "@pa-platform/pa-core";
import { readPiProcessIdentity } from "./process-identity.js";
import { authenticatePiDocumentCaller, documentTicketMutationContext } from "./document-session.js";
import { SystemDocumentBrowserFallback } from "./handoff-browser-fallback.js";
import { showHandoffReview, type HandoffReviewUi } from "./pi-extension/handoff-review-ui.js";
import type { PiWorkflowContext } from "./workflow-native.js";

const VERSION = "pa-handoff-native/v1" as const;
const LOCAL_VERSION = "pa-handoff-native/v2" as const;
type Effects = { publish: boolean; branchRef: boolean; queue: boolean };
type Request =
  | { action: "intake"; ticket: string } | { action: "intake"; title: string; content: string }
  | { action: "stage"; ticket: string; requestId: string; expectedTicketVersion: string; stage: "analysis" | "review" | "changes-requested" }
  | { action: "plan"; ticket: string; requestId: string; branch: string; expectedTicketVersion: string }
  | { action: "prepare-review"; documentSubjectSha256: string; planRequestId: string; effects: Effects }
  | { action: "review" | "request"; subjectSha256: string; expectedRevision: number }
  | { action: "show"; subjectSha256: string }
  | { action: "decide"; subjectSha256: string; expectedRevision: number; requestKey: string; outcome: LocalReviewOutcome }
  | { action: "revoke"; subjectSha256: string; expectedRevision: number; decisionId: string }
  | { action: "publish" | "complete-branch" | "queue"; subjectSha256: string; decisionId: string }
  | { action: "open"; subjectSha256: string; deliverySha256: string }
  | { action: "status" | "preflight"; subjectSha256: string }
  | { action: "refresh"; subjectSha256: string; expectedRevision: number; expectedTicketVersion: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new DocumentPackageError("DOCUMENT_INPUT");
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, keys: string[]): void {
  const descriptors = Object.getOwnPropertyDescriptors(row);
  if (Reflect.ownKeys(row).length !== keys.length || keys.some(key => !descriptors[key] || !("value" in descriptors[key]!))) throw new DocumentPackageError("DOCUMENT_INPUT");
}
function text(value: unknown, pattern?: RegExp, maximum = 4096): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/.test(value) || pattern && !pattern.test(value)) throw new DocumentPackageError("DOCUMENT_INPUT");
  return value;
}
const sha = (value: unknown) => text(value, /^[a-f0-9]{64}$/, 64);
const ticket = (value: unknown) => text(value, /^[A-Z][A-Z0-9]*-\d+$/, 64);
const id = (value: unknown) => text(value, /^[a-z][a-z0-9.-]{0,127}$/, 128);
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1023) throw new DocumentPackageError("DOCUMENT_INPUT"); return value as number; }
function parse(row: Record<string, unknown>): Request {
  const action = text(row.action, undefined, 32);
  if (row.schemaVersion !== VERSION && row.schemaVersion !== LOCAL_VERSION) throw new DocumentPackageError("DOCUMENT_INPUT");
  if (row.schemaVersion === LOCAL_VERSION) {
    if (action === "preflight") { exact(row, ["schemaVersion", "action", "subjectSha256"]); return { action, subjectSha256: sha(row.subjectSha256) }; }
    if (action === "refresh") { exact(row, ["schemaVersion", "action", "subjectSha256", "expectedRevision", "expectedTicketVersion"]); return { action, subjectSha256: sha(row.subjectSha256), expectedRevision: revision(row.expectedRevision), expectedTicketVersion: sha(row.expectedTicketVersion) }; }
    if (action === "show") { exact(row, ["schemaVersion", "action", "subjectSha256"]); return { action, subjectSha256: sha(row.subjectSha256) }; }
    if (action === "request") { exact(row, ["schemaVersion", "action", "subjectSha256", "expectedRevision"]); return { action, subjectSha256: sha(row.subjectSha256), expectedRevision: revision(row.expectedRevision) }; }
    if (action === "decide") {
      exact(row, ["schemaVersion", "action", "subjectSha256", "expectedRevision", "requestKey", "outcome"]);
      const outcome = row.outcome;
      if (outcome !== "approved" && outcome !== "changes-requested" && outcome !== "rejected" && outcome !== "cancelled") throw new DocumentPackageError("DOCUMENT_INPUT");
      return { action, subjectSha256: sha(row.subjectSha256), expectedRevision: revision(row.expectedRevision), requestKey: sha(row.requestKey), outcome };
    }
  }
  if (action === "intake") {
    if (Object.hasOwn(row, "ticket")) { exact(row, ["schemaVersion", "action", "ticket"]); return { action, ticket: ticket(row.ticket) }; }
    exact(row, ["schemaVersion", "action", "title", "content"]);
    return { action, title: text(row.title, undefined, 256), content: typeof row.content === "string" ? row.content : documentReject("DOCUMENT_INPUT") };
  }
  if (action === "stage") {
    exact(row, ["schemaVersion", "action", "ticket", "requestId", "expectedTicketVersion", "stage"]);
    if (!(["analysis", "review", "changes-requested"] as unknown[]).includes(row.stage)) throw new DocumentPackageError("DOCUMENT_INPUT");
    return { action, ticket: ticket(row.ticket), requestId: id(row.requestId), expectedTicketVersion: sha(row.expectedTicketVersion), stage: row.stage as "analysis" | "review" | "changes-requested" };
  }
  if (action === "plan") {
    exact(row, ["schemaVersion", "action", "ticket", "requestId", "branch", "expectedTicketVersion"]);
    return { action, ticket: ticket(row.ticket), requestId: id(row.requestId), branch: text(row.branch, undefined, 256), expectedTicketVersion: sha(row.expectedTicketVersion) };
  }
  if (action === "prepare-review") {
    exact(row, ["schemaVersion", "action", "documentSubjectSha256", "planRequestId", "effects"]);
    const effects = record(row.effects); exact(effects, ["publish", "branchRef", "queue"]);
    if (![effects.publish, effects.branchRef, effects.queue].every(value => typeof value === "boolean") || effects.branchRef && !effects.publish || effects.queue && !effects.branchRef) throw new DocumentPackageError("DOCUMENT_INPUT");
    return { action, documentSubjectSha256: sha(row.documentSubjectSha256), planRequestId: id(row.planRequestId), effects: effects as unknown as Effects };
  }
  if (action === "review") { exact(row, ["schemaVersion", "action", "subjectSha256", "expectedRevision"]); return { action, subjectSha256: sha(row.subjectSha256), expectedRevision: revision(row.expectedRevision) }; }
  if (action === "revoke") { exact(row, ["schemaVersion", "action", "subjectSha256", "expectedRevision", "decisionId"]); return { action, subjectSha256: sha(row.subjectSha256), expectedRevision: revision(row.expectedRevision), decisionId: id(row.decisionId) }; }
  if (["publish", "complete-branch", "queue"].includes(action)) {
    exact(row, ["schemaVersion", "action", "subjectSha256", "decisionId"]);
    return { action: action as "publish" | "complete-branch" | "queue", subjectSha256: sha(row.subjectSha256), decisionId: id(row.decisionId) };
  }
  if (action === "open") { exact(row, ["schemaVersion", "action", "subjectSha256", "deliverySha256"]); return { action, subjectSha256: sha(row.subjectSha256), deliverySha256: sha(row.deliverySha256) }; }
  if (action === "status") { exact(row, ["schemaVersion", "action", "subjectSha256"]); return { action, subjectSha256: sha(row.subjectSha256) }; }
  throw new DocumentPackageError("DOCUMENT_INPUT");
}
export interface PiHandoffContext extends PiWorkflowContext { readonly ui?: PiWorkflowContext["ui"] & HandoffReviewUi }
export function authenticatePiHandoffCaller(context: PiHandoffContext, signal?: AbortSignal) {
  if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
  const caller = authenticatePiDocumentCaller(context);
  if (!isModeCapabilitySession(caller.profile) || !caller.capabilities || !caller.sessionId || !caller.handoffIdentitySha256 || !capabilityToolSelected(caller.capabilities.policy, "pa_handoff")) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
  return Object.freeze({ deploymentId: caller.deploymentId, sessionId: caller.sessionId, repoKey: caller.repoKey, repoRoot: caller.repoRoot, ticket: caller.ticket,
    identitySha256: caller.handoffIdentitySha256, selectionSha256: workflowDigest(JSON.stringify(caller.capabilities)) });
}
function planningHost(context: PiHandoffContext, signal?: AbortSignal): NativeHandoffPlanningHost {
  const authenticate = () => {
    if (signal?.aborted) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const caller = authenticatePiHandoffCaller(context);
    if (!caller.ticket) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    return caller as ReturnType<NativeHandoffPlanningHost["authenticate"]>;
  };
  return { authenticate, assertAvailable(expected) { if (!isDeepStrictEqual(expected, authenticate())) throw new DocumentPackageError("DOCUMENT_STALE"); } };
}
function reviewHost(context: PiHandoffContext, tickets: TicketStore, db: ReturnType<typeof getDb>, signal?: AbortSignal): NativeHandoffReviewHost {
  const authenticate = () => {
    const caller = planningHost(context, signal).authenticate(); return caller;
  };
  const localHooks = localHandoffReviewHooks(db, tickets, new RegistryHandoffReviewJournal(db, false), getAiUsageDir());
  return { artifactRoot: getAiUsageDir(), tickets, authenticate,
    localReview: {
      ...localHooks,
      assertEffectCaller(subject, intent, caller) {
        localHooks.assertEffectCaller!(subject, intent, caller);
        if (caller.deploymentId !== subject.origin.deploymentId) {
          const original = readPiProcessIdentity(subject.origin.deploymentId, getDeployPaths(subject.origin.deploymentId).deployDir);
          assertNativeRestartProcessDead(original);
        }
      },
      async capture(request, view, settled) {
        const before = authenticate();
        if (context.mode !== "tui" || !context.ui?.custom || signal?.aborted) throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
        const detached = signal && settled ? AbortSignal.any([signal, settled]) : signal ?? settled;
        const outcome = await showHandoffReview(context.ui, request, view, detached, "detached");
        if (outcome !== "detached" && !isDeepStrictEqual(before, authenticate())) throw new DocumentPackageError("DOCUMENT_STALE");
        return outcome;
      },
    },
    assertAvailable(intent) {
      const caller = authenticate();
      if (caller.ticket !== intent.ticket || caller.repoKey !== intent.repository.key || caller.repoRoot !== intent.repository.root) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
      intakeNativeHandoffTicket(tickets, planningHost(context, signal), { ticket: intent.ticket });
      if (readTicketWorkflow(intent.ticket)) throw new DocumentPackageError("DOCUMENT_CONFLICT");
      try { observeReadonlyRepositoryTicketSlot(caller.repoRoot, intent.ticket); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DocumentPackageError("DOCUMENT_UNCERTAIN");
        try { lstatSync(preparedRepositoryTicketReservationPath(caller.repoRoot, intent.ticket)); }
        catch (reservation) { if ((reservation as NodeJS.ErrnoException).code === "ENOENT") return; throw new DocumentPackageError("DOCUMENT_UNCERTAIN"); }
      }
      throw new DocumentPackageError("DOCUMENT_CONFLICT");
    },
    async capture(request, view) {
      const before = authenticate();
      if (context.mode !== "tui" || !context.ui?.custom || signal?.aborted) throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
      const outcome = await showHandoffReview(context.ui, request, view, signal);
      if (!isDeepStrictEqual(before, authenticate())) throw new DocumentPackageError("DOCUMENT_STALE");
      const interactionId = `interaction-${randomUUID()}`, principal = `local-uid:${userInfo().uid}`;
      return Buffer.from(JSON.stringify({ schemaVersion: "pa-handoff-native-evidence/v1", method: "pi-native-handoff-review", request, outcome, principal, interactionId,
        boundary: "native-foreground-not-hostile-same-uid-isolation" }));
    } };
}
function services(context: PiHandoffContext, db: ReturnType<typeof getDb>, signal?: AbortSignal) {
  const caller = authenticatePiHandoffCaller(context, signal), artifactRoot = getAiUsageDir();
  const inside = (root: string, path: string) => { const value = relative(root, path); return value === "" || value !== ".." && !value.startsWith("../") && !isAbsolute(value); };
  if (realpathSync(artifactRoot) !== artifactRoot || inside(caller.repoRoot, artifactRoot) || inside(join(artifactRoot, "agent-teams/requirements/artifacts"), caller.repoRoot)) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
  try { if (realpathSync(getTicketsDir()) !== getTicketsDir()) throw new DocumentPackageError("DOCUMENT_AUTHORITY"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const tickets = new TicketStore(undefined, documentTicketMutationContext(authenticatePiDocumentCaller(context), "pa_handoff"));
  const journal = new RegistryHandoffReviewJournal(db), review = new HandoffReviewService(journal, reviewHost(context, tickets, db, signal));
  const publication = (subjectSha256: string) => {
    const { subject, intent } = journal.subject(subjectSha256);
    return new HandoffPublicationService(db, review, subject.schemaVersion === "pa-handoff-review/v2" ? subject.origin.planIdentity : nativeHandoffPlanIdentity(planningHost(context, signal).authenticate(), intent.requestId));
  };
  return { caller, tickets, db, journal, review, publication, host: planningHost(context, signal) };
}
function verifyPublishedReader(root: string, subjectSha256: string, deliverySha256: string, presentation: Record<string, unknown>): string {
  const folder = join(root, "agent-teams/requirements/artifacts/presentations", subjectSha256, deliverySha256);
  const outputs = presentation.outputs;
  if (!Array.isArray(outputs)) throw new DocumentPackageError("DOCUMENT_UNCERTAIN");
  for (const output of outputs) {
    const row = record(output); exact(row, ["path", "sha256", "bytes"]);
    const path = text(row.path, /^(?:index\.html|raw\/member-[1-9][0-9]*\.(?:md|txt|png|jpg)|members\/member-[1-9][0-9]*\.html)$/);
    const bytes = readArtifactFile(join(folder, path), 64 * 1024 * 1024, "ARTIFACT_STALE");
    if (workflowDigest(bytes) !== sha(row.sha256) || bytes.length !== row.bytes) throw new DocumentPackageError("DOCUMENT_STALE");
  }
  const manifest = readArtifactFile(join(folder, "manifest.json"), 64 * 1024 * 1024, "ARTIFACT_STALE");
  if (workflowDigest(manifest) !== sha(presentation.manifestSha256)) throw new DocumentPackageError("DOCUMENT_STALE");
  return folder;
}
export async function mutatePiHandoff(raw: string, context: PiHandoffContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let request: Request, local: boolean;
  try {
    const row = record(parseWorkflowRequest(raw));
    request = parse(row);
    local = row.schemaVersion === LOCAL_VERSION;
  }
  catch { throw new DocumentPackageError("DOCUMENT_INPUT"); }
  authenticatePiHandoffCaller(context, signal);
  if (local) {
    const selection = authenticatePiDocumentCaller(context).capabilities;
    if (!selection || !["document.local-review", "document.handoff", "document.package"].every(id => selection.policy.allow.includes(id))) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
  }
  if (local && (request.action === "show" || request.action === "status")) {
    return executeLocalReview(JSON.stringify({ schemaVersion: "pa-local-review/v1", action: "show", subjectSha256: request.subjectSha256 }));
  }
  const db = openDurableRegistryDatabase();
  try {
    if (request.action === "status") {
      const caller = authenticatePiHandoffCaller(context, signal), journal = new RegistryHandoffReviewJournal(db, false);
      const { subject, intent, document } = journal.subject(request.subjectSha256);
      if ((subject.schemaVersion === "pa-handoff-review/v2") !== local) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
      if (subject.callerIdentitySha256 !== caller.identitySha256 || subject.selectionSha256 !== caller.selectionSha256
        || intent.ticket !== caller.ticket || intent.repository.key !== caller.repoKey || intent.repository.root !== caller.repoRoot) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
      const events = journal.events(request.subjectSha256);
      return { schemaVersion: "pa-handoff-status/v1", subjectSha256: request.subjectSha256, subject, intent, document: { ticket: document.ticket, packageId: document.packageId, revision: document.revision },
        reviewRevision: events.length, pendingReview: events.at(-1)?.kind === "requested",
        latestRequest: events.filter(event => event.kind === "requested").at(-1)?.request ?? null,
        latestDecision: events.filter(event => event.kind === "issued").at(-1)?.decision ?? null,
        history: "preserved-in-native-journal", launchReady: false, productUat: "not-asserted" };
    }
    return await executeHandoff(request, context, db, local, signal);
  } finally { db.close(); }
}
async function executeHandoff(request: Request,  context: PiHandoffContext, db: ReturnType<typeof getDb>, local: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const s = services(context, db, signal);
  if (request.action === "intake") {
    const host = { authenticate: () => authenticatePiHandoffCaller(context, signal), assertAvailable(expected: ReturnType<typeof authenticatePiHandoffCaller>) {
      if (!isDeepStrictEqual(expected, authenticatePiHandoffCaller(context, signal))) throw new DocumentPackageError("DOCUMENT_STALE");
    } };
    const result = intakeNativeHandoffTicket(s.tickets, host, "ticket" in request ? { ticket: request.ticket } : { title: request.title, content: request.content });
    return { ...result, ticketVersion: nativeHandoffTicketVersion(result.ticket) };
  }
  if (request.action === "stage") {
    const { action: _action, ...input } = request;
    const result = stageNativeHandoffTicket(s.tickets, s.host, input);
    return { ...result, ticketVersion: nativeHandoffTicketVersion(result.ticket) };
  }
  if (request.action === "plan") {
    const result = planNativeHandoffTicket(s.tickets, s.host, JSON.stringify({ schemaVersion: "pa-handoff-request/v1", ...request }), s.db);
    return { ...result, ticketVersion: nativeHandoffTicketVersion(result.ticket) };
  }
  if ("subjectSha256" in request) {
    const { subject, intent } = s.journal.subject(request.subjectSha256);
    if ((subject.schemaVersion === "pa-handoff-review/v2") !== local) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    if (intent.ticket !== s.caller.ticket || intent.repository.key !== s.caller.repoKey || intent.repository.root !== s.caller.repoRoot) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    if (subject.schemaVersion === "pa-handoff-review/v1" && (subject.callerIdentitySha256 !== s.caller.identitySha256 || subject.selectionSha256 !== s.caller.selectionSha256)) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    if (subject.schemaVersion === "pa-handoff-review/v2" && ["publish", "complete-branch", "queue", "refresh"].includes(request.action)) s.review.assertEffectCaller(request.subjectSha256);
  }
  if (request.action === "prepare-review") {
    const caller = s.host.authenticate(), planIdentity = nativeHandoffPlanIdentity(caller, request.planRequestId), plan = s.tickets.inspectHandoffWithIntent(planIdentity);
    if (!plan?.complete || plan.record.change.kind !== "plan") throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const intent = plan.record.change.intent, document = s.journal.documents.subject(request.documentSubjectSha256);
    if (document.ticket !== caller.ticket || document.repository.key !== caller.repoKey || document.repository.root !== caller.repoRoot) throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const delivery = await presentFullDocumentReader(document, getAiUsageDir(), value => s.journal.documents.snapshot(value), { signal });
    const bindings = { documentSubjectSha256: request.documentSubjectSha256,
      branchIntentSha256: handoffBranchIntentSha(intent), deliverySha256: sha(delivery.deliverySha256), selectionSha256: caller.selectionSha256,
      callerIdentitySha256: caller.identitySha256, effects: request.effects };
    const subject = local ? { schemaVersion: "pa-handoff-review/v2" as const, ...bindings,
      origin: { deploymentId: caller.deploymentId, sessionId: caller.sessionId, planIdentity } }
      : { schemaVersion: "pa-handoff-review/v1" as const, ...bindings };
    const subjectSha256 = await s.review.freeze(subject, intent, planIdentity);
    const preflight = local && Object.values(request.effects).some(Boolean)
      ? await new LocalHandoffReviewService(s.journal, { ...s.review.host.localReview!, artifactRoot: getAiUsageDir(), tickets: s.tickets }).preflight(subjectSha256, true) : null;
    return { schemaVersion: local ? "pa-handoff-preparation-result/v2" : "pa-handoff-preparation-result/v1", subjectSha256, subject, intent, delivery,
      ...(local ? { trust: "local-unverified", authentication: "not-provided", preflight } : {}),
      approval: "not-issued", publication: "not-performed", branch: "not-performed", queue: "not-performed", opening: "not-requested", launchReady: false };
  }
  if (local && request.action === "refresh") {
    const previous = s.journal.subject(request.subjectSha256);
    if (previous.subject.schemaVersion !== "pa-handoff-review/v2") throw new DocumentPackageError("DOCUMENT_AUTHORITY");
    const refreshed = refreshNativeHandoffTicket(s.tickets, s.journal, request.subjectSha256, request.expectedRevision, request.expectedTicketVersion,
      () => s.review.assertEffectCaller(request.subjectSha256), s.db);
    const subject = { ...previous.subject, branchIntentSha256: refreshed.intentSha256, origin: { ...previous.subject.origin, planIdentity: refreshed.identity } };
    const subjectSha256 = withLocalHandoffRepository(refreshed.intent, () => s.tickets.withWorkflowTransaction(() => {
      s.review.assertEffectCaller(request.subjectSha256); return s.journal.freeze(subject, refreshed.intent);
    }));
    const owner = new LocalHandoffReviewService(s.journal, { ...s.review.host.localReview!, artifactRoot: getAiUsageDir(), tickets: s.tickets });
    const preflight = await owner.preflight(subjectSha256, true);
    return { schemaVersion: "pa-handoff-refresh-result/v2", ...refreshed, subjectSha256, subject, preflight, ticketVersion: nativeHandoffTicketVersion(refreshed.ticket),
      approval: "not-issued-by-this-operation", nextOwner: preflight.nextOwner, trust: "local-unverified", authentication: "not-provided" };
  }
  if (local && request.action === "preflight") {
    return new LocalHandoffReviewService(s.journal, { ...s.review.host.localReview!, artifactRoot: getAiUsageDir(), tickets: s.tickets }).preflight(request.subjectSha256);
  }
  if (local && (request.action === "request" || request.action === "revoke" || request.action === "decide" || request.action === "show")) {
    const hooks = s.review.host.localReview;
    if (!hooks) throw new DocumentPackageError("DOCUMENT_UNAVAILABLE");
    const owner = new LocalHandoffReviewService(s.journal, { ...hooks, artifactRoot: getAiUsageDir(), tickets: s.tickets });
    if (request.action === "show") return owner.show(request.subjectSha256);
    if (request.action === "decide") return owner.decide(request.subjectSha256, request.expectedRevision, request.requestKey, request.outcome);
    return request.action === "revoke" ? owner.revoke(request.subjectSha256, request.expectedRevision, request.decisionId)
      : owner.request(request.subjectSha256, request.expectedRevision);
  }
  if (request.action === "review") return s.review.review(request.subjectSha256, request.expectedRevision);
  if (request.action === "revoke") return s.review.review(request.subjectSha256, request.expectedRevision, "revoke", request.decisionId);
  if (request.action === "publish") return s.publication(request.subjectSha256).publish(request.subjectSha256, request.decisionId);
  if (request.action === "complete-branch") return s.publication(request.subjectSha256).completeBranch(request.subjectSha256, request.decisionId);
  if (request.action === "queue") return s.publication(request.subjectSha256).queue(request.subjectSha256, request.decisionId);
  if (request.action !== "open") throw new DocumentPackageError("DOCUMENT_INPUT");
  const { subject, document } = s.journal.subject(request.subjectSha256);
  if (subject.deliverySha256 !== request.deliverySha256) throw new DocumentPackageError("DOCUMENT_STALE");
  const presentation = await inspectFullDocumentReader(document, getAiUsageDir(), value => s.journal.documents.snapshot(value), request.deliverySha256, { signal });
  const deliveryRoot = verifyPublishedReader(getAiUsageDir(), subject.documentSubjectSha256, request.deliverySha256, presentation);
  const browser = new SystemDocumentBrowserFallback(join(deliveryRoot, "index.html"));
  const result = openBoundDocumentReader(new RegistryReaderOpeningJournal(s.db), {
    serialize: run => run(), authenticate: () => { const caller = authenticatePiHandoffCaller(context, signal); return { identitySha256: caller.identitySha256, selectionSha256: caller.selectionSha256 }; },
    verifyDelivery(value) { if (value !== request.deliverySha256) throw new DocumentPackageError("DOCUMENT_STALE"); verifyPublishedReader(getAiUsageDir(), subject.documentSubjectSha256, value, presentation); },
    available: () => browser.available(), requestOpen: (delivery, operation) => browser.request(delivery, operation), reconcile: (delivery, operation) => browser.reconcile(delivery, operation),
  }, request.deliverySha256);
  return { ...result, openingMode: "system-default-browser-fallback", cleanupScope: "desktop-launcher-only",
    trustedOpener: "not-qualified", networkIsolation: "not-provided", browserLifecycle: "not-owned", viewing: "not-established" };
}
export function handoffFailure(error: unknown): Record<string, unknown> {
  const reasons: Record<string, string> = {
    DOCUMENT_INPUT: "The request does not match the exact bounded handoff grammar.",
    DOCUMENT_AUTHORITY: "The current caller, immutable selection or finite decision does not authorize this operation.",
    DOCUMENT_STALE: "A bound caller, ticket, document or delivery changed; the original request is retained.",
    DOCUMENT_CONFLICT: "Existing intent, ownership, lifecycle or physical evidence conflicts with the requested effect.",
    DOCUMENT_SOURCE: "Required immutable source or native provenance could not be verified.",
    DOCUMENT_UNCERTAIN: "The original operation may be partial; its outcome or cleanup is not established.",
    DOCUMENT_UNAVAILABLE: "A required native owner or environment is unavailable; the exact cause is not established here.",
  };
  let code = "DOCUMENT_UNAVAILABLE";
  try {
    if (error instanceof DocumentPackageError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string" && Object.hasOwn(reasons, descriptor.value)) code = descriptor.value;
    }
  } catch { /* Hostile exception proxies are not trusted diagnostic facts. */ }
  const guidance = `Handoff completion is not established; preserve any completed effects.\nCondition: This handoff operation cannot report verified completion.\nSource: Native handoff owner (${code}).\nReason: ${reasons[code] ?? reasons.DOCUMENT_UNAVAILABLE}\nCorrection: Ask the runtime owner to inspect the original request and native records. Impact: read-only. Actor: agent or operator. New approval: not required for inspection; repairs need their owning authority. Prerequisite: retain the original subject, revision, request and decision coordinates.\nResume Action: Continue the same operation only after the owner establishes its state and resolves the cause. Remaining effects recheck admission; do not create a replacement request or repeat approval to bypass uncertainty.`;
  return { schemaVersion: "pa-handoff-result/v1", ok: false, code, guidance, scope: "this-operation-only", executionAdmitted: false };
}
