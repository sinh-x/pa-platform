import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { classifyRepositoryAccess, generatePrimer, modelMatchesProvider, parseTeamYamlContent, validateTeamSkillReferences, readReviewProducerFixtures, loadSelectedWorkflows, readReviewEvidenceFile, workflowDigest, validateWorkflowPair, type WorkflowSelection, type WorkflowPrimerView } from "../../packages/pa-core/src/index.js";

export interface PairedValidationOptions {
  configRoot: string;
  expectedSha: string;
  requireOriginDevelop?: boolean;
  requireReviewV1?: boolean;
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`pa-platform-config must be a Git checkout: ${root}`);
  }
}

const planFirstRequirementsModes = ["analyze", "analyze-auto", "spike"] as const;

/** Read-only selected-route projection checks. Fixture subjects are NOT issued
 * decisions; the preview run ID is explicitly structural and never persisted. */
export function validateWorkflowProcedures(configRoot: string, selection: WorkflowSelection, paired: ReturnType<typeof validateWorkflowPair>): ReadonlyMap<string, WorkflowPrimerView> {
  const routes = new Map<string, WorkflowPrimerView>();
  for (const binding of selection.bindings.filter(b => b.enabled)) {
    const key = `${binding.team}/${binding.mode}`;
    if (key !== "requirements/analyze") throw new Error("Unsupported selected v1 procedural route; no legacy fallback");
    const definition = selection.definitions.find(d => d.definition.workflowId === binding.workflowId && d.definition.version === binding.workflowVersion);
    const cases = paired.fixtures.filter(f => f.team === binding.team && f.mode === binding.mode);
    if (!definition || !["fresh", "amendment"].every(type => cases.some(f => f.handoff === type && f.bindingEnabled && f.definitionSha256 === definition.sha256))) throw new Error("Selected v1 procedure requires both exact typed handoffs");
    const team = parseTeamYamlContent(readFileSync(resolve(configRoot, "teams", `${binding.team}.yaml`), "utf8"));
    if (!team.deploy_modes?.some(m => m.id === binding.mode)) throw new Error("Selected v1 procedure names a missing team/mode");
    const view: WorkflowPrimerView = { runId: "paired-structural-preview", workflowId: binding.workflowId, version: binding.workflowVersion, sha256: definition.sha256,
      configRevision: selection.configRevision, nextOwner: "operator", nextAction: "Request the exact native package decision; structural preview grants no authority." };
    const primer = generatePrimer({ runtime: "pi", teamConfig: team, mode: binding.mode, workflow: view,
      repository: { repoKey: "pa-platform-config", repoRoot: configRoot }, resolveFile: path => resolve(configRoot, path), skillsDir: resolve(configRoot, "skills/global"),
      templateVars: { DEPLOY_ID: "paired-v1-preview", TEAM_NAME: binding.team, TICKET_ID: "PAP-271", TODAY: "2026-10-30" } });
    const identity = `Run: ${view.runId}; definition: ${view.workflowId}/${view.version}; raw SHA-256: ${view.sha256}; config: ${view.configRevision}.`;
    if (!primer.includes(identity) || !primer.includes(`Next owner: ${view.nextOwner}. Next action: ${view.nextAction}.`)) throw new Error("Selected v1 generated primer lost pinned contract identity");
    routes.set(key, view);
  }
  return routes;
}

