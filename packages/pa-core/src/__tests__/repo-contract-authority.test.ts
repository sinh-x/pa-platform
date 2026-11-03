import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RepoContractAuthority, RepoOperatorError } from "../repo-contract-authority.js";
import { runRepoSetupOperatorCommand } from "../cli/commands/repo-setup.js";
import { evaluateSafetyPolicy } from "../safety-policy.js";
import type { OperatorTerminal } from "../operator-terminal.js";

function fixture(run: (f: { root: string; repo: string; file: string; native: string; authority: RepoContractAuthority; secret: Buffer; identity: { key: string; root: string }; git(...args: string[]): string }) => unknown): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pap273-operator-")), old = process.env;
  process.env = { ...old };
  return (async () => { try {
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
    const repo = join(root, "repo"), config = join(root, "config"), native = join(root, "native");
    mkdirSync(repo); mkdirSync(config); mkdirSync(join(repo, ".pa"), { mode: 0o700 });
    process.env.PA_PLATFORM_CONFIG = config; writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: { example: { path: repo } } }));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q", "-b", "develop");
    const file = join(repo, ".pa", "project-commands.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: "project-command-catalogue/v1", repository: { key: "example", root: repo }, effects: ["project-read", "isolated-temp-write"], commands: [
      { id: "unit", executable: "/nix/store/absent-fixture/bin/node", argv: ["test.cjs"], environment: {}, readPaths: [], prerequisites: [{ path: "test.cjs", sha256: "a".repeat(64) }], timeoutSeconds: 60, maximumOutputBytes: 1024 },
    ] }), { mode: 0o600 });
    const authority = new RepoContractAuthority({ root: native, assertOperator: () => undefined });
    await run({ root, repo, file, native, authority, secret: Buffer.from(["synthetic", "operator", "fixture"].join("-")), identity: { key: "example", root: repo }, git });
  } finally { process.env = old; rmSync(root, { recursive: true, force: true }); } })();
}
const rejected = (code: string) => (error: unknown) => error instanceof RepoOperatorError && error.code === code;

test("operator owner uses protected native hash evidence and exact local-exclude effect, never a task execution grant", () => fixture(f => {
  assert.deepEqual(f.authority.credentialStatus(), { configured: false }); assert.equal(existsSync(f.native), false);
  assert.equal(f.authority.approved(f.identity), null); f.authority.configure("init", f.secret);
  const preview = f.authority.preview(f.identity), before = readFileSync(join(f.repo, ".git", "info", "exclude"));
  assert.throws(() => f.authority.approve(preview, Buffer.from("incorrect")), rejected("REPO_CREDENTIAL_INVALID"));
  assert.deepEqual(readFileSync(join(f.repo, ".git", "info", "exclude")), before);
  const receipt = f.authority.approve(preview, f.secret); assert.match(receipt, /^[0-9a-f]{64}$/);
  assert.deepEqual(readFileSync(join(f.repo, ".git", "info", "exclude")), Buffer.concat([before, Buffer.from("/.pa/\n")]));
  assert.equal(f.git("check-ignore", ".pa/project-commands.json"), ".pa/project-commands.json");
  assert.equal(f.authority.approved(f.identity)!.approvalSha256, receipt); assert.equal(f.git("ls-files", ".pa"), "");
  const historical = readdirSync(f.native).map(name => readFileSync(join(f.native, name)));
  assert.ok(historical.every(bytes => !bytes.includes(f.secret)), "verifier evidence contains no plaintext secret");
  const original = readFileSync(f.file); writeFileSync(f.file, Buffer.concat([original, Buffer.from("\n")]));
  assert.throws(() => f.authority.approved(f.identity), rejected("REPO_APPROVAL_STALE"));
  writeFileSync(f.file, original); assert.equal(f.authority.approved(f.identity)!.approvalSha256, receipt);
  rmSync(f.file); assert.throws(() => f.authority.approved(f.identity), rejected("REPO_APPROVAL_STALE"));
}));

