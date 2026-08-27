import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { modelMatchesProvider, parseTeamYamlContent, validateTeamSkillReferences } from "../../packages/pa-core/src/index.js";

export interface PairedValidationOptions {
  configRoot: string;
  expectedSha: string;
  requireOriginDevelop?: boolean;
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`pa-platform-config must be a Git checkout: ${root}`);
  }
}

export function validatePairedRepository(options: PairedValidationOptions): string[] {
  const configRoot = resolve(options.configRoot);
  const expectedSha = options.expectedSha.trim();
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("Expected pa-platform-config SHA must be a full 40-character commit id");
  const actualSha = git(configRoot, ["rev-parse", "HEAD"]);
  if (actualSha !== expectedSha) throw new Error(`pa-platform-config HEAD mismatch: expected ${expectedSha}, found ${actualSha}`);
  const status = git(configRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error(`pa-platform-config checkout must be clean:\n${status}`);
  if (options.requireOriginDevelop) {
    const result = spawnSync("git", ["-C", configRoot, "merge-base", "--is-ancestor", expectedSha, "origin/develop"], { stdio: "ignore" });
    if (result.status !== 0) throw new Error(`pa-platform-config ${expectedSha} is not contained in origin/develop; merge the config prerequisite first`);
  }

  const teamFiles = readdirSync(resolve(configRoot, "teams"))
    .filter((name) => name.endsWith(".yaml") && name !== "example.yaml")
    .sort();
  const teamNames = new Set<string>();
  let modeCount = 0;
  for (const file of teamFiles) {
    const team = parseTeamYamlContent(readFileSync(resolve(configRoot, "teams", file), "utf8"));
    if (!team.name || teamNames.has(team.name)) throw new Error(`teams/${file}: team name must be non-empty and unique`);
    teamNames.add(team.name);
    const modeIds = new Set<string>();
    for (const mode of team.deploy_modes ?? []) {
      if (!mode.id || modeIds.has(mode.id)) throw new Error(`teams/${file}: mode id must be non-empty and unique`);
      modeIds.add(mode.id);
      if (!mode.provider || !mode.model) throw new Error(`teams/${file}: mode ${mode.id} must define a complete provider/model pair`);
      const namespace = mode.provider === "minimax" ? "minimax-coding-plan" : mode.provider;
      if (!modelMatchesProvider(mode.model, [namespace])) throw new Error(`teams/${file}: mode ${mode.id} model namespace does not match provider ${mode.provider}`);
      modeCount += 1;
    }
    if (team.default_mode && !modeIds.has(team.default_mode)) throw new Error(`teams/${file}: default_mode ${team.default_mode} does not exist`);
  }
  if (teamFiles.length !== 9) throw new Error(`Expected 9 active teams, found ${teamFiles.length}`);
  if (modeCount !== 58) throw new Error(`Expected 58 active modes, found ${modeCount}`);
  const missing = validateTeamSkillReferences(resolve(configRoot, "teams"), configRoot, resolve(configRoot, "skills", "global"));
  if (missing.length > 0) throw new Error(`Found ${missing.length} missing team references`);

  return [
    `CONFIG_SHA=${actualSha}`,
    "CONFIG_CLEAN=true",
    `TEAMS_VALID=${teamFiles.length}/9`,
    `MODES_VALID=${modeCount}/58`,
    "LEGACY_RUNTIMES=0",
    "INVALID_PAIRS=0",
    "REFERENCES_MISSING=0",
  ];
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
  if (!configRoot) throw new Error("PA_PHASE5_CONFIG_ROOT is required");
  const expectedSha = readFileSync(resolve(process.cwd(), ".pa-platform-config.sha"), "utf8").trim();
  for (const line of validatePairedRepository({ configRoot, expectedSha, requireOriginDevelop: process.argv.includes("--require-origin-develop") })) console.log(line);
}
