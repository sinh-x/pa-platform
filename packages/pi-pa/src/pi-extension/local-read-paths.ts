import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalFileSource, SourceContentSecurityError, type SensitivePatternSet } from "@pa-platform/pa-core";

/** Pure enumeration of the inspected Pi 0.84.4 Linux resolver's finite spellings.
 * Keep original logical spelling as well as Pi's normalized spelling. No existence
 * probe, file open, private upstream import or caller-supplied trusted root. */
export function localReadPathCandidates(input: unknown, cwd: string): readonly string[] {
  if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0")) throw new SourceContentSecurityError("CONTENT_SOURCE_INVALID");
  const expand = (value: string) => {
    if (value === "~") return homedir();
    if (value.startsWith("~/")) return join(homedir(), value.slice(2));
    return value.startsWith("file://") ? fileURLToPath(value) : value;
  };
  try {
    const absolute = (value: string) => isAbsolute(value) ? resolve(value) : resolve(expand(cwd), value);
    const stripAt = (value: string) => value.startsWith("@") ? value.slice(1) : value;
    const original = absolute(expand(stripAt(input)));
    const normalized = absolute(expand(stripAt(input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " "))));
    const decomposed = normalized.normalize("NFD");
    return [...new Set([original, normalized,
      normalized.replace(/ (AM|PM)\./gi, "\u202f$1."), decomposed,
      normalized.replace(/'/g, "\u2019"), decomposed.replace(/'/g, "\u2019")])];
  } catch { throw new SourceContentSecurityError("CONTENT_SOURCE_INVALID"); }
}

/** Admit every potential candidate BEFORE delegating to Pi, whose resolver probes
 * existence before calling operations.access. Conservatively deny ambiguous
 * requests if any alternate spelling is protected, even if another one exists.
 * Realpath observations here belong to source admission, not upstream preflight. */
export function admitLocalReadPaths(input: unknown, cwd: string, patterns: SensitivePatternSet): ReadonlySet<string> {
  const candidates = localReadPathCandidates(input, cwd);
  for (const candidate of candidates) assertLocalFileSource(candidate, patterns);
  return new Set(candidates);
}
