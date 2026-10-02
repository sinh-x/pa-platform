import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentApiApp, DEFAULT_DEPLOY_TIMEOUT_SECONDS, MAX_REPOSITORY_DIAGNOSTIC_CHARS, formatBoundedFiveFieldDiagnostic, generatePrimer, runCoreCommand, type DeployRequest, type TeamConfig } from "../index.js";

const teamConfig: TeamConfig = {
  name: "builder",
  description: "Builder",
  objective: "Build",
  agents: [],
  default_mode: "implement",
  deploy_modes: [{ id: "implement", label: "Implement" }],
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initializeRepo(path: string): void {
  mkdirSync(path);
  git(["init", "-b", "develop"], path);
  git(["config", "user.email", "test@example.com"], path);
  git(["config", "user.name", "Test"], path);
  writeFileSync(join(path, "README.md"), "# Test\n");
  git(["add", "README.md"], path);
  git(["commit", "-m", "initial"], path);
}

interface Fixture {
  root: string;
  config: string;
  repo: string;
  otherRepo: string;
  worktree: string;
  aiUsage: string;
}

function createFixture(name: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `pa-core-deploy-cli-${name}-`));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const otherRepo = join(root, "other-repo");
  const worktree = join(root, "worktree");
  const aiUsage = join(root, "ai-usage");
  mkdirSync(config);
  mkdirSync(join(aiUsage, "tickets"), { recursive: true });
  initializeRepo(repo);
  initializeRepo(otherRepo);
  git(["remote", "add", "origin", "git@github.com:owner/project.git"], repo);
  git(["worktree", "add", "-b", `feature/${name}`, worktree], repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n    remote_url: git@github.com:owner/project.git\n  other:\n    path: ${otherRepo}\n`);
  return { root, config, repo, otherRepo, worktree, aiUsage };
}

function writeTicket(fixture: Fixture, id: string, project: string): void {
  writeFileSync(join(fixture.aiUsage, "tickets", `${id}.json`), JSON.stringify({ id, project, title: id }));
}

function assertFiveFieldDiagnostic(value: string): void {
  assert.match(value, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
  assert.ok(value.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS, `diagnostic length ${value.length} exceeded the bound`);
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

async function withFixture(name: string, callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = createFixture(name);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const previousAiUsage = process.env["PA_AI_USAGE_HOME"];
  const originalCwd = process.cwd();
  process.env["PA_PLATFORM_CONFIG"] = fixture.config;
  process.env["PA_AI_USAGE_HOME"] = fixture.aiUsage;
  try {
    await callback(fixture);
  } finally {
    process.chdir(originalCwd);
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    if (previousAiUsage === undefined) delete process.env["PA_AI_USAGE_HOME"];
    else process.env["PA_AI_USAGE_HOME"] = previousAiUsage;
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("deploy CLI resolves omitted repository identity from the exact configured root", async () => {
  await withFixture("cwd", async (fixture) => {
    const registeredNested = join(fixture.repo, "nested");
    mkdirSync(registeredNested);

    for (const invokingCwd of [fixture.repo, registeredNested]) {
      const seen: Array<{ request: DeployRequest; cwd: string; primer: string }> = [];
      const captured = capture();
      process.chdir(invokingCwd);
      const code = await runCoreCommand(["deploy", "builder", "--mode", "implement"], {
        io: captured.io,
        hooks: { deploy: (request) => {
          const cwd = process.cwd();
          const primer = generatePrimer({
            runtime: "pi",
            teamConfig,
            mode: "implement",
            objective: "Execute the canonical repository phase.",
            extraInstructions: `<deployment-context>\ncwd: ${cwd}\nrepo_root: /stale\npa_env_vars:\n  PA_REPO: ${request.repo ?? ""}\n</deployment-context>`,
          });
          seen.push({ request, cwd, primer });
          return { status: "pending", deploymentId: "d-hook" };
        } },
      });
      assert.equal(code, 0, captured.stderr.join("\n"));
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.request.repo, fixture.repo);
      assert.equal(seen[0]!.cwd, fixture.repo);
      assert.equal(seen[0]!.primer.match(/^## Additional Instructions$/gm)?.length, 1);
      assert.match(seen[0]!.primer, /^repo_key: registered$/m);
      assert.match(seen[0]!.primer, new RegExp(`^repo_root: ${fixture.repo}$`, "m"));
      assert.match(seen[0]!.primer, new RegExp(`^cwd: ${fixture.repo}$`, "m"));
      assert.match(seen[0]!.primer, new RegExp(`^  PA_REPO: ${fixture.repo}$`, "m"));
      assert.equal(process.cwd(), invokingCwd, "CLI must restore the operator's invoking CWD after the hook returns");
    }
  });
});

test("deploy CLI rejects non-registered explicit path forms before the adapter hook", async () => {
  await withFixture("explicit", async (fixture) => {
    const nested = join(fixture.repo, "nested");
    const alias = join(fixture.root, "alias");
    const nonGit = join(fixture.root, "non-git");
    const clone = join(fixture.root, "clone");
    mkdirSync(nested);
    mkdirSync(nonGit);
    symlinkSync(fixture.repo, alias, "dir");
    git(["clone", fixture.repo, clone], fixture.root);
    git(["remote", "set-url", "origin", "git@github.com:owner/project.git"], clone);
    process.chdir(fixture.repo);

    let hookCalls = 0;
    for (const repoInput of [nested, fixture.worktree, clone, alias, nonGit, join(fixture.root, "missing")]) {
      const captured = capture();
      const code = await runCoreCommand(["deploy", "builder", "--mode", "implement", "--repo", repoInput], {
        io: captured.io,
        hooks: { deploy: () => {
          hookCalls += 1;
          return { status: "pending", deploymentId: "d-forbidden" };
        } },
      });
      const diagnostic = captured.stderr.join("\n");
      assert.equal(code, 1, `input unexpectedly accepted: ${repoInput}`);
      assert.match(diagnostic, /registered project paths only/i);
      assert.match(diagnostic, /Corrective action/i);
      assert.ok(diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
    }
    assert.equal(hookCalls, 0, "invalid repository inputs must start zero adapter/runtime processes");
  });
});

test("ppa deploy preserves authenticated linked-worktree CWD while non-Pi adapters reject it", async () => {
  await withFixture("linked-cwd", async (fixture) => {
    const nested = join(fixture.worktree, "nested");
    mkdirSync(nested);
    process.chdir(nested);

    const seen: Array<{ request: DeployRequest; cwd: string }> = [];
    const accepted = capture();
    const acceptedCode = await runCoreCommand(["deploy", "builder", "--mode", "implement"], {
      binaryName: "ppa",
      io: accepted.io,
      hooks: { deploy: (request) => {
        seen.push({ request, cwd: process.cwd() });
        return { status: "pending", deploymentId: "d-worktree" };
      } },
    });
    assert.equal(acceptedCode, 0, accepted.stderr.join("\n"));
    assert.deepEqual(seen.map(({ request, cwd }) => ({ team: request.team, mode: request.mode, cwd })), [{ team: "builder", mode: "implement", cwd: fixture.worktree }]);
    assert.equal(process.cwd(), nested);

    let rejectedHookCalls = 0;
    const rejected = capture();
    const rejectedCode = await runCoreCommand(["deploy", "builder", "--mode", "implement"], {
      binaryName: "opa",
      io: rejected.io,
      hooks: { deploy: () => {
        rejectedHookCalls += 1;
        return { status: "pending", deploymentId: "d-forbidden" };
      } },
    });
    const diagnostic = rejected.stderr.join("\n");
    assert.equal(rejectedCode, 1);
    assert.equal(rejectedHookCalls, 0);
    assert.match(diagnostic, /registered project paths only.*linked Git working tree/is);
    assert.match(diagnostic, /Corrective action/i);
    assert.ok(diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
  });
});

test("ppa parented explicit selectors preserve the authenticated linked-worktree handoff", async () => {
  await withFixture("parented-selector", async (fixture) => {
    const inheritedKeys = ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE", "PA_MAX_RUNTIME"] as const;
    const previous = Object.fromEntries(inheritedKeys.map((key) => [key, process.env[key]])) as Record<(typeof inheritedKeys)[number], string | undefined>;
    delete process.env["PA_MAX_RUNTIME"];
    Object.assign(process.env, {
      PA_DEPLOYMENT_ID: "d-parent",
      PA_DEPLOYMENT_DIR: join(fixture.root, "deployments", "d-parent"),
      PA_TEAM: "builder",
      PA_MODE: "orchestrator",
    });
    process.chdir(fixture.worktree);
    try {
      for (const selector of ["registered", fixture.repo]) {
        const captured = capture();
        const seen: Array<{ request: DeployRequest; cwd: string }> = [];
        const code = await runCoreCommand(["deploy", "builder", "--mode", "implement", "--background", "--repo", selector], {
          binaryName: "ppa",
          io: captured.io,
          hooks: { deploy: (request) => {
            seen.push({ request, cwd: process.cwd() });
            return { status: "pending", deploymentId: "d-child" };
          } },
        });
        assert.equal(code, 0, captured.stderr.join("\n"));
        assert.deepEqual(seen, [{ request: { team: "builder", mode: "implement", background: true, repo: fixture.repo, timeout: DEFAULT_DEPLOY_TIMEOUT_SECONDS }, cwd: fixture.worktree }]);
        assert.equal(process.cwd(), fixture.worktree);
      }

      let hookCalls = 0;
      for (const selector of ["wrong-repository", "other", fixture.otherRepo]) {
        const rejected = capture();
        assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "implement", "--background", "--repo", selector], {
          binaryName: "ppa",
          io: rejected.io,
          hooks: { deploy: () => { hookCalls += 1; return { status: "pending", deploymentId: "d-forbidden" }; } },
        }), 1);
        const diagnostic = rejected.stderr.join("\n");
        assert.match(diagnostic, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
        assert.match(diagnostic, /expected canonical_root=.*parent_worktree=/s);
        assert.match(diagnostic, /observed selector_root=.*invocation_cwd=.*git_top_level=/s);
        assert.ok(diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
      }
      assert.equal(hookCalls, 0);
    } finally {
      for (const key of inheritedKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

test("ticket-worktree intent reaches only the eligible PPA CLI adapter boundary", async () => {
  await withFixture("ticket-worktree-boundary", async (fixture) => {
    writeTicket(fixture, "PAP-234", "registered");
    process.chdir(fixture.repo);

    for (const selector of [undefined, "registered", fixture.repo]) {
      const captured = capture();
      const seen: Array<{ request: DeployRequest; cwd: string }> = [];
      const selectorArgs = selector ? ["--repo", selector] : [];
      const code = await runCoreCommand(["deploy", "requirements", "--mode", "analyze", "--ticket", "PAP-234", "--ticket-worktree", "--timeout", String(DEFAULT_DEPLOY_TIMEOUT_SECONDS), ...selectorArgs], {
        binaryName: "ppa",
        io: captured.io,
        hooks: { deploy: (request) => {
          seen.push({ request, cwd: process.cwd() });
          return { status: "pending", deploymentId: "d-selection" };
        } },
      });
      assert.equal(code, 0, captured.stderr.join("\n"));
      assert.deepEqual(seen, [{
        request: {
          team: "requirements",
          mode: "analyze",
          repo: fixture.repo,
          ticket: "PAP-234",
          timeout: DEFAULT_DEPLOY_TIMEOUT_SECONDS,
          ticketWorktree: true,
          invocationChannel: "cli",
        },
        cwd: fixture.repo,
      }]);
    }

    let rejectedHookCalls = 0;
    for (const binaryName of ["opa", "cpa", "dpa", "pa-core"]) {
      const captured = capture();
      const code = await runCoreCommand(["deploy", "requirements", "--mode", "analyze", "--ticket", "PAP-234", "--ticket-worktree"], {
        binaryName,
        io: captured.io,
        hooks: { deploy: () => { rejectedHookCalls += 1; return { status: "pending", deploymentId: "d-forbidden" }; } },
      });
      assert.equal(code, 1, `${binaryName} unexpectedly accepted --ticket-worktree`);
      assertFiveFieldDiagnostic(captured.stderr.join("\n"));
    }

    for (const args of [
      ["deploy", "requirements", "--mode", "analyze", "--ticket-worktree"],
      ["deploy", "builder", "--mode", "orchestrator", "--ticket", "PAP-234", "--ticket-worktree"],
    ]) {
      const captured = capture();
      const code = await runCoreCommand(args, {
        binaryName: "ppa",
        io: captured.io,
        hooks: { deploy: () => { rejectedHookCalls += 1; return { status: "pending", deploymentId: "d-forbidden" }; } },
      });
      assert.equal(code, 1);
      assertFiveFieldDiagnostic(captured.stderr.join("\n"));
    }
    assert.equal(rejectedHookCalls, 0, "unsupported binaries, missing tickets, and builders must not reach adapter execution");
  });
});

test("ticket-worktree canonical selector and ticket project gates reject before adapter execution", async () => {
  await withFixture("ticket-worktree-repository", async (fixture) => {
    writeTicket(fixture, "PAP-234", "registered");
    writeTicket(fixture, "PAP-235", "other");
    process.chdir(fixture.repo);
    let hookCalls = 0;

    for (const args of [
      ["--ticket", "PAP-234", "--repo", fixture.worktree],
      ["--ticket", "PAP-235", "--repo", "registered"],
      ["--ticket", "PAP-999", "--repo", "registered"],
      ["--ticket", "PAP-234", "--repo", "x".repeat(4_000)],
    ]) {
      const captured = capture();
      const code = await runCoreCommand(["deploy", "requirements", "--mode", "analyze", "--ticket-worktree", ...args], {
        binaryName: "ppa",
        io: captured.io,
        hooks: { deploy: () => { hookCalls += 1; return { status: "pending", deploymentId: "d-forbidden" }; } },
      });
      assert.equal(code, 1);
      assertFiveFieldDiagnostic(captured.stderr.join("\n"));
    }
    assert.equal(hookCalls, 0);
  });
});

test("Agent API exposes no ticket-worktree request capability", async () => {
  await withFixture("ticket-worktree-api", async () => {
    let hookCalls = 0;
    const deploy = () => { hookCalls += 1; return { status: "pending" as const, deploymentId: "d-forbidden" }; };
    const api = createAgentApiApp({ hooks: { runtimeHooks: { opencode: { deploy }, pi: { deploy } } } });
    try {
      for (const ticketWorktree of [true, false]) {
        const response = await api.app.request("/api/deploy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ team: "requirements", mode: "analyze", runtime: "pi", ticket: "PAP-234", ticketWorktree }),
        });
        assert.equal(response.status, 400);
        const body = await response.json() as { error: string; code: string };
        assert.equal(body.code, "BAD_REQUEST");
        assertFiveFieldDiagnostic(body.error);
      }
      assert.equal(hookCalls, 0, "Agent API attempts must reject before runtime hook execution");
    } finally {
      api.cleanup();
    }
  });
});

test("source completions define a PPA-only ticket-worktree generation contract", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const source = readFileSync(join(repositoryRoot, "completions", "pa-core.fish"), "utf8");
  const generator = readFileSync(join(repositoryRoot, "scripts", "dev", "generate_completions.sh"), "utf8");
  assert.match(source, /^# PPA_ONLY_DEPLOY_OPTION ticket-worktree$/m);
  assert.doesNotMatch(source, /complete -c pa-core .* -l ticket-worktree/);
  assert.match(generator, /complete -c ppa -n __ppa_deploy_completing -l ticket-worktree/);
  assert.equal((generator.match(/PPA_ONLY_DEPLOY_OPTION ticket-worktree/g) ?? []).length, 4, "one PPA replacement and three non-PPA removals are required");
});

test("five-field repository diagnostics reserve every field under hostile long values", () => {
  const diagnostic = formatBoundedFiveFieldDiagnostic({
    condition: `selector\n${"c".repeat(4_000)}`,
    source: `registry\u0000${"s".repeat(4_000)}`,
    reason: `paths=${"/very-long".repeat(1_000)}`,
    correction: `preserve ${"x".repeat(4_000)}`,
    resumeAction: `retry ${"y".repeat(4_000)}`,
  });
  assert.match(diagnostic, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
  assert.equal(diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS, true);
  assert.doesNotMatch(diagnostic, /[\u0000-\u001f\u007f-\u009f]/);
});

test("ppa and opa deploy help document force and the registered-path-only contract", async () => {
  const opa = capture();
  const ppa = capture();
  const cpa = capture();
  const dpa = capture();
  const core = capture();
  const branch = capture();
  assert.equal(await runCoreCommand(["deploy", "--help"], { binaryName: "opa", io: opa.io }), 0);
  assert.equal(await runCoreCommand(["deploy", "--help"], { binaryName: "ppa", io: ppa.io }), 0);
  assert.equal(await runCoreCommand(["deploy", "--help"], { binaryName: "cpa", io: cpa.io }), 0);
  assert.equal(await runCoreCommand(["deploy", "--help"], { binaryName: "dpa", io: dpa.io }), 0);
  assert.equal(await runCoreCommand(["deploy", "--help"], { binaryName: "pa-core", io: core.io }), 0);
  assert.equal(await runCoreCommand(["branch", "--help"], { io: branch.io }), 0);
  for (const output of [opa.stdout.join("\n"), ppa.stdout.join("\n")]) {
    assert.match(output, /registered repository key or exact configured path/i);
    assert.match(output, /--force\s+Recover stale or malformed builder ownership evidence/);
    assert.match(output, /never overrides a live owner or other guards/);
  }
  assert.match(opa.stdout.join("\n"), /infer the exact configured root from CWD/i);
  assert.match(ppa.stdout.join("\n"), /infer an authenticated primary or linked worktree from CWD/i);
  assert.match(ppa.stdout.join("\n"), /live orchestrator may identify its direct background implement child by key or exact canonical root/i);
  assert.match(ppa.stdout.join("\n"), /protected parent worktree remains the only runtime root/i);
  assert.match(ppa.stdout.join("\n"), /there is no canonical-root execution mode/i);
  assert.match(ppa.stdout.join("\n"), /standalone implement must start.*--repo omitted.*non-Pi adapter behavior is unchanged/i);
  assert.match(ppa.stdout.join("\n"), /--ticket-worktree\s+Select the ticket's existing authenticated worktree.*requires --ticket/i);
  for (const output of [opa, cpa, dpa, core].map((captured) => captured.stdout.join("\n"))) {
    assert.doesNotMatch(output, /--ticket-worktree/);
  }
  assert.match(branch.stdout.join("\n"), /infer an exact configured root from CWD/i);
});

test("deploy CLI propagates force while exact-root and worktree guards remain authoritative", async () => {
  await withFixture("force", async (fixture) => {
    process.chdir(fixture.repo);
    const seen: DeployRequest[] = [];
    const accepted = capture();
    assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "implement", "--repo", "registered", "--timeout", "120", "--force"], {
      binaryName: "ppa",
      io: accepted.io,
      hooks: { deploy: (request) => { seen.push(request); return { status: "pending", deploymentId: "d-force" }; } },
    }), 0, accepted.stderr.join("\n"));
    assert.deepEqual(seen, [{ team: "builder", mode: "implement", repo: fixture.repo, timeout: 120, force: true }]);

    for (const rejectedRepo of [join(fixture.repo, "nested"), fixture.worktree]) {
      if (rejectedRepo.endsWith("nested")) mkdirSync(rejectedRepo);
      const rejected = capture();
      assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "implement", "--repo", rejectedRepo, "--force"], {
        binaryName: "opa",
        io: rejected.io,
        hooks: { deploy: (request) => { seen.push(request); return { status: "pending", deploymentId: "d-forbidden" }; } },
      }), 1);
      assert.match(rejected.stderr.join("\n"), /registered project paths only/i);
      assert.ok(rejected.stderr.join("\n").length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
    }
    assert.equal(seen.length, 1);
  });
});

test("deploy and evaluate accept dotted registry keys and exact paths containing spaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repo-specifiers-"));
  const config = join(root, "config");
  const repo = join(root, "repo with spaces");
  mkdirSync(config);
  initializeRepo(repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered.repo:\n    path: ${repo}\n`);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  process.env["PA_PLATFORM_CONFIG"] = config;
  try {
    for (const repoInput of ["registered.repo", repo]) {
      const deployRequests: DeployRequest[] = [];
      const deployIo = capture();
      assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "implement", "--repo", repoInput], {
        io: deployIo.io,
        hooks: { deploy: (request) => { deployRequests.push(request); return { status: "pending", deploymentId: "d-spec" }; } },
      }), 0, deployIo.stderr.join("\n"));
      assert.equal(deployRequests[0]?.repo, repo);

      const evaluateRequests: DeployRequest[] = [];
      const evaluateIo = capture();
      assert.equal(await runCoreCommand(["evaluate", "d-target", "--repo", repoInput], {
        io: evaluateIo.io,
        hooks: { deploy: (request) => { evaluateRequests.push(request); return { status: "pending", deploymentId: "d-eval" }; } },
      }), 0, evaluateIo.stderr.join("\n"));
      assert.equal(evaluateRequests[0]?.repo, repoInput);
    }
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
