import { createBashTool, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { executionFailure, workflowError } from "@pa-platform/pa-core";
import type { PiNativeExecutionAdapter, NativeExecutionSession } from "./execution-native.js";
import type { PiRuntime, PiSessionLifecycle, PiToolDefinition, PiToolResult } from "./pi-extension/index.js";
import { createPaTicketTool } from "./pi-extension/ticket-tool.js";

function administrativeText(text: string, session: NativeExecutionSession): string {
  const safe = session.publicText(text); const lines = safe.split("\n");
  if (Buffer.byteLength(safe) <= 50 * 1024 && lines.length <= 2000) return safe;
  return Buffer.from(lines.slice(0, 1998).join("\n")).subarray(0, 50 * 1024 - 128).toString("utf8") + "\n[Truncated administrative output; original retained in private evidence.]";
}

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
    const ticket = createPaTicketTool();
    pi.registerTool({
      ...ticket, executionMode: "sequential",
      execute: async (id, input, signal, update, ctx) => {
        if (signal?.aborted) throw workflowError();
        if (["read", "show", "list"].includes(String(input.action))) return ticket.execute(id, input, signal, update, ctx);
        const execute = async () => {
          const current = adapter.resolve(ctx); if (!current) throw workflowError();
          const result = await current.executeAdministration(id, { toolName: "pa_ticket", input }, ctx, () => ticket.execute(id, input, signal, update, ctx));
          return publicResult(result, current);
        };
        try { return await (lifecycle ? lifecycle.trackRegistryAccess(execute) : execute()); }
        catch { throw workflowError(); }
      },
    });
    for (const name of ["bash", "write", "edit"] as const) {
      const template = name === "bash" ? createBashTool(cwd) : name === "write" ? createWriteTool(cwd) : createEditTool(cwd);
      pi.registerTool?.({
        name, label: template.label,
        description: template.description + (name === "bash"
          ? " Before a source plan, authenticated PA reads admit only pwd; git rev-parse --show-toplevel or HEAD; git branch --show-current; git remote -v; git status, git status --short, or git status --porcelain=v2 -z --untracked-files=all; git log -n 5 --oneline; ppa bulletin list; ppa repos list; own ticket/status reads; date or date -u. A preflight may join only fixed Git/pwd/root observations and ppa repos list with ; or &&; no arbitrary shell, environment dump or project checks. For paths use printenv PA_REPO PA_WORKTREE_ROOT PA_MODE. Own foreground registry complete admits only partial/failed, a summary, an optional existing private own --log-file, and agent integer0..5 ratings; not success, user/system ratings or fallback."
          : name === "write" ? ` Before a source plan, only an ABSOLUTE private new self log under the AI usage sessions/YYYY/MM/agent-team directory is additionally allowed: YYYY-MM-DD-${session.actor.deploymentId}-builder--builder-agent--${session.contract.ticket}--<slug>.md (or team-manager). Maximum512KiB; mode0600, atomic no-clobber creation or byte-identical retry, never overwrite/edit or external source writes. Completion --log-file may reference this log.` : ""),
        parameters: template.parameters,
        executionMode: "sequential",
        execute: async (id, input, signal, update, ctx) => {
          const execute = async (): Promise<PiToolResult> => {
            if (signal?.aborted) throw workflowError();
            const current = adapter.resolve(ctx); if (!current) throw workflowError();
            if ((name === "bash" || name === "write") && current.administration({ toolName: name, input }, ctx)) {
              const result = await current.runAdministration(id, input, ctx, name);
              if (result.exitCode !== 0) throw workflowError();
              return { content: [{ type: "text", text: administrativeText(result.text, current) }], details: { exitCode: result.exitCode } };
            }
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
