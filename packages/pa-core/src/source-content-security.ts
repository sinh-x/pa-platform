import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isBlockedFilePath } from "./safety-policy.js";
import { getSensitiveFilename, loadSensitivePatterns, type SensitivePatternSet } from "./sensitive-patterns.js";

/** Trusted implementation metadata, NEVER a model/request-provided exemption. */
export type SecurityContentSource =
  | { readonly kind: "local-file"; readonly path: string }
  | { readonly kind: "local-tool-output"; readonly tool: string }
  | { readonly kind: "public-web-response" };
export const LOCAL_CONTENT_REDACTED = "[REDACTED local sensitive content]";
export const MAX_LOCAL_SECURITY_BYTES = 16 * 1024 * 1024;
const MAX_MATCHES = 10_000;
export type SourceContentCode = "LOCAL_SOURCE_UNAVAILABLE" | "LOCAL_SOURCE_UNSUPPORTED_FILE" | "LOCAL_SOURCE_BLOCKED" | "LOCAL_CONTENT_LIMIT" | "LOCAL_CONTENT_POLICY" | "CONTENT_SOURCE_INVALID";
export class SourceContentSecurityError extends Error {
  constructor(readonly code: SourceContentCode) {
    const reasons: Record<SourceContentCode, string> = {
      LOCAL_SOURCE_UNAVAILABLE: "A complete stable local read could not be established; the source may be absent or changed, or the read interrupted. No unexamined content is delivered.",
      LOCAL_SOURCE_UNSUPPORTED_FILE: "The opened source did not meet supported regular-file/single-link policy. Selected immutable Pi documentation eligibility has not been established. No content is delivered.",
      LOCAL_SOURCE_BLOCKED: "The local source matches protected-path or configured filename/path rules. Content redaction does not authorize reading it.",
      LOCAL_CONTENT_LIMIT: "The complete local content exceeds the bounded security scan. No unexamined text is returned.",
      LOCAL_CONTENT_POLICY: "The local sensitive-content policy could not be evaluated. Raw content is withheld, not allowed by default.",
      CONTENT_SOURCE_INVALID: "The implementation did not establish a supported source and content pair. Caller-supplied origin labels are not exemptions.",
    };
    super(`Local content is unavailable through this check.\nCondition: The requested local content cannot be delivered.\nSource: Source-aware local content security (${code}).\nReason: ${reasons[code]}\nCorrection: Ask the security/runtime owner to inspect the source classification and configured rules. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs need their owner. Prerequisite: preserve source and original operation coordinates without copying sensitive bytes or bypassing the denial.\nResume Action: Retry only after the owner establishes permitted source access and a working policy. If the underlying tool may already have changed state, inspect that same operation first; withholding output is not proof that its effect was absent.`);
  }
}
const fail = (code: SourceContentCode): never => { throw new SourceContentSecurityError(code); };
function patternsOrFail(patterns?: SensitivePatternSet): SensitivePatternSet {
  try { return patterns ?? loadSensitivePatterns(); } catch { return fail("LOCAL_CONTENT_POLICY"); }
}
function matches(regex: RegExp, value: string): boolean {
  // A shared /g or /y regex must not make admission depend on prior calls.
  return new RegExp(regex.source, regex.flags.replace(/[gy]/g, "")).test(value);
}
/** Call BEFORE opening a local file. Check logical and physical identity, not
 * just content or the caller's path spelling. Missing allowed files stay missing. */
