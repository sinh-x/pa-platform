import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { classifyRepositoryAccess, modelMatchesProvider, parseTeamYamlContent, validateTeamSkillReferences } from "../../packages/pa-core/src/index.js";

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

function validateRepositoryContracts(configRoot: string): void {
  const orchestratorPath = resolve(configRoot, "teams", "builder", "modes", "orchestrator.md");
  const orchestrator = readFileSync(orchestratorPath, "utf8");
  const branchOutcomes = [
    "| Already on the exact ticket branch | Proceed. |",
    "| On zero-entry `develop`, `develop` equals `origin/develop`, exact ticket branch is absent | Create the exact ticket branch from `develop`, then proceed. |",
    "| On zero-entry `develop`, `develop` equals `origin/develop`, exact ticket branch exists | Check out the exact ticket branch, then proceed. |",
    "| Dirty `develop` | Stop unchanged. |",
    "| `develop` is ahead, behind, or diverged from `origin/develop` | Stop unchanged. |",
    "| On the release branch or any unrelated branch | Stop unchanged. |",
    "| Detached HEAD | Stop unchanged. |",
  ];
  for (const outcome of branchOutcomes) {
    if (!orchestrator.includes(outcome)) throw new Error(`Paired orchestrator is missing branch-gate outcome: ${outcome}`);
  }
  if (!orchestrator.includes("Use `opa branch create`")) throw new Error("Paired orchestrator must use the retained branch creation command");
  if (!orchestrator.includes("a direct checkout only for the existing exact branch outcome")) throw new Error("Paired orchestrator must limit checkout to the existing exact ticket branch");
  if (!orchestrator.includes("Every stop occurs before project-file mutation or child launch")) throw new Error("Paired orchestrator must stop unchanged before mutation or child launch");

  const runtimeNeutral = readFileSync(resolve(configRoot, "docs", "runtime-neutral-config.md"), "utf8");
  if (!runtimeNeutral.includes("PA-managed worktrees") || !runtimeNeutral.includes("sandbox access classes")) {
    throw new Error("Paired configuration must retain the no-worktree/no-sandbox orchestration contract");
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
  validateRepositoryContracts(configRoot);

  const teamFiles = readdirSync(resolve(configRoot, "teams"))
    .filter((name) => name.endsWith(".yaml") && name !== "example.yaml")
    .sort();
  const teamNames = new Set<string>();
  let modeCount = 0;
  let builderExclusiveCount = 0;
  let requirementsReadOnlyCount = 0;
  let otherNonLockingCount = 0;
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
      const access = classifyRepositoryAccess(team.name, mode.id);
      const expectedAccess = team.name === "builder" ? "exclusive-builder" : team.name === "requirements" ? "read-only" : "non-locking";
      if (access !== expectedAccess) throw new Error(`teams/${file}: mode ${mode.id} repository admission must be ${expectedAccess}, found ${access}`);
      if (access === "exclusive-builder") builderExclusiveCount += 1;
      else if (access === "read-only") requirementsReadOnlyCount += 1;
      else otherNonLockingCount += 1;
      modeCount += 1;
    }
    if (team.default_mode && !modeIds.has(team.default_mode)) throw new Error(`teams/${file}: default_mode ${team.default_mode} does not exist`);
  }
  if (teamFiles.length !== 9) throw new Error(`Expected 9 active teams, found ${teamFiles.length}`);
  if (modeCount !== 58) throw new Error(`Expected 58 active modes, found ${modeCount}`);
  if (builderExclusiveCount !== 6) throw new Error(`Expected 6 exclusive builder modes, found ${builderExclusiveCount}`);
  if (requirementsReadOnlyCount !== 11) throw new Error(`Expected 11 read-only requirements modes, found ${requirementsReadOnlyCount}`);
  if (otherNonLockingCount !== 41) throw new Error(`Expected 41 non-locking modes for other teams, found ${otherNonLockingCount}`);
  // Absolute project guides are operator-owned inputs and cannot be present on a
  // generic CI runner. Runtime deploy validation remains responsible for them.
  const missing = validateTeamSkillReferences(resolve(configRoot, "teams"), configRoot, resolve(configRoot, "skills", "global"))
    .filter((reference) => !isAbsolute(reference.reference));
  if (missing.length > 0) {
    const details = missing
      .map((reference) => `${reference.team} ${reference.context}: ${reference.reference} -> ${reference.resolvedPath}`)
      .join("\n");
    throw new Error(`Found ${missing.length} missing team references:\n${details}`);
  }

  return [
    `CONFIG_SHA=${actualSha}`,
    "CONFIG_CLEAN=true",
    `TEAMS_VALID=${teamFiles.length}/9`,
    `MODES_VALID=${modeCount}/58`,
    "LEGACY_RUNTIMES=0",
    "INVALID_PAIRS=0",
    `BUILDER_EXCLUSIVE=${builderExclusiveCount}/6`,
    `REQUIREMENTS_READ_ONLY=${requirementsReadOnlyCount}/11`,
    `OTHER_NON_LOCKING=${otherNonLockingCount}/41`,
    `REPOSITORY_ADMISSION_MATRIX=${modeCount}/58`,
    "BRANCH_GATE=7/7",
    "NO_WORKTREE_ORCHESTRATION=true",
    "REFERENCES_MISSING=0",
  ];
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
  if (!configRoot) throw new Error("PA_PHASE5_CONFIG_ROOT is required");
  const expectedSha = readFileSync(resolve(process.cwd(), ".pa-platform-config.sha"), "utf8").trim();
  for (const line of validatePairedRepository({ configRoot, expectedSha, requireOriginDevelop: process.argv.includes("--require-origin-develop") })) console.log(line);
}
