import { access } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { createBashToolDefinition, createLocalBashOperations, createReadToolDefinition, detectSupportedImageMimeTypeFromFile, type BashOperations } from "@earendil-works/pi-coding-agent";
import { assertLocalFileSource, checkSourceContent, loadSensitivePatterns, MAX_LOCAL_SECURITY_BYTES, readArtifactFile, SourceContentSecurityError } from "@pa-platform/pa-core";
import { filterLocalToolResult, localContentFailure, safeLocalToolError } from "./local-content-security.js";
import { interceptToolCall } from "./safety.js";
import type { PiExtensionModule, PiToolDefinition, PiToolResult } from "./index.js";

/** Reuse Pi schemas, formatting, images and pagination. Only the local byte
 * ingress is changed: scan the complete file before any offset/limit selection. */
export function createSecureLocalReadTool(): PiToolDefinition {
  const base = createReadToolDefinition(process.cwd());
  return { ...base,
    description: `${base.description} Local source filename/path rules apply before access. Allowed local text is scanned before pagination; sensitive matching lines are redacted. Redacted content is a projection, not original bytes.`,
    execute: async (id: string, input: Record<string, unknown>, signal: AbortSignal | undefined, update: Parameters<PiToolDefinition["execute"]>[3], rawContext: unknown) => {
      try {
        const context = rawContext as { cwd: string }, patterns = loadSensitivePatterns();
        let projection: "allow" | "redact" | "withhold" = "allow", image = false;
        const guarded = createReadToolDefinition(context.cwd, { operations: {
          access: async path => { assertLocalFileSource(path, patterns); await access(path, constants.R_OK); },
          detectImageMimeType: async path => { assertLocalFileSource(path, patterns); const mime = await detectSupportedImageMimeTypeFromFile(path); image = !!mime; return mime; },
          readFile: async path => {
            assertLocalFileSource(path, patterns);
            // Existing artifact-file owner checks regular file/inode/alias and
            // size bounds. No raw body is sent to a hook, audit or temp spill.
            const physical = realpathSync(path);
            const bytes = readArtifactFile(physical, MAX_LOCAL_SECURITY_BYTES, "ARTIFACT_STALE");
            const checked = checkSourceContent({ source: { kind: "local-file", path }, content: bytes.toString("utf8") }, patterns);
            projection = checked.disposition;
            if (image && projection !== "allow") throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY");
            return image ? bytes : Buffer.from(checked.content);
          },
        } });
        const result = await guarded.execute(id, input as any, signal, update as any, rawContext as any) as unknown as PiToolResult;
        if (projection !== "allow") {
          result.content.push({ type: "text", text: "Local file content was redacted before pagination; displayed text and line ranges describe a security projection, not original bytes." });
          result.details = { ...result.details, paLocalContentSecurity: { source: "local-file", projection } };
        }
        return filterLocalToolResult("read", result, patterns);
      } catch (error) { return localContentFailure(error instanceof SourceContentSecurityError ? error : new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE")); }
    },
  } as unknown as PiToolDefinition;
}
/** Buffer local process bytes BEFORE Pi streaming/truncation/temp spill. Arbitrary
 * shell output has no authenticated remote-source exemption, even when it prints
 * JSON claiming source=public-web-response. This is not a shell/filesystem sandbox. */
export function createSecureLocalBashTool(backend: BashOperations = createLocalBashOperations()): PiToolDefinition {
  const base = createBashToolDefinition(process.cwd());
  return { ...base,
    description: `${base.description} Output is conservatively local and checked against sensitive-content rules before delivery or temp spill. Live text is delayed until completion; excessive/uncheckable output is withheld, not reported as an absent command effect.`,
    execute: async (id: string, input: Record<string, unknown>, signal: AbortSignal | undefined, update: Parameters<PiToolDefinition["execute"]>[3], rawContext: unknown) => {
      const safety = interceptToolCall({ toolName: "bash", input });
      if (!safety.allowed) throw safeLocalToolError("bash", new Error(safety.reason ?? "Shared shell safety did not admit this command."));
      let patterns;
      try { patterns = loadSensitivePatterns(); checkSourceContent({ source: { kind: "local-tool-output", tool: "bash" }, content: "" }, patterns); }
      catch (error) { return localContentFailure(error); }
      let withheld = false;
      const operations: BashOperations = { exec: async (command, cwd, options) => {
        let total = 0;
        const chunks: Buffer[] = [];
        const deliver = () => {
          if (withheld) { options.onData(Buffer.from("Local command output was withheld because its bounded security scan could not complete. The command may have changed state; inspect the original operation before retrying.\n")); return; }
          const checked = checkSourceContent({ source: { kind: "local-tool-output", tool: "bash" }, content: Buffer.concat(chunks).toString("utf8") }, patterns);
          options.onData(Buffer.from(checked.content));
          if (checked.disposition !== "allow") options.onData(Buffer.from("\nSensitive local output was redacted before streaming/truncation; this is a security projection.\n"));
        };
        let outcome;
        try {
          outcome = await backend.exec(command, cwd, { ...options, onData: data => {
            total += data.length;
            if (total > MAX_LOCAL_SECURITY_BYTES) { withheld = true; chunks.length = 0; }
            if (!withheld) chunks.push(Buffer.from(data));
          } });
        } catch (error) { deliver(); throw error; }
        deliver(); return outcome;
      } };
      const tool = createBashToolDefinition((rawContext as { cwd: string }).cwd, { operations });
      let result: PiToolResult;
      try { result = await tool.execute(id, input as any, signal, update as any, rawContext as any) as unknown as PiToolResult; }
      catch (error) { throw safeLocalToolError("bash", error); }
      if (withheld) { result.isError = true; result.details = { ...result.details, outputWithheld: true, effectState: "not-established" }; }
      return filterLocalToolResult("bash", result, patterns);
    },
  } as unknown as PiToolDefinition;
}
export const registerLocalSourceToolsModule: PiExtensionModule = pi => {
  pi.registerTool?.(createSecureLocalReadTool());
  pi.registerTool?.(createSecureLocalBashTool());
};
