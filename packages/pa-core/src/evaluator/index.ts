import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { appendEvaluatorResult, getDeploymentEvents, queryDeploymentStatus } from "../registry/index.js";
import { getAgentTeamsDir, getDeploymentDir } from "../paths.js";
import { TicketStore } from "../tickets/store.js";
import type { EvaluatorResult } from "../types.js";

export interface EvaluationEvidence {
  key: "objective" | "primer" | "activity" | "ticket" | "doc_refs" | "artifacts" | "session_log" | "registry_self_rating" | "registry_state";
  refs: string[];
  missing: boolean;
  note?: string;
}

export interface DeploymentEvidenceBundle {
  targetDeploymentId: string;
  evaluatorDeploymentId: string;
  evidence: EvaluationEvidence[];
}

export function collectDeploymentEvidence(targetDeploymentId: string, evaluatorDeploymentId: string): DeploymentEvidenceBundle {
  const target = queryDeploymentStatus(targetDeploymentId);
  if (!target) throw new Error(`Deployment not found: ${targetDeploymentId}`);
  const deployDir = getDeploymentDir(targetDeploymentId);
  const ticket = target.ticket_id ? new TicketStore().get(target.ticket_id) : undefined;
  const events = getDeploymentEvents(targetDeploymentId);
  const completed = [...events].reverse().find((event) => event.event === "completed");
  const selfRating = completed?.rating;

  const docRefs = ticket?.doc_refs.map((ref) => ref.path) ?? [];
  const artifacts = docRefs.filter((path) => path.includes("agent-teams/") || path.includes("artifacts/"));

  const sessionLog = target.log_file
    ? (existsSync(target.log_file) ? [target.log_file] : [])
    : [];

  return {
    targetDeploymentId,
    evaluatorDeploymentId,
    evidence: [
      mk("objective", target.objective ? [`registry:deployments/${targetDeploymentId}#objective`] : [], "objective missing on deployment"),
      mk("primer", target.primer ? [target.primer] : pathIfExists(resolve(deployDir, "primer.md")), "primer not found"),
      mk("activity", pathIfExists(resolve(deployDir, "activity.jsonl")), "activity log not found"),
      mk("ticket", ticket ? [`ticket:${ticket.id}`] : [], "ticket not linked or missing"),
      mk("doc_refs", docRefs, "ticket has no doc refs"),
      mk("artifacts", artifacts, "no artifact doc refs found"),
      mk("session_log", sessionLog, "session log missing or path not found"),
      mk("registry_self_rating", selfRating ? [`registry:events/${targetDeploymentId}#completed.rating`] : [], "self-rating missing in completed event"),
      mk("registry_state", [`registry:deployments/${targetDeploymentId}#status=${target.status}`]),
    ],
  };
}

export function scoreEvidence(bundle: DeploymentEvidenceBundle): EvaluatorResult {
  const hasMissing = bundle.evidence.some((entry) => entry.missing);
  const ticketRefs = bundle.evidence.find((entry) => entry.key === "ticket")?.refs ?? [];
  const objectiveRefs = bundle.evidence.find((entry) => entry.key === "objective")?.refs ?? [];
  const humanAgency = objectiveRefs.some((ref) => ref.includes("objective")) && ticketRefs.length > 0 ? 4 : 2;
  const overall = hasMissing ? 2.5 : 4.0;
  const findings = bundle.evidence
    .filter((entry) => entry.missing)
    .map((entry) => `${entry.key}: ${entry.note ?? "missing evidence"}`)
    .join("\n");
  const evidenceRefs = bundle.evidence.flatMap((entry) => entry.refs.length > 0 ? entry.refs : [`missing:${entry.key}`]);

  return {
    target_deployment_id: bundle.targetDeploymentId,
    evaluator_deployment_id: bundle.evaluatorDeploymentId,
    created_at: new Date().toISOString(),
    summary: hasMissing ? "Partial evaluator score with missing evidence markers." : "Evaluator score completed with full evidence references.",
    report_path: undefined,
    evidence_refs: evidenceRefs,
    findings: findings || "All required evidence sources were found.",
    rating: {
      source: "system",
      overall,
      metrics: {
        productivity: hasMissing ? 2 : 4,
        quality: hasMissing ? 2 : 4,
        efficiency: 4,
        insight: 3,
        human_agency: humanAgency,
        evidence_grounding: hasMissing ? 2 : 5,
        instruction_compliance: hasMissing ? 2 : 4,
        user_fit: hasMissing ? 2 : 4,
        risk_handling: hasMissing ? 2 : 4,
        outcome_integrity: hasMissing ? 2 : 4,
      },
    },
  };
}

export function runEvaluatorPass(targetDeploymentId: string, evaluatorDeploymentId: string, reportPath?: string): EvaluatorResult {
  const bundle = collectDeploymentEvidence(targetDeploymentId, evaluatorDeploymentId);
  const scored = scoreEvidence(bundle);
  return appendEvaluatorResult({ ...scored, report_path: reportPath ?? scored.report_path });
}

function mk(key: EvaluationEvidence["key"], refs: string[], note?: string): EvaluationEvidence {
  return { key, refs, missing: refs.length === 0, note };
}

function pathIfExists(path: string): string[] {
  return existsSync(path) ? [path] : [];
}

export function defaultEvaluatorOutputPath(targetDeploymentId: string): string {
  return resolve(getAgentTeamsDir(), "builder", "artifacts", `${new Date().toISOString().slice(0, 10)}-${targetDeploymentId}-evaluator-report.md`);
}
