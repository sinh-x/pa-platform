import { createBashToolDefinition, createLocalBashOperations, createReadToolDefinition, type BashOperations } from "@earendil-works/pi-coding-agent";
import { acquireLocalSourceFile, checkSourceContent, loadSensitivePatterns, MAX_LOCAL_SECURITY_BYTES } from "@pa-platform/pa-core";
import { bindLocalReadTool } from "./bound-local-read.js";
import { filterLocalToolResult, localContentFailure, safeLocalToolError } from "./local-content-security.js";
import { interceptToolCall } from "./safety.js";
import type { PiExtensionModule, PiToolDefinition, PiToolResult } from "./index.js";

/** Reuse Pi schemas, formatting, images and pagination. Only the local byte
 * ingress is changed: scan the complete file before any offset/limit selection. */
export function createSecureLocalReadTool(): PiToolDefinition {
  return bindLocalReadTool(createReadToolDefinition, acquireLocalSourceFile);
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
