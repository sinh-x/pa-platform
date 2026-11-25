import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendRegistryEvent, closeDb, getDeploymentEvents, getDeployPaths, getPlatformHomeDir, parseTeamYamlContent, queryDeploymentStatus, repositoryMutationLeasePath, runCoreCommand, type RuntimeAdapter } from "@pa-platform/pa-core";
import { createPiHooks, deployWithPi } from "../deploy.js";
import { registerDocumentModule } from "../pi-extension/document-tool.js";
import { createPiExecutionModule, createPiPhaseReportModule } from "../pi-extension/prepared-workflow.js";
import { interceptToolCall } from "../pi-extension/safety.js";
import type { PiRuntime } from "../pi-extension/index.js";

const selectedConfigRoot = getPlatformHomeDir();
const managedRoutes = [["coordinator", "coordinate"], ["analyst", "analyze"], ["builder", "implement"], ["review", "verify"], ["rollout", "rollout"]];

for (const { name, team, mode, legacy, drift, selected } of [
  { name: "PAP-316 binds committed resources and preserves public execution identity", team: "analyst", mode: "analyze", legacy: true, drift: false, selected: false },
  { name: "PAP-316 binds committed resources and rejects pre-spawn drift", team: "analyst", mode: "analyze", legacy: true, drift: true, selected: false },
  ...[["coordinator", "coordinate"], ["analyst", "analyze"], ["builder", "implement"], ["review", "verify"], ["rollout", "rollout"], ["evidence-lab", "investigate"]].map(([team, mode]) => ({
    name: `PAP-329 launches ordinary ${team}/${mode} without legacy workflow authority`, team: team!, mode: mode!, legacy: false, drift: false, selected: false,
  })),
  ...managedRoutes.map(([team, mode]) => ({
    name: `PAP-329 selected PAPC ${team}/${mode} reaches Pi through the CLI`, team: team!, mode: mode!, legacy: false, drift: false, selected: true,
  })),
]) test(name, async t => {
  // Preserve historical functional assertions for a future qualified executor;
  // PAP-334's interim Analyst boundary is exercised by repository-isolation-launch.
  if (team === "analyst") return t.skip("PAP-334: no qualified Analyst executor; functional launch assertions deferred");
  const selectedPath = join(selectedConfigRoot, "teams", `${team}.yaml`);
  if (selected && !existsSync(selectedPath)) return t.skip("external PAPC selected team is unavailable");
  const selectedYaml = selected ? readFileSync(selectedPath, "utf8") : undefined;
  const selectedTeam = selectedYaml ? parseTeamYamlContent(selectedYaml) : undefined;
  if (selectedTeam && !selectedTeam.deploy_modes?.some(entry => entry.id === mode && entry.mode_type === "interactive" && !entry.document_profile && !entry.capability_policy)) {
    return t.skip("external PAPC does not select the profile-free interactive contract");
  }
  const prior = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap316-selected-launch-")); closeDb();
  const config = join(root, "config"), repo = join(root, "repo"), usage = join(root, "usage");
  try {
    for (const path of [join(config, "teams"), join(config, "docs"), repo, usage]) mkdirSync(path, { recursive: true });
    writeFileSync(join(config, "config.yaml"), `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`);
    writeFileSync(join(config, "docs/objective.md"), "Captured public objective.\n");
    writeFileSync(join(config, "docs/completion.md"), "Captured PUBLIC completion, not the legacy fragment.\n");
    const ticket = legacy || team === "coordinator" || team === "evidence-lab" ? undefined : "EX-1";
    writeFileSync(join(config, `teams/${team}.yaml`), `name: ${team}\nobjective: fallback must not load\nagents: []\ndefault_mode: ${mode}\nglobal_docs: [docs/completion.md]\ndeploy_modes:\n - id: ${mode}\n   label: Analyze\n   provider: openai\n   model: fixture\n${legacy ? "   objective: docs/objective.md\n   document_profile: pa-document-policy/v1\n   capability_policy: {version: pa-mode-capabilities/v1, allow: []}\n" : `   objective: Plain PAPC objective.\n   mode_type: interactive\n${team === "coordinator" ? "" : "   require_ticket: true\n"}`}`);
    if (selectedTeam && selectedYaml) {
      writeFileSync(join(config, `teams/${team}.yaml`), selectedYaml);
      const selectedMode = selectedTeam.deploy_modes!.find(entry => entry.id === mode)!;
      for (const reference of new Set([...(selectedTeam.global_docs ?? []), ...(selectedMode.global_docs ?? []),
        ...selectedTeam.agents.flatMap(agent => agent.instruction ? [agent.instruction] : [])])) {
        const destination = join(config, reference);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(join(selectedConfigRoot, reference), "utf8"));
      }
    }
    for (const path of [config, repo]) {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
      git("init", "-b", "develop"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Disposable source fixture");
    }
    Object.assign(process.env, { PA_PLATFORM_HOME: config, PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: join(config, "teams"), PA_PLATFORM_SKILLS: join(config, "skills/global"),
      PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db") });
    for (const key of ["PA_DEPLOYMENT_ID", "PA_TEAM", "PA_MODE", "PA_TICKET_ID"]) delete process.env[key];
    process.chdir(repo);
    let spawns = 0, lateCustody: "hooks" | "preflight" | "gate" | undefined;
    const adapter: RuntimeAdapter = { name: "pi", defaultModel: "", sessionFileName: "session-id-pi.txt", allocateSessionId: () => "disposable-launch",
      installHooks() {
        if (drift) writeFileSync(join(config, "docs/objective.md"), "Changed AFTER immutable selection.\n");
        if (lateCustody === "hooks") writeFileSync(repositoryMutationLeasePath(repo), "late fixture custody");
      },
      describeTools: () => ({ runtime: "pi", markdown: "Disposable source tools." }), extractActivity: () => [],
      async resume(options) {
        assert.equal(team, "builder");
        assert.equal(options.sessionId, "disposable-launch");
        assert.equal(options.executionPlan?.treehouse, undefined);
        return { sessionId: options.sessionId, exitCode: 0, metadata: { sessionId: options.sessionId } };
      },
      async spawn(options) {
        if (lateCustody === "gate") {
          await Promise.resolve();
          writeFileSync(repositoryMutationLeasePath(repo), "late fixture custody");
          assert.ok(options.beforeRuntimeStart);
          options.beforeRuntimeStart(process.pid);
        }
        spawns++; assert.equal(options.env?.PA_TEAM, team); assert.equal(options.env?.PA_MODE, mode);
        assert.equal(options.executionPlan?.team, team);
        assert.equal(options.executionPlan?.repositoryAdmission.ownershipIntent, "none");
        const primer = readFileSync(options.primerPath, "utf8");
        if (legacy) {
          assert.equal(options.executionPlan?.repositoryAdmission.access, "read-only");
          assert.match(primer, /Captured public objective/); assert.match(primer, /Captured PUBLIC completion/);
          assert.match(primer, /Effective native identity and audit actor: requirements\/analyze/);
          assert.doesNotMatch(primer, /fallback must not load/);
        } else {
          assert.equal(options.executionPlan?.modeCapabilityBinding, undefined);
          assert.equal(options.executionPlan?.treehouse, undefined);
          assert.equal(options.executionPlan?.repositoryAdmission.access, "non-locking");
          assert.equal(options.env?.PA_TICKET_ID, ticket ?? "");
          if (selectedTeam) {
            const selectedMode = selectedTeam.deploy_modes!.find(entry => entry.id === mode)!;
            assert.ok(primer.includes(selectedMode.objective!.trim()));
            assert.equal(options.env?.PA_PROVIDER, "openai-codex");
            assert.equal(options.env?.PA_MODEL, "gpt-6.2-sol");
          } else assert.match(primer, /Plain PAPC objective/);
          assert.equal(options.executionPlan?.ticketRequired, false);
          assert.doesNotMatch(primer, /Effective native identity and audit actor|status transitions belong to the parent flow/i);
          const launcherEnv = process.env;
          process.env = { ...launcherEnv, ...options.env };
          try {
            const tools: string[] = [], sessionStarts: Array<(event: unknown, context: unknown) => unknown> = [];
            const pi = {
              registerTool: ({ name }: { name: string }) => tools.push(name),
              on: (event: string, handler: (event: unknown, context: unknown) => unknown) => { if (event === "session_start") sessionStarts.push(handler); },
            } as PiRuntime;
            registerDocumentModule(pi);
            createPiExecutionModule()(pi);
            createPiPhaseReportModule()(pi);
            for (const start of sessionStarts) await start({}, { cwd: repo, mode: "tui" });
            assert.deepEqual(tools, []);
            assert.equal(interceptToolCall({ toolName: "bash", input: { command: "rm fixture.txt" } }).allowed, false);
            assert.equal(interceptToolCall({ toolName: "read", input: { path: ".env" } }).allowed, false);
          } finally { process.env = launcherEnv; }
        }
        return { sessionId: options.sessionId!, exitCode: 0, metadata: { sessionId: options.sessionId! } };
      } };
    Object.assign(adapter, { async preflight() {
      if (lateCustody === "preflight") writeFileSync(repositoryMutationLeasePath(repo), "late fixture custody");
    } });
    if (legacy && !drift) {
      for (const excluded of [{ background: true }, { resume: "d-316fff" }, { ticketWorktree: true }, { force: true }]) {
        const rejected = await deployWithPi({ team: "analyst", repo: "example", ...excluded }, adapter);
        assert.equal(rejected.status, "failed"); assert.equal(rejected.deploymentId, undefined);
      }
      process.env.PA_DEPLOYMENT_ID = "d-316999";
      const inherited = await deployWithPi({ team: "analyst", repo: "example" }, adapter);
      assert.equal(inherited.status, "failed"); assert.equal(inherited.deploymentId, undefined);
      delete process.env.PA_DEPLOYMENT_ID;
      assert.equal(spawns, 0);
    }
    const request = { team, mode, repo: "example", ...(ticket ? { ticket } : {}) };
    if (!legacy && team === "builder") {
      const leasePath = repositoryMutationLeasePath(repo);
      writeFileSync(leasePath, "retained fixture custody");
      const denied = await deployWithPi({ ...request, force: true }, adapter);
      assert.equal(denied.status, "failed");
      assert.match(denied.reason ?? "", /checkout has retained execution custody/);
      assert.ok(denied.reason!.length <= 2000);
      for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) {
        assert.equal(denied.reason!.split(label).length - 1, 1);
      }
      assert.equal(readFileSync(leasePath, "utf8"), "retained fixture custody");
      assert.equal(spawns, 0);
      rmSync(leasePath);
      for (const timing of ["hooks", "preflight", "gate"] as const) {
        lateCustody = timing;
        const delayed = await deployWithPi(request, adapter);
        assert.equal(delayed.status, "failed", `${timing} custody must block runtime start`);
        assert.match(delayed.reason ?? "", /checkout has retained execution custody/);
        assert.equal(spawns, 0);
        assert.equal(readFileSync(leasePath, "utf8"), "late fixture custody");
        rmSync(leasePath);
      }
      lateCustody = undefined;
    }
    let result!: Awaited<ReturnType<typeof deployWithPi>>;
    if (selected) {
      const hooks = createPiHooks(adapter), output: string[] = [], errors: string[] = [];
      const code = await runCoreCommand(["deploy", team, "--mode", mode, "--repo", "example", ...(ticket ? ["--ticket", ticket] : [])], {
        binaryName: "ppa", io: { stdout: line => output.push(line), stderr: line => errors.push(line) },
        hooks: { ...hooks, async deploy(request, diagnostics) { result = await hooks.deploy!(request, diagnostics); return result; } },
      });
      assert.equal(code, 0, errors.join("\n"));
      assert.match(output.join("\n"), /Deployment completed/);
    } else result = await deployWithPi(request, adapter);
    assert.ok(result);
    assert.equal(result.status, drift ? "failed" : "success", result.reason);
    assert.equal(spawns, drift ? 0 : 1);
    assert.ok(result.deploymentId);
    const started = getDeploymentEvents(result.deploymentId).find(event => event.event === "started")!;
    assert.equal(started.team, team); assert.equal(started.mode, mode);
    if (legacy) assert.match(started.mode_capability_binding!, /pa-mode-capability-binding\/v2/);
    else {
      assert.equal(started.mode_capability_binding, undefined);
      assert.equal(started.note, undefined);
      assert.equal(started.builder_authority, undefined);
      assert.equal(started.ticket_id || undefined, ticket);
      // The fixture exits cleanly without an operator staging task completion.
      assert.equal(queryDeploymentStatus(result.deploymentId)?.status, "partial");
      if (team === "builder") {
        const retained = "d-329abc";
        appendRegistryEvent({ ...started, deployment_id: retained, repository_slot: "implement" });
        const retainedEvents = getDeploymentEvents(retained);
        const denied = await deployWithPi({ ...request, resume: retained }, adapter);
        assert.equal(denied.status, "failed");
        assert.equal(denied.deploymentId, undefined);
        assert.deepEqual(getDeploymentEvents(retained), retainedEvents);
        const originalEvents = getDeploymentEvents(result.deploymentId);
        const continued = await deployWithPi({ ...request, resume: result.deploymentId }, adapter);
        assert.equal(continued.status, "success", continued.reason);
        const resumed = getDeploymentEvents(continued.deploymentId!).find(event => event.event === "started");
        assert.equal(resumed?.resumed_from_deployment_id, result.deploymentId);
        assert.deepEqual(getDeploymentEvents(result.deploymentId), originalEvents);
      }
    }
    assert.ok(getDeployPaths(result.deploymentId).deployDir.startsWith(usage));
    if (drift) assert.match(result.reason ?? "", /CAPABILITY_BINDING/);
  } finally { closeDb(); process.chdir(cwd); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});
