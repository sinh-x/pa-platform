import type Database from "better-sqlite3";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withActiveRepositoryRefAdmission, withRepositoryRefAdmission, readProcessFingerprint, type RepositoryRefAdmission } from "../deploy/repository-admission.js";
import { assertReservationInventory } from "../deploy/execution-custody.js";
import { MAX_REPOSITORY_TICKET_SLOT_BYTES, preparedRepositoryTicketReservationPath, withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { readTicketWorkflow } from "../workflows/public.js";
import { integer, object, strictJson, text } from "../workflows/contracts.js";
import { documentReject, type DocumentPackage } from "./package-contract.js";
import type { ContentReviewSubject } from "./content-review-contract.js";
import type { ContentPublicationAuthority, ContentPublicationCaller } from "./content-publication-contract.js";

/** Native process owner checks are separate from the saved local content outcome.
 * Current process/session authentication remains the adapter's responsibility. */
export function assertContentPublicationCaller(db: Database.Database, subject: ContentReviewSubject, document: DocumentPackage,
  current: ContentPublicationCaller, authority?: ContentPublicationAuthority): void {
  const ended = (deployment: string) => {
    const raw = db.prepare("SELECT status,pid FROM deployments WHERE deployment_id=?").get(deployment);
    if (!raw) documentReject("DOCUMENT_UNCERTAIN");
    const row = object(raw, ["status", "pid"]), pid = integer(row.pid, 1, 2147483647);
    const terminal = db.prepare("SELECT event,status,fallback FROM registry_events WHERE deployment_id=? AND event IN ('completed','crashed') LIMIT 3").all(deployment);
    if (terminal.length !== 1) documentReject("DOCUMENT_UNCERTAIN");
    const event = object(terminal[0], ["event", "status", "fallback"]);
    if (!["success", "failed", "partial", "crashed"].includes(text(row.status)) || event.fallback
      || (event.event === "completed" ? (event.status ?? "success") !== row.status : event.event !== "crashed" || row.status !== "crashed")
      || readProcessFingerprint(pid)) documentReject("DOCUMENT_UNCERTAIN");
    let dead = false;
    try { process.kill(pid, 0); } catch (error) { dead = !!error && typeof error === "object" && "code" in error && error.code === "ESRCH"; }
    if (!dead) documentReject("DOCUMENT_UNCERTAIN");
  };
  const origin = { callerIdentitySha256: subject.callerIdentitySha256, selectionSha256: subject.selectionSha256, deploymentId: subject.deploymentId, sessionId: subject.sessionId };
  for (const saved of [origin, ...(authority ? [authority.caller] : [])]) {
    if (saved.deploymentId === current.deploymentId) {
      if (!isDeepStrictEqual(saved, current)) documentReject("DOCUMENT_AUTHORITY");
    } else ended(saved.deploymentId);
  }
  const associations = db.prepare("SELECT deployment_id,status FROM deployments WHERE ticket_id=? LIMIT 1025").all(document.ticket);
  if (associations.length > 1024) documentReject("DOCUMENT_UNCERTAIN");
  for (const value of associations) {
    const row = object(value, ["deployment_id", "status"]), id = text(row.deployment_id, /^d-[a-f0-9]{6}$/);
    if (id !== current.deploymentId && id !== origin.deploymentId && id !== authority?.caller.deploymentId) ended(id);
  }
  if (readTicketWorkflow(document.ticket)) documentReject("DOCUMENT_CONFLICT");
}
function assertCustody(document: DocumentPackage, admission: RepositoryRefAdmission): void {
  withActiveRepositoryRefAdmission(admission, document.repository.root, () => {
    const directory = dirname(preparedRepositoryTicketReservationPath(document.repository.root, document.ticket)), parent = lstatSync(directory);
    if (!parent.isDirectory() || realpathSync(directory) !== directory || parent.uid !== process.getuid?.() || (parent.mode & 0o7777) !== 0o700) documentReject("DOCUMENT_SOURCE");
    const paths = readdirSync(directory).filter(name => name.endsWith(".json")).sort().map(name => join(directory, name));
    const reservations = assertReservationInventory(paths.map(path => {
      const stat = lstatSync(path);
      if (stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) documentReject("DOCUMENT_SOURCE");
      return strictJson(readReviewEvidenceFile(path, MAX_REPOSITORY_TICKET_SLOT_BYTES, "content publication custody"), MAX_REPOSITORY_TICKET_SLOT_BYTES);
    }));
    reservations.forEach((row, index) => {
      if (row.repoKey !== document.repository.key || row.repoRoot !== document.repository.root || paths[index] !== preparedRepositoryTicketReservationPath(document.repository.root, row.ticket)
        || row.ticket === document.ticket || !["idle-ready", "settled-retained"].includes(row.occupancy)
        || row.custody.state !== "idle" || row.custody.holder !== null || row.custody.inFlightOperation !== null) documentReject("DOCUMENT_CONFLICT");
    });
  });
}
/** Existing repository -> ticket exclusion order. No branch intent, capacity,
 * lease, link, queue or resource is created by this finite publication boundary. */
export function withContentPublicationBoundary<T>(document: DocumentPackage, run: (assertCustody: () => void) => T): T {
  return withRepositoryRefTicketExclusion(document.repository.key, document.repository.root, exclusion =>
    withRepositoryRefAdmission(document.repository.root, exclusion, (_identity, admission) => run(() => assertCustody(document, admission))));
}
