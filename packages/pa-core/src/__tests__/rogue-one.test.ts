import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatePrimer } from "../primer/index.js";
import { resolveExecutionPlan } from "../deploy/plan.js";
import { isRogueOneTeam, normalizeRogueOneDeployRequest, rogueOneModeWarning } from "../deploy/rogue-one.js";
import type { RepositoryAdmissionOperation } from "../deploy/repository-admission.js";
import type { TeamConfig } from "../types.js";

const rogueTeam: TeamConfig = {
  name: "rogue-one",
  description: "CONFIGURED TEAM DESCRIPTION MUST NOT APPEAR",
  objective: "CONFIGURED OBJECTIVE MUST NOT APPEAR",
  agents: [{ name: "configured-agent", role: "CONFIGURED AGENT MUST NOT APPEAR", instruction: "agent.md" }],
  default_mode: "direct",
  global_docs: ["GLOBAL GUIDE MUST NOT APPEAR"],
  deploy_modes: [{
    id: "direct",
    label: "Direct",
    objective: "mode.md",
    require_ticket: false,
    mode_type: "interactive",
    skills: [],
    global_docs: ["MODE GUIDE MUST NOT APPEAR"],
  }],
};

function withRegisteredRepo<T>(fn: (root: string, repo: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "rogue-one-core-"));
  const config = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(config);
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "develop"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# Fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n`);
  const previous = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    return fn(root, repo);
  } finally {
    if (previous === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("rogue-one activation is exact and configured mode is not rewritten or warned ignored", () => {
  assert.equal(isRogueOneTeam("rogue-one"), true);
  for (const nearMatch of ["Rogue-One", "rogue_one", "rogue-one-extra", " rogue-one"]) assert.equal(isRogueOneTeam(nearMatch), false);
  assert.equal(normalizeRogueOneDeployRequest({ team: "rogue-one", mode: "direct" }).mode, "direct");
  assert.equal(normalizeRogueOneDeployRequest({ team: "builder", mode: "implement" }).mode, "implement");
  assert.equal(rogueOneModeWarning("rogue-one", "direct"), undefined);
});

test("configured rogue-one execution plan remains immutable, ticket-free and performs zero Git or lease operations", () => {
  withRegisteredRepo((root, repo) => {
    const operations: RepositoryAdmissionOperation[] = [];
    const plan = resolveExecutionPlan({
      request: { team: "rogue-one", mode: "direct", objective: "Ship directly", repo, invocationChannel: "agent-api", force: true },
      teamConfig: rogueTeam,
      mode: rogueTeam.deploy_modes![0],
      runtime: "pi",
      deploymentId: "d-rogue",
      deploymentDir: join(root, "deployments", "d-rogue"),
      activityLogPath: join(root, "activity.jsonl"),
      environment: { PA_MODE: "implement", PA_TICKET_ID: "" },
      timeoutSeconds: 60,
      skillsDir: join(root, "missing-skills"),
      observeRepositoryAdmissionOperation: (operation) => operations.push(operation),
      captureRepositoryGitSnapshot: () => { throw new Error("rogue-one must not inspect Git"); },
    });

    assert.equal(plan.team, "rogue-one");
    assert.equal(plan.mode, "direct");
    assert.equal(plan.rogue_one, true);
    assert.equal(plan.invocation_channel, "agent-api");
    assert.equal(plan.ticketRequired, false);
    assert.equal(plan.ticket, undefined);
    assert.equal(plan.repositoryAdmission.access, "non-locking");
    assert.equal(plan.repositoryAdmission.ownershipIntent, "none");
    assert.deepEqual(operations, []);
    assert.deepEqual(plan.skills, []);
    assert.deepEqual(plan.memoryDocuments, ["GLOBAL GUIDE MUST NOT APPEAR", "MODE GUIDE MUST NOT APPEAR"]);
    assert.equal(plan.objective, "Ship directly");
    assert.equal(plan.environment.PA_MODE, "direct");
    assert.equal(plan.environment.PA_ROGUE_ONE, "1");
    assert.equal(Object.isFrozen(plan), true);
  });
});

test("rogue-one primer preserves the bare objective, context, tools, and audit evidence", () => {
  const primer = generatePrimer({
    runtime: "opencode",
    teamConfig: rogueTeam,
    mode: "rogue-one",
    objective: "Ship directly",
    repository: { repoKey: "pa-platform", repoRoot: "/registered/pa-platform" },
    toolReference: { runtime: "opencode", markdown: "Use runtime tools exposed by this session." },
    rogueOne: true,
    invocationChannel: "agent-api",
    extraInstructions: "<deployment-context>\ndeployment_id: d-rogue\ncwd: /stale\nrepo: /stale\n</deployment-context>",
  });

  assert.match(primer, /Team: rogue-one\nMode: rogue-one/);
  assert.match(primer, /Ship directly/);
  assert.match(primer, /repo_key: pa-platform/);
  assert.match(primer, /repo_root: \/registered\/pa-platform/);
  assert.match(primer, /Use runtime tools exposed by this session/);
  assert.match(primer, /ROGUE-ONE ACTIVE/);
  assert.match(primer, /Invocation channel: agent-api/);
  assert.match(primer, /does not assert direct human approval/);
  for (const excluded of ["CONFIGURED TEAM DESCRIPTION", "CONFIGURED OBJECTIVE", "CONFIGURED AGENT", "GLOBAL GUIDE", "MODE GUIDE", "missing-workflow-skill", "Active Bulletins", "Deployment Instructions", "Mandatory Dirty Repository Intent Contract"]) {
    assert.equal(primer.includes(excluded), false, `primer leaked excluded content: ${excluded}`);
  }
});

for (const runtime of ["pi", "opencode"] as const) {
  test(`${runtime}: bare Rogue-One loads only the common guide allowlist, once, without opt-in`, () => {
    withRegisteredRepo((root, repo) => {
      const fixtures = new Map([
        ["docs/workflow/pi-task-tracking.md", "# Task Guide Fixture"],
        ["docs/workflow/design-charter.md", "# Charter Fixture"],
        ["docs/workflow/html-reporting.md", "# Report Guide Fixture"],
      ]);
      const paths: string[] = [];
      for (const [index, text] of [...fixtures.values()].entries()) writeFileSync(join(root, `${index}.md`), text);
      const primer = generatePrimer({
        runtime, teamConfig: rogueTeam, rogueOne: true, repository: { repoKey: "registered", repoRoot: repo },
        resolveFile(path) {
          assert.ok(fixtures.has(path), `unexpected guide selection: ${path}`);
          paths.push(path);
          return join(root, `${[...fixtures.keys()].indexOf(path)}.md`);
        },
      });
      assert.deepEqual(paths, [...fixtures.keys()]);
      for (const text of fixtures.values()) assert.equal(primer.split(text).length, 2, text);
      assert.match(primer, /No user objective was provided/);
      assert.match(primer, /ROGUE-ONE ACTIVE/);
      assert.doesNotMatch(primer, /CONFIGURED OBJECTIVE|CONFIGURED AGENT|GLOBAL GUIDE|MODE GUIDE/);
    });
  });
}
