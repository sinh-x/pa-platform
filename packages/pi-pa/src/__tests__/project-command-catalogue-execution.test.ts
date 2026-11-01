import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflowDigest } from "@pa-platform/pa-core";
import { RepoContractAuthority } from "../../../pa-core/dist/repo-contract-authority.js";
import { ProjectCommandContract, type ProjectCommandSourceHost } from "../project-command-contract.js";

function fixture(run: (f: { repo: string; worktree: string; file: string; authority: RepoContractAuthority; secret: Buffer; host: ProjectCommandSourceHost; command: string; approve(): void }) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap273-catalogue-execution-")), old = process.env; process.env = { ...old };
  try {
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
    const repo = join(root, "repo"), worktree = join(root, "linked"), config = join(root, "config"); mkdirSync(repo); mkdirSync(config);
    process.env.PA_PLATFORM_CONFIG = config; writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo } } }));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "develop"); const script = Buffer.from("console.log('catalogue-native-check');\n"); writeFileSync(join(repo, "test.cjs"), script);
    git("add", "test.cjs"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture");
    git("worktree", "add", "-q", "-b", "feature/EX-1-catalogue", worktree);
    mkdirSync(join(repo, ".pa"), { mode: 0o700 }); const file = join(repo, ".pa", "project-commands.json");
    const command = "node 'test.cjs'";
    writeFileSync(file, JSON.stringify({ schemaVersion: "project-command-catalogue/v1", repository: { key: "example", root: repo }, effects: ["project-read", "isolated-temp-write"], commands: [
      { id: "unit", executable: realpathSync(process.execPath), argv: ["test.cjs"], environment: {}, readPaths: [], prerequisites: [{ path: "test.cjs", sha256: workflowDigest(script) }], timeoutSeconds: 10, maximumOutputBytes: 1024 },
      { id: "unused", executable: "/nix/store/not-installed-fixture/bin/unused", argv: [], environment: {}, readPaths: [], prerequisites: [{ path: "unused.cjs", sha256: "a".repeat(64) }], timeoutSeconds: 10, maximumOutputBytes: 1024 },
    ] }), { mode: 0o600 });
    const authority = new RepoContractAuthority({ root: join(root, "native"), assertOperator: () => undefined }), secret = Buffer.from("synthetic-catalogue-fixture");
    authority.configure("init", secret);
    const host = { readApproved: (key: string, physical: string) => authority.approved({ key, root: physical }) };
    run({ repo, worktree, file, authority, secret, host, command, approve() { authority.approve(authority.preview({ key: "example", root: repo }), secret); } });
  } finally { process.env = old; rmSync(root, { recursive: true, force: true }); }
}

test("native catalogue executes every selected task check, not unused catalogue members, under unchanged real confinement", () => fixture(f => {
  f.approve(); const profile = ProjectCommandContract.inspect("example", f.repo, f.host)!;
  assert.equal(profile.source, "catalogue"); assert.equal(profile.checks.length, 2);
  const contract = ProjectCommandContract.resolve("example", f.repo, f.worktree, [f.command], f.host)!;
  assert.equal(contract.checks.length, 1); const program = contract.program(contract.checks[0]!);
  const output = execFileSync(program.executable, [...program.argv], { env: program.environment, encoding: "utf8", timeout: 10000 });
  assert.equal(output.trim(), "catalogue-native-check");
  assert.ok(ProjectCommandContract.registrationIdentity("example", f.repo, f.host));
}));

test("native catalogue resolution refuses absent/empty/duplicate/outsider task scope and cannot run a catalogue without native approval", () => fixture(f => {
  assert.throws(() => ProjectCommandContract.resolve("example", f.repo, f.worktree, [f.command], f.host), /EXECUTION_PROJECT_APPROVAL_REQUIRED/);
  f.approve();
  for (const required of [undefined, [], [f.command, f.command], ["node 'outsider.cjs'"]]) assert.throws(() => ProjectCommandContract.resolve("example", f.repo, f.worktree, required, f.host));
}));

test("native catalogue revocation/reset/drift invalidates a running contract before another dispatch without legacy fallback", () => fixture(f => {
  f.approve(); const contract = ProjectCommandContract.resolve("example", f.repo, f.worktree, [f.command], f.host)!;
  const identity = ProjectCommandContract.registrationIdentity("example", f.repo, f.host);
  f.authority.revoke({ key: "example", root: f.repo }, f.secret); assert.throws(() => contract.program(contract.checks[0]!), /EXECUTION_PROJECT_APPROVAL_REVOKED/);
  f.approve(); assert.notEqual(ProjectCommandContract.registrationIdentity("example", f.repo, f.host), identity); assert.throws(() => contract.assertCurrent());
  const next = ProjectCommandContract.resolve("example", f.repo, f.worktree, [f.command], f.host)!;
  const bytes = readFileSync(f.file); writeFileSync(f.file, Buffer.concat([bytes, Buffer.from("\n")])); assert.throws(() => next.assertCurrent(), /EXECUTION_PROJECT_APPROVAL_STALE/);
  writeFileSync(f.file, bytes); f.authority.configure("reset", Buffer.from("synthetic-catalogue-reset-fixture")); assert.throws(() => next.assertCurrent(), /EXECUTION_PROJECT_APPROVAL_REVOKED/);
}));

test("native catalogue binds selected prerequisite bytes and cannot use a linked administrative substitute", () => fixture(f => {
  f.approve(); const contract = ProjectCommandContract.resolve("example", f.repo, f.worktree, [f.command], f.host)!;
  const before = contract.inputIdentity(contract.checks[0]!); assert.match(before, /^[0-9a-f]{64}$/);
  writeFileSync(join(f.worktree, "test.cjs"), "console.log('changed');\n"); assert.throws(() => contract.program(contract.checks[0]!), /EXECUTION_PROJECT_CONTRACT_INVALID/);
  mkdirSync(join(f.worktree, ".pa")); writeFileSync(join(f.worktree, ".pa", "project-commands.json"), readFileSync(f.file));
  assert.throws(() => ProjectCommandContract.inspectWorktree("example", f.repo, f.worktree, [f.command], f.host), /EXECUTION_PROJECT_SOURCE_CONFLICT/);
}));