test("normal credential rotation preserves approvals; revocation and forgotten-password reset retain history and deny new consumption until reapproval", () => fixture(f => {
  f.authority.configure("init", f.secret); f.authority.approve(f.authority.preview(f.identity), f.secret);
  const approved = f.authority.approved(f.identity)!, next = Buffer.from("synthetic-rotated-fixture"), reset = Buffer.from("synthetic-reset-fixture");
  const history = new Map(readdirSync(f.native).map(name => [name, readFileSync(join(f.native, name))]));
  assert.throws(() => f.authority.configure("rotate", next, Buffer.from("wrong")), rejected("REPO_CREDENTIAL_INVALID"));
  f.authority.configure("rotate", next, f.secret); assert.equal(f.authority.approved(f.identity)!.approvalSha256, approved.approvalSha256);
  assert.throws(() => f.authority.revoke(f.identity, f.secret), rejected("REPO_CREDENTIAL_INVALID"));
  f.authority.revoke(f.identity, next); assert.throws(() => f.authority.approved(f.identity), rejected("REPO_APPROVAL_REVOKED"));
  f.authority.approve(f.authority.preview(f.identity), next); assert.notEqual(f.authority.approved(f.identity)!.approvalSha256, approved.approvalSha256);
  f.authority.configure("reset", reset); assert.throws(() => f.authority.approved(f.identity), rejected("REPO_APPROVAL_REVOKED"));
  assert.throws(() => f.authority.approve(f.authority.preview(f.identity), next), rejected("REPO_CREDENTIAL_INVALID"));
  f.authority.approve(f.authority.preview(f.identity), reset); assert.ok(f.authority.approved(f.identity));
  for (const [name, bytes] of history) assert.deepEqual(readFileSync(join(f.native, name)), bytes);
}));

test("operator approval rechecks displayed candidate and exclude bytes before issuance; tracked source/negations cannot be repaired into authority", () => fixture(f => {
  f.authority.configure("init", f.secret); const preview = f.authority.preview(f.identity), original = readFileSync(f.file);
  writeFileSync(f.file, Buffer.concat([original, Buffer.from("\n")])); assert.throws(() => f.authority.approve(preview, f.secret), rejected("REPO_APPROVAL_STALE"));
  writeFileSync(f.file, original); const second = f.authority.preview(f.identity);
  writeFileSync(join(f.repo, ".git", "info", "exclude"), "# concurrent unrelated rule\n"); assert.throws(() => f.authority.approve(second, f.secret), rejected("REPO_APPROVAL_STALE"));
  f.git("add", "-f", ".pa/project-commands.json"); assert.throws(() => f.authority.preview(f.identity)); assert.equal(f.authority.approved(f.identity), null);
  f.git("rm", "--cached", ".pa/project-commands.json");
  writeFileSync(join(f.repo, ".gitignore"), "!/.pa/\n!/.pa/project-commands.json\n");
  assert.throws(() => f.authority.approve(f.authority.preview(f.identity), f.secret)); assert.equal(f.authority.approved(f.identity), null);
  assert.equal(readFileSync(join(f.repo, ".gitignore"), "utf8"), "!/.pa/\n!/.pa/project-commands.json\n");
}));

for (const variant of ["private-root-mode", "private-root-alias", "exclude-alias", "candidate-mode", "legacy-conflict"] as const) test(`operator rejects ${variant} without approval/repair`, () => fixture(f => {
  f.authority.configure("init", f.secret);
  if (variant === "private-root-mode") chmodSync(f.native, 0o755);
  if (variant === "private-root-alias") { const other = join(f.root, "actual-native"); renameSync(f.native, other); symlinkSync(other, f.native); }
  if (variant === "exclude-alias") { const target = join(f.root, "exclude"); writeFileSync(target, "keep\n"); rmSync(join(f.repo, ".git", "info", "exclude")); symlinkSync(target, join(f.repo, ".git", "info", "exclude")); }
  if (variant === "candidate-mode") chmodSync(f.file, 0o644);
  if (variant === "legacy-conflict") writeFileSync(join(f.root, "config", "config.yaml"), JSON.stringify({ repos: { example: { path: f.repo, projectCommands: { manifest: "legacy.json", sha256: "a".repeat(64) } } } }));
  assert.throws(() => f.authority.approve(f.authority.preview(f.identity), f.secret));
}));

