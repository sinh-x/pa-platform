import { basename } from "node:path";

export interface HumanFeedback {
  action: string;
  by?: string;
  at?: string;
  note?: string;
  chips: string[];
  what_is_wrong?: string;
  what_to_fix?: string;
  priority?: string;
  defer_reason?: string;
  requeue_after?: string;
}

export interface MarkdownMetadata {
  title: string;
  date?: string;
  from?: string;
  to?: string;
  deployment?: string;
  type?: string;
  status?: string;
  priority?: string;
  human_feedback?: HumanFeedback;
}

export type FeedbackAnnotation =
  | { kind: "approve"; note?: string; chips?: string[] }
  | { kind: "reject"; what_is_wrong: string; what_to_fix: string; priority?: string; chips?: string[] }
  | { kind: "pending-reject" }
  | { kind: "defer"; reason?: string; requeue_after?: string; chips?: string[] }
  | { kind: "save-for-later" }
  | { kind: "acknowledge"; note?: string };

const METADATA_PATTERN = /^>\s*\*\*(.+?):\*\*\s*(.+)$/;
const TITLE_PATTERN = /^#\s+(.+)$/;

function extractFrontmatter(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  return end === -1 ? null : content.substring(4, end);
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  return end === -1 ? content : content.substring(end + 5);
}

function unquoteYamlValue(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.substring(1, value.length - 1);
  return value;
}

function parseYamlList(value: string): string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) return [];
  return value.substring(1, value.length - 1).split(",").map((entry) => unquoteYamlValue(entry.trim())).filter((entry) => entry.length > 0);
}

function parseFrontmatterFeedback(content: string): HumanFeedback | undefined {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return undefined;
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "human_feedback:");
  if (start < 0) return undefined;
  const feedbackMap: Record<string, string> = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;
    feedbackMap[trimmed.substring(0, colonIdx).trim()] = unquoteYamlValue(trimmed.substring(colonIdx + 1).trim());
  }
  const action = feedbackMap["action"];
  if (!action) return undefined;
  const feedback: HumanFeedback = { action, chips: feedbackMap["chips"] ? parseYamlList(feedbackMap["chips"]) : [] };
  if (feedbackMap["by"]) feedback.by = feedbackMap["by"];
  if (feedbackMap["at"]) feedback.at = feedbackMap["at"];
  if (feedbackMap["note"]) feedback.note = feedbackMap["note"];
  if (feedbackMap["what_is_wrong"]) feedback.what_is_wrong = feedbackMap["what_is_wrong"];
  if (feedbackMap["what_to_fix"]) feedback.what_to_fix = feedbackMap["what_to_fix"];
  if (feedbackMap["priority"]) feedback.priority = feedbackMap["priority"];
  if (feedbackMap["defer_reason"]) feedback.defer_reason = feedbackMap["defer_reason"];
  if (feedbackMap["requeue_after"]) feedback.requeue_after = feedbackMap["requeue_after"];
  return feedback;
}

export function parseMarkdownMetadata(content: string, filename?: string): MarkdownMetadata {
  let title: string | undefined;
  let date: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let deployment: string | undefined;
  let type: string | undefined;
  let status: string | undefined;
  let priority: string | undefined;
  const humanFeedback = parseFrontmatterFeedback(content);

  for (const line of stripFrontmatter(content).split("\n")) {
    const trimmed = line.trim();
    if (!title) {
      const titleMatch = TITLE_PATTERN.exec(trimmed);
      if (titleMatch) {
        title = titleMatch[1]?.trim();
        continue;
      }
    }
    const metaMatch = METADATA_PATTERN.exec(trimmed);
    if (!metaMatch) continue;
    const key = metaMatch[1]?.trim().toLowerCase();
    const value = metaMatch[2]?.trim();
    if (!key || !value) continue;
    if (key === "date") date = value;
    else if (key === "from") from = value;
    else if (key === "to") to = value;
    else if (key === "deployment") deployment = value;
    else if (key === "type") type = value;
    else if (key === "status") status = value;
    else if (key === "priority") priority = value;
  }

  const meta: MarkdownMetadata = { title: title ?? (filename ? basename(filename).replace(/\.md$/, "") : "Untitled") };
  if (date) meta.date = date;
  if (from) meta.from = from;
  if (to) meta.to = to;
  if (deployment) meta.deployment = deployment;
  if (type) meta.type = type;
  if (status) meta.status = status;
  if (priority) meta.priority = priority;
  if (humanFeedback) meta.human_feedback = humanFeedback;
  return meta;
}

