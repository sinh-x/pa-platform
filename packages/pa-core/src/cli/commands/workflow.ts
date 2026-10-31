import { workflowFailure, workflowReadService, type WorkflowReadHost } from "../../workflows/public.js";
import { JsonWorkflowError } from "../../workflows/contracts.js";
import type { CliIo } from "../utils.js";

/** Pi entry point only; no CLI decision writer or workflow enablement override exists. */
export function runWorkflowCommand(kind: "workflow" | "decision", argv: string[], io: Required<CliIo>, host: WorkflowReadHost = {}): number {
  const help = kind === "workflow"
    ? "Usage: ppa workflow list|show --id ID|validate --definition-file FILE|preflight|status|next --ticket TICKET [--json]"
    : "Usage: ppa decision show|verify --ticket TICKET --id ID [--json]";
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) { io.stdout(`${help}\nRead-only projections/static validation. Human capture/revocation require foreground native pa_decision; no actor/outcome/force/result override.`); return 0; }
  let json = false;
  try {
    const args = [...argv], action = args.shift();
    if (!(kind === "workflow" ? ["list", "show", "validate", "preflight", "status", "next"] : ["show", "verify"]).includes(action ?? "")) throw new JsonWorkflowError("WORKFLOW_CONTRACT");
    const request: Record<string, unknown> = { action: kind === "decision" ? `decision-${action}` : action };
    const seen = new Set<string>();
    while (args.length) {
      const flag = args.shift()!;
      if (seen.has(flag)) throw new JsonWorkflowError("WORKFLOW_CONTRACT"); seen.add(flag);
      if (flag === "--json") { json = true; continue; }
      if (!["--id", "--ticket", "--definition-file"].includes(flag) || !args.length || args[0]!.startsWith("--")) throw new JsonWorkflowError("WORKFLOW_CONTRACT");
      request[flag === "--definition-file" ? "definitionFile" : flag.slice(2)] = args.shift();
    }
    const result = workflowReadService(JSON.stringify(request), host);
    io.stdout(json ? JSON.stringify(result) : `# PA ${kind} (read-only)\n\n${JSON.stringify(result, null, 2)}`);
    return result.ok === true ? 0 : 1;
  } catch (error) { io.stdout(JSON.stringify(workflowFailure(error))); return 1; }
}
