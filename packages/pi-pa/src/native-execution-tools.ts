import { createBashTool, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { executionFailure, workflowError } from "@pa-platform/pa-core";
import type { PiNativeExecutionAdapter, NativeExecutionSession } from "./execution-native.js";
import type { PiRuntime, PiSessionLifecycle, PiToolDefinition, PiToolResult } from "./pi-extension/index.js";

function publicResult(result: unknown, session: NativeExecutionSession): PiToolResult {
  const value = JSON.parse(JSON.stringify(result), (_key, item: unknown) => typeof item === "string" ? session.publicText(item) : item) as PiToolResult;
  return { ...value, details: value.details ?? {} };
}
/** Install only after authenticated ordinary or consumed lineage is observed.
 * Independently admitted pre-migration bootstrap sessions retain actual built-ins.
 * Native tool_call records precede these lower SDK operation boundaries. */
export function registerNativeExecutionBuiltins(pi: PiRuntime, adapter: PiNativeExecutionAdapter, lifecycle?: PiSessionLifecycle): () => boolean {
  let installed = false;
  pi.on?.("session_start", (_event, context) => {
    if (installed) return;
    const session = adapter.resolve(context); if (!session) return;
    if (!pi.registerTool) throw executionFailure("EXECUTION_CAPABILITY_UNSUPPORTED");
    const cwd = session.contract.worktreeRoot;
    for (const name of ["bash", "write", "edit"] as const) {
      const template = name === "bash" ? createBashTool(cwd) : name === "write" ? createWriteTool(cwd) : createEditTool(cwd);
      pi.registerTool?.({
        name, label: template.label, description: template.description, parameters: template.parameters,
        executionMode: "sequential",
        execute: async (id, input, signal, update, ctx) => {
          const execute = async (): Promise<PiToolResult> => {
            const current = adapter.resolve(ctx); if (!current) throw workflowError();
            return current.execute(id, input, async (native) => {
              const tool = name === "write" ? createWriteTool(cwd, { operations: {
                writeFile: async (path, content) => { native.file(path, content); },
                mkdir: async (path) => { native.file(path, undefined, true); },
              } }) : name === "edit" ? createEditTool(cwd, { operations: {
                readFile: async (path) => native.file(path) as Buffer,
                writeFile: async (path, content) => { native.file(path, content); },
                access: async (path) => { native.file(path); },
              } }) : createBashTool(cwd, { exposeSessionEnvironment: false, operations: {
                exec: async (command, directory, options) => {
                  const result = await native.runBash(id, input, command, directory, options.timeout ?? 1200, options.signal);
                  // Keep channels separate in private evidence. Only the whole-
                  // buffer redacted reading stream reaches Pi/log/temp output.
                  const text = native.publicText(native.evidence.blob(result.stdout).toString("utf8") + native.evidence.blob(result.stderr).toString("utf8"));
                  options.onData(Buffer.from(text));
                  if (!result.groupSettled || result.timedOut || result.aborted || result.outputLimitExceeded) throw workflowError();
                  return { exitCode: result.exitCode };
                },
              } });
              // SDK AgentTool has four execution arguments; Pi's ToolDefinition
              // adds context. Adapt that API boundary, not a tool-supplied port.
              const invoke = tool.execute as unknown as PiToolDefinition["execute"];
              const result = await invoke(id, input, signal, update ? (partial) => update(publicResult(partial, native)) : undefined, ctx);
              return publicResult(result, native);
            });
          };
          try { return await (lifecycle ? lifecycle.trackRegistryAccess(execute) : execute()); }
          catch { throw workflowError(); }
        },
      });
    }
    installed = true;
  });
  return () => installed;
}
