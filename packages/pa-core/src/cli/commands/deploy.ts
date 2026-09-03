import { DEFAULT_DEPLOY_TIMEOUT_SECONDS, MAX_DEPLOY_TIMEOUT_SECONDS, MIN_DEPLOY_TIMEOUT_SECONDS, validateDeployRequestFields, withResolvedDeployTimeout } from "../../deploy/index.js";
import type { CoreExecutionHooks, DeployRequest } from "../../deploy/index.js";
import { resolveRepoExecutionPath } from "../../repos.js";
import { assertNoSensitiveMatch, readGuardedLocalTextFile } from "../../sensitive-patterns.js";
import { loadTeamConfig, validateTeamSkillReferences } from "../../teams/index.js";
import type { CliIo } from "../utils.js";

const STATUS_WAIT_OVERRIDE_ENV = "PA_STATUS_WAIT_TIMEOUT";

export function parseDeployArgs(argv: string[]): { fields: Record<string, unknown> } | { error: string } {
  const [team, ...rest] = argv;
  if (!team || team.startsWith("-")) return { error: "team is required" };
  const fields: Record<string, unknown> = { team };
  const flagMap: Record<string, keyof DeployRequest | "objectiveFile"> = { "--mode": "mode", "--objective": "objective", "--objective-file": "objectiveFile", "--evaluate-deployment": "evaluateDeployment", "--repo": "repo", "--ticket": "ticket", "--timeout": "timeout", "--provider": "provider", "--model": "model", "--team-model": "teamModel", "--agent-model": "agentModel", "--resume": "resume", "--autonomy": "autonomy" };
  const booleanMap: Record<string, keyof DeployRequest> = { "--dry-run": "dryRun", "--background": "background", "--list-modes": "listModes", "--validate": "validate" };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    const booleanKey = booleanMap[arg];
    if (booleanKey) {
      fields[booleanKey] = true;
      continue;
    }
    const key = flagMap[arg];
    if (!key && (arg === "--interactive" || arg === "--direct")) return { error: `${arg} was removed. Foreground TUI is now the default; use --background for detached runs or --dry-run to preview.` };
    if (!key) return { error: `Unsupported deploy option: ${arg}` };
    const value = rest[i + 1];
    if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
    if (key === "objectiveFile") {
      try {
        fields.objective = readGuardedLocalTextFile(value);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    else fields[key] = key === "timeout" ? Number(value) : value;
    i += 1;
  }
  return { fields };
}

export function printDeployModes(team: string, io: Required<CliIo>): number {
  const config = loadTeamConfig(team);
  const modes = config.deploy_modes ?? [];
  if (modes.length === 0) {
    io.stdout(`No deploy modes configured for ${team}.`);
    return 0;
  }
  io.stdout(`Deploy modes for ${team}:`);
  for (const mode of modes) io.stdout(`  ${mode.id.padEnd(18)} ${mode.label}`);
  return 0;
}

export function validateDeployConfig(team: string, io: Required<CliIo>, binaryName = "opa"): number {
  const config = loadTeamConfig(team);
  const missingReferences = validateTeamSkillReferences().filter((reference) => reference.team === config.name);
  if (missingReferences.length > 0) {
    io.stderr(`Team config validation failed: ${missingReferences.length} missing referenced file(s) for ${config.name}.`);
    for (const reference of missingReferences) {
      io.stderr(`- ${reference.reference} (${reference.context}; ${reference.kind})`);
      io.stderr(`  attempted: ${reference.resolvedPath}`);
      io.stderr(`  team config: ${reference.teamConfigPath}`);
    }
    io.stderr(`Fix the missing path(s) or the team references, then rerun: opa deploy ${config.name} --validate`);
    return 1;
  }
  const modes = config.deploy_modes ?? [];
  const configuredPairs = modes.filter((mode) => mode.provider !== undefined && mode.model !== undefined).length;
  const defaultPairs = modes.length - configuredPairs;
  io.stdout(`Valid team config: ${config.name}`);
  io.stdout(`Agents: ${config.agents.length}`);
  io.stdout(`Modes: ${modes.length}`);
  io.stdout(`Provider/model pairs: valid (${configuredPairs} configured, ${defaultPairs} adapter-default)`);
  io.stdout(`When both fields are absent, ${deployHelpProfile(binaryName).defaultDescription}`);
  return 0;
}

interface DeployHelpProfile {
  runtime: string;
  providerDescription: string;
  modelDescription: string;
  defaultDescription: string;
}

function deployHelpProfile(binaryName: string): DeployHelpProfile {
  if (binaryName === "ppa") {
    return {
      runtime: "Pi",
      providerDescription: "Pi provider (`openai` or `openai-codex`; default command value: `openai-codex`)",
      modelDescription: "Pi model (default command value: `gpt-5.6-sol`; flat config uses `openai/gpt-5.6-sol`)",
      defaultDescription: "PPA uses OpenAI Sol (`openai-codex` / `gpt-5.6-sol`)",
    };
  }
  if (binaryName === "cpa") {
    return {
      runtime: "Claude Code",
      providerDescription: "Claude provider (`anthropic` only)",
      modelDescription: "Claude model",
      defaultDescription: "CPA uses `anthropic` / `claude-opus-4-7`",
    };
  }
  if (binaryName === "dpa") {
    return {
      runtime: "Droid",
      providerDescription: "Droid provider (adapter-specific)",
      modelDescription: "Droid model (default: `deepseek-v4-pro`)",
      defaultDescription: "DPA uses its documented adapter default (`deepseek-v4-pro` when unset)",
    };
  }
  return {
    runtime: "OpenCode",
    providerDescription: "Model provider (`minimax`, `openai`, `deepseek`, `ollama-cloud`, `opencode-go`; default: `ollama-cloud`)",
    modelDescription: "Override default model",
    defaultDescription: "OPA uses its provider-specific default (normally `ollama-cloud` / `ollama-cloud/deepseek-v4-pro`)",
  };
}

export function printDeployHelp(io: Required<CliIo>, binaryName = "opa"): void {
  const profile = deployHelpProfile(binaryName);
  io.stdout("Usage: deploy <team> [options]");
  io.stdout("");
  io.stdout("Mode flags:");
  io.stdout("  --background        Run detached/headless");
  io.stdout(`  --dry-run           Generate primer and plan without invoking ${profile.runtime}`);
  io.stdout("  --list-modes        Print available deploy modes for the team");
  io.stdout("  --validate          Validate team config without deploying");
  io.stdout("");
  io.stdout("Deployment options:");
  io.stdout("  --mode <mode>       Deploy mode ID (required)");
  io.stdout("  --objective <text>  Inline objective override");
  io.stdout("  --objective-file <path>  Read objective from file");
  io.stdout("  --evaluate-deployment <id>  Generate evaluator primer objective for a completed deployment");
  io.stdout("  --repo <key|path>   Registered repository key or exact configured path");
  io.stdout("                      Omit to infer the exact configured root from CWD");
  io.stdout("  --ticket <id>       Associate deployment with a ticket");
  io.stdout("  --timeout <seconds>    Override deployment timeout");
  io.stdout("  --resume <id>          Resume a prior deployment");
  io.stdout("  --autonomy <low|medium|high>  Override autonomy level (default: medium)");
  io.stdout("");
  io.stdout("Provider options:");
  io.stdout(`  --provider <name>      ${profile.providerDescription}`);
  io.stdout(`  --model <name>         ${profile.modelDescription}`);
  io.stdout("  --team-model <name>    Deprecated alias for --model; removal tracked by PAP-147");
  io.stdout("  --agent-model <name>   Rejected; per-agent overrides are tracked by PAP-148");
  io.stdout(`  Defaults:              ${profile.defaultDescription}`);
  io.stdout("  Config:                deploy_modes[].provider and deploy_modes[].model must both be present or both absent");
}

export async function runDeployCommand(argv: string[], io: Required<CliIo>, hooks: CoreExecutionHooks, binaryName = "opa"): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printDeployHelp(io, binaryName);
    return 0;
  }
  const parsed = parseDeployArgs(argv);
  if ("error" in parsed) {
    io.stderr(parsed.error);
    return 1;
  }
  const validated = validateDeployRequestFields(parsed.fields);
  if ("error" in validated) {
    io.stderr(validated.error);
    return 1;
  }
  if (validated.warnings) {
    for (const warning of validated.warnings) io.stderr(warning);
  }
  if (validated.request.objective) {
    try {
      assertNoSensitiveMatch("content", validated.request.objective);
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (validated.request.listModes) return printDeployModes(validated.request.team, io);
  if (validated.request.validate) return validateDeployConfig(validated.request.team, io, binaryName);
  const resolved = withResolvedDeployTimeout(validated.request);
  if ("error" in resolved) {
    io.stderr(resolved.error);
    return 1;
  }
  if (!hooks.deploy) {
    io.stderr("Deployment execution requires an adapter hook");
    return 1;
  }

  let repository: ReturnType<typeof resolveRepoExecutionPath>;
  try {
    repository = resolveRepoExecutionPath(resolved.request.repo);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const originalCwd = process.cwd();
  let result: Awaited<ReturnType<NonNullable<CoreExecutionHooks["deploy"]>>>;
  try {
    process.chdir(repository.repoRoot);
    result = await hooks.deploy({ ...resolved.request, repo: repository.repoRoot }, { stderr: io.stderr });
  } finally {
    process.chdir(originalCwd);
  }
  if (result.status === "failed") {
    io.stderr(result.reason ?? "Deployment failed");
    return 1;
  }
  const label = result.status === "success" ? "completed" : "pending";
  io.stdout(`Deployment ${label}: ${result.deploymentId ?? "(adapter-managed)"}`);
  return 0;
}

export { STATUS_WAIT_OVERRIDE_ENV };