function normalizeDocumentType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower === "work-report" || lower === "work report") return "work-report";
  if (lower.startsWith("review")) return "review-request";
  if (lower.startsWith("plan")) return "plan-draft";
  if (lower.startsWith("fyi") || lower === "notification") return "fyi";
  if (lower.startsWith("decision")) return "decision-needed";
  return "work-report";
}

export function detectDocumentType(content: string, filename: string): string {
  for (const line of stripFrontmatter(content).split("\n")) {
    if (line.startsWith("> **Type:**")) return normalizeDocumentType(line.replace("> **Type:**", "").trim());
    if (line.length > 0 && !line.startsWith("#") && !line.startsWith(">") && line.trim().length > 0) break;
  }
  const withoutDate = basename(filename).replace(/^\d{4}-\d{2}-\d{2}-/, "");
  if (withoutDate.startsWith("review-")) return "review-request";
  if (withoutDate.includes("plan-draft")) return "plan-draft";
  return "work-report";
}

function quoteYamlString(value: string): string {
  if (value.includes(": ") || value.includes("#") || value.includes('"') || value.includes("'")) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return value;
}

function buildFeedbackYaml(opts: { action: string; by: string; at: string; note?: string; chips?: string[]; what_is_wrong?: string; what_to_fix?: string; priority?: string; defer_reason?: string; requeue_after?: string }): string {
  const lines = ["human_feedback:", `  action: ${opts.action}`, `  by: ${opts.by}`, `  at: ${opts.at}`];
  if (opts.note) lines.push(`  note: ${quoteYamlString(opts.note)}`);
  if (opts.chips && opts.chips.length > 0) lines.push(`  chips: [${opts.chips.map((chip) => `"${chip.replace(/"/g, '\\"')}"`).join(", ")}]`);
  if (opts.what_is_wrong) lines.push(`  what_is_wrong: ${quoteYamlString(opts.what_is_wrong)}`);
  if (opts.what_to_fix) lines.push(`  what_to_fix: ${quoteYamlString(opts.what_to_fix)}`);
  if (opts.priority) lines.push(`  priority: ${opts.priority}`);
  if (opts.defer_reason) lines.push(`  defer_reason: ${quoteYamlString(opts.defer_reason)}`);
  if (opts.requeue_after) lines.push(`  requeue_after: "${opts.requeue_after}"`);
  return lines.join("\n");
}

function buildHumanReviewSection(opts: { action: string; at: string; note?: string; chips?: string[]; what_is_wrong?: string; what_to_fix?: string; priority?: string; defer_reason?: string; requeue_after?: string }): string {
  const displayAt = opts.at.length > 16 ? opts.at.substring(0, 16) : opts.at;
  const lines = ["## Human Review", "", `> **Action:** ${opts.action}`, "> **By:** Sinh", `> **At:** ${displayAt}`];
  if (opts.note) lines.push(`> **Note:** ${opts.note}`);
  if (opts.chips && opts.chips.length > 0) lines.push(`> **Chips:** ${opts.chips.join(", ")}`);
  if (opts.what_is_wrong) lines.push(`> **What's wrong:** ${opts.what_is_wrong}`);
  if (opts.what_to_fix) lines.push(`> **What to fix:** ${opts.what_to_fix}`);
  if (opts.priority) lines.push(`> **Priority:** ${opts.priority[0]?.toUpperCase()}${opts.priority.slice(1)}`);
  if (opts.defer_reason) lines.push(`> **Reason:** ${opts.defer_reason}`);
  if (opts.requeue_after) lines.push(`> **Re-queue after:** ${opts.requeue_after}`);
  return lines.join("\n");
}

