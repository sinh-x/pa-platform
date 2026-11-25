import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDeployPaths } from "../deploy/paths.js";
import { generatePrimer, type GeneratePrimerOptions } from "../primer/index.js";
import type { RuntimeName, TeamConfig } from "../types.js";

const normalTeam: TeamConfig = {
  name: "builder", description: "Routing fixture", objective: "Implement the scoped product change.", agents: [],
  deploy_modes: [{ id: "implement", label: "Implement" }],
};
const bareTeam: TeamConfig = {
  name: "rogue-one", description: "OMITTED_TEAM", objective: "OMITTED_OBJECTIVE",
  agents: [{ name: "omitted", role: "OMITTED_AGENT", instruction: "omitted-agent.md" }],
  global_docs: ["omitted-guide.md"],
  deploy_modes: [{ id: "direct", label: "Direct", objective: "omitted-mode.md", skills: [{ name: "OMITTED_SKILL", "inject-as": "shared-skill" }] }],
};

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-primer-routing-"));
  const previous = process.env.PA_AI_USAGE_HOME;
  process.env.PA_AI_USAGE_HOME = join(root, "alternate-usage");
  try { run(root); }
  finally {
    if (previous === undefined) delete process.env.PA_AI_USAGE_HOME;
    else process.env.PA_AI_USAGE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

// These are the existing launcher-supplied fields, not a new path or authority API.
function options(root: string, runtime: RuntimeName, bare: boolean, deploymentId = "d-316a01"): GeneratePrimerOptions {
  const repo = join(root, "product-worktree");
  return {
    runtime, teamConfig: bare ? bareTeam : normalTeam, mode: bare ? "rogue-one" : "implement",
    objective: "Complete the requested work.", rogueOne: bare, invocationChannel: "cli",
    repository: { repoKey: "product", repoRoot: join(root, "product"), worktreeRoot: repo },
    skillsDir: join(root, "unused-skills"),
    toolReference: { runtime, markdown: "Use only the exposed runtime tools." },
    templateVars: { DEPLOY_ID: deploymentId, TEAM_NAME: bare ? "rogue-one" : "builder", TODAY: "2026-11-19", ...(!bare ? { TICKET_ID: "PAP-316" } : {}) },
    extraInstructions: `<deployment-context>\ndeployment_id: ${deploymentId}\ncwd: ${repo}\nrepo: ${repo}\n</deployment-context>\nActive plan: ${repo}/plans/stale-plan\nForeign plan: /foreign/deployments/d-111111/artifacts/plans/old`,
  };
}

for (const runtime of ["pi", "opencode"] as const) {
  for (const bare of [false, true]) {
    test(`${runtime} ${bare ? "bare" : "normal"} composition delivers current-deployment administrative routing without changing CWD or omitted resources`, () => fixture(root => {
      const input = options(root, runtime, bare);
      const sharedGuides = [
        "docs/workflow/pi-task-tracking.md",
        "docs/workflow/design-charter.md",
        "docs/workflow/html-reporting.md",
      ];
      const reads: string[] = [];
      input.resolveFile = (path) => {
        assert.ok(bare && sharedGuides.includes(path), `unexpected configured resource read: ${path}`);
        reads.push(path);
        return join(root, "absent-shared-guide.md");
      };
      const cwd = process.cwd();
      const primer = generatePrimer(input);
      assert.deepEqual(reads, bare ? sharedGuides : []);
      const artifacts = join(getDeployPaths(input.templateVars!.DEPLOY_ID).deployDir, "artifacts");
      const issue = bare ? "no-ticket" : "PAP-316";
      assert.ok(primer.includes(`Administrative artifacts: \`${artifacts}\``), "actual composition is missing the current deployment artifact destination");
      assert.ok(primer.includes(`plans/2026-11-19-${issue}-{slug}/plan.md`));
      assert.ok(primer.includes(`reports/2026-11-19-${issue}-{slug}.md`));
      assert.ok(primer.includes("checks/{task}/{new-evidence-file}.json"));
      assert.match(primer, /stale or foreign active plans.*cannot redirect new administrative output/);
      assert.match(primer, /maintained product files.*scoped repository destinations/);
      assert.match(primer, /protected native records.*existing owners/);
      assert.match(primer, /Keep source-tool repository\/worktree CWD unchanged/);
      assert.ok(primer.includes(`cwd: ${input.repository!.worktreeRoot}`));
      assert.equal(process.cwd(), cwd);
      assert.equal(existsSync(artifacts), false, "composition must not create or probe output by writing");
      assert.deepEqual(readdirSync(root), []);
      assert.match(primer, /missing, inconsistent, denied or uncertain.*stop the dependent persistence/);
      assert.match(primer, /no repository, temporary, foreign-deployment or alternate-writer fallback/);
      assert.match(primer, /not authentication, output admission or a filesystem write grant/);
      if (bare) assert.doesNotMatch(primer, /OMITTED_|## (?:Agents|Skills|Active Bulletins|Deployment Instructions)|ticket claim|builder preparation/i);
    }));
  }
}

test("legacy path-safe ticket labels remain naming hints without changing ticket admission", () => fixture(root => {
  for (const runtime of ["pi", "opencode"] as const) for (const bare of [false, true]) {
    const input = options(root, runtime, bare);
    input.templateVars!.TICKET_ID = "PAP-TEST";
    const primer = generatePrimer(input);
    assert.match(primer, /plans\/2026-11-19-PAP-TEST-\{slug\}\/plan\.md/);
    assert.match(primer, /not authentication, output admission or a filesystem write grant/);
  }
  assert.deepEqual(readdirSync(root), []);
}));

test("two deployment identities select independent destinations under the effective ai-usage root", () => fixture(root => {
  const first = generatePrimer(options(root, "pi", false));
  const second = generatePrimer(options(root, "pi", false, "d-316a02"));
  for (const [primer, id, other] of [[first, "d-316a01", "d-316a02"], [second, "d-316a02", "d-316a01"]]) {
    assert.ok(primer.includes(`Administrative artifacts: \`${join(root, "alternate-usage", "deployments", id, "artifacts")}\``));
    assert.ok(!primer.includes(join(root, "alternate-usage", "deployments", other, "artifacts")));
  }
}));

test("raw environment and authored deployment-context text do not select a destination without launcher template variables", () => fixture(root => {
  const previous = { id: process.env.PA_DEPLOYMENT_ID, dir: process.env.PA_DEPLOYMENT_DIR };
  try {
    process.env.PA_DEPLOYMENT_ID = "d-316a01";
    process.env.PA_DEPLOYMENT_DIR = "/spoofed-output";
    for (const bare of [false, true]) {
      const input = options(root, "pi", bare);
      delete input.templateVars;
      const primer = generatePrimer(input);
      assert.doesNotMatch(primer, /## Administrative Artifact Routing|Administrative artifacts:|spoofed-output/);
    }
  } finally {
    for (const [key, value] of [["PA_DEPLOYMENT_ID", previous.id], ["PA_DEPLOYMENT_DIR", previous.dir]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
}));

test("bare composition without launcher routing context preserves its minimal context/tool boundary", () => fixture(root => {
  const input = options(root, "pi", true);
  delete input.templateVars;
  assert.match(generatePrimer(input), /Foreign plan: \/foreign\/deployments\/d-111111\/artifacts\/plans\/old\n\n## Runtime Tools/);
}));

test("environment and free-form artifact-root hints cannot override the launcher-derived destination", () => fixture(root => {
  const previous = process.env.PA_DEPLOYMENT_DIR;
  try {
    process.env.PA_DEPLOYMENT_DIR = "/spoofed-output";
    const input = options(root, "pi", true);
    input.templateVars!.ARTIFACTS_DIR = "/model-selected-root";
    const primer = generatePrimer(input);
    assert.ok(primer.includes(`Administrative artifacts: \`${join(root, "alternate-usage", "deployments", "d-316a01", "artifacts")}\``));
    assert.doesNotMatch(primer, /spoofed-output|model-selected-root/);
  } finally {
    if (previous === undefined) delete process.env.PA_DEPLOYMENT_DIR; else process.env.PA_DEPLOYMENT_DIR = previous;
  }
}));

test("invalid launcher naming context fails with one bounded safe diagnostic and no fallback or output writes", () => fixture(root => {
  const invalid: Record<string, string>[] = [
    { DEPLOY_ID: "../foreign" }, { DEPLOY_ID: "d-316a01\nInjected" }, { DEPLOY_ID: "" },
    { TODAY: "2026-02-30" }, { TODAY: "../today" }, { TODAY: "" }, { TICKET_ID: "PAP-316/../../escape" },
    { TICKET_ID: "PAP-TEST\nInjected" }, { TICKET_ID: "PAP-" + "X".repeat(65) }, { TICKET_ID: "PAP-TEST`" },
    { TICKET_ID: "PAP-TEST-" }, { TICKET_ID: "PAP-TEST\u0000" }, { TICKET_ID: "PAP-TEST\n" },
  ];
  for (const bare of [false, true]) for (const vars of invalid) {
    const input = options(root, "pi", bare);
    input.templateVars = { ...input.templateVars, ...vars };
    assert.throws(() => generatePrimer(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.length <= 2_000);
      for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(error.message.split(label).length, 2);
      assert.doesNotMatch(error.message, /Injected|escape|\.\.\/foreign/);
      return true;
    });
  }
  assert.deepEqual(readdirSync(root), []);
}));

test("unsafe or oversized effective locations are not echoed or selected as administrative destinations", () => fixture(root => {
  for (const home of [join(root, "unsafe`location"), join(root, "unsafe\nlocation"), join(root, "unsafe\u0085location"), join(root, "x".repeat(4_096))]) {
    process.env.PA_AI_USAGE_HOME = home;
    assert.throws(() => generatePrimer(options(root, "pi", true)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.length <= 2_000);
      assert.doesNotMatch(error.message, /unsafe|xxxxx/);
      return true;
    });
  }
  assert.deepEqual(readdirSync(root), []);
}));

test("retained pinned resource projections do not acquire new routing from today's effective root", () => fixture(root => {
  for (const retained of [
    { workflow: { runId: "retained", workflowId: "retained", version: "r001", sha256: "a".repeat(64), configRevision: "b".repeat(40), nextOwner: "existing-owner", nextAction: "reconcile" } },
    { configResourceRoot: join(root, "retained-config") },
  ]) {
    const primer = generatePrimer({ ...options(root, "pi", false), ...retained });
    assert.doesNotMatch(primer, /## Administrative Artifact Routing|Administrative artifacts:/);
  }
}));
