import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { capabilityToolSelected, checkSourceContent, hasModeResources, loadSensitivePatterns, ModeCapabilityError, modeResourcePath, readSelectedModeResource, SELECTED_RESOURCE_PREFIX, SourceContentSecurityError } from "@pa-platform/pa-core";
import { assertSameDocumentCaller, authenticatePiReadonlyDocumentCaller, type PiDocumentCaller } from "../document-session.js";
import { markSourceGuardResult } from "./source-guard-coverage.js";
import type { PiPreparationContext } from "./prepared-workflow.js";
import type { PiToolDefinition, PiToolResult } from "./index.js";

const deny = (): never => { throw new ModeCapabilityError("CAPABILITY_BINDING"); };
export function isSelectedResourceRead(input: Record<string, unknown>): boolean {
  return typeof input.path === "string" && input.path.startsWith(SELECTED_RESOURCE_PREFIX);
}
function contextIsValid(value: unknown): value is PiPreparationContext {
  return !!value && typeof value === "object" && "cwd" in value && typeof value.cwd === "string" && "mode" in value && value.mode === "tui"
    && "sessionManager" in value && !!value.sessionManager && typeof value.sessionManager === "object"
    && "getSessionId" in value.sessionManager && typeof value.sessionManager.getSessionId === "function";
}
function selection(expected: PiDocumentCaller, input: Record<string, unknown>, context: unknown) {
  if (!contextIsValid(context) || !isSelectedResourceRead(input) || typeof input.path !== "string") return deny();
  const caller = authenticatePiReadonlyDocumentCaller(context);
  // Ticket association can legitimately change during this same session; it
  // cannot replace its deployment, root, session or immutable resource policy.
  if (caller.deploymentId !== expected.deploymentId || caller.repoKey !== expected.repoKey || caller.repoRoot !== expected.repoRoot
    || caller.sessionId !== expected.sessionId || !isDeepStrictEqual(caller.capabilities, expected.capabilities) || !hasModeResources(caller.capabilities)) return deny();
  const binding = caller.capabilities;
  if (!capabilityToolSelected(binding.policy, "read")) throw new ModeCapabilityError("CAPABILITY_OMITTED");
  const path = modeResourcePath(input.path.slice(SELECTED_RESOURCE_PREFIX.length));
  if (!binding.resources.some(resource => resource.path === path)) throw new ModeCapabilityError("CAPABILITY_OMITTED");
  return { caller, binding, path, context };
}
/** Native tool-call guards can admit this exact URI without granting a filesystem
 * path exemption. It performs authentication/membership checks, not body reads. */
export function assertSelectedResourceRead(expected: PiDocumentCaller, input: Record<string, unknown>, context: unknown): void {
  selection(expected, input, context);
}
/** Wrap the already selected guarded/ordinary read implementation, not a new
 * capability. Parent composition must route selected-resource: through this
 * wrapper and its guard; all other inputs keep their existing read behavior. */
export function createSelectedResourceReadTool(caller: PiDocumentCaller, fallback: PiToolDefinition): PiToolDefinition {
  const expected = Object.freeze({ ...caller });
  return { ...fallback, name: "read",
    description: `${fallback.description} For immutable selected configuration references, use path=selected-resource:<exact listed relative path>. Reading reference bytes does not activate instructions, tools or additional resources. offset/limit are one-based lines; follow nextOffset in details for complete exact content.`,
    execute: async (id, input, signal, update, context): Promise<PiToolResult> => {
      if (!isSelectedResourceRead(input)) return fallback.execute(id, input, signal, update, context);
      try {
        const selected = selection(expected, input, context);
        if (Object.keys(input).some(key => !["path", "offset", "limit"].includes(key)) || signal?.aborted) return deny();
        const offset = input.offset ?? 1, limit = input.limit ?? 2000;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1 || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) return deny();
        const body = readSelectedModeResource(selected.binding, selected.path);
        let patterns;
        try { patterns = loadSensitivePatterns(); } catch { throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY"); }
        const checked = checkSourceContent({ source: { kind: "local-file", path: resolve(selected.binding.configRoot, selected.path) }, content: body }, patterns);
        // Exact-byte reference delivery cannot silently become a redacted projection.
        if (checked.disposition !== "allow") throw new SourceContentSecurityError("LOCAL_CONTENT_POLICY");
        const lines = body.split("\n");
        if (offset > lines.length) return deny();
        let end = offset - 1, bytes = 0;
        while (end < lines.length && end < offset - 1 + limit) {
          const lineBytes = Buffer.byteLength(lines[end]!) + (end < lines.length - 1 ? 1 : 0);
          if (bytes + lineBytes > 48 * 1024) break;
          bytes += lineBytes; end++;
        }
        if (end === offset - 1) throw new SourceContentSecurityError("LOCAL_CONTENT_LIMIT");
        const text = lines.slice(offset - 1, end).join("\n") + (end < lines.length ? "\n" : "");
        assertSameDocumentCaller(selected.caller, authenticatePiReadonlyDocumentCaller(selected.context));
        if (signal?.aborted) return deny();
        return markSourceGuardResult({ content: [{ type: "text", text }], details: { source: "selected-immutable-resource", status: "reference-only", path: selected.path,
          configRevision: selected.binding.configRevision, sha256: selected.binding.resources.find(r => r.path === selected.path)!.sha256,
          offset, lines: end - offset + 1, totalLines: lines.length, complete: offset === 1 && end === lines.length, nextOffset: end < lines.length ? end + 1 : null } });
      } catch (error) {
        const failure = error instanceof ModeCapabilityError || error instanceof SourceContentSecurityError ? error : new ModeCapabilityError("CAPABILITY_BINDING");
        return markSourceGuardResult({ isError: true, content: [{ type: "text", text: failure.message }], details: { code: failure.code, status: "not-read" } });
      }
    },
  };
}
