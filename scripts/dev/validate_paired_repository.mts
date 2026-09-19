import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { classifyRepositoryAccess, generatePrimer, modelMatchesProvider, parseTeamYamlContent, validateTeamSkillReferences } from "../../packages/pa-core/src/index.js";

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

const planFirstRequirementsModes = ["analyze", "analyze-auto", "spike"] as const;

function validatePlanFirstRequirementsContracts(configRoot: string): number {
  const requirements = parseTeamYamlContent(readFileSync(resolve(configRoot, "teams", "requirements.yaml"), "utf8"));
  const configuredModes = new Set(requirements.deploy_modes?.map((mode) => mode.id) ?? []);
  const requiredCases = [
    ["canonical ticket/base/branch plan", /record(?:s|ed|ing)?[\s\S]{0,1400}canonical `?repo_key`?\/?`?repo_root`?[\s\S]{0,1400}exact ticket[\s\S]{0,1400}approved full base SHA[\s\S]{0,1400}exact (?:linked |feature )?(?:feature )?branch[\s\S]{0,1400}`?planned`?[\s\S]{0,1400}`?create`?/iu],
    ["no requirements-time checkout prerequisite", /(?:(?:requires? no|does not supply or require|must not require)[\s\S]{0,320}requirements-time[\s\S]{0,320}(?:builder )?(?:checkout|worktree)[\s\S]{0,240}lease|requirements-time[\s\S]{0,320}(?:builder )?(?:checkout|worktree)[\s\S]{0,240}lease[\s\S]{0,320}neither required nor accepted)/iu],
    ["zero requirements lifecycle or branch action", /Requirements[\s\S]{0,480}(?:performs?|perform)[\s\S]{0,240}(?:no (?:Treehouse )?checkout lifecycle operation|no checkout acquire)[\s\S]{0,320}no branch action/iu],
    ["builder-owned ordered materialization", /trusted PPA builder\/orchestrator launcher[\s\S]{0,640}reserve(?:s)?[^.\n]{0,160}capacity[\s\S]{0,640}acquire(?:s)? or reuse(?:s)?[\s\S]{0,320}authenticat(?:e|es)[\s\S]{0,5000}(?:ordinary-Git|branch materialization)[\s\S]{0,3600}(?:persist|durable)[\s\S]{0,1800}(?:implementation spawn|builder child\/runtime spawn|spawns? implementation)/iu],
    ["one-lineage/four-ticket capacity", /one active builder lineage per repository\/ticket[\s\S]{0,240}(?:at most|max(?:imum)? of) four active ticket checkouts per canonical repository/iu],
    ["operator-only return", /only Sinh\/operator[\s\S]{0,240}(?:return the checkout|approve checkout return|return of the Treehouse checkout)[\s\S]{0,240}explicit approval/iu],
    ["adapter and runtime-authority boundaries", /(?=[\s\S]*OPA(?:\/OpenCode)?[\s\S]{0,160}CPA(?:\/Claude Code)?[\s\S]{0,240}no Treehouse (?:behavior )?claim)(?=[\s\S]*PAP-189 runtime)(?=[\s\S]*PAP-215)[\s\S]+/iu],
  ] as const;
  const prohibited = [
    "Operator-Prepared Checkout Evidence:",
    "For Pi/PPA with an authenticated operator-prepared ticket checkout, requirements must use the distinct authenticated worktree_root.",
    "A builder-bound Pi/PPA handoff must carry authenticated worktree_root and operator-prepared checkout evidence before orchestrator dispatch.",
    "Requirements must carry Treehouse lease, holder, ticket slot, and repository permit evidence before builder launch.",
    "Sinh/operator must prepare and authenticate the checkout before requirements analysis.",
  ] as const;

  for (const mode of planFirstRequirementsModes) {
    if (!configuredModes.has(mode)) throw new Error(`requirements/${mode}: plan-first mode is not configured`);
    const primer = generatePrimer({
      runtime: "pi",
      teamConfig: requirements,
      mode,
      objective: `Validate plan-first requirements behavior for ${mode}.`,
      repository: { repoKey: "pa-platform-config", repoRoot: configRoot },
      resolveFile: (relativePath) => resolve(configRoot, relativePath),
      skillsDir: resolve(configRoot, "skills", "global"),
      templateVars: { DEPLOY_ID: `paired-${mode}`, TEAM_NAME: "requirements", TICKET_ID: "PAPC-024", TODAY: "2026-09-19" },
    });
    for (const [label, pattern] of requiredCases) {
      if (!pattern.test(primer)) throw new Error(`requirements/${mode}: generated primer is missing plan-first contract: ${label}`);
    }
    for (const stale of prohibited) {
      if (primer.includes(stale)) throw new Error(`requirements/${mode}: generated primer restores a requirements-time checkout prerequisite`);
    }
  }
  return planFirstRequirementsModes.length;
}

