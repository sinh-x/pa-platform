import type { SemanticCandidate, SemanticQueryResult } from "./candidate-discovery.js";

export interface SemanticEvidenceLink {
  type: "source" | "missing";
  detail: string;
}

export interface SemanticEvidenceClaim {
  claim: string;
  evidence: SemanticEvidenceLink;
}

export interface SemanticBriefingBundle {
  query: string;
  groups: Record<string, SemanticCandidate[]>;
  evidence_map: SemanticEvidenceClaim[];
  confirmation_question: string;
}

export interface SemanticBriefingRenderOptions {
  summaryClaims?: ReadonlyArray<{ claim: string; sourceLink?: string }>;
}

const GROUP_ORDER = [
  "reflections",
  "ticket",
  "ticket-comment",
  "doc-ref",
  "artifact",
  "session-log",
  "deployment",
  "registry-event",
  "sinh-input",
] as const;

export function buildSemanticBriefingBundle(result: SemanticQueryResult, options: SemanticBriefingRenderOptions = {}): SemanticBriefingBundle {
  const groups: Record<string, SemanticCandidate[]> = { reflections: result.reflections };
  for (const item of result.system) {
    const key = item.metadata.type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  const evidenceMap: SemanticEvidenceClaim[] = [
    ...result.reflections.map((candidate) => sourceClaim(candidate)),
    ...result.system.map((candidate) => sourceClaim(candidate)),
    ...resolveSummaryClaims(options.summaryClaims ?? []),
  ];
  return {
    query: result.query,
    groups,
    evidence_map: evidenceMap,
    confirmation_question: "I found related context. Should I continue with deeper analysis now?",
  };
}

export function renderSemanticBriefingBundle(bundle: SemanticBriefingBundle): string {
  const lines: string[] = [
    `Semantic briefing for: ${bundle.query}`,
    "",
    "Related context bundle:",
  ];
  for (const key of GROUP_ORDER) {
    const entries = bundle.groups[key];
    if (!entries || entries.length === 0) continue;
    lines.push(`- ${key}:`);
    for (const item of entries) {
      lines.push(`  - ${item.title} | ${item.metadata.link} | score=${item.score.toFixed(3)}`);
    }
  }
  lines.push("", "Evidence map:");
  for (const claim of bundle.evidence_map) {
    if (claim.evidence.type === "source") lines.push(`- ${claim.claim} -> ${claim.evidence.detail}`);
    else lines.push(`- ${claim.claim} -> missing evidence (${claim.evidence.detail})`);
  }
  lines.push("", `Confirmation gate: ${bundle.confirmation_question}`);
  return lines.join("\n");
}

export function enforceSemanticConfirmationGate(confirmed: boolean, pendingWriteTargets: readonly string[]): { allowed: boolean; reason?: string } {
  if (confirmed) return { allowed: true };
  if (pendingWriteTargets.length === 0) return { allowed: true };
  const blocked = pendingWriteTargets.filter((target) => /(ticket|doc|status|branch|registry|doc-ref)/i.test(target));
  if (blocked.length === 0) return { allowed: true };
  return {
    allowed: false,
    reason: `blocked before confirmation: ${blocked.join(", ")}`,
  };
}

function sourceClaim(candidate: SemanticCandidate): SemanticEvidenceClaim {
  return {
    claim: `Related ${candidate.metadata.type}: ${candidate.title}`,
    evidence: { type: "source", detail: candidate.metadata.link },
  };
}

function resolveSummaryClaims(claims: ReadonlyArray<{ claim: string; sourceLink?: string }>): SemanticEvidenceClaim[] {
  return claims.map((item) => {
    if (item.sourceLink && item.sourceLink.trim().length > 0) {
      return { claim: item.claim, evidence: { type: "source", detail: item.sourceLink } };
    }
    return { claim: item.claim, evidence: { type: "missing", detail: "no supporting source link provided" } };
  });
}
