import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { resolveExecutionPlan } from "../deploy/plan.js";
import type { TeamConfig } from "../types.js";

function team(skill: string): TeamConfig {
  return {
    name: "builder",
    description: "builder",
    objective: "objective",
    agents: [],
    default_mode: "implement",
    deploy_modes: [{ id: "implement", label: "Implement", skills: [{ name: skill, "inject-as": "reference" }] }],
  };
}

test("execution plans are immutable and resolve selected skill paths", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-plan-"));
  const skillPath = join(root, "pa-cli", "SKILL.md");
  mkdirSync(join(root, "pa-cli"));
  writeFileSync(skillPath, "# pa-cli\n");
  const plan = resolveExecutionPlan({
    request: { team: "builder", mode: "implement" },
    teamConfig: team("pa-cli"),
    mode: team("pa-cli").deploy_modes?.[0],
    runtime: "pi",
    deploymentId: "d-plan01",
    deploymentDir: root,
    activityLogPath: join(root, "activity.jsonl"),
    environment: { PA_TEAM: "builder" },
    timeoutSeconds: 60,
    skillsDir: root,
  });
  assert.equal(plan.skills[0]?.path, skillPath);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.skills), true);
});

test("missing selected skills fail with team, mode, name, and attempted path", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-plan-missing-"));
  assert.throws(() => resolveExecutionPlan({
    request: { team: "builder", mode: "implement" },
    teamConfig: team("missing"),
    mode: team("missing").deploy_modes?.[0],
    runtime: "pi",
    deploymentId: "d-plan02",
    deploymentDir: root,
    activityLogPath: join(root, "activity.jsonl"),
    environment: {},
    timeoutSeconds: 60,
    skillsDir: root,
  }), /team 'builder'.*mode 'implement'.*skill 'missing'.*attempted path/);
});
