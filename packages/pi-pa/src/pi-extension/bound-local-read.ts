import { checkSourceContent, loadSensitivePatterns, SourceContentSecurityError, type LocalSourceFile, type SensitivePatternSet } from "@pa-platform/pa-core";
import { detectAdmittedImageMimeType } from "./local-image-type.js";
import { admitLocalReadPaths } from "./local-read-paths.js";
import { filterLocalToolResult, localContentFailure } from "./local-content-security.js";
import type { PiToolDefinition, PiToolResult } from "./index.js";

/** Native implementation composition, never a root/grant accepted in tool JSON,
 * environment or configuration. The ordinary public constructor fixes its own
 * single-link acquirer. A selected host must construct its private acquirer only
 * after establishing build/execution custody; this factory is not that proof. */
export function bindLocalReadTool(
  createDefinition: typeof import("@earendil-works/pi-coding-agent").createReadToolDefinition,
  acquireSource: (path: string, patterns: SensitivePatternSet, signal?: AbortSignal) => LocalSourceFile,
): PiToolDefinition {
  const base = createDefinition(process.cwd());
  return { ...base,
    description: `${base.description} Local source filename/path rules apply before access. Allowed local text is scanned before pagination; sensitive matching lines are redacted. Redacted content is a projection, not original bytes.`,
    execute: async (id: string, input: Record<string, unknown>, signal: AbortSignal | undefined, update: Parameters<PiToolDefinition["execute"]>[3], rawContext: unknown) => {
      let source: LocalSourceFile | undefined;
      try {
        try {
          const context = rawContext as { cwd: string };
          let patterns: SensitivePatternSet;
          try { patterns = loadSensitivePatterns(); }
          catch { throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY"); }
          if (signal?.aborted) throw new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE");
          const admittedPaths = admitLocalReadPaths(input.path, context.cwd, patterns);
          let projection: "allow" | "redact" | "withhold" = "allow";
          let prepared: { path: string; mime: string | null; bytes: Buffer } | undefined;
          const prepare = (path: string) => {
            if (!admittedPaths.has(path)) throw new SourceContentSecurityError("CONTENT_SOURCE_INVALID");
            if (prepared) {
              if (prepared.path !== path) throw new SourceContentSecurityError("CONTENT_SOURCE_INVALID");
              source!.assertStable();
              return prepared;
            }
            source = acquireSource(path, patterns, signal);
            const checked = checkSourceContent({ source: { kind: "local-file", path }, content: source.bytes.toString("utf8") }, patterns);
            projection = checked.disposition;
            const mime = detectAdmittedImageMimeType(source.bytes);
            if (mime && projection !== "allow") throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY");
            prepared = { path, mime, bytes: mime ? source.bytes : Buffer.from(checked.content) };
            return prepared;
          };
          const guarded = createDefinition(context.cwd, { operations: {
            access: async path => { prepare(path); },
            detectImageMimeType: async path => prepare(path).mime,
            readFile: async path => prepare(path).bytes,
          } });
          const result = await guarded.execute(id, input as any, signal, update as any, rawContext as any) as unknown as PiToolResult;
          if (projection !== "allow") {
            result.content.push({ type: "text", text: "Local file content was redacted before pagination; displayed text and line ranges describe a security projection, not original bytes." });
            result.details = { ...result.details, paLocalContentSecurity: { source: "local-file", projection } };
          }
          const filtered = filterLocalToolResult("read", result, patterns);
          source?.assertStable();
          if (signal?.aborted) throw new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE");
          return filtered;
        } finally { source?.close(); }
      } catch (error) { return localContentFailure(error instanceof SourceContentSecurityError ? error : new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE")); }
    },
  } as unknown as PiToolDefinition;
}