function validatePlanFirstRequirementsContracts(configRoot: string, directLocal = false, workflows: ReadonlyMap<string, WorkflowPrimerView> = new Map()): number {
  const requirements = parseTeamYamlContent(readFileSync(resolve(configRoot, "teams", "requirements.yaml"), "utf8"));
  const configuredModes = new Set(requirements.deploy_modes?.map((mode) => mode.id) ?? []);
  const requiredCases = [
    ["canonical ticket/base/branch plan", /record(?:s|ed|ing)?[\s\S]{0,1400}canonical `?repo_key`?\/?`?repo_root`?[\s\S]{0,1400}exact ticket[\s\S]{0,1400}approved full base SHA[\s\S]{0,1400}exact (?:linked |feature )?(?:feature )?branch[\s\S]{0,1400}`?planned`?[\s\S]{0,1400}`?create`?/iu],
    ["no requirements-time checkout prerequisite", /(?:(?:requires? no|does not supply or require|must not require)[\s\S]{0,320}requirements-time[\s\S]{0,320}(?:builder )?(?:checkout|worktree)[\s\S]{0,240}lease|requirements-time[\s\S]{0,320}(?:builder )?(?:checkout|worktree)[\s\S]{0,240}lease[\s\S]{0,320}neither required nor accepted)/iu],
    ["zero requirements lifecycle or branch action", /Requirements[\s\S]{0,480}(?:performs?|perform)[\s\S]{0,240}(?:no (?:Treehouse )?checkout lifecycle operation|no checkout acquire)[\s\S]{0,320}no branch action/iu],
    ["builder-owned ordered materialization", /trusted PPA builder\/orchestrator launcher[\s\S]{0,640}reserve(?:s)?[^.\n]{0,160}capacity[\s\S]{0,640}acquire(?:s)? or reuse(?:s)?[\s\S]{0,320}authenticat(?:e|es)[\s\S]{0,5000}(?:ordinary-Git|branch materialization)[\s\S]{0,3600}(?:persist|durable)[\s\S]{0,1800}(?:implementation spawn|builder child\/runtime spawn|spawns? implementation)/iu],
    ["one-lineage/four-ticket capacity", /one active builder lineage per repository\/ticket[\s\S]{0,240}(?:at most|max(?:imum)? of) four active ticket checkouts per canonical repository/iu],
    ["operator-only return", /only Sinh\/operator[\s\S]{0,240}(?:return the checkout|approve checkout return|return of the Treehouse checkout)[\s\S]{0,240}explicit approval/iu],
    // Older approved config may name historical adapters in the same sentence.
    // Validate OPA's boundary, not the spelling/cardinality of those subjects;
    // active runtime admission still accepts only Pi/OpenCode.
    ["adapter and runtime-authority boundaries", /(?=[\s\S]*OPA(?:\/OpenCode)?\b[\s\S]{0,240}\bno Treehouse (?:behavior )?claim)(?=[\s\S]*PAP-189 runtime)(?=[\s\S]*PAP-215)[\s\S]+/iu],
  ] as const;
  const directLocalCases: Readonly<Record<string, RegExp>> = {
    "one-lineage/four-ticket capacity": /Allow one active builder lineage per repository\/ticket and at most four active ticket checkouts; duplicate and fifth requests reject before mutation or spawn/iu,
    "zero requirements lifecycle or branch action": /Requirements discovery\/drafting performs no checkout lifecycle operation or branch action/iu,
    "builder-owned ordered materialization": /trusted launcher independently authenticates[\s\S]{0,640}REUSES it without a second reservation or branch construction[\s\S]{0,480}acquires\/authenticates[\s\S]{0,1800}Persist checkout, lease, capacity, lineage, correlation, branch result and launch snapshot before implementation spawn/iu,
  };
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
      ...(workflows.has(`requirements/${mode}`) ? { workflow: workflows.get(`requirements/${mode}`)! } : {}),
      teamConfig: requirements,
      mode,
      objective: `Validate plan-first requirements behavior for ${mode}.`,
      repository: { repoKey: "pa-platform-config", repoRoot: configRoot },
      resolveFile: (relativePath) => resolve(configRoot, relativePath),
      skillsDir: resolve(configRoot, "skills", "global"),
      templateVars: { DEPLOY_ID: `paired-${mode}`, TEAM_NAME: "requirements", TICKET_ID: "PAPC-024", TODAY: "2026-09-19" },
    });
    // Only this exact enabled/typed route replaces procedural paragraphs.
    // Every unselected mode retains the previous complete legacy checks.
    for (const [label, pattern] of workflows.has(`requirements/${mode}`) ? [] : requiredCases) {
      if (!pattern.test(primer) && !(directLocal && directLocalCases[label]?.test(primer))) throw new Error(`requirements/${mode}: generated primer is missing plan-first contract: ${label}`);
    }
    for (const stale of prohibited) {
      if (primer.includes(stale)) throw new Error(`requirements/${mode}: generated primer restores a requirements-time checkout prerequisite`);
    }
  }
  return planFirstRequirementsModes.length;
}

