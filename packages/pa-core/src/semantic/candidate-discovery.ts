import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDataDir, getRegistryDbPath, getTicketsDir } from "../paths.js";
import { queryDeploymentStatuses, readRegistry } from "../registry/index.js";
import { listDocuments, readDocument } from "../documents/index.js";
import { TicketStore } from "../tickets/store.js";
import { buildSemanticSourceMetadata, isApprovedSemanticPath, type SemanticSourceMetadata, type SemanticSourceType } from "./source-inventory.js";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the", "to", "was", "with",
  "should", "could", "need", "needs", "get", "up", "date", "related", "context", "ticket", "task", "work",
]);
const INDEX_DIR = resolve(getDataDir(), "semantic");
const INDEX_FILE = resolve(INDEX_DIR, "candidate-index.json");

export interface SemanticCandidate {
  metadata: SemanticSourceMetadata;
  title: string;
  excerpt: string;
  score: number;
}

export interface SemanticIndexedDocument {
  metadata: SemanticSourceMetadata;
  title: string;
  content: string;
}

export interface SemanticCandidateIndex {
  version: number;
  generated_at: string;
  documents: SemanticIndexedDocument[];
}

export interface SemanticQueryResult {
  query: string;
  reflections: SemanticCandidate[];
  system: SemanticCandidate[];
}

