import { basename, resolve } from "node:path";
import {
  getAiUsageDir, getTicketsDir, loadReposYaml, MAX_REVIEW_ARTIFACT_BYTES, MAX_REVIEW_OBJECTIVE_BYTES, isCanonicalTicketId, assertNoSensitiveMatch,
  parseReviewEvidenceJson, inspectReviewObjective, parseReviewReadinessBinding,
  readReviewEvidenceFile, readReviewMatrixArtifact, ReviewContractError,
  formatReviewContractDiagnostic, structuredReviewArtifact, type ReviewObjective, type ReviewMatrixArtifact,
  type ReviewReadinessBinding, type Ticket, type ValidationDiagnostic,
} from "@pa-platform/pa-core";

export const REVIEW_PREFLIGHT_VERSION = "pa-review-preflight/v1" as const;
export interface ReviewPreflightDiagnostic extends ValidationDiagnostic { code: string }
export interface ReviewPreflightReport {
  schemaVersion: typeof REVIEW_PREFLIGHT_VERSION;
  status: "compatible" | "incompatible";
  checks: Array<{ id: string; status: "passed" | "failed" | "blocked" }>;
  diagnostics: ReviewPreflightDiagnostic[];
  deferredLaunchChecks: readonly string[];
}
export interface ReviewPreflightDependencies {
  aiUsageRoot: string;
  readTicket: (ticket: string) => Ticket;
  repositories: () => Record<string, { path: string }>;
  structuredArtifact?: typeof structuredReviewArtifact;
}
export interface ReviewStaticEvidence {
  report: ReviewPreflightReport;
  objective?: ReviewObjective;
  artifact?: ReviewMatrixArtifact;
  ticket?: Ticket;
  readiness: ReviewReadinessBinding[];
}
export function reviewPreflightDependencies(): ReviewPreflightDependencies {
  return {
    aiUsageRoot: getAiUsageDir(), repositories: loadReposYaml, structuredArtifact: structuredReviewArtifact,
    readTicket: (ticket) => {
      if (!isCanonicalTicketId(ticket)) throw new ReviewContractError("REVIEW_FIELD", "ticket", "requires an exact canonical ticket ID");
      const bytes = readReviewEvidenceFile(resolve(getTicketsDir(), `${ticket}.json`), MAX_REVIEW_ARTIFACT_BYTES, "ticket");
      const row = parseReviewEvidenceJson(bytes, "ticket") as Ticket;
      if (row?.id !== ticket || !Array.isArray(row.comments) || !Array.isArray(row.linkedBranches) || !Array.isArray(row.doc_refs)) {
        throw new ReviewContractError("REVIEW_FIELD", "ticket", "existing ticket shape/identity is invalid; aliases are not authority");
      }
      return row;
    },
  };
}
const deferred = Object.freeze([
  "Installed runtime/config provenance and readiness approval authentication",
  "Physical candidate Git identity, clean branch/HEAD/base ancestry and checkout reservation",
  "Exact live platform/tool/dependency prerequisites and candidate drift rereads",
  "Atomic one-use authorization, active legacy/v1 review exclusion and actual-launch accounting",
  "Complete terminal validation ledger and independent reviewer findings",
]);

