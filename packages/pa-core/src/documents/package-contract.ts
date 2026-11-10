import { isAbsolute } from "node:path";
import { array, digest, ID, integer, literal, object, oneOf, parseWorkflowRequest, relativePath, SHA256, text, unique, workflowTicket } from "../workflows/contracts.js";

/** Separate version dispatch: never reinterpret pa-review-bundle/v1. */
export const DOCUMENT_PACKAGE_VERSION = "pa-document-package/v1" as const;
export const DOCUMENT_LIMITS = Object.freeze({ members: 64, textBytes: 1_048_576, memberBytes: 8_388_608, totalBytes: 16_777_216, requestBytes: 65_536 });
export class DocumentPackageError extends Error {
  constructor(readonly code: "DOCUMENT_INPUT" | "DOCUMENT_SOURCE" | "DOCUMENT_STALE" | "DOCUMENT_AUTHORITY" | "DOCUMENT_CONFLICT" | "DOCUMENT_UNCERTAIN" | "DOCUMENT_UNAVAILABLE") { super(code); }
}
export function documentReject(code: DocumentPackageError["code"] = "DOCUMENT_INPUT"): never { throw new DocumentPackageError(code); }
export interface DocumentMember {
  id: string; role: "brief" | "requirements" | "uat" | "specification";
  mediaType: "text/markdown" | "text/plain" | "image/png" | "image/jpeg";
  source: string; description: string; bytes: number; sha256: string;
}
export interface DocumentPackage {
  schemaVersion: typeof DOCUMENT_PACKAGE_VERSION; packageId: string; revision: number;
  repository: { key: string; root: string }; ticket: string; predecessor: string | null;
  members: DocumentMember[];
  references: { locator: string; version: string; description: string }[];
  effects: { publish: true; queue: boolean; route: { team: "builder"; mode: "orchestrator" } };
}
export function documentGuard<T>(read: () => T): T {
  try { return read(); } catch (error) { if (error instanceof DocumentPackageError) throw error; return documentReject(); }
}
/** Only non-project requirements artifacts. Destinations are derived, not imported. */
export function documentSource(value: unknown): string {
  const path = relativePath(value);
  if (!/^agent-teams\/requirements\/artifacts\/(?:drafts|reviews)\//.test(path)) documentReject();
  return path;
}
export function parseDocumentMember(value: unknown): DocumentMember {
  const m = object(value, ["id", "role", "mediaType", "source", "description", "bytes", "sha256"]);
  const mediaType = oneOf(m.mediaType, ["text/markdown", "text/plain", "image/png", "image/jpeg"]);
  const member = { id: text(m.id, ID), role: oneOf(m.role, ["brief", "requirements", "uat", "specification"]), mediaType,
    source: documentSource(m.source), description: text(m.description, undefined, 2048), bytes: integer(m.bytes, 1, mediaType.startsWith("text/") ? DOCUMENT_LIMITS.textBytes : DOCUMENT_LIMITS.memberBytes), sha256: text(m.sha256, SHA256) };
  if (member.role !== "specification" && !mediaType.startsWith("text/")) documentReject();
  return member;
}
export function parseDocumentPackage(value: unknown): DocumentPackage {
  return documentGuard(() => {
    const p = object(value, ["schemaVersion", "packageId", "revision", "repository", "ticket", "predecessor", "members", "references", "effects"]);
    const repo = object(p.repository, ["key", "root"]), root = text(repo.root);
    if (!isAbsolute(root) || root.split("/").slice(1).some(part => !part || part === "." || part === "..")) documentReject();
    const ticket = workflowTicket(p.ticket), members = array(p.members, parseDocumentMember, DOCUMENT_LIMITS.members);
    unique(members.map(m => m.id)); unique(members.map(m => m.source));
    if (members.reduce((sum, m) => sum + m.bytes, 0) > DOCUMENT_LIMITS.totalBytes) documentReject();
    for (const role of ["brief", "requirements", "uat"]) if (members.filter(m => m.role === role).length !== 1) documentReject();
    const effects = object(p.effects, ["publish", "queue", "route"]), route = object(effects.route, ["team", "mode"]);
    if (effects.publish !== true || typeof effects.queue !== "boolean") documentReject();
    const result: DocumentPackage = { schemaVersion: literal(p.schemaVersion, DOCUMENT_PACKAGE_VERSION), packageId: text(p.packageId, ID), revision: integer(p.revision, 1, 999999),
      repository: { key: text(repo.key, ID), root }, ticket, predecessor: p.predecessor === null ? null : text(p.predecessor, SHA256), members,
      references: array(p.references, value => { const r = object(value, ["locator", "version", "description"]); return { locator: text(r.locator), version: text(r.version), description: text(r.description) }; }, 64),
      effects: { publish: true, queue: effects.queue, route: { team: literal(route.team, "builder"), mode: literal(route.mode, "orchestrator") } } };
    // Canonical reconstructed metadata is itself bounded, including programmatic callers.
    if (Buffer.byteLength(JSON.stringify(result)) > DOCUMENT_LIMITS.requestBytes) documentReject();
    return result;
  });
}
export const DOCUMENT_ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  capabilities: [], status: ["ticket"], "branch-inspect": ["ticket"], "ticket-create": ["title", "content", "intakeId"], discover: ["path"], context: ["path"], draft: ["path", "content", "expectedSha256"],
  check: ["package"], freeze: ["package", "expectedRevision"], show: ["sha256"], present: ["sha256"], read: ["sha256", "path", "offset"], compare: ["sha256", "previousSha256"],
  confirm: ["sha256", "expectedRevision", "scope"], "confirm-revoke": ["sha256", "expectedRevision", "decisionId"],
  capture: ["sha256", "expectedRevision"], revoke: ["sha256", "expectedRevision", "decisionId"], publish: ["sha256", "expectedRevision", "decisionId"], queue: ["sha256", "expectedRevision", "decisionId"],
});
export function documentInterfaceDescription(): Record<string, unknown> {
  return { schemaVersion: "pa-document-interface/v1", packageVersion: DOCUMENT_PACKAGE_VERSION, nativeTool: "pa_document", actions: DOCUMENT_ACTION_FIELDS, limits: DOCUMENT_LIMITS,
    cli: "description-only-no-decision-or-effect-import", availability: "requires-native-authenticated-Pi-requirements-session", preview: "unavailable-use-full-markdown", sourceAuthority: false, installedQualification: "not-asserted" };
}
export function parseDocumentRequest(input: string): Record<string, unknown> {
  return documentGuard(() => object(parseWorkflowRequest(input), ["action"], ["package", "sha256", "expectedRevision", "previousSha256", "decisionId", "path", "content", "expectedSha256", "offset", "title", "intakeId", "ticket", "scope"]));
}
export function documentPackageSha(subject: DocumentPackage): string { return digest(JSON.stringify(parseDocumentPackage(subject))); }
export function documentDestination(subject: DocumentPackage, member: DocumentMember): string {
  const extension = { "text/markdown": "md", "text/plain": "txt", "image/png": "png", "image/jpeg": "jpg" }[member.mediaType];
  return `agent-teams/requirements/artifacts/packages/${subject.ticket}/${subject.packageId}/r${String(subject.revision).padStart(3, "0")}/${member.id}.${extension}`;
}
