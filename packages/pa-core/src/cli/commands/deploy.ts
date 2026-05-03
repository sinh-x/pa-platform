import { DEFAULT_DEPLOY_TIMEOUT_SECONDS, MAX_DEPLOY_TIMEOUT_SECONDS, MIN_DEPLOY_TIMEOUT_SECONDS, validateDeployRequestFields, withResolvedDeployTimeout } from "../../deploy/index.js";
import type { CoreExecutionHooks, DeployRequest } from "../../deploy/index.js";
import { assertNoSensitiveMatch, readGuardedLocalTextFile } from "../../sensitive-patterns.js";
import { loadTeamConfig } from "../../teams/index.js";
import type { CliIo } from "../utils.js";

const STATUS_WAIT_OVERRIDE_ENV = "PA_STATUS_WAIT_TIMEOUT";

export function parseDeployArgs(argv: string[]): { fields: Record<string, unknown> } | { error: string } {
  const [team, ...rest] = argv;
  if (!team || team.startsWith("-")) return { error: "team is required" };
  const fields: Record<string, unknown> = { team };
  const flagMap: Record<string, keyof DeployRequest | "objectiveFile"> = { "--mode": "mode", "--objective": "objective", "--objective-file": "objectiveFile", "--repo": "repo", "--ticket": "ticket", "--timeout": "timeout", "--provider": "provider", "--model": "model", "--team-model": "teamModel", "--agent-model": "agentModel", "--resume": "resume" };
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

export function validateDeployConfig(team: string, io: Required<CliIo>): number {
  const config = loadTeamConfig(team);
  io.stdout(`Valid team config: ${config.name}`);
  io.stdout(`Agents: ${config.agents.length}`);
  io.stdout(`Modes: ${(config.deploy_modes ?? []).length}`);
  return 0;
}

export function printDeployHelp(io: Required<CliIo>): void {
  io.stdout("Usage: deploy <team> [options]");
  io.stdout("");
  io.stdout("Mode flags:");
  io.stdout("  --background        Run detached/headless");
  io.stdout("  --dry-run           Generate primer and plan without invoking opencode");
  io.stdout("  --list-modes        Print available deploy modes for the team");
  io.stdout("  --validate          Validate team config without deploying");
  io.stdout("");
  io.stdout("Deployment options:");
  io.stdout("  --mode <mode>       Deploy mode ID (required)");
  io.stdout("  --objective <text>  Inline objective override");
  io.stdout("  --objective-file <path>  Read objective from file");
  io.stdout("  --repo <path>       Override repository path");
  io.stdout("  --ticket <id>       Associate deployment with a ticket");
  io.stdout("  --timeout <seconds> Override deployment timeout");
  io.stdout("  --resume <id>       Resume a prior deployment");
  io.stdout("");
  io.stdout("Provider options:");
  io.stdout("  --provider <name>   Model provider (minimax, openai, deepseek)");
  io.stdout("  --model <name>      Override default model");
  io.stdout("  --team-model <name> Override team-level model");
  io.stdout("  --agent-model <name> Override agent-level model");
}

export async function runDeployCommand(argv: string[], io: Required<CliIo>, hooks: CoreExecutionHooks): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printDeployHelp(io);
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
  if (validated.request.objective) {
    try {
      assertNoSensitiveMatch("content", validated.request.objective);
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (validated.request.listModes) return printDeployModes(validated.request.team, io);
  if (validated.request.validate) return validateDeployConfig(validated.request.team, io);
  const resolved = withResolvedDeployTimeout(validated.request);
  if ("error" in resolved) {
    io.stderr(resolved.error);
    return 1;
  }
  if (!hooks.deploy) {
    io.stderr("Deployment execution requires an adapter hook");
    return 1;
  }

  const result = await hooks.deploy(resolved.request);
  if (result.status === "failed") {
    io.stderr(result.reason ?? "Deployment failed");
    return 1;
  }
  const label = result.status === "success" ? "completed" : "pending";
  io.stdout(`Deployment ${label}: ${result.deploymentId ?? "(adapter-managed)"}`);
  return 0;
}

export { STATUS_WAIT_OVERRIDE_ENV };