export function rebuildSemanticCandidateIndex(): SemanticCandidateIndex {
  const documents: SemanticIndexedDocument[] = [
    ...collectTicketDocuments(),
    ...collectDocRefAndArtifactDocuments(),
    ...collectSessionLogs(),
    ...collectRegistryAndDeployments(),
    ...collectReflections(),
  ];
  const dedup = new Map<string, SemanticIndexedDocument>();
  for (const doc of documents) dedup.set(doc.metadata.id, doc);
  const index: SemanticCandidateIndex = {
    version: 1,
    generated_at: new Date().toISOString(),
    documents: [...dedup.values()],
  };
  mkdirSync(INDEX_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
  return index;
}

export function loadSemanticCandidateIndex(): SemanticCandidateIndex {
  if (!existsSync(INDEX_FILE)) return { version: 1, generated_at: new Date(0).toISOString(), documents: [] };
  return JSON.parse(readFileSync(INDEX_FILE, "utf-8")) as SemanticCandidateIndex;
}

export function querySemanticCandidates(query: string, topK = 5, index = loadSemanticCandidateIndex()): SemanticQueryResult {
  const queryTokens = tokenize(query);
  const scored = index.documents
    .map((doc) => ({
      doc,
      score: scoreDocument(queryTokens, doc.content, doc.metadata.reflection_first),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(topK * 3, topK));
  const reflections: SemanticCandidate[] = [];
  const system: SemanticCandidate[] = [];
  for (const entry of scored) {
    const candidate: SemanticCandidate = {
      metadata: entry.doc.metadata,
      title: entry.doc.title,
      excerpt: buildExcerpt(entry.doc.content),
      score: Number(entry.score.toFixed(6)),
    };
    if (candidate.metadata.section === "reflections") reflections.push(candidate);
    else system.push(candidate);
  }
  return {
    query,
    reflections: reflections.slice(0, topK),
    system: system.slice(0, topK),
  };
}

function collectTicketDocuments(): SemanticIndexedDocument[] {
  if (!existsSync(getTicketsDir())) return [];
  const store = new TicketStore();
  return store.list().flatMap((ticket) => {
    const ticketMeta = metadata("ticket", ticket.id, `tickets/${ticket.id}`);
    const ticketDoc: SemanticIndexedDocument = {
      metadata: ticketMeta,
      title: `${ticket.id} ${ticket.title}`,
      content: `${ticket.id}\n${ticket.title}\n${ticket.summary}\n${ticket.description}\nstatus ${ticket.status} assignee ${ticket.assignee}`,
    };
    const commentDocs = ticket.comments.map((comment) => ({
      metadata: metadata("ticket-comment", `${ticket.id}#${comment.id}`, `tickets/${ticket.id}#${comment.id}`, comment.author),
      title: `${ticket.id} comment ${comment.id}`,
      content: `${ticket.id}\n${comment.author}\n${comment.content}`,
    }));
    return [ticketDoc, ...commentDocs];
  });
}

function collectDocRefAndArtifactDocuments(): SemanticIndexedDocument[] {
  const docs = listDocuments("agent-teams");
  return docs
    .filter((entry) => entry.relativePath.endsWith(".md") && isApprovedSemanticPath(entry.absolutePath))
    .map((entry) => ({
      metadata: metadata("artifact", `agent-teams/${entry.relativePath}`, `agent-teams/${entry.relativePath}`),
      title: entry.relativePath,
      content: readSafe(entry.absolutePath),
    }));
}

function collectSessionLogs(): SemanticIndexedDocument[] {
  return listDocuments("sessions")
    .filter((entry) => entry.relativePath.endsWith(".md") && isApprovedSemanticPath(entry.absolutePath))
    .map((entry) => ({
      metadata: metadata("session-log", `sessions/${entry.relativePath}`, `sessions/${entry.relativePath}`),
      title: entry.relativePath,
      content: readDocument("sessions", entry.relativePath),
    }));
}

function collectRegistryAndDeployments(): SemanticIndexedDocument[] {
  const registryPath = getRegistryDbPath();
  if (!isApprovedSemanticPath(registryPath)) return [];
  const deploymentDocs = queryDeploymentStatuses().map((deployment) => ({
    metadata: metadata("deployment", deployment.deploy_id, `deployments/${deployment.deploy_id}`),
    title: `deployment ${deployment.deploy_id}`,
    content: `${deployment.deploy_id}\n${deployment.team}\n${deployment.status}\n${deployment.summary ?? ""}\n${deployment.objective ?? ""}`,
  }));
  const eventDocs = readRegistry().map((event) => ({
    metadata: metadata("registry-event", `${event.deployment_id}:${event.event}:${event.timestamp}`, `deployments/${event.deployment_id}`),
    title: `${event.deployment_id} ${event.event}`,
    content: `${event.deployment_id}\n${event.event}\n${event.status ?? ""}\n${event.summary ?? ""}\n${event.note ?? ""}`,
  }));
  return [...deploymentDocs, ...eventDocs];
}

function collectReflections(): SemanticIndexedDocument[] {
  const roots: Array<{ type: SemanticSourceType; area: "sinh-inputs"; dir: string }> = [
    { type: "reflection", area: "sinh-inputs", dir: "for-review" },
    { type: "sinh-input", area: "sinh-inputs", dir: "inbox" },
    { type: "sinh-input", area: "sinh-inputs", dir: "ideas" },
    { type: "sinh-input", area: "sinh-inputs", dir: "daily-plan" },
  ];
  return roots.flatMap((root) => listDocuments(root.area, root.dir)
    .filter((entry) => entry.relativePath.endsWith(".md") && isApprovedSemanticPath(entry.absolutePath))
    .map((entry) => ({
      metadata: metadata(root.type, `sinh-inputs/${entry.relativePath}`, `sinh-inputs/${entry.relativePath}`, "sinh"),
      title: entry.relativePath,
      content: readDocument(root.area, entry.relativePath),
    })));
}

function metadata(type: SemanticSourceType, locator: string, link: string, authoredBy?: string): SemanticSourceMetadata {
  return buildSemanticSourceMetadata({ type, locator, link, authoredBy });
}

function scoreDocument(queryTokens: string[], content: string, reflectionFirst: boolean): number {
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(content);
  if (docTokens.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const token of docTokens) freq.set(token, (freq.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of queryTokens) score += (freq.get(token) ?? 0);
  score = score / Math.sqrt(docTokens.length);
  if (reflectionFirst && score > 0) score = score * 1.25;
  return score;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function buildExcerpt(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 220);
}

function readSafe(path: string): string {
  try {
    if (!existsSync(path)) return "";
    const stat = statSync(path);
    if (!stat.isFile()) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function getSemanticIndexPath(): string {
  return INDEX_FILE;
}

export function semanticIndexExists(): boolean {
  return existsSync(INDEX_FILE);
}

export function countIndexedSourcesByType(index: SemanticCandidateIndex): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const doc of index.documents) totals[doc.metadata.type] = (totals[doc.metadata.type] ?? 0) + 1;
  return totals;
}

export function listSemanticFixtureQuestions(): string[] {
  return [
    "Which ticket discussed semantic briefing addendum for PAP-058?",
    "Where are Sinh reflections about workflow pressure?",
    "Show deployment entries linked to PAP-058.",
    "Find builder artifacts for semantic evaluator work.",
    "Which session logs mention independent evaluator pass?",
    "What comments mention reflection-first ranking?",
    "Find doc refs for semantic candidate discovery phase.",
    "Where are registry events with partial or failed outcomes?",
    "Which personal inputs mention requirements intake concerns?",
    "Locate deployment status summary for semantic briefing work.",
  ];
}
