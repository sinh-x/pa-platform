import yaml from "js-yaml";
import { resolve } from "node:path";
import { parseReviewMatrixPlan } from "../validation/review-contract.js";
import { reject, type TemplateId } from "./schema.js";

import { DOCUMENT_PROFILES } from "./document-profiles.js";
function failure(): never { return reject("TEMPLATE_STRUCTURE", "document", "selected document sections, metadata, trace or scenario contract is incomplete or conflicting"); }
export interface MarkdownShape { lines: string[]; visible: string[]; headings: Array<{ text: string; index: number; level: number }> }
/** Fence/indent-aware structural projection; original source bytes never change. */
export function markdownShape(candidate: string): MarkdownShape {
  if (/[\p{Cf}\p{Cs}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(candidate) || /\r(?!\n)/.test(candidate)) failure();
  const lines = candidate.split(/\r?\n/), visible = [...lines], headings: MarkdownShape["headings"] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      else if (delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
      visible[index] = ""; continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) { visible[index] = ""; continue; }
    const heading = /^(#{1,6}) [^\s#].*$/.exec(line);
    if (heading) headings.push({ text: line, index, level: heading[1]!.length });
  }
  if (fence) failure();
  return { lines, visible, headings };
}
export function documentHeader(shape: MarkdownShape, label: string): string {
  const end = shape.headings.find(h => h.level === 2)?.index ?? shape.lines.length;
  const variants = [`> ${label}: `, `> **${label}:** `];
  const spelling = new RegExp(`^>[ \\t]*(?:\\*\\*)?${label}(?::|\\*\\*)`);
  const values = shape.visible.slice(0, end).filter(line => spelling.test(line));
  if (values.length !== 1) failure();
  const prefix = variants.find(prefix => values[0]!.startsWith(prefix));
  if (!prefix) failure(); const value = values[0]!.slice(prefix.length);
  if (!value.trim() || value !== value.trim() || value.length > 4096) failure(); return value;
}
function nonemptySection(shape: MarkdownShape, index: number): boolean {
  const next = shape.headings.find(h => h.index > index && h.level <= shape.headings.find(h => h.index === index)!.level)?.index ?? shape.lines.length;
  return shape.lines.slice(index + 1, next).some(line => line.trim() && !/^#{1,6} /.test(line) && !/^\s*(?:<!--.*-->|[-*_]{3,}|`{3,}[^`]*|~{3,}[^~]*)\s*$/.test(line));
}
function numberedSections(shape: MarkdownShape, count: number): void {
  for (let n = 1; n <= count; n++) if (shape.headings.filter(h => h.level === 2 && new RegExp(`^## ${n}\\. `).test(h.text)).length !== 1) failure();
}
function section(shape: MarkdownShape, pattern: RegExp): string {
  const headings = shape.headings.filter(h => pattern.test(h.text)); if (headings.length !== 1) failure();
  const h = headings[0]!, end = shape.headings.find(next => next.index > h.index && next.level <= h.level)?.index ?? shape.lines.length;
  return shape.visible.slice(h.index + 1, end).join("\n");
}
function table(text: string): void {
  const rows = text.split("\n").filter(line => /^\|.*\|$/.test(line));
  if (rows.length < 3) failure();
  const cells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
  const header = cells(rows[0]!); if (header.length < 2 || header.some(cell => !cell) || !cells(rows[1]!).every(cell => /^:?-{3,}:?$/.test(cell))) failure();
  if (rows.slice(2).some(row => cells(row).length !== header.length || cells(row).some(cell => !cell))) failure();
}
function traceIds(text: string, prefix: string): string[] {
  const ids = [...text.matchAll(new RegExp(`(?:^|[|\\s])(${prefix}-?[1-9][0-9]*)(?=[|\\s:])`, "gm"))].map(match => match[1]!);
  if (!ids.length || new Set(ids).size !== ids.length) failure(); return ids;
}
function scenarios(shape: MarkdownShape, criteria?: readonly string[]): void {
  const rows = shape.headings.filter(h => /^### TS-[1-9][0-9]*: /.test(h.text));
  if (!rows.length || new Set(rows.map(h => h.text.match(/^### (TS-[0-9]+):/)![1])).size !== rows.length) failure();
  const covered = new Set<string>();
  for (const h of rows) {
    const end = shape.headings.find(next => next.index > h.index && next.level <= 3)?.index ?? shape.lines.length;
    const lines = shape.visible.slice(h.index + 1, end);
    for (const field of ["Preconditions", "Steps", "Expected Result", "Actual Result", "Status"]) if (lines.filter(line => line.startsWith(`- ${field}:`)).length !== 1) failure();
    if (!lines.some(line => /^ {2}[1-9][0-9]*\. \S/.test(line)) || !lines.includes("- Actual Result: Not run.") || !lines.includes("- Status: Not run.")) failure();
    if (criteria) {
      const ac = lines.filter(line => line.startsWith("- Acceptance Criterion: "));
      if (ac.length !== 1) failure(); const id = ac[0]!.slice("- Acceptance Criterion: ".length);
      if (!criteria.includes(id) || covered.has(id)) failure(); covered.add(id);
    }
  }
  if (criteria && covered.size !== criteria.length) failure();
}
function learningFrontmatter(candidate: string): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(candidate); if (!match) failure();
  // No aliases, anchors, tags or secondary YAML documents. CORE_SCHEMA cannot
  // instantiate runtime values. Duplicate keys remain errors, never last-wins.
  if (/(?:^|[\s:[,])(?:[&*!][A-Za-z]|<<:)|^---$/m.test(match[1]!)) failure();
  let data: unknown; try { data = yaml.load(match[1]!, { schema: yaml.CORE_SCHEMA }); } catch { failure(); }
  if (!data || typeof data !== "object" || Array.isArray(data)) failure();
  const r = data as Record<string, unknown>;
  for (const field of ["type", "status", "source_doc", "source_repo", "source_ticket"]) if (typeof r[field] !== "string" || !(r[field] as string).trim()) failure();
  if (r.type !== "spike-research" || !["draft", "pending"].includes(r.status as string) || !Array.isArray(r.source_deployments) || !r.source_deployments.length || r.source_deployments.length > 64 || r.source_deployments.some(v => typeof v !== "string" || !/^d-[0-9a-f]{6}$/.test(v))) failure();
}
export function validateDocument(candidate: string, id: TemplateId, required: string[]): void {
  const profile = DOCUMENT_PROFILES[id]; if (!profile || required.length < profile.minimumSections) failure();
  const shape = markdownShape(candidate);
  if (shape.headings.filter(h => h.level === 1).length !== 1) failure();
  let previous = -1;
  for (const text of required) {
    const found = shape.headings.filter(h => h.text === text);
    if (found.length !== 1 || found[0]!.index <= previous || !nonemptySection(shape, found[0]!.index)) failure(); previous = found[0]!.index;
  }
  for (const label of profile.headers) documentHeader(shape, label);
  if (profile.headers.includes("Ticket") && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(documentHeader(shape, "Ticket"))) failure();
  if (profile.headers.includes("Repository Key") && !/^[a-zA-Z0-9_-]+$/.test(documentHeader(shape, "Repository Key"))) failure();
  if (profile.headers.includes("Repository Root")) { const root = documentHeader(shape, "Repository Root"); if (!/^\/[A-Za-z0-9_./-]+$/.test(root) || resolve(root) !== root) failure(); }
  for (const label of ["Review Revision", "Revision"]) if (profile.headers.includes(label) && !/^r[0-9]{3,}$/.test(documentHeader(shape, label))) failure();
  if (profile.headers.includes("Status") && !/^(?:Draft|UNAPPROVED(?: .*)?)$/.test(documentHeader(shape, "Status"))) failure();
  if (id === "requirements") {
    numberedSections(shape, 16);
    const classification = documentHeader(shape, "Class"), route = documentHeader(shape, "Route");
    if ((classification === "software-dev" && route !== "builder/orchestrator") || (classification === "data-analysis/dashboard-pipeline" && route !== "builder/data-analysis") || !["software-dev", "data-analysis/dashboard-pipeline"].includes(classification)) failure();
    const fr = section(shape, /^## 6\. /), nfr = section(shape, /^## 7\. /), ac = section(shape, /^## 10\. /);
    table(fr); table(nfr); traceIds(fr, "FR"); traceIds(nfr, "NFR"); traceIds(ac, "AC");
    const sources = shape.visible.filter(line => line.startsWith("Matrix Source: ")); if (sources.length !== 1) failure();
    const plan = parseReviewMatrixPlan(Buffer.from(candidate), sources[0]!.slice("Matrix Source: ".length));
    if (plan.digest !== documentHeader(shape, "Matrix Authority SHA-256") || plan.matrix.repository.key !== documentHeader(shape, "Repository Key") || plan.matrix.repository.root !== documentHeader(shape, "Repository Root") || plan.matrix.repository.branch !== documentHeader(shape, "Feature Branch") || (plan.matrix.environment.PA_TICKET_ID as { literal?: string }).literal !== documentHeader(shape, "Ticket")) failure();
    const handoff = documentHeader(shape, "Handoff Type");
    if (!["fresh", "amendment"].includes(handoff) || plan.matrix.repository.baseSha !== documentHeader(shape, handoff === "fresh" ? "Approved Base SHA" : "Retained Base SHA") || !plan.matrix.repository.branch.startsWith(`feature/${documentHeader(shape, "Ticket")}-`)) failure();
    const preamble = shape.visible.slice(0, shape.headings.find(h => h.level === 2)?.index ?? shape.lines.length);
    if (preamble.some(line => new RegExp(`^>[ \\t]*(?:\\*\\*)?${handoff === "fresh" ? "Retained" : "Approved"} Base SHA:`).test(line))) failure();
  }
  if (id === "builder-objective" && documentHeader(shape, "Execution Model") !== "direct-phase") failure();
  if (id === "implementation-phase-report") table(section(shape, /^## Checks$/));
  if (id === "spike-full-requirements") numberedSections(shape, 13);
  if (id === "project-agent-guide") numberedSections(shape, 9);
  if (id === "spike-learning-note") learningFrontmatter(candidate);
  if (id === "uat-plan") {
    let criteria: unknown; try { criteria = JSON.parse(documentHeader(shape, "Acceptance Criteria")); } catch { failure(); }
    if (!Array.isArray(criteria) || !criteria.length || criteria.length > 256 || criteria.some(id => typeof id !== "string" || !/^AC-?[1-9][0-9]*$/.test(id)) || new Set(criteria).size !== criteria.length) failure();
    scenarios(shape, criteria as string[]);
  }
  if (id === "uat-review") scenarios(shape);
  if (id === "uat-review" || id === "uat-plan") if (/^\s*- \[[xX]\]/m.test(section(shape, /^## UAT Sign-Off$/))) failure();
}
