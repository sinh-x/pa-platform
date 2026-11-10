import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeAdvisoryFile, executeOperation, operationExitCode, operationFailure, readAdvisoryStart, resolveAdvisoryOperationHost, type AdvisoryOperationHost } from "@pa-platform/pa-core";
import { operationAsPiResult } from "./operation-tool.js";
import type { PiExtensionModule, PiToolDefinition } from "./index.js";
import { createPaCapabilitiesTool } from "./capability-tool.js";

/** Version dispatch is native registry-owned. Retained built-ins/controllers
 * are not re-registered, reset or translated. All new effects use local custody. */
export const registerAdvisoryModule: PiExtensionModule = (pi, lifecycle) => {
  let installed = false;
  const marked = () => Boolean(process.env.PA_DEPLOYMENT_ID && readAdvisoryStart(process.env.PA_DEPLOYMENT_ID));
  const resolve = (context: unknown): AdvisoryOperationHost => {
    const host = resolveAdvisoryOperationHost("pi", (context as { cwd?: string } | null)?.cwd ?? process.cwd());
    if (!host) throw new Error("OPERATION_SESSION_UNAVAILABLE"); return host;
  };
  pi.on?.("session_start", (_event, context) => {
    if (installed || !marked()) return;
    const host = resolve(context);
    if (!pi.registerTool) throw new Error("OPERATION_CAPABILITY_UNAVAILABLE");
    pi.registerTool({ name: "bash", label: "Bash", description: "Execute a bounded safe shell command in the authenticated checkout. Failure is factual data; inspect/repair/recheck under PAPC policy. No catalogue, phase plan or prescribed command order. Protected operations and conflicting/uncertain writers remain denied.",
      parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: 14400 })) }, { additionalProperties: false }), executionMode: "sequential",
      execute: async (_id, input, signal, _update, ctx) => {
        const run = async () => operationAsPiResult(await executeOperation(JSON.stringify({ action: "run", command: input.command, ...(input.timeout !== undefined ? { timeoutSeconds: input.timeout } : {}) }), "pi", resolve(ctx), signal));
        try { return await (lifecycle ? lifecycle.trackRegistryAccess(run) : run()); } catch { return operationAsPiResult(operationFailure("OPERATION_INVOCATION_ERROR")); }
      },
    });
    for (const kind of ["write", "edit"] as const) {
      const template = kind === "write" ? createWriteTool(host.cwd) : createEditTool(host.cwd);
      pi.registerTool({ name: kind, label: template.label, description: `${template.description} Native checkout-local atomic file safety and live-writer exclusion remain active. No phase plan, package or catalogue is required.`,
        parameters: template.parameters, executionMode: "sequential",
        execute: async (id, input, signal, _update, ctx) => {
          const run = async () => {
            const current = resolve(ctx);
            const result = await executeAdvisoryFile(current, kind, input, async files => {
              const tool = kind === "write" ? createWriteTool(current.cwd, { operations: { writeFile: async (path, content) => { files.file(path, content); }, mkdir: async path => { files.file(path, undefined, true); } } })
                : createEditTool(current.cwd, { operations: { readFile: async path => files.file(path) as Buffer, writeFile: async (path, content) => { files.file(path, content); }, access: async path => { files.file(path); } } });
              return (tool.execute as unknown as PiToolDefinition["execute"])(id, input, signal, undefined, ctx);
            }, signal);
            return operationAsPiResult(result);
          };
          try { return await (lifecycle ? lifecycle.trackRegistryAccess(run) : run()); } catch { return operationAsPiResult(operationFailure("OPERATION_INVOCATION_ERROR")); }
        },
      });
    }
    // Additive source metadata only. Retained/unmarked starts keep their old
    // registrations; this does not select expanded ticket-write permissions.
    const capabilities = createPaCapabilitiesTool(ctx => { if (!marked()) return false; resolve(ctx); return true; });
    pi.registerTool({ ...capabilities, execute: (...args) => lifecycle
      ? lifecycle.trackRegistryAccess(() => capabilities.execute(...args)) : capabilities.execute(...args) });
    installed = true;
  });
  pi.on?.("tool_call", raw => {
    if (!marked()) return;
    const call = raw as { toolName?: string; name?: string };
    const name = (call.toolName ?? call.name ?? "").replace(/^functions\./, "");
    // Known observations and existing PA effect owners stay available even when
    // a source operation is uncertain. Unknown mutation surfaces do not inherit
    // untracked writer rights merely because they are custom tools.
    if (["read", "grep", "find", "ls", "question", "todo"].includes(name) || name.startsWith("pa_")) return;
    if (["bash", "write", "edit"].includes(name) && installed) return;
    return { block: true, reason: "OPERATION_CAPABILITY_UNAVAILABLE: no authenticated local effect boundary for this tool; independent safe diagnosis remains available." };
  });
  pi.on?.("user_bash", async (raw, context) => {
    if (!marked()) return;
    const event = raw as { command?: string };
    const result = await executeOperation(JSON.stringify({ action: "run", command: event.command }), "pi", resolve(context));
    return { result: { output: result.output.text, exitCode: result.process?.exitCode ?? operationExitCode(result), cancelled: result.completion === "cancelled", truncated: result.output.truncated } };
  });
};
