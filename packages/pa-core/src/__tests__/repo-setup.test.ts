import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoSetupService, MAX_REPO_SETUP_REQUEST_BYTES, type RepoSetupCandidateReference, type RepoSetupHost } from "../repo-setup.js";
import { withPreparedTicketCapacity } from "../deploy/ticket-concurrency.js";
import { withVacantRepositorySetup } from "../deploy/repository-admission.js";

function fixture(run: (f: { root: string; repo: string; file: string; config: string; host: RepoSetupHost; candidate: string; request(value: unknown): Record<string, unknown>; git(...args: string[]): string }) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap273-setup-")), old = process.env;
  process.env = { ...old };
  try {
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
    const repo = join(root, "repo"), config = join(root, "config"); mkdirSync(repo); mkdirSync(config);
    process.env.PA_PLATFORM_CONFIG = config;
    writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo } } }));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q", "-b", "feature/example");
    writeFileSync(join(repo, "existing.txt"), "unrelated content\n");
    git("add", "existing.txt"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture");
    writeFileSync(join(repo, "unrelated.txt"), "preserve untracked\n");
    const host = { authenticate: () => ({ key: "example", root: repo }) };
    const candidate = JSON.stringify({ schemaVersion: "project-command-catalogue/v1", repository: { key: "example", root: repo }, effects: ["project-read", "isolated-temp-write"], commands: [
      { id: "unit", executable: "/nix/store/not-present/bin/node", argv: ["test.cjs"], environment: {}, readPaths: [], prerequisites: [{ path: "test.cjs", sha256: "a".repeat(64) }], timeoutSeconds: 60, maximumOutputBytes: 1024 },
    ] });
    run({ root, repo, file: join(repo, ".pa", "project-commands.json"), config, host, candidate, git, request: value => repoSetupService(JSON.stringify(value), host) });
  } finally { process.env = old; rmSync(root, { force: true, recursive: true }); }
}
const code = (result: Record<string, unknown>) => (result.error as { code: string })?.code;

test("repo setup stages only fixed candidate bytes with exact CAS reference and no approval/execution or Git/source changes", () => fixture(f => {
  const head = f.git("rev-parse", "HEAD"), index = readFileSync(join(f.repo, ".git", "index")), exclude = readFileSync(join(f.repo, ".git", "info", "exclude"));
  assert.equal(f.request({ action: "inspect" }).state, "missing"); assert.equal(existsSync(join(f.repo, ".pa")), false);
  const result = f.request({ action: "stage", expected: null, candidate: f.candidate });
  assert.equal(result.ok, true); assert.equal(result.executionReady, false); assert.equal(result.state, "candidate-unapproved");
  const ref = result.candidate as RepoSetupCandidateReference;
  assert.deepEqual(ref.repository, { key: "example", root: f.repo }); assert.equal(ref.path, ".pa/project-commands.json");
  assert.equal(readFileSync(f.file, "utf8"), f.candidate); assert.equal(lstatSync(f.file).mode & 0o777, 0o600); assert.equal(lstatSync(join(f.repo, ".pa")).mode & 0o777, 0o700);
  assert.deepEqual(f.request({ action: "inspect" }).candidate, ref);
  assert.equal(code(f.request({ action: "stage", expected: null, candidate: f.candidate })), "SETUP_STALE");
  const changed = f.request({ action: "stage", expected: ref, candidate: `${f.candidate}\n` });
  assert.equal(changed.ok, true); assert.notDeepEqual(changed.candidate, ref);
  assert.equal(code(f.request({ action: "stage", expected: ref, candidate: f.candidate })), "SETUP_STALE");
  assert.equal(f.git("rev-parse", "HEAD"), head); assert.deepEqual(readFileSync(join(f.repo, ".git", "index")), index);
  assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "preserve untracked\n");
  assert.equal(readFileSync(join(f.repo, "existing.txt"), "utf8"), "unrelated content\n");
  assert.deepEqual(readdirSync(join(f.repo, ".pa")), ["project-commands.json"]); assert.deepEqual(readFileSync(join(f.repo, ".git", "info", "exclude")), exclude);
}));

test("repo setup parser rejects duplicate/unknown fields, oversized/sensitive/malformed candidates and caller grants before any administrative write", () => fixture(f => {
  for (const request of ['{"action":"inspect","action":"stage"}', '{"action":"inspect","approved":true}', JSON.stringify({ action: "stage", expected: null, candidate: "PRIVATE-SENTINEL" }), JSON.stringify({ action: "stage", expected: null, candidate: f.candidate, root: f.repo }), JSON.stringify({ action: "approve" }), " ".repeat(MAX_REPO_SETUP_REQUEST_BYTES + 1)]) {
    const result = repoSetupService(request, f.host); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes("PRIVATE-SENTINEL"), false); assert.equal(existsSync(join(f.repo, ".pa")), false);
  }
  const wrong = { schemaVersion: "repo-setup-candidate/v1", repository: { key: "elsewhere", root: f.repo }, path: ".pa/project-commands.json", sha256: "a".repeat(64) };
  assert.equal(code(f.request({ action: "stage", expected: wrong, candidate: f.candidate })), "SETUP_REQUEST");
}));

for (const name of ["pa-repository-mutation.lease.json", "pa-repository-mutation.implement.lease.json", "pa-repository-mutation.borrower.json", "pa-repository-review.reservation.json", "pa-repository-child-settlement.json"]) {
  test(`repo setup preserves and rejects uncertain retained ${name} at primary or linked checkout`, () => fixture(f => {
    const linked = join(f.root, "linked"); f.git("worktree", "add", "-q", "-b", "feature/linked", linked);
    const metadata = f.git("-C", linked, "rev-parse", "--absolute-git-dir");
    for (const dir of [join(f.repo, ".git"), metadata]) {
      const file = join(dir, name); writeFileSync(file, "malformed-retained-evidence", { mode: 0o600 });
      assert.equal(code(f.request({ action: "stage", expected: null, candidate: f.candidate })), "SETUP_BUSY");
      assert.equal(readFileSync(file, "utf8"), "malformed-retained-evidence"); assert.equal(existsSync(f.file), false); rmSync(file);
    }
  }));
}

