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
/** Bounded observations from native read owners, never raw errno/exception text. */
const localSourceFailureReasons = {
  "source-open": "The source could not be opened or its path resolved. Its existence and readable state are not established; no content is delivered.",
  "source-stat": "Required source or directory metadata could not be inspected. A stable source association is not established; no content is delivered.",
  "source-read": "The pinned source read did not complete. No partial or unexamined content is delivered.",
  "source-changed": "The source identity, metadata, path association or complete byte count did not remain stable. No content is delivered.",
  "source-close": "The owned source descriptors could not all be released successfully. Content is withheld after the cleanup failure.",
  "cancelled": "The read was cancelled or its owning lifetime ended before delivery. No unpublished content is delivered.",
  "unsupported-platform": "The descriptor-pinned local reader is unavailable on this platform. No content is delivered.",
  "read-range": "The requested starting line is beyond the completely checked text projection. Source acquisition succeeded, but this range has no content; this is not evidence of a missing source or policy denial.",
  "read-processing": "The read tool could not resolve, format or paginate the request. The underlying cause is unproven; this is not an established source-stability or policy failure.",
  "read-publication": "The runtime could not establish current read-result custody at delivery. Source, host or result association may have changed; the exact cause is unproven and content is withheld.",
} as const;
export type LocalSourceFailureClass = keyof typeof localSourceFailureReasons;
export class SourceContentSecurityError extends Error {
  readonly failureClass?: LocalSourceFailureClass;
  constructor(readonly code: SourceContentCode, failureClass?: LocalSourceFailureClass) {
    const reasons: Record<SourceContentCode, string> = {
      LOCAL_SOURCE_UNAVAILABLE: "A complete stable local read could not be established; the source may be absent or changed, or the read interrupted. No unexamined content is delivered.",
      LOCAL_SOURCE_UNSUPPORTED_FILE: "The source is not a supported regular file or qualified selected-Pi document. Ordinary reads require a regular file with exactly one link. Multi-link text is limited to finite selected-Pi documentation with its native selected-host binding and immutable-file checks. No content is delivered.",
      LOCAL_SOURCE_BLOCKED: "The local source matches protected-path or configured filename/path rules. Content redaction does not authorize reading it.",
      LOCAL_CONTENT_LIMIT: "The complete local content exceeds the bounded security scan. No unexamined text is returned.",
      LOCAL_CONTENT_POLICY: "The local sensitive-content policy could not be evaluated. Raw content is withheld, not allowed by default.",
      CONTENT_SOURCE_INVALID: "The implementation did not establish a supported source and content pair. Caller-supplied origin labels are not exemptions.",
    };
    const observed = code === "LOCAL_SOURCE_UNAVAILABLE" && typeof failureClass === "string"
      && Object.hasOwn(localSourceFailureReasons, failureClass) ? failureClass : undefined;
    const range = observed === "read-range";
    const correction = range
      ? "Request an earlier starting line through the same guarded reader. Impact: read-only. Actor: agent or operator. New approval: not required for an already permitted read. Prerequisite: existing source access; do not use an alternate reader to bypass safeguards."
      : "Ask the security/runtime owner to inspect the source classification and configured rules. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs need their owner. Prerequisite: preserve source and original operation coordinates without copying sensitive bytes or bypassing the denial.";
    const resume = range
      ? "Request a valid line range; source admission, stability and complete content checks run again. No source or policy change is needed solely to correct the range."
      : "Retry only after the owner establishes permitted source access and a working policy. If the underlying tool may already have changed state, inspect that same operation first; withholding output is not proof that its effect was absent.";
    super(`${range ? "The requested lines were not returned." : "Local content is unavailable through this check."}\nCondition: The requested local content cannot be delivered.\nSource: Source-aware local content security (${code}${observed ? `; ${observed}` : ""}).\nReason: ${observed ? localSourceFailureReasons[observed] : reasons[code]}\nCorrection: ${correction}\nResume Action: ${resume}`);
    this.failureClass = observed;
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