test("operator CLI displays exact native candidate, requires fresh hidden-secret transport, rejects caller flags and clears returned secret buffers", () => fixture(async f => {
  const output: string[] = [], errors: string[] = [], shown: string[] = [], buffers: Buffer[] = [];
  f.authority.configure("init", f.secret);
  const terminal: OperatorTerminal = { assertAvailable() {}, display(text) { shown.push(text); }, async confirm(_prompt, expected) { return expected === "APPROVE"; }, async secret() { const value = Buffer.from(f.secret); buffers.push(value); return value; } };
  const io = { stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
  const host = { authority: f.authority, terminal, assertOperator: () => undefined };
  assert.equal(await runRepoSetupOperatorCommand(["approve", "example"], io, host), 0); assert.equal(buffers.length, 1); assert.ok(buffers[0]!.every(byte => byte === 0));
  assert.ok(shown.join("").includes(f.authority.approved(f.identity)!.catalogue.sha256)); assert.equal(JSON.parse(output[0]!).executionReady, false);
  assert.equal([...shown, ...output, ...errors].join("").includes(f.secret.toString()), false);
  assert.equal(await runRepoSetupOperatorCommand(["approve", "example", "--yes"], io, host), 1);
  assert.equal(await runRepoSetupOperatorCommand(["credential", "init", "--password", "PRIVATE-SENTINEL"], io, host), 1);
  assert.equal(errors.join("").includes("PRIVATE-SENTINEL"), false); assert.equal(buffers.length, 1);
  process.env.PA_TEAM = "rogue-one";
  assert.equal(await runRepoSetupOperatorCommand(["approve", "example"], io), 1);
  assert.equal(buffers.length, 1);
}));

test("default native operator origin rejects managed contexts before reading or creating credential storage", () => fixture(f => {
  const native = join(f.root, "must-not-exist"); process.env.PA_DEPLOYMENT_ID = "d-123abc";
  const authority = new RepoContractAuthority({ root: native }); assert.throws(() => authority.configure("init", f.secret), rejected("REPO_OPERATOR_REQUIRED"));
  assert.equal(existsSync(native), false);
}));

test("reset racing final native approval publication invalidates the old epoch without deleting its historical issuance", () => fixture(f => {
  f.authority.configure("init", f.secret); const preview = f.authority.preview(f.identity); let calls = 0;
  const racer = new RepoContractAuthority({ root: f.native, assertOperator() { if (++calls === 5) f.authority.configure("reset", Buffer.from("synthetic-reset-race-fixture")); } });
  assert.throws(() => racer.approve(preview, f.secret), rejected("REPO_APPROVAL_REVOKED"));
  assert.throws(() => f.authority.approved(f.identity), rejected("REPO_APPROVAL_REVOKED")); assert.ok(readdirSync(f.native).length >= 3);
}));

test("one machine credential reset invalidates every repository approval, never only the selected project", () => fixture(f => {
  const other = join(f.root, "second"), identity = { key: "second", root: other };
  mkdirSync(other); mkdirSync(join(other, ".pa"), { mode: 0o700 }); f.git("init", "-q", other);
  const candidate = JSON.parse(readFileSync(f.file, "utf8")); candidate.repository = identity;
  writeFileSync(join(other, ".pa", "project-commands.json"), JSON.stringify(candidate), { mode: 0o600 });
  writeFileSync(join(f.root, "config", "config.yaml"), JSON.stringify({ repos: { example: { path: f.repo }, second: { path: other } } }));
  f.authority.configure("init", f.secret); f.authority.approve(f.authority.preview(f.identity), f.secret); f.authority.approve(f.authority.preview(identity), f.secret);
  f.authority.configure("reset", Buffer.from("synthetic-reset-every-repo"));
  for (const repo of [f.identity, identity]) assert.throws(() => f.authority.approved(repo), rejected("REPO_APPROVAL_REVOKED"));
}));

test("managed safety rejects operator mutation commands through supported wrappers/nested shells but not displayed prose or read-only status", () => {
  for (const command of ["ppa repo-setup approve example", "env -i /bin/ppa repo-setup credential init", "command pa-core repo-setup revoke example", "sh -c 'ppa repo-setup credential reset'"]) assert.equal(evaluateSafetyPolicy({ kind: "shell", value: command }).allowed, false, command);
  for (const command of ["printf '%s' 'ppa repo-setup approve example'", "ppa repo-setup status example", "ppa repo-setup --help"]) assert.equal(evaluateSafetyPolicy({ kind: "shell", value: command }).allowed, true, command);
});