/** Current direct-only config owns its instruction/model checker. Historical
 * split-mode fixtures retain their old checks below; requiring an implement
 * borrower or per-fix approval in a direct-only candidate would restore the bug.
 * This is source pairing, never runtime readiness or independent acceptance. */
export function validateDirectLocalProfile(configRoot: string, workflows: ReadonlyMap<string, WorkflowPrimerView> = new Map()): number {
  const checkerPath = resolve(configRoot, "scripts/check-prepared-autonomy-workflow.mjs");
  if (realpathSync(checkerPath) !== checkerPath) throw new Error("Direct local producer checker must be a physical file in the selected config");
  const team = parseTeamYamlContent(readFileSync(resolve(configRoot, "teams/builder.yaml"), "utf8"));
  const mode = team.deploy_modes?.find((entry) => entry.id === "orchestrator");
  if (!mode || team.deploy_modes?.some((entry) => entry.id === "implement")) throw new Error("Direct local producer cannot restore an implement fallback");
  const primer = generatePrimer({ runtime: "pi", teamConfig: team, mode: "orchestrator", objective: "Validate the scoped ordinary local source pair.", repository: { repoKey: "pa-platform-config", repoRoot: configRoot },
    resolveFile: (path) => resolve(configRoot, path), skillsDir: resolve(configRoot, "skills/global"),
    templateVars: { DEPLOY_ID: "paired-local", TEAM_NAME: "builder", TICKET_ID: "PAP-268", TODAY: "2026-10-26" } });
  // A fresh process prevents ESM/require cache from certifying bytes belonging
  // to a previously selected config SHA. Only this fixed source-only checker
  // runs; it receives no ambient credentials or PA/PI/Git authority environment.
  const script = `import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';import{resolve}from'node:path';
    const input=JSON.parse(readFileSync(0,'utf8')); const c=await import(pathToFileURL(resolve(input.root,'scripts/check-prepared-autonomy-workflow.mjs')).href);
    if(c.DIRECT_ONLY_DECLARATION?.version!==4||c.DIRECT_ONLY_DECLARATION.candidatePolicy!=='orchestrator-direct-only'||typeof c.checkDirectOnlyWorkflow!=='function'||typeof c.checkScopedLocalText!=='function')throw Error('unsupported producer');
    const r=c.checkDirectOnlyWorkflow(input.root,undefined,{workflowRoutes:input.routes}); c.checkScopedLocalText(input.primer,'teams/builder/modes/orchestrator.md');
    if(input.routes.length&&JSON.stringify(r.workflowRoutes)!==JSON.stringify(input.routes))throw Error('selected procedural coexistence counterpart missing');
    console.log(JSON.stringify({ok:r.ok,evidenceClass:r.evidenceClass,scopedLocal:r.scopedLocal}));`;
  const checked = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify({ root: configRoot, primer, routes: [...workflows.keys()].sort() }),
    env: { HOME: "/nonexistent", LANG: "C.UTF-8", TZ: "UTC" }, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  if (checked.error || checked.status !== 0 || checked.signal) throw new Error("Selected direct-only/scoped-local producer failed its source check; no legacy fallback");
  const result = JSON.parse(checked.stdout) as { ok?: boolean; evidenceClass?: string; scopedLocal?: { runtimeOwner?: string; presentation?: string; acceptance?: string; sources?: unknown[] } };
  if (result.ok !== true || result.evidenceClass !== "current-structural-and-synthetic-not-runtime-proof" || result.scopedLocal?.runtimeOwner !== "PAP-268"
    || result.scopedLocal.presentation !== "Markdown-sufficient-rich-view-optional" || result.scopedLocal.acceptance !== "paired-proof-required" || !result.scopedLocal.sources?.length) throw new Error("Direct local config checker did not prove its source-only instruction contract");
  return validatePlanFirstRequirementsContracts(configRoot, true, workflows);
}

