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

test("deploy CLI resolves omitted repository identity and relocates the adapter hook to the configured root", async () => {
  await withFixture("cwd", async (fixture) => {
    const registeredNested = join(fixture.repo, "nested");
    const worktreeNested = join(fixture.worktree, "nested");
    mkdirSync(registeredNested);
    mkdirSync(worktreeNested);

    for (const invokingCwd of [fixture.repo, registeredNested, fixture.worktree, worktreeNested]) {
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

test("deploy CLI rejects ambiguous omitted CWD identity before the adapter hook", async () => {
  await withFixture("ambiguous", async (fixture) => {
    const second = join(fixture.root, "second-registered");
    const invokingWorktree = join(fixture.root, "invoking-worktree");
    git(["worktree", "add", "-b", "feature/second", second], fixture.repo);
    git(["worktree", "add", "-b", "feature/invoking", invokingWorktree], fixture.repo);
    writeFileSync(join(fixture.config, "config.yaml"), `repos:\n  first:\n    path: ${fixture.repo}\n  second:\n    path: ${second}\n`);
    process.chdir(invokingWorktree);
    let hookCalls = 0;
    const captured = capture();
    const code = await runCoreCommand(["deploy", "builder", "--mode", "implement"], {
      io: captured.io,
      hooks: { deploy: () => {
        hookCalls += 1;
        return { status: "pending", deploymentId: "d-forbidden" };
      } },
    });
    assert.equal(code, 1);
    assert.equal(hookCalls, 0);
    assert.match(captured.stderr.join("\n"), /registered project paths only.*ambiguous.*first.*second/is);
  });
});

test("deploy and branch help document the registered-path-only contract", async () => {
  const deploy = capture();
  const branch = capture();
  assert.equal(await runCoreCommand(["deploy", "--help"], { io: deploy.io }), 0);
  assert.equal(await runCoreCommand(["branch", "--help"], { io: branch.io }), 0);
  assert.match(deploy.stdout.join("\n"), /registered repository key or exact configured path/i);
  assert.match(deploy.stdout.join("\n"), /infer CWD identity and relocate to the configured path/i);
  assert.match(branch.stdout.join("\n"), /operate only at its exact configured registered path/i);
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