function removeFrontmatterKey(yaml: string, key: string): string {
  const result: string[] = [];
  let inKey = false;
  for (const line of yaml.split("\n")) {
    if (line.trimEnd() === `${key}:` || line.startsWith(`${key}: `) || line.startsWith(`${key}:`)) {
      inKey = true;
      continue;
    }
    if (inKey) {
      if (line.startsWith(" ") || line.startsWith("\t") || line === "") continue;
      inKey = false;
    }
    result.push(line);
  }
  while (result.at(-1) === "") result.pop();
  return result.join("\n");
}

function mergeYamlFrontmatter(content: string, yamlBlock: string): string {
  if (content.startsWith("---\n")) {
    const endIdx = content.indexOf("\n---\n", 4);
    if (endIdx !== -1) {
      let existing = removeFrontmatterKey(content.substring(4, endIdx), "human_feedback");
      if (existing.length > 0 && !existing.endsWith("\n")) existing += "\n";
      return `---\n${existing}${yamlBlock}\n---\n${content.substring(endIdx + 5)}`;
    }
  }
  return `---\n${yamlBlock}\n---\n${content}`;
}

function applyAnnotation(content: string, yamlBlock: string, humanReviewSection: string | null): string {
  let result = mergeYamlFrontmatter(content, yamlBlock);
  if (humanReviewSection !== null) {
    if (!result.endsWith("\n")) result += "\n";
    if (!result.endsWith("\n\n")) result += "\n";
    result += `${humanReviewSection}\n`;
  }
  return result;
}

export function writeFeedbackAnnotation(content: string, annotation: FeedbackAnnotation): string {
  const now = new Date().toISOString();
  const by = "Sinh";
  if (annotation.kind === "approve") {
    const chips = annotation.chips ?? [];
    if (!annotation.note && chips.length === 0) return content;
    return applyAnnotation(content, buildFeedbackYaml({ action: "approved", by, at: now, note: annotation.note, chips }), buildHumanReviewSection({ action: "approved", at: now, note: annotation.note, chips }));
  }
  if (annotation.kind === "reject") {
    const chips = annotation.chips ?? [];
    const priority = annotation.priority ?? "medium";
    return applyAnnotation(content, buildFeedbackYaml({ action: "rejected", by, at: now, chips, what_is_wrong: annotation.what_is_wrong, what_to_fix: annotation.what_to_fix, priority }), buildHumanReviewSection({ action: "rejected", at: now, chips, what_is_wrong: annotation.what_is_wrong, what_to_fix: annotation.what_to_fix, priority }));
  }
  if (annotation.kind === "pending-reject") return applyAnnotation(content, buildFeedbackYaml({ action: "pending-reject-feedback", by, at: now }), null);
  if (annotation.kind === "defer") {
    const chips = annotation.chips ?? [];
    if (!annotation.reason && annotation.requeue_after == null && chips.length === 0) return content;
    return applyAnnotation(content, buildFeedbackYaml({ action: "deferred", by, at: now, chips, defer_reason: annotation.reason, requeue_after: annotation.requeue_after }), buildHumanReviewSection({ action: "deferred", at: now, chips, defer_reason: annotation.reason, requeue_after: annotation.requeue_after }));
  }
  if (annotation.kind === "save-for-later") return applyAnnotation(content, buildFeedbackYaml({ action: "saved-for-later", by, at: now }), null);
  if (!annotation.note) return content;
  return applyAnnotation(content, buildFeedbackYaml({ action: "acknowledged", by, at: now, note: annotation.note }), null);
}
