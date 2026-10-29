import { parseReviewMatrixPlan } from "../validation/review-contract.js";
import { digest, MAX_WORKFLOW_BYTES, reject, type EvidenceRef, type ReviewBundle } from "./contracts.js";

/** Authenticate artifact bytes and the matrix's RAW SECTION identity, not the whole-document hash.
 * Parsing is observational; no project command or legacy approval reader is invoked. */
export function readWorkflowEvidence(subject: ReviewBundle, read: (ref: EvidenceRef) => Uint8Array | null): Uint8Array[] {
  try {
    const requirements = read(subject.requirements), uat = read(subject.uat);
    if (!requirements || !uat || requirements.byteLength > MAX_WORKFLOW_BYTES || uat.byteLength > MAX_WORKFLOW_BYTES || digest(requirements) !== subject.requirements.sha256 || digest(uat) !== subject.uat.sha256) reject("WORKFLOW_SOURCE");
    for (const raw of [requirements, uat]) {
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
      if (decoded.startsWith("\uFEFF")) reject("WORKFLOW_SOURCE");
    }
    const plan = parseReviewMatrixPlan(requirements, subject.matrix.ref);
    const repo = plan.matrix.repository;
    if (plan.digest !== subject.matrix.sha256 || repo.key !== subject.repository.key || repo.root !== subject.repository.root
      || repo.baseSha !== subject.handoff.baseSha || repo.branch !== subject.handoff.branch
      || !plan.matrix.prerequisites.every(p => p.kind !== "operatorGate" || p.ticket === subject.ticket)
      || subject.scope.checks.some(check => check.matrixSource !== plan.source || check.matrixSha256 !== plan.digest || !plan.matrix.commands.some(command => command.id === check.commandId))) reject("WORKFLOW_SOURCE");
    return [Uint8Array.from(requirements), Uint8Array.from(uat), Uint8Array.from(plan.authorityBytes)];
  } catch { return reject("WORKFLOW_SOURCE"); }
}
