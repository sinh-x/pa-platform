import { basename, join } from "node:path";
import { readArtifactFile } from "../artifacts/manifest.js";
import { assertNoSensitiveMatch } from "../sensitive-patterns.js";
import { digest } from "../workflows/contracts.js";
import { documentReject, DOCUMENT_LIMITS, parseDocumentPackage, type DocumentMember, type DocumentPackage } from "./package-contract.js";

export function documentText(raw: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return documentReject("DOCUMENT_SOURCE"); }
}
export function validateDocumentBytes(member: DocumentMember, raw: Uint8Array): void {
  if (raw.byteLength !== member.bytes || digest(raw) !== member.sha256) documentReject("DOCUMENT_STALE");
  const bytes = Buffer.from(raw);
  if (member.mediaType.startsWith("text/")) {
    const content = documentText(raw);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/.test(content) || /<(?:script|iframe|svg|object|embed|html)\b|(?:javascript|vbscript):|data:text\/html/i.test(content)) documentReject("DOCUMENT_SOURCE");
    try { assertNoSensitiveMatch("content", content); } catch { documentReject("DOCUMENT_SOURCE"); }
  } else if (member.mediaType === "image/png") {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) documentReject("DOCUMENT_SOURCE");
  } else if (bytes.length < 4 || !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || !bytes.subarray(-2).equals(Buffer.from([255, 217]))) documentReject("DOCUMENT_SOURCE");
}
export function readDocumentSources(subjectInput: DocumentPackage, root: string): Buffer[] {
  const subject = parseDocumentPackage(subjectInput);
  return subject.members.map(member => {
    const path = join(root, member.source);
    try {
      assertNoSensitiveMatch("path", path); assertNoSensitiveMatch("filename", basename(path));
      const bytes = readArtifactFile(path, member.mediaType.startsWith("text/") ? DOCUMENT_LIMITS.textBytes : DOCUMENT_LIMITS.memberBytes, "ARTIFACT_STALE");
      validateDocumentBytes(member, bytes); return bytes;
    } catch (error) { if (error instanceof Error && error.message.startsWith("DOCUMENT_")) throw error; return documentReject("DOCUMENT_SOURCE"); }
  });
}
export interface DocumentFinding { code: string; memberId: string; reference?: string }
/** Structural/declared traceability only. Never semantic completeness or acceptance. */
export function checkDocumentPackage(subject: DocumentPackage, bytes: readonly Uint8Array[]): { findings: DocumentFinding[]; structuralPass: boolean; semanticCompleteness: "not-assessed" } {
  const findings: DocumentFinding[] = [], definitions = new Set<string>(), mentions: { memberId: string; reference: string }[] = [];
  subject.members.forEach((member, index) => {
    validateDocumentBytes(member, bytes[index]!);
    if (!member.mediaType.startsWith("text/")) return;
    const content = documentText(bytes[index]!);
    if (member.role === "brief" && (Buffer.byteLength(content) > 16384 || content.trim().split(/\s+/).length > 1000)) findings.push({ code: "BRIEF_WORD_OR_BYTE_LIMIT", memberId: member.id });
    for (const match of content.matchAll(/^(?:#{1,6}\s+|\|\s*|-\s+)((?:FR|AC|TS)-\d+)\b/gm)) definitions.add(match[1]!);
    for (const match of content.matchAll(/\b(?:FR|AC|TS)-\d+\b/g)) mentions.push({ memberId: member.id, reference: match[0] });
  });
  const reported = new Set<string>();
  for (const mention of mentions) if (!definitions.has(mention.reference) && !reported.has(`${mention.memberId}:${mention.reference}`)) {
    findings.push({ code: "UNDEFINED_TRACE_REFERENCE", ...mention }); reported.add(`${mention.memberId}:${mention.reference}`);
  }
  return { findings, structuralPass: findings.length === 0, semanticCompleteness: "not-assessed" };
}
export function compareDocumentPackages(previous: DocumentPackage, current: DocumentPackage, read: (sha256: string) => Uint8Array): Record<string, unknown> {
  const changes: Record<string, unknown>[] = [];
  for (const member of current.members) {
    const before = previous.members.find(m => m.id === member.id);
    if (!before) { changes.push({ id: member.id, change: "added" }); continue; }
    if (JSON.stringify(before) === JSON.stringify(member)) continue;
    const text = before.mediaType.startsWith("text/") && member.mediaType.startsWith("text/");
    let difference: Record<string, unknown> = {};
    if (text && before.sha256 !== member.sha256) {
      const previousLines = documentText(read(before.sha256)).split("\n"), currentLines = documentText(read(member.sha256)).split("\n");
      let start = 0;
      while (start < Math.min(previousLines.length, currentLines.length) && previousLines[start] === currentLines[start]) start++;
      const contextStart = Math.max(0, start - 2);
      difference = { firstChangedLine: start + 1, excerptStartLine: contextStart + 1,
        previousText: previousLines.slice(contextStart, contextStart + 20).join("\n").slice(0, 2048), currentText: currentLines.slice(contextStart, contextStart + 20).join("\n").slice(0, 2048), textIsExcerpt: true };
    }
    changes.push({ id: member.id, change: "changed", previousSha256: before.sha256, sha256: member.sha256, previousRole: before.role, role: member.role, ...difference });
  }
  for (const member of previous.members) if (!current.members.some(m => m.id === member.id)) changes.push({ id: member.id, change: "removed" });
  return { changes, effectsChanged: JSON.stringify(previous.effects) !== JSON.stringify(current.effects), referencesChanged: JSON.stringify(previous.references) !== JSON.stringify(current.references), semanticMateriality: "not-assessed", approvalTransferred: false };
}
