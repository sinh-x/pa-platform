import { maskSecrets } from "../activity/index.js";
import { findSensitiveMatch, loadSensitivePatterns, type SensitivePatternSet } from "../sensitive-patterns.js";
import { openReadonlyRegistryDatabase } from "./db.js";
import { SESSION_CANDIDATE_LIMIT } from "./session-inventory.js";

export type SessionObjectivePreview =
  | { state: "available"; preview: string; text: string; truncated: boolean }
  | { state: "withheld"; reason: "sensitive-or-private" | "oversized-or-structured" }
  | { state: "unavailable"; reason: "not-recorded" | "metadata-unavailable" | "screening-unavailable" };
export const OBJECTIVE_SOURCE_LIMIT = 4096;
export const OBJECTIVE_TEXT_LIMIT = 1024;
export const OBJECTIVE_PREVIEW_LIMIT = 180;
/** Pure projection over the entire bounded source before truncation. No partial
 * masking: one suspicious match withholds the whole value, including its prefix. */
export function screenSessionObjective(value: unknown, patterns: SensitivePatternSet): SessionObjectivePreview {
  if (value === null || value === undefined || value === "") return { state: "unavailable", reason: "not-recorded" };
  if (typeof value !== "string") return { state: "withheld", reason: "sensitive-or-private" };
  if (value.length > OBJECTIVE_SOURCE_LIMIT || /^[\s]*[\[{]/.test(value)) return { state: "withheld", reason: "oversized-or-structured" };
  const plain = value.replace(/\s+/g, " ").trim();
  if (!plain) return { state: "unavailable", reason: "not-recorded" };
  try {
    if (/[/\\\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
      || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
      || /\b[A-Za-z0-9_-]{32,}\b/.test(value)
      || [value, plain].some(text => maskSecrets(text) !== text || findSensitiveMatch("content", text, patterns))) {
      return { state: "withheld", reason: "sensitive-or-private" };
    }
  } catch { return { state: "unavailable", reason: "screening-unavailable" }; }
  const clip = (text: string, limit: number) => text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  const text = clip(plain, OBJECTIVE_TEXT_LIMIT);
  return { state: "available", preview: clip(text, OBJECTIVE_PREVIEW_LIMIT), text, truncated: plain.length > text.length };
}
/** Existing-only bounded metadata read for exact captured deployments. Never
 * reads argv/environment, initializes a DB, or exports raw objective strings. */
export function readSessionObjectivePreviews(deploymentIds: string[]): Record<string, SessionObjectivePreview> {
  if (!Array.isArray(deploymentIds) || deploymentIds.length > SESSION_CANDIDATE_LIMIT
    || deploymentIds.some(id => typeof id !== "string" || !/^d-[a-f0-9]{6}$/.test(id))) throw new Error("Invalid objective selection");
  const ids = [...new Set(deploymentIds)];
  const unavailable = (reason: "not-recorded" | "metadata-unavailable" | "screening-unavailable") => Object.fromEntries(ids.map(id => [id, { state: "unavailable" as const, reason }]));
  if (!ids.length) return {};
  let patterns: SensitivePatternSet;
  try { patterns = loadSensitivePatterns(); } catch { return unavailable("screening-unavailable"); }
  try {
    const db = openReadonlyRegistryDatabase(true);
    try {
      const result: Record<string, SessionObjectivePreview> = unavailable("not-recorded");
      // Bound SQLite variables and stream bounded source values rather than
      // materializing all raw objectives in a single large array.
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        const statement = db.prepare(`SELECT deployment_id AS id, substr(CAST(objective AS BLOB), 1, ?) AS objectiveBytes
          FROM deployments WHERE runtime = 'pi' AND binary = 'ppa' AND deployment_id IN (${batch.map(() => "?").join(",")})`);
        for (const raw of statement.iterate(OBJECTIVE_SOURCE_LIMIT * 4 + 1, ...batch)) {
          const row = raw as { id: string; objectiveBytes: unknown };
          let value = row.objectiveBytes;
          if (Buffer.isBuffer(value)) {
            // SQLite text substr stops at NUL. Read bounded bytes instead so a
            // control or secret suffix cannot disappear before screening.
            try { value = new TextDecoder("utf-8", { fatal: true }).decode(value); }
            catch { result[row.id] = { state: "withheld", reason: "sensitive-or-private" }; continue; }
          }
          result[row.id] = screenSessionObjective(value, patterns);
        }
      }
      return result;
    } finally { db.close(); }
  } catch { return unavailable("metadata-unavailable"); }
}
