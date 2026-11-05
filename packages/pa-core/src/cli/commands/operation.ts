import { executeOperation, operationFailure, OPERATION_TOOL_DESCRIPTION, type AdvisoryOperationHost } from "../../operations/service.js";
import { operationExitCode, OPERATION_RESULT_VERSION, serializeOperationResult } from "../../operations/result.js";
import type { CliIo } from "../utils.js";

export async function runOperationCommand(argv: string[], io: Required<CliIo>, runtime: "pi" | "opencode", host: AdvisoryOperationHost | null = null): Promise<number> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    io.stdout(`Usage: operation capabilities --format ${OPERATION_RESULT_VERSION}\n       operation run --command <shell-command> [--timeout <seconds>] --format ${OPERATION_RESULT_VERSION}\n${OPERATION_TOOL_DESCRIPTION}\nCLI exits: 0 passed/warning; 1 failed check; 2 error/unavailable/unknown; 3 security denial; 124 timeout; 130 cancellation. Actual child exit/signal is separate. Legacy commands/formats are unchanged.`);
    return 0;
  }
  let request: string;
  try {
    const [action, ...args] = argv;
    const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1];
      if (!["--command", "--timeout", "--format"].includes(key) || value === undefined || values.has(key)) throw new Error();
      values.set(key, value);
    }
    if (values.get("--format") !== OPERATION_RESULT_VERSION) throw new Error();
    if (action === "capabilities" && values.size === 1) request = JSON.stringify({ action });
    else if (action === "run" && values.has("--command")) request = JSON.stringify({ action, command: values.get("--command"), ...(values.has("--timeout") ? { timeoutSeconds: Number(values.get("--timeout")) } : {}) });
    else throw new Error();
  } catch { const failure = operationFailure("OPERATION_INPUT_INVALID"); io.stdout(serializeOperationResult(failure)); return operationExitCode(failure); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    const result = await executeOperation(request, runtime, host, controller.signal);
    io.stdout(serializeOperationResult(result)); return operationExitCode(result);
  } catch { const failure = operationFailure("OPERATION_INVOCATION_ERROR"); io.stdout(serializeOperationResult(failure)); return operationExitCode(failure); }
  finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}
