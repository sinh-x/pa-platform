import { assertNoSensitiveMatch } from "../../sensitive-patterns.js";
import { withResolvedDeployTimeout } from "../../deploy/index.js";
import type { CoreExecutionHooks, DeployRequest } from "../../deploy/index.js";
import { runEvaluatorPass } from "../../evaluator/index.js";
import type { EvaluatorMetricName } from "../../types.js";
import type { CliIo } from "../utils.js";

const EVALUATOR_TEAM = "evaluator";
const EVALUATOR_MODE = "deployment-review";
const DEPLOYMENT_ID_PATTERN = /^d-[a-z0-9]{6}$/;

type EvaluateArgs =
  | { action: "launch"; request: DeployRequest }
  | { action: "record"; targetDeploymentId: string; evaluatorDeploymentId: string; reportPath?: string; overall?: number; metrics: Partial<Record<EvaluatorMetricName, number>> };

const METRIC_FLAGS: Record<string, EvaluatorMetricName> = {
  "--productivity": "productivity",
  "--quality": "quality",
  "--efficiency": "efficiency",
  "--insight": "insight",
  "--human-agency": "human_agency",
  "--evidence-grounding": "evidence_grounding",
  "--instruction-compliance": "instruction_compliance",
  "--user-fit": "user_fit",
  "--risk-handling": "risk_handling",
  "--outcome-integrity": "outcome_integrity",
};

export function parseEvaluateArgs(argv: string[]): EvaluateArgs | { error: string } {
  const request: DeployRequest = { team: EVALUATOR_TEAM, mode: EVALUATOR_MODE };
  let record = false;
  let evaluatorDeploymentId: string | undefined;
  let reportPath: string | undefined;
  let overall: number | undefined;
  const metrics: Partial<Record<EvaluatorMetricName, number>> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (DEPLOYMENT_ID_PATTERN.test(arg) && !request.evaluateDeployment) {
      request.evaluateDeployment = arg;
      continue;
    }
    if (arg === "--record") {
      record = true;
      continue;
    }
    if (arg === "--dry-run") {
      request.dryRun = true;
      continue;
    }
    if (arg === "--background") {
      request.background = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
    const metricName = METRIC_FLAGS[arg];
    if (metricName) {
      const score = Number(value);
      const scoreError = validateScore(score, arg);
      if (scoreError) return { error: scoreError };
      metrics[metricName] = score;
      i += 1;
      continue;
    }

    switch (arg) {
      case "--evaluate-deployment":
        if (request.evaluateDeployment) return { error: "evaluate target specified more than once" };
        request.evaluateDeployment = value;
        break;
      case "--evaluator-deployment":
        evaluatorDeploymentId = value;
        break;
      case "--report-path":
        reportPath = value;
        break;
      case "--overall": {
        const score = Number(value);
        const scoreError = validateScore(score, arg);
        if (scoreError) return { error: scoreError };
        overall = score;
        break;
      }
      case "--repo":
        request.repo = value;
        break;
      case "--ticket":
        request.ticket = value;
        break;
      case "--timeout":
        request.timeout = Number(value);
        break;
      case "--provider":
        request.provider = value;
        break;
      case "--model":
        request.model = value;
        break;
      case "--team-model":
        request.teamModel = value;
        break;
      case "--agent-model":
        request.agentModel = value;
        break;
      default:
        return { error: `Unsupported evaluate option: ${arg}` };
    }
    i += 1;
  }

  if (!request.evaluateDeployment) return { error: "evaluate requires --evaluate-deployment <deploy-id>" };
  if (!DEPLOYMENT_ID_PATTERN.test(request.evaluateDeployment)) return { error: "Invalid evaluate deployment id" };
  if (record) {
    const resolvedEvaluatorDeploymentId = evaluatorDeploymentId ?? process.env["PA_DEPLOYMENT_ID"];
    if (!resolvedEvaluatorDeploymentId) return { error: "--record requires --evaluator-deployment <deploy-id> or PA_DEPLOYMENT_ID" };
    if (!DEPLOYMENT_ID_PATTERN.test(resolvedEvaluatorDeploymentId)) return { error: "Invalid evaluator deployment id" };
    if (request.dryRun || request.background || request.repo || request.ticket || request.timeout !== undefined || request.provider || request.model || request.teamModel || request.agentModel) return { error: "--record only supports --evaluate-deployment, --evaluator-deployment, --report-path, and score flags" };
    return { action: "record", targetDeploymentId: request.evaluateDeployment, evaluatorDeploymentId: resolvedEvaluatorDeploymentId, reportPath, overall, metrics };
  }
  if (evaluatorDeploymentId || reportPath || overall !== undefined || Object.keys(metrics).length > 0) return { error: "--evaluator-deployment, --report-path, and score flags require --record" };
  if (request.repo && !isSafeRepoSpecifier(request.repo)) return { error: "Invalid repo name" };
  if (request.ticket && !/^[A-Z][A-Z0-9]+-[0-9]+$/.test(request.ticket)) return { error: "Invalid ticket ID" };
  if (request.timeout !== undefined && (!Number.isInteger(request.timeout) || request.timeout < 60 || request.timeout > 7200)) return { error: "timeout must be between 60 and 7200 seconds" };
  if (request.provider && !/^[a-zA-Z0-9_-]+$/.test(request.provider)) return { error: "Invalid provider name" };
  if (request.model && !/^[a-zA-Z0-9_.\/-]+$/.test(request.model)) return { error: "Invalid model name" };
  if (request.teamModel && !/^[a-zA-Z0-9_.\/-]+$/.test(request.teamModel)) return { error: "Invalid team model name" };
  if (request.agentModel && !/^[a-zA-Z0-9_.\/-]+$/.test(request.agentModel)) return { error: "Invalid agent model name" };
  if (request.dryRun && request.background) return { error: "--background and --dry-run are mutually exclusive" };

  return { action: "launch", request };
}

