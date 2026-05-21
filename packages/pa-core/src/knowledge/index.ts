import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getAgentTeamsDir, getDeploymentsDir, getKnowledgeBaseDir, getSessionsDir } from "../paths.js";
import { queryEvaluatorResults } from "../registry/index.js";

export type KnowledgeItemType =
  | "memory-doc"
  | "runtime-instruction"
  | "packaged-skill"
  | "knowledge-base-entry"
  | "artifact"
  | "session-log"
  | "deployment-record"
  | "ticket-doc-ref";

export interface KnowledgeBoundary {
  itemType: KnowledgeItemType;
  primaryPurpose: string;
  storageLocation: string;
}

export type ImprovementCandidateStatus = "new" | "triaged" | "accepted" | "rejected";
export type ImprovementCandidateDecision = "pending" | "accepted" | "rejected";

export interface ImprovementCandidate {
  id: string;
  sourceType: "session-log" | "evaluator-artifact";
  sourceLink: string;
  owner: string;
  status: ImprovementCandidateStatus;
  decision: ImprovementCandidateDecision;
  followUpReference: string | null;
  summary: string;
  createdAt: string;
}

export function listKnowledgeBoundaries(): KnowledgeBoundary[] {
  return [
    {
      itemType: "memory-doc",
      primaryPurpose: "Agent memory and global behavior guidance injected at runtime start",
      storageLocation: "~/.claude/CLAUDE.md",
    },
    {
      itemType: "runtime-instruction",
      primaryPurpose: "Repository-scoped runtime instructions for deployments",
      storageLocation: "<repo>/CLAUDE.md and <repo>/OPENCODE.md",
    },
    {
      itemType: "packaged-skill",
      primaryPurpose: "Versioned operational procedure and team/mode skill content",
      storageLocation: "<pa-platform-config>/skills/",
    },
    {
      itemType: "knowledge-base-entry",
      primaryPurpose: "Durable how-to, decisions, and shared reference material",
      storageLocation: getKnowledgeBaseDir(),
    },
    {
      itemType: "artifact",
      primaryPurpose: "Durable implementation and review deliverables linked from tickets",
      storageLocation: resolve(getAgentTeamsDir(), "<team>/artifacts"),
    },
    {
      itemType: "session-log",
      primaryPurpose: "Historical execution timeline, outcomes, and self-improvement notes",
      storageLocation: getSessionsDir(),
    },
    {
      itemType: "deployment-record",
      primaryPurpose: "Runtime lifecycle evidence, activity stream, and registry status",
      storageLocation: getDeploymentsDir(),
    },
    {
      itemType: "ticket-doc-ref",
      primaryPurpose: "Stable ticket-linked references to durable documents",
      storageLocation: "Ticket store doc_refs via opa ticket update --doc-ref",
    },
  ];
}

export function listImprovementCandidates(): ImprovementCandidate[] {
  const byId = new Map<string, ImprovementCandidate>();
  for (const candidate of extractSessionLogCandidates()) byId.set(candidate.id, candidate);
  for (const candidate of extractEvaluatorCandidates()) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function extractSessionLogCandidates(): ImprovementCandidate[] {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  const candidates: ImprovementCandidate[] = [];
  for (const path of walkMarkdownFiles(sessionsDir)) {
    let content = "";
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const section = sectionBody(content, "Self-Improvement");
    if (!section) continue;
    const summary = firstNonEmptyLine(section.replace(/^#+\s+/gm, "").trim());
    if (!summary) continue;
    const stat = statSync(path);
    candidates.push({
      id: `session:${basename(path)}:${hashText(summary)}`,
      sourceType: "session-log",
      sourceLink: path,
      owner: ownerFromSessionLog(path, content),
      status: "new",
      decision: "pending",
      followUpReference: extractFollowUpReference(content),
      summary,
      createdAt: stat.mtime.toISOString(),
    });
  }
  return candidates;
}

function extractEvaluatorCandidates(): ImprovementCandidate[] {
  const rows = queryEvaluatorResults();
  const candidates: ImprovementCandidate[] = [];
  for (const row of rows) {
    const chunks = splitFindings(row.findings);
    for (const chunk of chunks) {
      candidates.push({
        id: `evaluator:${row.target_deployment_id}:${row.evaluator_deployment_id}:${hashText(chunk)}`,
        sourceType: "evaluator-artifact",
        sourceLink: row.report_path ?? `registry:evaluator/${row.target_deployment_id}/${row.evaluator_deployment_id}`,
        owner: "builder/team-manager",
        status: "new",
        decision: "pending",
        followUpReference: findTicketRef([row.summary ?? "", row.findings ?? "", ...row.evidence_refs]),
        summary: chunk,
        createdAt: row.created_at,
      });
    }
  }
  return candidates;
}

function walkMarkdownFiles(root: string): string[] {
  const results: string[] = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) results.push(...walkMarkdownFiles(path));
    else if (name.endsWith(".md")) results.push(path);
  }
  return results;
}

function sectionBody(content: string, title: string): string | null {
  const match = content.match(new RegExp(`^##\\s+${escapeRegex(title)}\\s*\\n([\\s\\S]*?)(^##\\s+|$)`, "m"));
  if (!match) return null;
  return match[1]?.trim() ?? null;
}

function splitFindings(findings?: string): string[] {
  if (!findings) return [];
  return findings
    .split(/\n+/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0 && !/^all required evidence/i.test(line));
}

function ownerFromSessionLog(path: string, content: string): string {
  const headerAgent = content.match(/^>\s*Agent:\s*(.+)$/m)?.[1]?.trim();
  if (headerAgent) return headerAgent;
  const file = basename(path);
  const parts = file.split("--");
  return parts.length >= 2 ? `${parts[0] ?? "builder"}/${parts[1]?.replace(/\.md$/, "") ?? "team-manager"}` : "builder/team-manager";
}

function extractFollowUpReference(content: string): string | null {
  const ticket = findTicketRef(content.split(/\s+/));
  return ticket;
}

function findTicketRef(parts: string[]): string | null {
  for (const part of parts) {
    const match = part.match(/[A-Z]{2,}-\d+/);
    if (match) return match[0];
  }
  return null;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const value = line.trim().replace(/^[-*]\s+/, "");
    if (value.length > 0) return value;
  }
  return "";
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash) + value.charCodeAt(i);
  return Math.abs(hash).toString(16);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
