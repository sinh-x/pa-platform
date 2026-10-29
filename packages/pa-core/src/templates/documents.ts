import yaml from "js-yaml";
import { resolve } from "node:path";
import { parseReviewMatrixPlan } from "../validation/review-contract.js";
import { isCanonicalTicketId } from "../tickets/validate.js";
import { reject, type TemplateId } from "./schema.js";

import { DOCUMENT_PROFILES } from "./document-profiles.js";
/** Finite runtime-owned rules only: never interpolate labels, headings, YAML,
 * rejected values or parser exceptions into diagnostics. Keep the public error
 * code stable while identifying the first failed structural rule. */
const DOCUMENT_RULES = {
  characters: "document must exclude unsafe controls, format characters and lone carriage returns",
  fence: "Markdown code fences must close with the matching marker and length",
  metadata: "each required preamble field must occur once with canonical spelling and a nonempty bounded value",
  sections: "selected sections must occur once, in declared order, with populated bodies outside fenced or indented headings",
  "numbered-sections": "each required numbered level-two section must occur exactly once",
  table: "required table must contain a populated header, separator and complete equally sized data rows",
  trace: "required trace identifiers must be present, valid and unique in their owning section",
  scenarios: "at least one uniquely numbered level-three test scenario is required",
  "scenario-fields": "each scenario must contain exactly one Preconditions, Steps, Expected Result, Actual Result and Status field",
  "scenario-steps": "each scenario must include a concrete numbered step",
  "scenario-results": "scenario Actual Result and Status must remain exactly Not run; structural validation cannot certify execution",
  "criteria-coverage": "each declared acceptance criterion must have exactly one scenario and no foreign or repeated criterion",
  criteria: "Acceptance Criteria must be a nonempty bounded JSON array of unique valid AC identifiers",
  frontmatter: "learning note requires one leading YAML frontmatter block",
  "frontmatter-yaml": "frontmatter must be a mapping with unique keys and no aliases, anchors, tags or secondary documents",
  "frontmatter-fields": "frontmatter requires nonempty source fields, spike-research type, draft or pending status and bounded deployment identifiers",
  profile: "selected document must declare its supported profile and complete minimum section contract",
  title: "document must contain exactly one visible level-one title",
  ticket: "Ticket must preserve an exact bounded canonical ticket ID, including any registry-issued zero padding",
  "repository-key": "Repository Key must use the supported identifier grammar",
  "repository-root": "Repository Root must be an absolute normalized unaliased path",
  revision: "document revision metadata must use the exact rNNN grammar",
  status: "document Status must remain Draft or UNAPPROVED; rendering cannot issue approval",
  "classification-route": "Class and Route must name one supported matching workflow profile",
  "matrix-source": "requirements must declare exactly one visible Matrix Source",
  "matrix-digest": "Matrix Authority SHA-256 must equal the actual raw review-matrix plan digest",
  "matrix-tuple": "review-matrix repository key, root, branch and exact ticket must match requirements metadata",
  "handoff-type": "Handoff Type must be exactly fresh or amendment",
  "handoff-tuple": "review-matrix base must match the handoff-specific base field and branch must belong to the exact ticket",
  "base-field": "fresh and amendment base metadata must not be mixed",
  "execution-model": "builder objective Execution Model must remain direct-phase, never retired implementation-child dispatch",
} as const;
function failure(rule: keyof typeof DOCUMENT_RULES): never { return reject("TEMPLATE_STRUCTURE", `document.${rule}`, DOCUMENT_RULES[rule]); }
export interface MarkdownShape { lines: string[]; visible: string[]; headings: Array<{ text: string; index: number; level: number }> }
/** Fence/indent-aware structural projection; original source bytes never change. */
export function markdownShape(candidate: string): MarkdownShape {
  if (/[\p{Cf}\p{Cs}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(candidate) || /\r(?!\n)/.test(candidate)) failure("characters");
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
  if (fence) failure("fence");
  return { lines, visible, headings };
}
export function documentHeader(shape: MarkdownShape, label: string): string {
  const end = shape.headings.find(h => h.level === 2)?.index ?? shape.lines.length;
  const variants = [`> ${label}: `, `> **${label}:** `];
  const spelling = new RegExp(`^>[ \\t]*(?:\\*\\*)?${label}(?::|\\*\\*)`);
  const values = shape.visible.slice(0, end).filter(line => spelling.test(line));
  if (values.length !== 1) failure("metadata");
  const prefix = variants.find(prefix => values[0]!.startsWith(prefix));
  if (!prefix) failure("metadata"); const value = values[0]!.slice(prefix.length);
  if (!value.trim() || value !== value.trim() || value.length > 4096) failure("metadata"); return value;
}
function nonemptySection(shape: MarkdownShape, index: number): boolean {
  const next = shape.headings.find(h => h.index > index && h.level <= shape.headings.find(h => h.index === index)!.level)?.index ?? shape.lines.length;
  return shape.lines.slice(index + 1, next).some(line => line.trim() && !/^#{1,6} /.test(line) && !/^\s*(?:<!--.*-->|[-*_]{3,}|`{3,}[^`]*|~{3,}[^~]*)\s*$/.test(line));
}
function numberedSections(shape: MarkdownShape, count: number): void {
  for (let n = 1; n <= count; n++) if (shape.headings.filter(h => h.level === 2 && new RegExp(`^## ${n}\\. `).test(h.text)).length !== 1) failure("numbered-sections");
}
function section(shape: MarkdownShape, pattern: RegExp): string {
  const headings = shape.headings.filter(h => pattern.test(h.text)); if (headings.length !== 1) failure("sections");
  const h = headings[0]!, end = shape.headings.find(next => next.index > h.index && next.level <= h.level)?.index ?? shape.lines.length;
  return shape.visible.slice(h.index + 1, end).join("\n");
}
function table(text: string): void {
  const rows = text.split("\n").filter(line => /^\|.*\|$/.test(line));
  if (rows.length < 3) failure("table");
  const cells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
  const header = cells(rows[0]!); if (header.length < 2 || header.some(cell => !cell) || !cells(rows[1]!).every(cell => /^:?-{3,}:?$/.test(cell))) failure("table");
  if (rows.slice(2).some(row => cells(row).length !== header.length || cells(row).some(cell => !cell))) failure("table");
}
function traceIds(text: string, prefix: string): string[] {
  const ids = [...text.matchAll(new RegExp(`(?:^|[|\\s])(${prefix}-?[1-9][0-9]*)(?=[|\\s:])`, "gm"))].map(match => match[1]!);
  if (!ids.length || new Set(ids).size !== ids.length) failure("trace"); return ids;
}
function scenarios(shape: MarkdownShape, criteria?: readonly string[]): void {
  const rows = shape.headings.filter(h => /^### TS-[1-9][0-9]*: /.test(h.text));
  if (!rows.length || new Set(rows.map(h => h.text.match(/^### (TS-[0-9]+):/)![1])).size !== rows.length) failure("scenarios");
  const covered = new Set<string>();
  for (const h of rows) {
    const end = shape.headings.find(next => next.index > h.index && next.level <= 3)?.index ?? shape.lines.length;
    const lines = shape.visible.slice(h.index + 1, end);
    for (const field of ["Preconditions", "Steps", "Expected Result", "Actual Result", "Status"]) if (lines.filter(line => line.startsWith(`- ${field}:`)).length !== 1) failure("scenario-fields");
    if (!lines.some(line => /^ {2}[1-9][0-9]*\. \S/.test(line))) failure("scenario-steps");
    if (!lines.includes("- Actual Result: Not run.") || !lines.includes("- Status: Not run.")) failure("scenario-results");
    if (criteria) {
      const ac = lines.filter(line => line.startsWith("- Acceptance Criterion: "));
      if (ac.length !== 1) failure("criteria-coverage"); const id = ac[0]!.slice("- Acceptance Criterion: ".length);
      if (!criteria.includes(id) || covered.has(id)) failure("criteria-coverage"); covered.add(id);
    }
  }
  if (criteria && covered.size !== criteria.length) failure("criteria-coverage");
}
function learningFrontmatter(candidate: string): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(candidate); if (!match) failure("frontmatter");
  // No aliases, anchors, tags or secondary YAML documents. CORE_SCHEMA cannot
  // instantiate runtime values. Duplicate keys remain errors, never last-wins.
  if (/(?:^|[\s:[,])(?:[&*!][A-Za-z]|<<:)|^---$/m.test(match[1]!)) failure("frontmatter-yaml");
  let data: unknown; try { data = yaml.load(match[1]!, { schema: yaml.CORE_SCHEMA }); } catch { failure("frontmatter-yaml"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) failure("frontmatter-yaml");
  const r = data as Record<string, unknown>;
  for (const field of ["type", "status", "source_doc", "source_repo", "source_ticket"]) if (typeof r[field] !== "string" || !(r[field] as string).trim()) failure("frontmatter-fields");
  if (r.type !== "spike-research" || !["draft", "pending"].includes(r.status as string) || !Array.isArray(r.source_deployments) || !r.source_deployments.length || r.source_deployments.length > 64 || r.source_deployments.some(v => typeof v !== "string" || !/^d-[0-9a-f]{6}$/.test(v))) failure("frontmatter-fields");
}
export function validateDocument(candidate: string, id: TemplateId, required: string[]): void {
  const profile = DOCUMENT_PROFILES[id]; if (!profile || required.length < profile.minimumSections) failure("profile");
  const shape = markdownShape(candidate);
  if (shape.headings.filter(h => h.level === 1).length !== 1) failure("title");
  let previous = -1;
  for (const text of required) {
    const found = shape.headings.filter(h => h.text === text);
    if (found.length !== 1 || found[0]!.index <= previous || !nonemptySection(shape, found[0]!.index)) failure("sections"); previous = found[0]!.index;
  }
  for (const label of profile.headers) documentHeader(shape, label);
  if (profile.headers.includes("Ticket") && !isCanonicalTicketId(documentHeader(shape, "Ticket"))) failure("ticket");
  if (profile.headers.includes("Repository Key") && !/^[a-zA-Z0-9_-]+$/.test(documentHeader(shape, "Repository Key"))) failure("repository-key");
  if (profile.headers.includes("Repository Root")) { const root = documentHeader(shape, "Repository Root"); if (!/^\/[A-Za-z0-9_./-]+$/.test(root) || resolve(root) !== root) failure("repository-root"); }
  for (const label of ["Review Revision", "Revision"]) if (profile.headers.includes(label) && !/^r[0-9]{3,}$/.test(documentHeader(shape, label))) failure("revision");
  if (profile.headers.includes("Status") && !/^(?:Draft|UNAPPROVED(?: .*)?)$/.test(documentHeader(shape, "Status"))) failure("status");
  if (id === "requirements") {
    numberedSections(shape, 16);
    const classification = documentHeader(shape, "Class"), route = documentHeader(shape, "Route");
    if ((classification === "software-dev" && route !== "builder/orchestrator") || (classification === "data-analysis/dashboard-pipeline" && route !== "builder/data-analysis") || !["software-dev", "data-analysis/dashboard-pipeline"].includes(classification)) failure("classification-route");
    const fr = section(shape, /^## 6\. /), nfr = section(shape, /^## 7\. /), ac = section(shape, /^## 10\. /);
    table(fr); table(nfr); traceIds(fr, "FR"); traceIds(nfr, "NFR"); traceIds(ac, "AC");
    const sources = shape.visible.filter(line => line.startsWith("Matrix Source: ")); if (sources.length !== 1) failure("matrix-source");
    const plan = parseReviewMatrixPlan(Buffer.from(candidate), sources[0]!.slice("Matrix Source: ".length));
    if (plan.digest !== documentHeader(shape, "Matrix Authority SHA-256")) failure("matrix-digest");
    if (plan.matrix.repository.key !== documentHeader(shape, "Repository Key") || plan.matrix.repository.root !== documentHeader(shape, "Repository Root") || plan.matrix.repository.branch !== documentHeader(shape, "Feature Branch") || (plan.matrix.environment.PA_TICKET_ID as { literal?: string }).literal !== documentHeader(shape, "Ticket")) failure("matrix-tuple");
    const handoff = documentHeader(shape, "Handoff Type");
    if (!["fresh", "amendment"].includes(handoff)) failure("handoff-type");
    if (plan.matrix.repository.baseSha !== documentHeader(shape, handoff === "fresh" ? "Approved Base SHA" : "Retained Base SHA") || !plan.matrix.repository.branch.startsWith(`feature/${documentHeader(shape, "Ticket")}-`)) failure("handoff-tuple");
    const preamble = shape.visible.slice(0, shape.headings.find(h => h.level === 2)?.index ?? shape.lines.length);
    if (preamble.some(line => new RegExp(`^>[ \\t]*(?:\\*\\*)?${handoff === "fresh" ? "Retained" : "Approved"} Base SHA:`).test(line))) failure("base-field");
  }
  if (id === "builder-objective" && documentHeader(shape, "Execution Model") !== "direct-phase") failure("execution-model");
  if (id === "implementation-phase-report") table(section(shape, /^## Checks$/));
  if (id === "spike-full-requirements") numberedSections(shape, 13);
  if (id === "project-agent-guide") numberedSections(shape, 9);
  if (id === "spike-learning-note") learningFrontmatter(candidate);
  if (id === "uat-plan") {
    const header = documentHeader(shape, "Acceptance Criteria");
    let criteria: unknown; try { criteria = JSON.parse(header); } catch { failure("criteria"); }
    if (!Array.isArray(criteria) || !criteria.length || criteria.length > 256 || criteria.some(id => typeof id !== "string" || !/^AC-?[1-9][0-9]*$/.test(id)) || new Set(criteria).size !== criteria.length) failure("criteria");
    scenarios(shape, criteria as string[]);
  }
  if (id === "uat-review") scenarios(shape);
  if (id === "uat-review" || id === "uat-plan") if (/^\s*- \[[xX]\]/m.test(section(shape, /^## UAT Sign-Off$/))) failure("scenario-results");
}