function validateRepositoryContracts(configRoot: string, workflows: ReadonlyMap<string, WorkflowPrimerView> = new Map()): number {
  const builder = parseTeamYamlContent(readFileSync(resolve(configRoot, "teams/builder.yaml"), "utf8"));
  if (builder.deploy_modes?.some((mode) => mode.id === "orchestrator") && !builder.deploy_modes.some((mode) => mode.id === "implement")) return validateDirectLocalProfile(configRoot, workflows);
  const orchestratorPath = resolve(configRoot, "teams", "builder", "modes", "orchestrator.md");
  const orchestrator = readFileSync(orchestratorPath, "utf8");
  const ppaBranchContracts = [
    ["plan-only requirements handoff", /approved requirements plan supplies only canonical `repo_key`\/`repo_root`[\s\S]{0,320}approved full base SHA[\s\S]{0,320}`planned` state[\s\S]{0,160}`create` action[\s\S]{0,320}does not supply or require a requirements-time builder checkout, worktree, or lease/iu],
    ["builder-owned checkout acquisition", /trusted PPA launcher reserves capacity, acquires or reuses and authenticates the distinct Treehouse ticket checkout/iu],
    ["planned create and materialized select", /Branch evidence is planned or materialized for the exact linked branch[\s\S]{0,480}ordinary Git[\s\S]{0,320}create the exact planned branch[\s\S]{0,320}select the exact materialized branch/iu],
    ["one-lineage/four-ticket capacity", /one active builder lineage per repository\/ticket and at most four active ticket checkouts per canonical repository/iu],
    ["mismatch rejection", /conflicting identity, ticket, branch state, base, branch, action, lineage, or capacity evidence rejects before project-file or branch mutation and before builder child\/runtime spawn/iu],
    ["non-Pi branch boundary", /OPA\/OpenCode\b[\s\S]{0,240}\bsupported non-Treehouse seven-state branch behavior[\s\S]{0,320}\bno Treehouse claim/iu],
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
  return validatePlanFirstRequirementsContracts(configRoot, false, workflows);
}

/** Producer-owned read-only manifest; missing pairing is a rollout blocker, never inferred from template prose. */
export function validateReviewProducerFixtures(configRoot: string): number {
  return readReviewProducerFixtures(resolve(configRoot));
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
  const selectedRead = (relative: string): Uint8Array | null => {
    const path = resolve(configRoot, relative);
    if (!existsSync(path)) return null;
    const raw = readReviewEvidenceFile(path, 1_048_576, "paired.workflow-source");
    const committed = execFileSync("git", ["--no-replace-objects", "--no-optional-locks", "-C", configRoot, "show", `${actualSha}:${relative}`], { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), maxBuffer: 1_048_577, stdio: ["ignore", "pipe", "ignore"] });
    if (workflowDigest(raw) !== workflowDigest(committed)) throw new Error("Selected workflow source differs from the pinned committed bytes");
    return raw;
  };
  const requiredRead = (relative: string): Uint8Array => { const raw = selectedRead(relative); if (!raw) throw new Error("Required pinned workflow fixture is missing"); return raw; };
  const workflowSelection = loadSelectedWorkflows({ root: () => configRoot, revision: () => git(configRoot, ["rev-parse", "HEAD"]), read: (_root, relative) => selectedRead(relative) });
  let workflowFixtureCount: number | undefined;
  let workflowProcedures: ReadonlyMap<string, WorkflowPrimerView> = new Map();
  if (workflowSelection.bindings.length) {
    const registry = requiredRead("contracts/templates-v1.json"), fixtures = requiredRead("workflows/fixtures-v1.json");
    const paired = validateWorkflowPair(workflowSelection, { root: configRoot, configRevision: actualSha, registrySha256: workflowDigest(registry) }, fixtures, requiredRead);
    workflowFixtureCount = paired.fixtures.length;
    workflowProcedures = validateWorkflowProcedures(configRoot, workflowSelection, paired);
  }
  const reviewProducerCount = options.requireReviewV1 ? validateReviewProducerFixtures(configRoot) : undefined;
  const planFirstPrimerCount = validateRepositoryContracts(configRoot, workflowProcedures);
  const builderConfig = parseTeamYamlContent(readFileSync(resolve(configRoot, "teams/builder.yaml"), "utf8"));
  const directLocal = builderConfig.deploy_modes?.some((mode) => mode.id === "orchestrator") === true && !builderConfig.deploy_modes.some((mode) => mode.id === "implement");
  const expected = directLocal ? { modes: 52, builder: 4, requirements: 6, other: 42 } : { modes: 59, builder: 6, requirements: 11, other: 42 };

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
  if (modeCount !== expected.modes) throw new Error(`Expected ${expected.modes} active modes, found ${modeCount}`);
  if (builderExclusiveCount !== expected.builder) throw new Error(`Expected ${expected.builder} exclusive builder modes, found ${builderExclusiveCount}`);
  if (requirementsReadOnlyCount !== expected.requirements) throw new Error(`Expected ${expected.requirements} read-only requirements modes, found ${requirementsReadOnlyCount}`);
  if (otherNonLockingCount !== expected.other) throw new Error(`Expected ${expected.other} non-locking modes for other teams, found ${otherNonLockingCount}`);
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
    ...(workflowFixtureCount === undefined ? [] : [`JSON_WORKFLOW_STRUCTURAL_FIXTURES=${workflowFixtureCount}`, "JSON_WORKFLOW_EXECUTION_ADMITTED=false"]),
    ...(workflowProcedures.size ? [`JSON_WORKFLOW_PROCEDURAL_ROUTES=${[...workflowProcedures.keys()].sort().join(",")}`, "JSON_WORKFLOW_PRIMER_IDENTITY=verified-structural-only"] : []),
    ...(reviewProducerCount === undefined ? [] : [`REVIEW_V1_PRODUCER_PROFILES=${reviewProducerCount}/3`]),
    "CONFIG_CLEAN=true",
    `TEAMS_VALID=${teamFiles.length}/10`,
    `MODES_VALID=${modeCount}/${expected.modes}`,
    ...(directLocal ? ["SOURCE_PROFILE=ordinary-local/v1"] : []),
    "LEGACY_RUNTIMES=0",
    "INVALID_PAIRS=0",
    `BUILDER_EXCLUSIVE=${builderExclusiveCount}/${expected.builder}`,
    `REQUIREMENTS_READ_ONLY=${requirementsReadOnlyCount}/${expected.requirements}`,
    `OTHER_NON_LOCKING=${otherNonLockingCount}/${expected.other}`,
    `REPOSITORY_ADMISSION_MATRIX=${modeCount}/${expected.modes}`,
    directLocal ? "PPA_BRANCH_GATE=current-direct-source-checked" : "PPA_BRANCH_GATE=6/6",
    `PLAN_FIRST_REQUIREMENTS_PRIMERS=${planFirstPrimerCount}/${planFirstRequirementsModes.length}`,
    "REQUIREMENTS_TIME_CHECKOUT_PREREQUISITES=0",
    "BUILDER_OWNED_TREEHOUSE_MATERIALIZATION=true",
    directLocal ? "DIRTY_DIRECT_BORROW_POLICY=historical-read-only" : "DIRTY_DIRECT_BORROW_POLICY=6/6",
    directLocal ? "DIRTY_DIRECT_BORROWER_EXCEPTION=retired-no-fallback" : "DIRTY_DIRECT_BORROWER_EXCEPTION=1/1",
    "GENERAL_DIRTY_BACKGROUND_REJECTION=true",
    "REFERENCES_MISSING=0",
  ];
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
  if (!configRoot) throw new Error("PA_PHASE5_CONFIG_ROOT is required");
  const expectedSha = readFileSync(resolve(process.cwd(), ".pa-platform-config.sha"), "utf8").trim();
  for (const line of validatePairedRepository({ configRoot, expectedSha, requireOriginDevelop: process.argv.includes("--require-origin-develop"), requireReviewV1: process.argv.includes("--require-review-v1") })) console.log(line);
}