test("repo setup refuses retained capacity and forged/expired owners without reclaiming evidence", () => fixture(f => {
  withPreparedTicketCapacity({ canonicalRepoKey: "example", canonicalRepoRoot: f.repo }, tx => {
    assert.equal(tx.reserve({ ticket: "EX-1", operationId: "a".repeat(64), reservationId: "b".repeat(64), retainedAt: new Date().toISOString() }).status, "reserved");
  });
  assert.equal(code(f.request({ action: "stage", expected: null, candidate: f.candidate })), "SETUP_BUSY");
  assert.throws(() => withVacantRepositorySetup(f.repo, {} as never, () => undefined)); assert.equal(existsSync(f.file), false);
}));

for (const variant of ["legacy", "tracked", "parent-alias", "parent-permissions", "file-alias", "hard-link", "file-permissions", "temporary", "malformed", "linked-candidate", "broken-worktree"] as const) {
  test(`repo setup rejects ${variant} without fallback/repair/overwrite`, () => fixture(f => {
    if (variant === "legacy") writeFileSync(join(f.config, "config.yaml"), JSON.stringify({ repos: { example: { path: f.repo, projectCommands: { manifest: "old.json", sha256: "a".repeat(64) } } } }));
    if (variant === "parent-alias") { mkdirSync(join(f.root, "elsewhere")); symlinkSync(join(f.root, "elsewhere"), join(f.repo, ".pa")); }
    else { mkdirSync(join(f.repo, ".pa"), { mode: 0o700 }); writeFileSync(f.file, f.candidate, { mode: 0o600 }); }
    if (variant === "tracked") f.git("add", ".pa/project-commands.json");
    if (variant === "parent-permissions") chmodSync(join(f.repo, ".pa"), 0o755);
    if (variant === "file-alias") { rmSync(f.file); symlinkSync(join(f.repo, "existing.txt"), f.file); }
    if (variant === "hard-link") linkSync(f.file, join(f.root, "other.json"));
    if (variant === "file-permissions") chmodSync(f.file, 0o644);
    if (variant === "temporary") writeFileSync(join(f.repo, ".pa", ".pa-setup-crashed.tmp"), "retained", { mode: 0o600 });
    if (variant === "malformed") writeFileSync(f.file, "bad");
    if (variant === "linked-candidate" || variant === "broken-worktree") {
      const linked = join(f.root, "linked"); f.git("worktree", "add", "-q", "-b", "feature/linked", linked);
      if (variant === "broken-worktree") rmSync(linked, { recursive: true });
      else { mkdirSync(join(linked, ".pa")); writeFileSync(join(linked, ".pa", "project-commands.json"), "retain"); }
    }
    const before = existsSync(f.file) ? readFileSync(f.file) : null;
    const result = f.request({ action: "stage", expected: null, candidate: `${f.candidate}\n` }); assert.equal(result.ok, false);
    if (before) assert.deepEqual(readFileSync(f.file), before);
    assert.equal(readFileSync(join(f.repo, "existing.txt"), "utf8"), "unrelated content\n");
  }));
}

test("repo setup actual concurrent processes serialize fixed-path creation and reject the losing stale reference", () => fixture(f => {
  const source = new URL("../repo-setup.ts", import.meta.url).href;
  const worker = `import { repoSetupService } from ${JSON.stringify(source)}; console.log(JSON.stringify(repoSetupService(${JSON.stringify(JSON.stringify({ action: "stage", expected: null, candidate: f.candidate }))}, {authenticate: () => ({key: 'example', root: ${JSON.stringify(f.repo)}})})));`;
  const coordinator = `import {spawn} from 'node:child_process'; const results = await Promise.all([1,2].map(() => new Promise((resolve,reject) => { const child = spawn(process.execPath, ['--import=tsx','--input-type=module','-e',${JSON.stringify(worker)}], {stdio:['ignore','pipe','pipe']}); let out='', err=''; child.stdout.on('data', x=>out+=x); child.stderr.on('data',x=>err+=x); child.on('error',reject); child.on('close',status=>status===0?resolve(JSON.parse(out)):reject(new Error(err))); }))); console.log(JSON.stringify(results));`;
  const results = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", coordinator], { encoding: "utf8", timeout: 20000 })) as Record<string, unknown>[];
  assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.filter(result => code(result) === "SETUP_STALE").length, 1);
  assert.equal(readFileSync(f.file, "utf8"), f.candidate); assert.deepEqual(readdirSync(join(f.repo, ".pa")), ["project-commands.json"]);
}));

test("repo setup reauthenticates before publication and retains uncertain staged bytes on lost native actor", () => fixture(f => {
  let count = 0;
  const host = { authenticate() { if (++count === 3) throw new Error("PRIVATE-SENTINEL"); return { key: "example", root: f.repo }; } };
  const result = repoSetupService(JSON.stringify({ action: "stage", expected: null, candidate: f.candidate }), host);
  assert.equal(code(result), "SETUP_ACTOR"); assert.equal(existsSync(f.file), false);
  const names = readdirSync(join(f.repo, ".pa")); assert.equal(names.length, 1); assert.match(names[0]!, /^\.pa-setup-.*\.tmp$/);
  assert.equal(code(f.request({ action: "inspect" })), "SETUP_IO");
}));