export function assertLocalFileSource(path: string, patterns?: SensitivePatternSet): void {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) return fail("CONTENT_SOURCE_INVALID");
  const checked = patternsOrFail(patterns);
  const check = (candidate: string) => {
    if (isBlockedFilePath(candidate, checked) || checked.patterns.some(p => p.inputClass === "path" && matches(p.regex, candidate)
      || p.inputClass === "filename" && matches(p.regex, getSensitiveFilename(candidate)))) fail("LOCAL_SOURCE_BLOCKED");
  };
  try {
    check(resolve(path));
    try { check(realpathSync(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) { if (error instanceof SourceContentSecurityError) throw error; fail("LOCAL_CONTENT_POLICY"); }
}
export interface SourceContentProjection {
  readonly source: SecurityContentSource["kind"];
  readonly disposition: "allow" | "redact" | "withhold";
  readonly content: string;
}
/** Data check only: public response allowance belongs exclusively to the native
 * public reader. Local inputs cannot import that source through a tool argument.
 * Local file text must be checked BEFORE pagination; partial text cannot prove a
 * whole-file scan. Input/approval/effect validators keep their existing denials. */
export function checkSourceContent(input: { source: SecurityContentSource; content: string }, patterns?: SensitivePatternSet): SourceContentProjection {
  const source = input?.source;
  if (!source || typeof input.content !== "string" || !["local-file", "local-tool-output", "public-web-response"].includes(source.kind)) return fail("CONTENT_SOURCE_INVALID");
  if (source.kind === "public-web-response") {
    if (Object.keys(source).length !== 1) return fail("CONTENT_SOURCE_INVALID");
    return { source: source.kind, disposition: "allow", content: input.content };
  }
  if (source.kind === "local-tool-output" && (Object.keys(source).length !== 2 || typeof source.tool !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(source.tool))) return fail("CONTENT_SOURCE_INVALID");
  if (source.kind === "local-file" && Object.keys(source).length !== 2) return fail("CONTENT_SOURCE_INVALID");
  const checked = patternsOrFail(patterns);
  if (source.kind === "local-file") assertLocalFileSource(source.path, checked);
  const text = input.content;
  if (Buffer.byteLength(text) > MAX_LOCAL_SECURITY_BYTES) return fail("LOCAL_CONTENT_LIMIT");
  const ranges: Array<[number, number]> = [];
  try {
    for (const pattern of checked.patterns) {
      if (pattern.inputClass !== "content") continue;
      const regex = new RegExp(pattern.regex.source, `${pattern.regex.flags.replace(/[gy]/g, "")}g`);
      for (const match of text.matchAll(regex)) {
        let start = match.index!, end = start + match[0].length;
        // Policy patterns may include bounding newlines, not the previous line.
        while (start < end && /[\r\n]/.test(text[start]!)) start++;
        while (end > start && /[\r\n]/.test(text[end - 1]!)) end--;
        // Existing private-key detection intentionally matches only its header.
        // Suppress its complete body/footer (or to EOF when unterminated), too.
        const header = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----/.exec(match[0]);
        if (header) {
          const footer = `-----END ${header[1]}-----`, at = text.indexOf(footer, end);
          end = at < 0 ? text.length : at + footer.length;
        }
        ranges.push([start, end]);
        if (ranges.length > MAX_MATCHES) return { source: source.kind, disposition: "withhold", content: LOCAL_CONTENT_REDACTED };
      }
    }
  } catch { return fail("LOCAL_CONTENT_POLICY"); }
  if (!ranges.length) return { source: source.kind, disposition: "allow", content: text };
  // Whole matching lines prevent a header-only/custom-regex match from leaving
  // its value visible. Retain line count so ordinary read offsets stay meaningful.
  ranges.sort((a, b) => a[0] - b[0]);
  let offset = 0, cursor = 0;
  const lines = text.split("\n").map(line => {
    const end = offset + line.length;
    while (cursor < ranges.length && ranges[cursor]![1] < offset) cursor++;
    const sensitive = cursor < ranges.length && ranges[cursor]![0] <= end && ranges[cursor]![1] >= offset;
    offset = end + 1;
    return sensitive ? LOCAL_CONTENT_REDACTED : line;
  });
  const content = lines.join("\n");
  if (Buffer.byteLength(content) > MAX_LOCAL_SECURITY_BYTES) return { source: source.kind, disposition: "withhold", content: LOCAL_CONTENT_REDACTED };
  return { source: source.kind, disposition: "redact", content };
}
