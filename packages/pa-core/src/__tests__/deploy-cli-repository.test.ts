import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_REPOSITORY_DIAGNOSTIC_CHARS, generatePrimer, runCoreCommand, type DeployRequest, type TeamConfig } from "../index.js";

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
  worktree: string;
}

function createFixture(name: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `pa-core-deploy-cli-${name}-`));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  mkdirSync(config);
  initializeRepo(repo);
  git(["remote", "add", "origin", "git@github.com:owner/project.git"], repo);
  git(["worktree", "add", "-b", `feature/${name}`, worktree], repo);
  writeFileSync(join(config, "config.yaml"), `repos:\n  registered:\n    path: ${repo}\n    remote_url: git@github.com:owner/project.git\n`);
  return { root, config, repo, worktree };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

async function withFixture(name: string, callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = createFixture(name);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const originalCwd = process.cwd();
  process.env["PA_PLATFORM_CONFIG"] = fixture.config;
  try {
    await callback(fixture);
  } finally {
    process.chdir(originalCwd);
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
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
    const inheritedKeys = ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_TEAM", "PA_MODE"] as const;
    const previous = Object.fromEntries(inheritedKeys.map((key) => [key, process.env[key]])) as Record<(typeof inheritedKeys)[number], string | undefined>;
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
        assert.deepEqual(seen, [{ request: { team: "builder", mode: "implement", background: true, repo: fixture.repo, timeout: 2700 }, cwd: fixture.worktree }]);
        assert.equal(process.cwd(), fixture.worktree);
      }

      let hookCalls = 0;
      const rejected = capture();
      assert.equal(await runCoreCommand(["deploy", "builder", "--mode", "implement", "--background", "--repo", "wrong-repository"], {
        binaryName: "ppa",
        io: rejected.io,
        hooks: { deploy: () => { hookCalls += 1; return { status: "pending", deploymentId: "d-forbidden" }; } },
      }), 1);
      const diagnostic = rejected.stderr.join("\n");
      assert.equal(hookCalls, 0);
      assert.match(diagnostic, /Condition:.*Source:.*Reason:.*Correction:.*Resume Action:/s);
      assert.match(diagnostic, /expected canonical_root=.*parent_worktree=/s);
      assert.match(diagnostic, /observed selector_root=.*invocation_cwd=.*git_top_level=/s);
      assert.ok(diagnostic.length <= MAX_REPOSITORY_DIAGNOSTIC_CHARS);
    } finally {
      for (const key of inheritedKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

test("ppa and opa deploy help document force and the registered-path-only contract", async () => {
  const opa = capture();
  const ppa = capture();
  const branch = capture();
  assert.equal(await runCoreCommand(["deploy", "--help"], { binaryName: "opa", io: opa.io }), 0);
  assert.equal(await runCoreCommand(["deploy", "--help"], { binaryName: "ppa", io: ppa.io }), 0);
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
