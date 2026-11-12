import { checkSourceContent, loadSensitivePatterns, SourceContentSecurityError, type SensitivePatternSet } from "@pa-platform/pa-core";
import type { PiExtensionModule, PiToolResult } from "./index.js";

// Native implementation custody, not a source/contentPolicy string in JSON.
// The runtime passes the same content array into tool_result. A replacement by
// another extension loses this exemption and is checked as local output.
const nativePublicContent = new WeakSet<object>();
export function markNativePublicContent<T extends object>(content: T): T { nativePublicContent.add(content); return content; }
const projectionNotice = "Sensitive local content was redacted. This is a readable projection, not the original source bytes.";
export const localProgressResult = (): PiToolResult => ({ content: [{ type: "text", text: "Local tool output is being checked; details will be available after completion." }], details: {} });

export function localContentFailure(error: unknown): PiToolResult {
  const safe = error instanceof SourceContentSecurityError ? error : new SourceContentSecurityError("LOCAL_CONTENT_POLICY");
  return { content: [{ type: "text", text: safe.message }], details: { code: safe.code, outputWithheld: true, effectState: "not-established" }, isError: true };
}
/** Check presentation strings AND structured/rendering details. Never change an
 * owner's backing state, approval subject or original evidence bytes. */
export function filterLocalToolResult(tool: string, result: PiToolResult, suppliedPatterns?: SensitivePatternSet): PiToolResult {
  try {
    const publicContent = tool === "pa_web_read" && nativePublicContent.has(result.content);
    // The real public reader returns no local rendering/structured payload.
    // Do not reapply local content policy to that authenticated response body.
    if (publicContent && result.details && Object.keys(Object.getOwnPropertyDescriptors(result.details)).length === 0
      && !("structuredContent" in result)) return result;
    const patterns = suppliedPatterns ?? loadSensitivePatterns();
    let changed = false, nodes = 0;
    const seen = new Set<object>();
    const project = (value: string): string => checkSourceContent({ source: { kind: "local-tool-output", tool }, content: value }, patterns).content;
    const clean = (value: unknown, key?: string, depth = 0): unknown => {
      if (++nodes > 20_000 || depth > 64) throw new SourceContentSecurityError("LOCAL_CONTENT_LIMIT");
      if (typeof value === "string") {
        // Structured JSON keys are context too: a leaf may be a credential even
        // when it has no standalone token prefix. Preserve the key, not its value.
        if (key && project(value) === value && project(`${key} = ${value}`) !== `${key} = ${value}`) { changed = true; return "[REDACTED local sensitive value]"; }
        let text = project(value);
        if (text !== value) {
          // For machine-shaped native replies, retain safe fields and JSON syntax
          // rather than replacing quotes/keys inside a serialized object.
          try {
            const parsed: unknown = JSON.parse(value);
            if (parsed && typeof parsed === "object") {
              const structured = JSON.stringify(clean(parsed, undefined, depth + 1));
              text = project(structured) === structured ? structured : "[REDACTED local sensitive content]";
            }
          } catch { /* Ordinary file/shell text remains a marked projection. */ }
          changed = true;
        }
        return text;
      }
      if (typeof value === "number" && key && project(`${key} = ${value}`) !== `${key} = ${value}`) { changed = true; return "[REDACTED local sensitive value]"; }
      if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
      if (typeof value !== "object" || seen.has(value)) throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY");
      const proto = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY");
      seen.add(value);
      try {
        if (Array.isArray(value)) return value.map(item => clean(item, undefined, depth + 1));
        const out: Record<string, unknown> = Object.create(null);
        for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
          if (!("value" in descriptor)) throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY");
          const safeName = project(name) === name ? name : `redacted-field-${nodes}`;
          if (safeName !== name) changed = true;
          out[safeName] = clean(descriptor.value, name, depth + 1);
        }
        return out;
      } finally { seen.delete(value); }
    };
    const content = publicContent ? result.content : result.content.map(block => {
      const before = JSON.stringify(block), cleaned = clean(block) as typeof block;
      // Never ship a damaged attachment after modifying its encoded bytes.
      if (block.type !== "text" && JSON.stringify(cleaned) !== before) return { type: "text" as const, text: "Local attachment withheld by sensitive-content policy." };
      return cleaned;
    });
    if (!publicContent) {
      const texts = content.filter(block => block.type === "text").map(block => block.text);
      // A sensitive value split across content blocks must not evade the check.
      if (texts.length > 1 && [texts.join(""), texts.join("\n")].some(text => project(text) !== text)) {
        changed = true;
        for (let n = 0; n < content.length; n++) if (content[n]!.type === "text") content[n] = { type: "text", text: "[REDACTED local sensitive content]" };
      }
    }
    const details = clean(result.details) as Record<string, unknown>;
    const raw = result as PiToolResult & { structuredContent?: unknown };
    const structuredContent = raw.structuredContent === undefined ? undefined : clean(raw.structuredContent);
    const rest: Record<string, unknown> = Object.create(null);
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(result))) {
      if (["content", "details", "structuredContent"].includes(name)) continue;
      if (!("value" in descriptor)) throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY");
      rest[name] = clean(descriptor.value, name);
    }
    if (!changed) return result;
    return { ...rest, content: [...content, { type: "text", text: projectionNotice }],
      details: { ...details, paLocalContentSecurity: { source: "local", projection: "redacted" } },
      ...(raw.structuredContent === undefined ? {} : { structuredContent }) } as PiToolResult;
  } catch (error) { return localContentFailure(error); }
}
export function safeLocalToolError(tool: string, error: unknown): unknown {
  try {
    if (!(error instanceof Error)) return new Error(new SourceContentSecurityError("LOCAL_CONTENT_POLICY").message);
    const filtered = filterLocalToolResult(tool, { content: [{ type: "text", text: error.message }], details: {} });
    if (filtered.isError || filtered.content[0]?.text !== error.message) return new Error(filtered.content[0]?.text ?? new SourceContentSecurityError("LOCAL_CONTENT_POLICY").message);
    return error;
  } catch { return new Error(new SourceContentSecurityError("LOCAL_CONTENT_POLICY").message); }
}
/** Built-in and nested tool_result boundary. The registration wrapper also
 * protects direct custom calls; this hook must not throw and fall through raw. */
export const registerLocalContentResultModule: PiExtensionModule = pi => {
  pi.on?.("tool_result", raw => {
    const event = raw as PiToolResult & { toolName: string };
    const result = filterLocalToolResult(event.toolName, event);
    if (result === event) return;
    // Explicit content replacement also drops unfiltered structuredContent on
    // hosts that do not support its replacement field yet.
    return { content: result.content, details: result.details, isError: result.isError,
      structuredContent: (result as PiToolResult & { structuredContent?: unknown }).structuredContent };
  });
};
