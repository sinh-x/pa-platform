import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { openArtifactDirectory } from "../artifacts/manifest.js";
import { AdvisoryFiles } from "../operations/files.js";
import { digest } from "../workflows/contracts.js";
import { documentReject, type DocumentPackage } from "./package-contract.js";
import type { DocumentConfirmation, DocumentEvent } from "../registry/documents.js";
import type { TicketStore } from "../tickets/store.js";

/** Deterministic derived representation, NOT an importable permission receipt.
 * Own digest is deliberately outside these bytes. */
export function confirmationRepresentation(subject: DocumentPackage, event: DocumentEvent & { data: DocumentConfirmation & { kind: "confirmation" } }): Buffer {
  const d = event.data;
  return Buffer.from(JSON.stringify({ schemaVersion: "pa-document-approval/v1", decisionId: d.decisionId,
    repository: subject.repository, ticket: subject.ticket,
    subject: { packageId: subject.packageId, revision: subject.revision, manifestSha256: d.subjectSha256, members: subject.members },
    decision: d.outcome, operation: d.operation, revokes: d.revokes,
    scope: { content: true, publish: d.scope !== "content", queue: d.scope === "publish-and-queue" },
    confirmationMethod: d.method, interactionId: d.interactionId,
    principal: { id: d.principal, provenance: "native-local-uid-not-independent-human-identity" },
    deploymentId: d.deploymentId, sessionId: d.sessionId, recordedAt: d.recordedAt,
    native: { schemaVersion: d.confirmationVersion, evidenceSha256: d.evidenceSha256, registryRef: `registry-document-event:${subject.repository.key}:${subject.ticket}:${event.revision}`, callerIdentity: d.callerIdentity, requestKey: d.requestKey },
  }, null, 2) + "\n");
}

/** Complete-before-publication, no-replace link; recover only our exact pinned
 * pending inode/prefix. A partial final file, alias or conflicting byte rejects.
 * Ticket mutex serializes managed writers; no hostile-same-UID claim. */
function immutableFile(root: string, folder: string, name: string, bytes: Buffer): void {
  new AdvisoryFiles(root).file(folder, undefined, true);
  const directory = openArtifactDirectory(join(root, folder), "ARTIFACT_STALE");
  const path = (file: string) => `/proc/self/fd/${directory}/${file}`;
  const pending = `.${name}.pending`;
  const inspect = (file: string) => {
    let fd: number;
    try { fd = openSync(path(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > bytes.length || stat.uid !== process.getuid?.() || stat.nlink > 2 || stat.mode & 0o022) documentReject("DOCUMENT_CONFLICT");
      return { stat, bytes: readFileSync(fd) };
    } finally { closeSync(fd); }
  };
  try {
    const final = inspect(name);
    if (final) {
      if (!final.bytes.equals(bytes)) documentReject("DOCUMENT_CONFLICT");
      if (final.stat.nlink === 2) {
        const temp = inspect(pending);
        if (!temp || temp.stat.ino !== final.stat.ino || temp.stat.dev !== final.stat.dev || !temp.bytes.equals(bytes)) documentReject("DOCUMENT_CONFLICT");
        unlinkSync(path(pending)); fsyncSync(directory);
      }
      if (inspect(name)?.stat.nlink !== 1) documentReject("DOCUMENT_CONFLICT");
      return;
    }
    let temp = inspect(pending);
    if (!temp) {
      const fd = openSync(path(pending), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd); fsyncSync(directory); temp = inspect(pending);
    }
    if (!temp || temp.stat.nlink !== 1 || !bytes.subarray(0, temp.bytes.length).equals(temp.bytes)) documentReject("DOCUMENT_CONFLICT");
    const fd = openSync(path(pending), constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (stat.ino !== temp.stat.ino || stat.dev !== temp.stat.dev || stat.nlink !== 1 || stat.size !== temp.bytes.length) documentReject("DOCUMENT_CONFLICT");
      let offset = temp.bytes.length;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    linkSync(path(pending), path(name)); unlinkSync(path(pending)); fsyncSync(directory);
    const written = inspect(name);
    if (!written || written.stat.nlink !== 1 || !written.bytes.equals(bytes)) documentReject("DOCUMENT_UNCERTAIN");
  } finally { closeSync(directory); }
}
export function linkDocumentConfirmation(root: string, tickets: TicketStore, subject: DocumentPackage, event: DocumentEvent & { data: DocumentConfirmation & { kind: "confirmation" } }): Record<string, unknown> {
  const d = event.data, folder = `agent-teams/requirements/artifacts/approvals/${subject.ticket}`, path = `${folder}/${d.decisionId}.json`;
  const bytes = confirmationRepresentation(subject, event), sha256 = digest(bytes);
  immutableFile(root, folder, `${d.decisionId}.json`, bytes);
  const ticket = () => { const t = tickets.get(subject.ticket); if (!t || t.project !== subject.repository.key) documentReject("DOCUMENT_AUTHORITY"); return t; };
  let refs = ticket().doc_refs.filter(r => r.path === path);
  if (refs.length > 1 || refs.some(r => r.type !== "attachment" || r.primary)) documentReject("DOCUMENT_CONFLICT");
  if (!refs.length) tickets.update(subject.ticket, { add_doc_ref: { type: "attachment", path, primary: false } }, "documents/tickets");
  const content = `Native document decision ${d.decisionId}: ${d.outcome}; operation ${d.operation}; scope ${d.scope}. Package ${subject.packageId} revision ${subject.revision}; subject SHA-256 ${d.subjectSha256}. JSON ${path}; file SHA-256 ${sha256}. Tracking only; consumers verify the native registry decision. No implementation launch or product acceptance.`;
  let comments = ticket().comments.filter(c => c.author === "documents/tickets" && c.content === content);
  if (comments.length > 1) documentReject("DOCUMENT_CONFLICT");
  if (!comments.length) tickets.comment(subject.ticket, "documents/tickets", content);
  refs = ticket().doc_refs.filter(r => r.path === path && r.type === "attachment" && !r.primary);
  comments = ticket().comments.filter(c => c.author === "documents/tickets" && c.content === content);
  if (refs.length !== 1 || comments.length !== 1) documentReject("DOCUMENT_UNCERTAIN");
  immutableFile(root, folder, `${d.decisionId}.json`, bytes);
  return { decisionId: d.decisionId, path, sha256, linkage: "complete", registryRevision: event.revision, authority: "native-registry-only" };
}