/** Observational only: never constructs TicketStore/registry, probes Git/tools or allocates state. */
export function inspectReviewPreflight(input: { ticket: string; objective: string | Uint8Array }, dependencies = reviewPreflightDependencies()): ReviewStaticEvidence {
  const report: ReviewPreflightReport = { schemaVersion: REVIEW_PREFLIGHT_VERSION, status: "compatible", checks: [], diagnostics: [], deferredLaunchChecks: deferred };
  const readiness: ReviewReadinessBinding[] = [];
  const check = (id: string, run?: () => void): void => {
    if (!run) { report.checks.push({ id, status: "blocked" }); return; }
    try { run(); report.checks.push({ id, status: "passed" }); }
    catch (error) {
      const e = error instanceof ReviewContractError ? error : new ReviewContractError("REVIEW_IO", id, "cannot read or interpret existing evidence; no initialization or repair was attempted");
      report.checks.push({ id, status: "failed" });
      for (const defect of e.relatedErrors?.length ? e.relatedErrors : [e]) report.diagnostics.push({ code: defect.code, ...defect.diagnostic });
    }
  };
  const equal = (actual: unknown, expected: unknown, source: string): void => {
    if (actual !== expected) throw new ReviewContractError("REVIEW_BINDING", source, "does not agree exactly with the selected ticket/objective/header/approval identity");
  };
  let objective: ReviewObjective | undefined;
  let artifact: ReviewMatrixArtifact | undefined;
  let ticket: Ticket | undefined;
  let structuredAuthority = false;
  const inputSize = typeof input.objective === "string" ? Buffer.byteLength(input.objective, "utf8") : input.objective.byteLength;
  check("objective.sensitiveInput", inputSize <= MAX_REVIEW_OBJECTIVE_BYTES ? () => {
    try { assertNoSensitiveMatch("content", typeof input.objective === "string" ? input.objective : Buffer.from(input.objective).toString("utf8")); }
    catch { throw new ReviewContractError("REVIEW_SENSITIVE", "objective", "sensitive-input validation rejected the request without disclosure"); }
  } : undefined);
  const parsed = inspectReviewObjective(input.objective);
  objective = parsed.objective;
  report.checks.push({ id: "objective.schema", status: objective ? "passed" : "failed" });
  for (const error of parsed.errors) report.diagnostics.push({ code: error.code, ...error.diagnostic });
  check("objective.sensitiveFields", objective ? () => {
    try {
      assertNoSensitiveMatch("content", JSON.stringify(objective));
      assertNoSensitiveMatch("path", objective!.matrixSource.slice("requirements:".length));
    } catch { throw new ReviewContractError("REVIEW_SENSITIVE", "objective", "sensitive-input validation rejected decoded authority fields without disclosure"); }
  } : undefined);
  check("ticket.evidence", () => { ticket = dependencies.readTicket(input.ticket); });
  check("objective.ticket", objective ? () => equal(objective!.ticket, input.ticket, "objective.ticket") : undefined);
  const sensitiveObjective = report.diagnostics.some((d) => d.code === "REVIEW_SENSITIVE");
  check("artifact.schema", objective && ticket && !sensitiveObjective ? () => {
    const structured = dependencies.structuredArtifact?.(ticket!.project, ticket!.id, objective!.matrixSource, objective!.matrixApprovalEvidence);
    if (structured) { artifact = structured; structuredAuthority = true; }
    else {
      if (ticket!.doc_refs.some(ref => ref.type === "workflow") || objective!.matrixApprovalEvidence.startsWith("workflow-decision:")) throw new ReviewContractError("REVIEW_BINDING", "structured-approval", "adopted structured authority is absent; no legacy fallback");
      artifact = readReviewMatrixArtifact(dependencies.aiUsageRoot, objective!.matrixSource);
    }
  } : undefined);
  const o = objective; const a = artifact; const t = ticket;
  check("artifact.sensitiveInput", a ? () => {
    try {
      assertNoSensitiveMatch("content", Buffer.from(a.authorityBytes).toString("utf8"));
      // JSON escaping must not hide sensitive input from the data actually used
      // by the executor. Hash unchanged raw bytes, but also inspect decoded data.
      for (const command of a.matrix.commands) {
        assertNoSensitiveMatch("content", command.command);
        assertNoSensitiveMatch("path", command.cwd);
      }
      for (const value of Object.values(a.matrix.environment)) if ("literal" in value) assertNoSensitiveMatch("content", value.literal);
    } catch { throw new ReviewContractError("REVIEW_SENSITIVE", "artifact.matrix", "sensitive-input validation rejected raw or decoded approved command data without disclosure"); }
  } : undefined);
  check("ticket.source", o && t ? () => {
    const matches = t.doc_refs.filter((ref) => ref.type === "requirements" && `requirements:${ref.path}` === o.matrixSource);
    equal(matches.length, 1, "ticket.doc_refs.requirements");
  } : undefined);
  check("ticket.branch", o && t && a ? () => {
    const links = t.linkedBranches.filter((link) => link.repo === a.matrix.repository.key);
    equal(links.length, 1, "ticket.linkedBranches");
    equal(links[0]?.state, "materialized", "ticket.linkedBranches.state");
    equal(links[0]?.branch, o.branch, "ticket.linkedBranches.branch");
    equal(links[0]?.baseSha, a.matrix.repository.baseSha, "ticket.linkedBranches.baseSha");
    equal(links[0]?.headSha, o.featureSha, "ticket.linkedBranches.headSha");
    if (links[0]?.sha !== undefined) equal(links[0].sha, o.featureSha, "ticket.linkedBranches.sha");
  } : undefined);
  check("repository.registry", a ? () => {
    equal(dependencies.repositories()[a.matrix.repository.key]?.path, a.matrix.repository.root, "matrix.repository.root");
  } : undefined);
  const pairs: Array<[string, unknown, unknown]> = o && a ? [
    ["artifact.header.ticket", a.header.ticket, input.ticket],
    ["artifact.header.repositoryKey", a.header.repositoryKey, a.matrix.repository.key],
    ["artifact.header.repositoryRoot", a.header.repositoryRoot, a.matrix.repository.root],
    ["artifact.header.approvedBaseSha", a.header.approvedBaseSha, a.matrix.repository.baseSha],
    ["artifact.header.featureBranch", a.header.featureBranch, o.branch],
    ["matrix.repository.branch", a.matrix.repository.branch, o.branch],
    ["artifact.source", a.source, o.matrixSource],
    ["objective.matrixAuthoritySha256", o.matrixAuthoritySha256, a.digest],
    ["artifact.header.matrixAuthoritySha256", a.header.matrixAuthoritySha256, a.digest],
    ["artifact.header.matrixApprovalEvidence", a.header.matrixApprovalEvidence, o.matrixApprovalEvidence],
    ["matrix.environment.PA_TICKET_ID", (a.matrix.environment.PA_TICKET_ID as { literal: string }).literal, input.ticket],
  ] : [];
  if (!pairs.length) check("authority.agreement");
  for (const [id, actual, expected] of pairs) check(id, () => equal(actual, expected, id));
  check("matrix.approval", o && a && t ? () => {
    if (structuredAuthority) return; // already verified against native issued/revoked registry state above
    const approvals = t.comments.filter((comment) => comment.id === o.matrixApprovalEvidence);
    equal(approvals.length, 1, "approval.commentId");
    const approval = approvals[0]!;
    equal(approval.author, "sinh", "approval.author");
    // Durable prose approval remains valid only when it names the exact source/digest/branch once.
    for (const value of [o.matrixSource, a.digest, o.branch]) {
      equal(approval.content.split(value).length - 1, 1, "approval.binding");
    }
  } : undefined);
  check("prerequisite.selections", o && a ? () => {
    const gates = a.matrix.prerequisites.filter((p) => p.kind === "operatorGate");
    equal(gates.filter((gate) => gate.id === "paired-runtime-ready").length, 1, "matrix.prerequisites.paired-runtime-ready");
    equal(Object.keys(o.prerequisiteEvidence).length, gates.length, "objective.prerequisiteEvidence");
    for (const gate of gates) {
      equal(gate.ticket, input.ticket, "matrix.prerequisites.operatorGate.ticket");
      if (!Object.hasOwn(o.prerequisiteEvidence, gate.id)) throw new ReviewContractError("REVIEW_BINDING", "objective.prerequisiteEvidence", "missing a declared gate comment selection");
    }
  } : undefined);
  if (o && a && t) {
    for (const [index, gate] of a.matrix.prerequisites.filter((p) => p.kind === "operatorGate").entries()) {
      check(`prerequisite.gates[${index}]`, () => {
        if (o.prerequisiteEvidence[gate.id] === o.matrixApprovalEvidence) throw new ReviewContractError("REVIEW_BINDING", "readiness.commentId", "readiness must be a separate durable approval, not the matrix approval comment");
        const comments = t.comments.filter((comment) => comment.id === o.prerequisiteEvidence[gate.id]);
        equal(comments.length, 1, "readiness.commentId");
        equal(comments[0]!.author, "sinh", "readiness.author");
        const binding = parseReviewReadinessBinding(comments[0]!.content);
        for (const key of ["ticket", "branch", "featureSha", "matrixSource", "matrixAuthoritySha256"] as const) equal(binding[key], o[key], `readiness.${key}`);
        equal(binding.gateId, gate.id, "readiness.gateId");
        readiness.push(binding);
      });
    }
  } else check("prerequisite.gates");
  if (report.diagnostics.length || report.checks.some((c) => c.status === "blocked")) report.status = "incompatible";
  return { report, objective, artifact, ticket, readiness };
}
export function formatReviewPreflight(report: ReviewPreflightReport): string {
  return [
    `Protected review preflight: ${report.status}. Static compatibility is not launch authorization.`,
    ...report.checks.map((check) => `${check.id}: ${check.status}`),
    ...report.diagnostics.map((d) => `${d.code}\nCondition: ${d.condition}\nSource: ${d.source}\nReason: ${d.reason}\nCorrection: ${d.correction}\nResume Action: ${d.resumeAction}`),
    "Deferred launch checks:", ...report.deferredLaunchChecks.map((check) => `- ${check}`),
  ].join("\n");
}
export function requireReviewPreflight(input: { ticket: string; objective: string | Uint8Array }, dependencies = reviewPreflightDependencies()): Required<Pick<ReviewStaticEvidence, "objective" | "artifact" | "ticket">> & ReviewStaticEvidence {
  const evidence = inspectReviewPreflight(input, dependencies);
  if (evidence.report.status !== "compatible") {
    const d = evidence.report.diagnostics[0];
    throw new ReviewContractError((d?.code as ReviewContractError["code"]) ?? "REVIEW_BINDING", d?.source ?? "preflight", d?.reason ?? "dependent checks are blocked");
  }
  return evidence as Required<Pick<ReviewStaticEvidence, "objective" | "artifact" | "ticket">> & ReviewStaticEvidence;
}
export function runReviewPreflightCommand(args: string[], io = { stdout: (s: string) => process.stdout.write(s), stderr: (s: string) => process.stderr.write(s) }): number {
  const usage = "Usage: ppa review preflight --ticket <ID> --objective-file <request.json> [--json]\nObservational only; exit 0 compatible, 1 incompatible, 2 usage/I/O failure. No launch authority.\n";
  if (args.length === 0 || args.includes("--help")) { io.stdout(usage); return 0; }
  if (args[0] !== "preflight") { io.stderr(usage); return 2; }
  let ticket: string | undefined; let file: string | undefined; let asJson = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" && !asJson) asJson = true;
    else if (arg === "--ticket" && !ticket && args[i + 1] && !args[i + 1]!.startsWith("--")) ticket = args[++i];
    else if (arg === "--objective-file" && !file && args[i + 1] && !args[i + 1]!.startsWith("--")) file = args[++i];
    else { io.stderr(usage); return 2; }
  }
  if (!ticket || !isCanonicalTicketId(ticket) || !file) { io.stderr(usage); return 2; }
  try {
    const path = resolve(file);
    try { assertNoSensitiveMatch("path", path); assertNoSensitiveMatch("filename", basename(path)); }
    catch { throw new ReviewContractError("REVIEW_SENSITIVE", "objectiveFile", "sensitive-input validation rejected the file selector without disclosure"); }
    const bytes = readReviewEvidenceFile(path, 65_536, "objectiveFile");
    const { report } = inspectReviewPreflight({ ticket, objective: bytes });
    io.stdout(`${asJson ? JSON.stringify(report) : formatReviewPreflight(report)}\n`);
    return report.status === "compatible" ? 0 : report.diagnostics.some((d) => d.code === "REVIEW_IO") ? 2 : 1;
  } catch (error) {
    const e = error instanceof ReviewContractError ? error : new ReviewContractError("REVIEW_IO", "objectiveFile", "cannot read existing objective input");
    io.stderr(`${formatReviewContractDiagnostic(e)}\n`);
    return e.code === "REVIEW_SIZE" || e.code === "REVIEW_SENSITIVE" ? 1 : 2;
  }
}
