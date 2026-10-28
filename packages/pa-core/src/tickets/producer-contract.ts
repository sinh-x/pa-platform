import { resolve } from "node:path";
import { parseReviewMatrixSource } from "../validation/review-contract.js";

/** Syntax only. A parsed candidate is never an authenticated operator decision. */
export class ProducerContractError extends Error {
  constructor() { super("Workflow producer contract is incomplete, conflicting or unsupported."); this.name = "ProducerContractError"; }
}
const invalid = (): never => { throw new ProducerContractError(); };
const sha = /^[0-9a-f]{40}$/;
const hash = /^[0-9a-f]{64}$/;
const revision = /^r[0-9]{3,}$/;
const ticket = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
export interface TaskHandoff {
  ticket: string; repositoryKey: string; repositoryRoot: string;
  handoffType: "fresh" | "amendment"; branch: string; baseSha: string;
  branchAction: "create" | "select"; linkedBranchState: "planned" | "materialized";
  featureSha?: string; amendmentSource?: string; tupleApprovalEvidence?: string;
  immediateRereadSha256?: string; finalRereadSha256?: string;
}
export function amendmentHandoffFields(get: (label: string) => string): Pick<TaskHandoff, "featureSha" | "amendmentSource" | "tupleApprovalEvidence" | "immediateRereadSha256" | "finalRereadSha256"> {
  return { featureSha: get("Current Feature SHA"), amendmentSource: get("Amendment Source Requirements Ref"), tupleApprovalEvidence: get("Amendment Tuple Approval Evidence"), immediateRereadSha256: get("Amendment Immediate Reread SHA-256"), finalRereadSha256: get("Amendment Final Reread SHA-256") };
}
export function producerText(raw: Uint8Array): string {
  if (raw.byteLength > 1_048_576 || (raw[0] === 239 && raw[1] === 187 && raw[2] === 191)) return invalid();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return invalid(); }
}
export function producerPreamble(markdown: string): string { return markdown.split(/^##[ \t]/m)[0]!; }
/** New v1 publication may insert only these administrative header values. Raw
 * preview/final digests remain distinct; neither signed byte sequence is edited.
 * No body, command, scope, path or authority-bearing tuple can be substituted. */
export function producerSourceAgrees(finalRaw: Uint8Array, previewRaw: Uint8Array): boolean {
  const administrative = ["Status", "Review Approval Evidence", "Matrix Approval Evidence", "Review Progress", "Shape-Conformance"];
  const projection = (raw: Uint8Array): string => {
    const text = producerText(raw), preamble = producerPreamble(text), seen = new Set<string>();
    const retained = preamble.split("\n").filter(line => {
      const label = administrative.find(label => new RegExp(`^>[ \\t]+(?:\\*\\*)?${label}:`).test(line));
      if (!label) return true;
      if (seen.has(label) || !line.startsWith(`> ${label}: `)) invalid(); seen.add(label); return false;
    }).join("\n");
    return retained + text.slice(preamble.length);
  };
  return projection(finalRaw) === projection(previewRaw);
}
/** Shared by existing baseline admission and the producer. No body/fenced example
 * can supply a canonical preamble field; malformed aliases count as duplicates. */
export function producerHeader(preamble: string, label: string): string {
  if (!/^[A-Za-z0-9 -]+$/.test(label)) return invalid();
  const matches = preamble.split(/\r?\n/).filter(line => new RegExp(`^>[ \\t]+(?:\\*\\*)?${label}:`).test(line));
  const prefix = `> ${label}: `;
  if (matches.length !== 1 || !matches[0]!.startsWith(prefix) || !matches[0]!.slice(prefix.length)) return invalid();
  return matches[0]!.slice(prefix.length);
}
function field(value: string, pattern: RegExp): string {
  if (!pattern.test(value) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return invalid();
  return value;
}
function tuple(values: Omit<TaskHandoff, "branchAction" | "linkedBranchState">): TaskHandoff {
  field(values.ticket, ticket); field(values.repositoryKey, /^[a-zA-Z0-9_-]{1,128}$/);
  field(values.repositoryRoot, /^\/[A-Za-z0-9_./-]+$/);
  if (resolve(values.repositoryRoot) !== values.repositoryRoot) return invalid();
  field(values.branch, /^feature\/[A-Z][A-Z0-9]*-[1-9][0-9]*-[A-Za-z0-9][A-Za-z0-9._/-]*$/);
  if (!values.branch.startsWith(`feature/${values.ticket}-`) || values.branch.includes("..") || values.branch.includes("//") || values.branch.endsWith("/") || values.branch.split("/").some(part => part.endsWith(".") || part.endsWith(".lock"))) return invalid();
  field(values.baseSha, sha);
  if (values.handoffType !== "fresh" && values.handoffType !== "amendment") return invalid();
  if (values.handoffType === "amendment") {
    field(values.featureSha ?? "", sha); parseReviewMatrixSource(values.amendmentSource);
    field(values.tupleApprovalEvidence ?? "", new RegExp(`^${values.ticket}#c-[0-9]{17}$`));
    field(values.immediateRereadSha256 ?? "", hash); field(values.finalRereadSha256 ?? "", hash);
  } else if ([values.featureSha, values.amendmentSource, values.tupleApprovalEvidence, values.immediateRereadSha256, values.finalRereadSha256].some(value => value !== undefined)) return invalid();
  return { ...values, branchAction: values.handoffType === "fresh" ? "create" : "select", linkedBranchState: values.handoffType === "fresh" ? "planned" : "materialized" };
}
/** Complete versioned handoff shape. Neither Draft nor Approved authenticates a
 * decision here; the actual resolver retains its separate status/author checks. */
export function parseTaskHandoff(markdown: string): TaskHandoff {
  const preamble = producerPreamble(markdown);
  const get = (label: string) => producerHeader(preamble, label);
  if (get("Handoff Contract") !== "pa-task-handoff/v1") return invalid();
  const handoffType = get("Handoff Type") as TaskHandoff["handoffType"];
  if (handoffType !== "fresh" && handoffType !== "amendment") return invalid();
  const opposite = handoffType === "fresh" ? "Retained Base SHA" : "Approved Base SHA";
  if (new RegExp(`^>[ \\t]+(?:\\*\\*)?${opposite}:`, "m").test(preamble)) return invalid();
  if (handoffType === "fresh" && /^>[ \t]+(?:\*\*)?(?:Current Feature SHA|Amendment [A-Za-z0-9 -]+):/m.test(preamble)) return invalid();
  if (handoffType === "amendment" && /^>[ \t]+(?:\*\*)?Fresh [A-Za-z0-9 -]+:/m.test(preamble)) return invalid();
  const result = tuple({ ticket: get("Ticket"), repositoryKey: get("Repository Key"), repositoryRoot: get("Repository Root"), handoffType,
    branch: get("Feature Branch"), baseSha: get(handoffType === "fresh" ? "Approved Base SHA" : "Retained Base SHA"),
    ...(handoffType === "amendment" ? amendmentHandoffFields(get) : {}) });
  if (get("Branch Action") !== result.branchAction || get("Linked Branch State") !== result.linkedBranchState || get("Route") !== "builder/orchestrator") return invalid();
  return result;
}
export interface PairSignoff extends TaskHandoff {
  reviewRevision: string; requirementsSource: string; requirementsPreviewPath: string; requirementsPreviewSha256: string;
  uatPreviewPath: string; uatPreviewSha256: string; matrixSource: string; matrixSha256: string;
}
const PAIR_FIELDS = ["Decision", "Ticket", "Repository Key", "Repository Root", "Handoff Type", "Feature Branch", "Base SHA", "Branch Action", "Linked Branch State", "Review Revision", "Requirements Source", "Requirements Preview", "Requirements Raw SHA-256", "UAT Preview", "UAT Raw SHA-256", "Matrix Source", "Matrix Authority SHA-256"] as const;
/** Exact finite v1 candidate/decision grammar. No approval keyword inference,
 * optional prose suffix, authority flag, author, dynamic clause or normalization. */
export function parsePairSignoff(content: string): PairSignoff {
  if (Buffer.byteLength(content) > 65_536 || /[\p{Cf}\p{Cs}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(content) || /\r(?!\n)/.test(content)) return invalid();
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "PA pair-signoff/v1") return invalid();
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([A-Za-z0-9 -]+): ([^\r\n]+)$/.exec(line);
    if (!match || fields.has(match[1]!)) return invalid(); fields.set(match[1]!, match[2]!);
  }
  const handoffType = fields.get("Handoff Type") as TaskHandoff["handoffType"];
  const expected: readonly string[] = handoffType === "amendment" ? [...PAIR_FIELDS, "Current Feature SHA", "Amendment Source Requirements Ref", "Amendment Tuple Approval Evidence", "Amendment Immediate Reread SHA-256", "Amendment Final Reread SHA-256"] : PAIR_FIELDS;
  if (expected.some(key => !fields.has(key)) || fields.size !== expected.length || [...fields.keys()].some(key => !expected.includes(key))) return invalid();
  const get = (key: string) => fields.get(key)!;
  if (get("Decision") !== "approve-pair-and-matrix") return invalid();
  const handoff = tuple({ ticket: get("Ticket"), repositoryKey: get("Repository Key"), repositoryRoot: get("Repository Root"), handoffType,
    branch: get("Feature Branch"), baseSha: get("Base SHA"), ...(handoffType === "amendment" ? amendmentHandoffFields(get) : {}) });
  if (get("Branch Action") !== handoff.branchAction || get("Linked Branch State") !== handoff.linkedBranchState) return invalid();
  const reviewRevision = field(get("Review Revision"), revision);
  const requirementsSource = parseReviewMatrixSource(get("Requirements Source"));
  if (get("Matrix Source") !== requirementsSource) return invalid();
  const canonical = `agent-teams/requirements/artifacts/reviews/${handoff.ticket}/${reviewRevision}`;
  if (get("Requirements Preview") !== `${canonical}/requirements.md` || get("UAT Preview") !== `${canonical}/uat-preview.md`) return invalid();
  return { ...handoff, reviewRevision, requirementsSource, requirementsPreviewPath: get("Requirements Preview"), requirementsPreviewSha256: field(get("Requirements Raw SHA-256"), hash),
    uatPreviewPath: get("UAT Preview"), uatPreviewSha256: field(get("UAT Raw SHA-256"), hash), matrixSource: requirementsSource, matrixSha256: field(get("Matrix Authority SHA-256"), hash) };
}
export function assertProducerTuple(actual: TaskHandoff, expected: TaskHandoff): void {
  for (const key of ["ticket", "repositoryKey", "repositoryRoot", "handoffType", "branch", "baseSha", "branchAction", "linkedBranchState", "featureSha", "amendmentSource", "tupleApprovalEvidence", "immediateRereadSha256", "finalRereadSha256"] as const) if (actual[key] !== expected[key]) return invalid();
}