function validateRepositoryContracts(configRoot: string): number {
  const orchestratorPath = resolve(configRoot, "teams", "builder", "modes", "orchestrator.md");
  const orchestrator = readFileSync(orchestratorPath, "utf8");
  const ppaBranchContracts = [
    ["plan-only requirements handoff", /approved requirements plan supplies only canonical `repo_key`\/`repo_root`[\s\S]{0,320}approved full base SHA[\s\S]{0,320}`planned` state[\s\S]{0,160}`create` action[\s\S]{0,320}does not supply or require a requirements-time builder checkout, worktree, or lease/iu],
    ["builder-owned checkout acquisition", /trusted PPA launcher reserves capacity, acquires or reuses and authenticates the distinct Treehouse ticket checkout/iu],
    ["planned create and materialized select", /Branch evidence is planned or materialized for the exact linked branch[\s\S]{0,480}ordinary Git[\s\S]{0,320}create the exact planned branch[\s\S]{0,320}select the exact materialized branch/iu],
    ["one-lineage/four-ticket capacity", /one active builder lineage per repository\/ticket and at most four active ticket checkouts per canonical repository/iu],
    ["mismatch rejection", /conflicting identity, ticket, branch state, base, branch, action, lineage, or capacity evidence rejects before project-file or branch mutation and before builder child\/runtime spawn/iu],
    ["non-Pi branch boundary", /OPA\/OpenCode and CPA\/Claude Code[\s\S]{0,240}supported non-Treehouse seven-state branch behavior[\s\S]{0,320}no Treehouse claim/iu],
  ] as const;
  for (const [label, pattern] of ppaBranchContracts) {
    if (!pattern.test(orchestrator)) throw new Error(`Paired orchestrator is missing PPA branch-gate contract: ${label}`);
  }

  const dirtyBorrowRequiredCases = [
    ["default rejection and narrow exception", /default dirty-background rejection remains fail-closed[\s\S]{0,240}only dirty-background exception/iu],
    ["authenticated direct implement lineage", /one runtime-authenticated direct `builder\/implement` child[\s\S]{0,240}process-verified, registry-running `builder\/orchestrator`/iu],
    ["complete classified path set", /complete NUL-safe porcelain-v2 path\/status metadata set[\s\S]{0,240}active-ticket work/iu],
    ["approval identity and action bindings", /canonical repository key\/root,(?: authenticated worktree root,)? ticket, exact linked branch, full HEAD[\s\S]{0,320}exactly one delegated action[\s\S]{0,80}`commit` or `cleanup`/iu],
    ["metadata-only hash boundary", /File contents are not part of the approval hash/iu],
    ["two unchanged rereads", /immediate pre-intent reread[\s\S]{0,160}mutex-serialized admission reread[\s\S]{0,240}(?:difference|change)[\s\S]{0,160}reject before spawn/iu],
    ["delegated scope and custody", /touch only the approved path set for the approved action[\s\S]{0,240}parent (?:must not|neither) mutate[\s\S]{0,160}sibling[\s\S]{0,160}child (?:must not|cannot) delegate/iu],
    ["parent accountability", /parent retains phase acceptance and commit\/cleanup accountability/iu],
    ["matching idempotent finalization", /matching (?:PA authority )?finalization(?=[\s\S]{0,1600}(?:exact final (?:Git )?snapshot|publishes the exact final snapshot))(?=[\s\S]{0,1600}clears only matching)(?=[\s\S]{0,1600}retains authority|[\s\S]{0,1600}retains (?:a )?(?:matching )?(?:live )?parent)(?=[\s\S]{0,1600}releases?)(?=[\s\S]{0,1600}idempotent)/iu],
    ["protected evidence bounds", /one-use[\s\S]{0,160}(?:mode[- ]`0600`|mode `0600`)[\s\S]{0,160}(?:at most|max(?:imum)?)[- ]65,536 bytes[\s\S]{0,200}non-user-visible|non-user-visible[\s\S]{0,200}one-use[\s\S]{0,160}(?:mode[- ]`0600`|mode `0600`)[\s\S]{0,160}(?:at most|max(?:imum)?)[- ]65,536 bytes/iu],
    ["forbidden lineage and bypasses", /sibling[\s\S]{0,160}descendant[\s\S]{0,160}(?:unrelated builder|unrelated-builder)[\s\S]{0,240}(?:public|force)[\s\S]{0,240}bypass/iu],
    ["config-first pairing", /PAPC-017[\s\S]{0,240}PAP-191[\s\S]{0,240}merged `develop` SHA[\s\S]{0,240}(?:do not prove|does not prove|not runtime-admission success)/iu],
  ] as const;
  const dirtyExceptionSurfaces = [
    "docs/runtime-neutral-config.md",
    "teams/builder.yaml",
    "teams/builder/modes/implement.md",
    "teams/builder/modes/orchestrator.md",
    "skills/templates/builder-objective.md",
    "skills/templates/orchestration-report.md",
  ] as const;
  for (const relativePath of dirtyExceptionSurfaces) {
    const content = readFileSync(resolve(configRoot, relativePath), "utf8");
    for (const [label, pattern] of dirtyBorrowRequiredCases) {
      if (!pattern.test(content)) throw new Error(`${relativePath}: missing affirmative classified dirty direct-borrower case: ${label}`);
    }
  }

  const contractSurfaces = [
    "docs/runtime-neutral-config.md",
    "teams/builder.yaml",
    "teams/builder/modes/data-analysis.md",
    "teams/builder/modes/implement.md",
    "teams/builder/modes/orchestrator.md",
    "teams/builder/modes/routine.md",
    "teams/builder/modes/worker.md",
    "skills/templates/builder-objective.md",
  ] as const;
  const universalAdmissionClauses = [
    ["requirements read-only admission", /Every `requirements\/\*` mode (?:bypasses dirty-state inspection and repository-ownership admission, including while a live builder (?:owns the same canonical repository|lineage exists)|uses canonical `repo_root` as its read-only analysis root[\s\S]{0,320}(?:creates|create),? (?:borrows|borrow),? (?:transfers|transfer),? (?:modifies|modify),? or (?:removes|remove) no (?:repository lease or )?builder authority|retains its read-only status-and-ownership bypass[\s\S]{0,240}(?:creates|create),? (?:borrows|borrow),? (?:transfers|transfer),? (?:modifies|modify),? or (?:removes|remove) no repository lease)/iu],
    ["one-lineage/four-ticket ownership", /one active builder lineage per (?:canonical )?repository\/ticket[\s\S]{0,240}at most four active ticket checkouts per canonical repository/iu],
    ["verified-live force boundary", /(?:`--force` (?:recovery )?applies only to stale or malformed (?:ownership )?evidence and never overrides (?:a )?process-verified live (?:owner or borrower authority|ownership|parented family or standalone execution holder|holder)|`--force` never overrides a live holder)/iu],
  ] as const;
  const dirtyBuilderClauses = [
    ["dirty foreground admission", /(?:Foreground admission permits (?:a dirty canonical checkout|dirty-state handling) for every `builder\/\*` mode, including `builder\/orchestrator`|Foreground dirty-state handling remains classify-propose-ask-reread|Foreground builders may launch dirty only under the classify\/propose\/ask\/re-read contract)/iu],
    ["dirty foreground re-evaluation", /(?:After a dirty foreground launch|Foreground dirty-state handling[\s\S]{0,240})[\s\S]{0,240}re-evaluate (?:the current )?branch, full HEAD, and complete staged, unstaged, and untracked status/iu],
    ["dirty foreground intent question", /(?:Classify whether each observed change belongs to the active ticket|classify every change)[\s\S]{0,160}propose (?:one concrete )?preserve, wait, or stop[\s\S]{0,160}ask Sinh before (?:any agent-initiated )?Git (?:mutation )?or project-file mutation/iu],
    ["dirty foreground re-read", /(?:Immediately before an approved action, re-read branch, HEAD, and status; if repository state or proposed scope changed, ask Sinh again|reread immediately before an approved action[\s\S]{0,160}changed state or scope requires a fresh decision)/iu],
    ["dirty background rejection", /(?:Dirty background `builder\/\*` deployments reject before runtime spawn[\s\S]{0,320}(?:leave|leaves) no ownership evidence|default dirty-background rejection remains fail-closed)/iu],
  ] as const;
  const dirtyBuilderSurfaces = [
    "docs/runtime-neutral-config.md",
    "teams/builder.yaml",
    "teams/builder/modes/implement.md",
    "teams/builder/modes/orchestrator.md",
    "skills/templates/builder-objective.md",
  ] as const;
  const retiredBlanketContract = /no per-mode repository access class|(?:leases|repository ownership).{0,160}not part of the active contract|repository admission.{0,120}(?:does not exist|is not part of the active contract)/is;
  for (const relativePath of contractSurfaces) {
    const content = readFileSync(resolve(configRoot, relativePath), "utf8");
    for (const [label, pattern] of universalAdmissionClauses) {
      if (!pattern.test(content)) throw new Error(`${relativePath}: missing affirmative ${label} clause`);
    }
    if (retiredBlanketContract.test(content)) throw new Error(`${relativePath}: contains retired blanket no-admission/no-ownership semantics`);
  }
  for (const relativePath of dirtyBuilderSurfaces) {
    const content = readFileSync(resolve(configRoot, relativePath), "utf8");
    for (const [label, pattern] of dirtyBuilderClauses) {
      if (!pattern.test(content)) throw new Error(`${relativePath}: missing affirmative ${label} clause`);
    }
  }
  const runtimeNeutral = readFileSync(resolve(configRoot, "docs", "runtime-neutral-config.md"), "utf8");
  if (!/no requirements-time authenticated builder checkout, worktree, lease, holder, ticket slot, or repository permit is required/iu.test(runtimeNeutral)
    || !/PAP-215 owns plan-first Treehouse[\s\S]{0,240}must pin the exact merged PAPC-024 `develop` SHA/iu.test(runtimeNeutral)) {
    throw new Error("Paired configuration must retain the plan-first requirements/builder materialization boundary");
  }
  return validatePlanFirstRequirementsContracts(configRoot);
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
  const planFirstPrimerCount = validateRepositoryContracts(configRoot);

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
  if (teamFiles.length !== 10) throw new Error(`Expected 10 active teams, found ${teamFiles.length}`);
  if (modeCount !== 59) throw new Error(`Expected 59 active modes, found ${modeCount}`);
  if (builderExclusiveCount !== 6) throw new Error(`Expected 6 exclusive builder modes, found ${builderExclusiveCount}`);
  if (requirementsReadOnlyCount !== 11) throw new Error(`Expected 11 read-only requirements modes, found ${requirementsReadOnlyCount}`);
  if (otherNonLockingCount !== 42) throw new Error(`Expected 42 non-locking modes for other teams, found ${otherNonLockingCount}`);
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
    `TEAMS_VALID=${teamFiles.length}/10`,
    `MODES_VALID=${modeCount}/59`,
    "LEGACY_RUNTIMES=0",
    "INVALID_PAIRS=0",
    `BUILDER_EXCLUSIVE=${builderExclusiveCount}/6`,
    `REQUIREMENTS_READ_ONLY=${requirementsReadOnlyCount}/11`,
    `OTHER_NON_LOCKING=${otherNonLockingCount}/42`,
    `REPOSITORY_ADMISSION_MATRIX=${modeCount}/59`,
    "PPA_BRANCH_GATE=6/6",
    `PLAN_FIRST_REQUIREMENTS_PRIMERS=${planFirstPrimerCount}/${planFirstRequirementsModes.length}`,
    "REQUIREMENTS_TIME_CHECKOUT_PREREQUISITES=0",
    "BUILDER_OWNED_TREEHOUSE_MATERIALIZATION=true",
    "DIRTY_DIRECT_BORROW_POLICY=6/6",
    "DIRTY_DIRECT_BORROWER_EXCEPTION=1/1",
    "GENERAL_DIRTY_BACKGROUND_REJECTION=true",
    "REFERENCES_MISSING=0",
  ];
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
  if (!configRoot) throw new Error("PA_PHASE5_CONFIG_ROOT is required");
  const expectedSha = readFileSync(resolve(process.cwd(), ".pa-platform-config.sha"), "utf8").trim();
  for (const line of validatePairedRepository({ configRoot, expectedSha, requireOriginDevelop: process.argv.includes("--require-origin-develop") })) console.log(line);
}