function validateScore(score: number, flag: string): string | undefined {
  if (!Number.isFinite(score) || score < 0 || score > 5) return `${flag} must be a number between 0 and 5`;
  return undefined;
}

function isSafeRepoSpecifier(value: string): boolean {
  if (/^[a-zA-Z0-9_-]+$/.test(value)) return true;
  if (value.includes("..")) return false;
  return /^(?:~\/|\/)[a-zA-Z0-9_./-]+$/.test(value);
}

export function printEvaluateHelp(io: Required<CliIo>): void {
  io.stdout("Usage: evaluate --evaluate-deployment <deploy-id> [options]");
  io.stdout("       evaluate <deploy-id> [options]");
  io.stdout("");
  io.stdout("Launches the dedicated evaluator team in deployment-review mode.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --evaluate-deployment <id>  Target completed deployment to evaluate (positional <deploy-id> is shorthand)");
  io.stdout("  --background                Run detached/headless");
  io.stdout("  --dry-run                   Generate evaluator primer without invoking opencode");
  io.stdout("  --ticket <id>               Associate evaluator run with a ticket");
  io.stdout("  --repo <path>               Repository context for memory docs");
  io.stdout("  --timeout <seconds>         Override evaluator deployment timeout");
  io.stdout("  --provider <name>           Model provider");
  io.stdout("  --model <name>              Override model");
  io.stdout("  --team-model <name>         Override team-level model");
  io.stdout("  --agent-model <name>        Override agent-level model");
  io.stdout("  --record                   Store evaluator result for the target deployment");
  io.stdout("  --evaluator-deployment <id> Evaluator deployment ID for --record (defaults to PA_DEPLOYMENT_ID)");
  io.stdout("  --report-path <path>        Evaluator report path for --record");
  io.stdout("  --overall <0-5>            Overall evaluator score for --record");
  io.stdout("  --human-agency <0-5>       Human Agency score for --record");
}

export async function runEvaluateCommand(argv: string[], io: Required<CliIo>, hooks: CoreExecutionHooks): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printEvaluateHelp(io);
    return 0;
  }

  const parsed = parseEvaluateArgs(argv);
  if ("error" in parsed) {
    io.stderr(parsed.error);
    return 1;
  }
  if (parsed.action === "record") {
    const result = runEvaluatorPass(parsed.targetDeploymentId, parsed.evaluatorDeploymentId, parsed.reportPath, { overall: parsed.overall, metrics: parsed.metrics });
    io.stdout(`Recorded evaluator result: ${result.evaluator_deployment_id} -> ${result.target_deployment_id}`);
    if (result.report_path) io.stdout(`Report: ${result.report_path}`);
    return 0;
  }
  try {
    assertNoSensitiveMatch("content", parsed.request.evaluateDeployment ?? "");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const resolved = withResolvedDeployTimeout(parsed.request);
  if ("error" in resolved) {
    io.stderr(resolved.error);
    return 1;
  }
  if (!hooks.deploy) {
    io.stderr("Evaluation deployment requires an adapter hook");
    return 1;
  }

  const result = await hooks.deploy(resolved.request);
  if (result.status === "failed") {
    io.stderr(result.reason ?? "Evaluation deployment failed");
    return 1;
  }
  const label = result.status === "success" ? "completed" : "pending";
  io.stdout(`Evaluation ${label}: ${result.deploymentId ?? "(adapter-managed)"}`);
  return 0;
}
