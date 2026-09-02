import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activateRepositoryLifecycle, constrainRuntimeProcess, finalizeRepositoryLifecycle, type ExecutionPlan } from "../index.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "pa-process-sandbox-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "develop"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "readable\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  return { root, repo };
}

function plan(root: string, repo: string, id: string, access: "read-only" | "mutating"): ExecutionPlan {
  const deploymentDir = join(root, "deployments", id);
  mkdirSync(deploymentDir, { recursive: true });
  return Object.freeze({
    runtime: "opencode", team: "test", mode: "inspect", repoKey: "registered", repoRoot: repo,
    repositoryCwd: repo, memoryDocumentRoot: repo, repositoryAccess: access, ticketRequired: false,
    objective: "test", skills: Object.freeze([]), memoryDocuments: Object.freeze([]),
    environment: Object.freeze({ PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: deploymentDir, PA_REPO: repo }),
    timeoutSeconds: 60,
    lifecycle: Object.freeze({ deploymentId: id, deploymentDir, activityLogPath: join(deploymentDir, "activity.jsonl"), registryDbPath: join(root, "registry.db"), terminalMarker: join(deploymentDir, "terminal.json") }),
  });
}

test("preserves mutator commands and reader argument boundaries", () => {
  const f = fixture();
  try {
    const originalArgs = ["space value", "'quote'", "--", "", "$(touch nope)"];
    const mutating = constrainRuntimeProcess(plan(f.root, f.repo, "d-owner", "mutating"), "runtime", originalArgs, f.repo);
    assert.equal(mutating.command, "runtime");
    assert.equal(mutating.args, originalArgs);

    const reader = constrainRuntimeProcess(plan(f.root, f.repo, "d-reader", "read-only"), "runtime", originalArgs, f.repo);
    assert.equal(reader.command, "bwrap");
    assert.deepEqual(reader.args.slice(-originalArgs.length - 1), ["runtime", ...originalArgs]);
    assert.deepEqual(reader.args.slice(0, 3), ["--ro-bind", "/", "/"]);
    assert.ok(reader.args.includes("--ro-bind"));
    assert.deepEqual(reader.args.slice(reader.args.indexOf("--chdir"), reader.args.indexOf("--chdir") + 3), ["--chdir", f.repo, "--"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("missing Bubblewrap fails closed without running the unprotected command", () => {
  const f = fixture();
  try {
    const marker = join(f.root, "unprotected-runtime-ran");
    const reader = constrainRuntimeProcess(plan(f.root, f.repo, "d-reader", "read-only"), process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], f.repo);
    const result = spawnSync(reader.command, [...reader.args], { cwd: reader.cwd, env: { PATH: "" } });
    assert.equal(result.status, null);
    assert.equal(result.error?.code, "ENOENT");
    assert.equal(existsSync(marker), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const hasBubblewrap = spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;

test("a live mutator and sandboxed reader coexist while file and branch writes fail", { skip: !hasBubblewrap }, () => {
  const f = fixture();
  try {
    const owner = activateRepositoryLifecycle(plan(f.root, f.repo, "d-owner", "mutating"));
    const readerPlan = activateRepositoryLifecycle(plan(f.root, f.repo, "d-reader", "read-only"));
    const script = [
      "const fs=require('node:fs'),cp=require('node:child_process');",
      "if(fs.readFileSync('README.md','utf8')!=='readable\\n')process.exit(10);",
      "let blocked=false;try{fs.writeFileSync('forbidden.txt','no')}catch(e){blocked=e.code==='EROFS'||e.code==='EACCES'}",
      "if(!blocked)process.exit(11);",
      "const branch=cp.spawnSync('git',['checkout','-b','forbidden-reader-branch'],{stdio:'ignore'});",
      "if(branch.status===0)process.exit(12);",
      "if(process.cwd()!==process.argv[1])process.exit(13);",
    ].join("");
    const launch = constrainRuntimeProcess(readerPlan, process.execPath, ["-e", script, f.repo], f.repo);
    const result = spawnSync(launch.command, [...launch.args], { cwd: launch.cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.repo, "forbidden.txt")), false);
    assert.equal(git(f.repo, ["branch", "--show-current"]), "develop");
    assert.equal(git(f.repo, ["status", "--porcelain"]), "");
    assert.ok(owner.repositoryLease?.leasePath && existsSync(owner.repositoryLease.leasePath));
    assert.equal(finalizeRepositoryLifecycle(readerPlan).ok, true);
    assert.equal(finalizeRepositoryLifecycle(owner).ok, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
