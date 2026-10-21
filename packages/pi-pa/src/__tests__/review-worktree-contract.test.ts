import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appendRegistryEvent, closeDb, queryReviewAuthorizationClaims, parseReviewMatrixArtifact, parseReviewObjective,
  acquireRepositoryMutationLease, queryDeploymentStatus, repositoryReviewReservationPath, withRepositoryReviewReservation,
  digestValidationManifest, runCoreCommand, type ValidationHandoff, type ReviewMatrix,
} from "@pa-platform/pa-core";
import { createPiHooks, deployWithPi, piReviewCheckoutCorrelation, selectPiReviewCandidateBeforePlanning, reservePiReviewCandidate, rereadPiReviewCandidate } from "../deploy.js";
import { assertVersionedRuntimeProvenance, authorizeVersionedReview, createVersionedValidationLaunch, evaluateVersionedPrerequisites, revalidateVersionedReview } from "../review-v1-launch.js";
import { requireReviewPreflight } from "../review-preflight.js";
import { PI_VALIDATION_HANDOFF_FILE, readPiProtectedValidationLaunch, runPiValidationBeforeReviewer, writePiProtectedValidationLaunch } from "../validation-supervisor.js";
import { redactPiProtectedReviewPrimer, type PiBackgroundConfig } from "../adapter.js";
import { runPiBackgroundRunner } from "../background-runner.js";
import { TreehouseClient } from "./treehouse-fixture.js";
import { piMatrixAttemptStatePath, readPiMatrixStartedEvent, type PiValidationLaunchInput } from "../validation-launch.js";

const fixtures = fileURLToPath(new URL("../../../pa-core/src/__tests__/fixtures/protected-review-v1/", import.meta.url));
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function isolated(run: (root: string) => Promise<void>) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PA_|PI_|GIT_)/.test(key)));
  const path = process.env.PATH;
  process.env.PATH = (path ?? "").split(":").filter((entry) => isAbsolute(entry)).join(":");
  for (const key of Object.keys(inherited)) delete process.env[key];
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "pap237-worktree-")));
  process.env.PA_AI_USAGE_HOME = root; process.env.PA_REGISTRY_DB = resolve(root, "registry.db"); process.env.PA_PLATFORM_CONFIG = resolve(root, "config");
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1";
  try { await run(root); }
  finally {
    closeDb(); for (const key of Object.keys(process.env)) if (/^(PA_|PI_|GIT_)/.test(key)) delete process.env[key];
    Object.assign(process.env, inherited); process.env.PATH = path; rmSync(root, { recursive: true, force: true });
  }
}
function fixture(root: string, name: string, changeMatrix?: (matrix: ReviewMatrix) => void) {
  const canonical = resolve(root, "canonical"); const candidate = resolve(root, "candidate");
  mkdirSync(canonical); execFileSync("git", ["init", "-q", "-b", "develop", canonical]);
  git(canonical, "config", "user.name", "Isolated review"); git(canonical, "config", "user.email", "fixture@example.invalid");
  writeFileSync(resolve(canonical, "identity"), "canonical\n"); writeFileSync(resolve(canonical, ".gitignore"), "node_modules/\nbackend/node_modules/\nfrontend/node_modules/\n");
  git(canonical, "add", "."); git(canonical, "commit", "-qm", "canonical"); const base = git(canonical, "rev-parse", "HEAD");
  const o = parseReviewObjective(readFileSync(resolve(fixtures, `${name}.objective.json`)));
  const a = parseReviewMatrixArtifact(readFileSync(resolve(fixtures, `${name}.md`)), o.matrixSource);
  git(canonical, "worktree", "add", "-b", o.branch, candidate);
  writeFileSync(resolve(candidate, "identity"), "candidate-only\n"); git(candidate, "add", "identity"); git(candidate, "commit", "-qm", "candidate differs");
  o.featureSha = git(candidate, "rev-parse", "HEAD"); o.prerequisiteEvidence["paired-runtime-ready"] = "c-20000101000000001";
  a.matrix.repository.root = canonical; a.matrix.repository.baseSha = base;
  const bin = resolve(root, "bin"); mkdirSync(bin);
  for (const p of a.matrix.prerequisites) {
    if (p.kind === "tool") {
      if (p.name === "git" || p.name === "bash") {
        p.version = execFileSync(p.name, ["--version"], { encoding: "utf8" }).split(/\r?\n/)[0]!;
        continue;
      }
      const binary = p.name === "pnpm" ? "corepack" : p.name;
      const corepack = a.matrix.prerequisites.find((v) => v.kind === "tool" && v.name === "corepack");
      writeFileSync(resolve(bin, binary), `#!/bin/sh\nif [ "$*" = 'pnpm --version' ]; then printf '%s\\n' '10.28.0'; else printf '%s\\n' '${binary === "corepack" && corepack?.kind === "tool" ? corepack.version : p.version}'; fi\n`, { mode: 0o755 });
    }
    if (p.kind === "dependency") {
      const metadata = resolve(candidate, p.root, "node_modules", p.name, "package.json"); mkdirSync(dirname(metadata), { recursive: true });
      writeFileSync(metadata, JSON.stringify({ name: p.name, version: p.version }));
    }
  }
  // Git/Bash are real launcher-owned executables, not canonical-root/SHA mocks.
  process.env.PATH = `${bin}:${process.env.PATH}`;
  a.matrix.commands[0]!.command = 'PA_PHASE5_CONFIG_ROOT=/isolated/config test "$PWD" = "$PA_REPO" && test "$(git rev-parse --show-toplevel)" = "$PA_REPO" && test "$(git rev-parse HEAD)" = "$PA_FEATURE_SHA" && test "$(git branch --show-current)" = "' + o.branch + '" && test "$(head -n1 identity)" = "candidate-only"';
  a.matrix.commands[0]!.timeoutSeconds = 5;
  changeMatrix?.(a.matrix);
  const section = `### Full Validation Matrix\n\nMatrix Source: ${o.matrixSource}\n\n\`\`\`json\n${JSON.stringify(a.matrix, null, 2)}\n\`\`\`\n\n`;
  o.matrixAuthoritySha256 = createHash("sha256").update(section).digest("hex");
  const artifactPath = resolve(root, o.matrixSource.slice("requirements:".length)); mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, [`# Isolated fixture`, `> Ticket: ${o.ticket}`, `> Repository Key: ${a.matrix.repository.key}`, `> Repository Root: ${canonical}`,
    `> Approved Base SHA: ${base}`, `> Feature Branch: ${o.branch}`, `> Matrix Authority SHA-256: ${o.matrixAuthoritySha256}`, `> Matrix Approval Evidence: ${o.matrixApprovalEvidence}`, "", section + "## End"].join("\n"));
  const readiness = JSON.parse(readFileSync(resolve(fixtures, "readiness.json"), "utf8"));
  Object.assign(readiness, { featureSha: o.featureSha, matrixSource: o.matrixSource, matrixAuthoritySha256: o.matrixAuthoritySha256 }); readiness.installedRuntime.sourceSha = o.featureSha;
  mkdirSync(resolve(root, "tickets"));
  const ticket = { id: o.ticket, project: a.matrix.repository.key, doc_refs: [{ type: "requirements", path: o.matrixSource.slice("requirements:".length) }],
    linkedBranches: [{ repo: a.matrix.repository.key, branch: o.branch, state: "materialized", baseSha: base, headSha: o.featureSha }],
    comments: [{ id: o.matrixApprovalEvidence, author: "sinh", content: `Approved ${o.branch} ${o.matrixSource} ${o.matrixAuthoritySha256}` },
      { id: o.prerequisiteEvidence["paired-runtime-ready"], author: "sinh", content: JSON.stringify(readiness) }] };
  const ticketPath = resolve(root, `tickets/${o.ticket}.json`); writeFileSync(ticketPath, JSON.stringify(ticket));
  mkdirSync(resolve(root, "config")); writeFileSync(resolve(root, "config/repos.yaml"), `repos:\n  ${a.matrix.repository.key}:\n    path: ${canonical}\n`);
  const treehouse = new TreehouseClient({ run: () => ({ status: 0, stdout: Buffer.from(JSON.stringify([{ path: candidate, leased: true, lease_id: "fixture-lease", lease_holder: `pa:${a.matrix.repository.key}:${o.ticket}` }])), stderr: Buffer.alloc(0) }) });
  const request = { team: "requirements", mode: "review-auto", ticket: o.ticket, background: true, repo: a.matrix.repository.key,
    objective: JSON.stringify(o).replace("review-auth:", "\\u0072eview-auth:") };
  const authorization = authorizeVersionedReview(request, { repoKey: a.matrix.repository.key, repoRoot: canonical });
  const selected = selectPiReviewCandidateBeforePlanning({ request, runtime: "pi", cwd: canonical, authorizedBinding: authorization.binding }, { treehouse })!;
  const deploymentId = "d-237abc"; const deploymentDirectory = resolve(root, "deployments", deploymentId); mkdirSync(deploymentDirectory, { recursive: true });
  const checkout = selected.reviewCheckout;
  const plan = { runtime: "pi", team: "requirements", mode: "review-auto", ticket: o.ticket, repoKey: a.matrix.repository.key, repoRoot: canonical,
    worktreeRoot: candidate, repositoryCwd: candidate, reviewCheckout: checkout, environment: { PA_REPO: candidate, PA_WORKTREE_ROOT: candidate, PA_REPO_ROOT: canonical, PA_DEPLOYMENT_DIR: deploymentDirectory } };
  appendRegistryEvent({ deployment_id: deploymentId, team: "requirements", mode: "review-auto", runtime: "pi", binary: "ppa", event: "started", timestamp: new Date().toISOString(), ticket_id: o.ticket,
    objective: request.objective, repo: candidate, repo_root: canonical, worktree_root: candidate, review_checkout: piReviewCheckoutCorrelation(checkout) });
  // Only installed-provider readiness is synthetic here. This is not AC-9 live evidence.
  const dependencies = { verifyReadiness: (bindings: unknown[]) => { assert.equal(bindings.length, 1); } };
  return { canonical, candidate, o, a, artifactPath, ticketPath, request, treehouse, checkout, deploymentId, deploymentDirectory, dependencies,
    input: { deploymentId, deploymentDirectory, request, plan: plan as unknown as PiValidationLaunchInput["plan"], environment: { PATH: process.env.PATH! } } };
}

test("physical distinct-worktree v1 selector/contract/executor fixtures cover all three profiles without canonical fallback", async (t) => {
  for (const name of ["producer-node-pnpm", "mvm-179-migrated", "nx-055-migrated"]) await t.test(name, () => isolated(async (root) => {
    const seed = fixture(root, name);
    assert.notEqual(git(seed.canonical, "rev-parse", "HEAD"), seed.o.featureSha);
    assert.equal(readFileSync(resolve(seed.canonical, "identity"), "utf8"), "canonical\n");
    const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
    const redacted = redactPiProtectedReviewPrimer(seed.request.objective, launch.review.authorizationId);
    assert.doesNotMatch(redacted, /review-auth:|\\\\u0072eview-auth:/, "escaped objective redaction succeeds after exact one-use admission");
    const reservation = reservePiReviewCandidate({ checkout: seed.checkout, deploymentId: seed.deploymentId, authorizationId: seed.o.reviewAuthorizationId }, { treehouse: seed.treehouse });
    launch.reservation = reservation;
    const writer = acquireRepositoryMutationLease({ canonicalRepoKey: seed.a.matrix.repository.key, canonicalRepoRoot: seed.canonical,
      worktreeRoot: seed.candidate, deploymentId: "d-237def", deploymentDirectory: seed.deploymentDirectory, runtime: "pi", team: "builder", mode: "implement", launchMode: "background", ticket: seed.o.ticket });
    assert.equal(writer.status, "rejected", "new implementation borrowers cannot enter the reserved physical v1 candidate");
    const handoff = launch.validationHandoff as ValidationHandoff;
    assert.equal(handoff.manifest.repository.worktreeRoot, seed.candidate);
    assert.equal(handoff.manifest.commands[0]?.cwd, seed.candidate);
    assert.equal(handoff.manifest.environment.PA_REPO, seed.candidate);
    assert.equal(Object.keys(handoff.manifest.environment).length, 11);
    let reviewers = 0;
    const result = await runPiValidationBeforeReviewer(launch, { evidenceRoot: resolve(root, "evidence"), ledgerPath: resolve(root, "evidence/ledger.json"),
      beforeExecute: () => { rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }); revalidateVersionedReview(launch, seed.dependencies); },
      beforeReviewer: () => { rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }); revalidateVersionedReview(launch, seed.dependencies); },
      startReviewer: (context) => { reviewers++; assert.equal(context.featureSha, seed.o.featureSha); assert.equal(context.checkout?.worktreeRoot, seed.candidate); assert.equal(context.validationResult, "passed"); } });
    assert.equal(result.admitted, true, JSON.stringify(result)); assert.equal(result.reviewerStarted, true); assert.equal(reviewers, 1);
    if (result.admitted) assert.equal(result.validation.ledger?.result, "passed");
    assert.equal(queryReviewAuthorizationClaims().length, 1);
    const event = readPiMatrixStartedEvent(piMatrixAttemptStatePath(seed.deploymentDirectory));
    assert.equal(event.worktreeRoot, seed.candidate); assert.equal(event.candidateHead, seed.o.featureSha);
    assert.equal(git(seed.candidate, "rev-parse", "HEAD"), seed.o.featureSha);
    assert.equal(git(seed.candidate, "status", "--porcelain"), "");
    assert.doesNotMatch(readFileSync(resolve(root, "evidence/ledger.json"), "utf8"), /review-auth:/);
  }));
});
const inlineExecutionCases = [
  ["exact historical NODE_ENV=test TZ=UTC assignment pair", `NODE_ENV=test TZ=UTC node -e 'if(process.env.NODE_ENV!=="test" || process.env.TZ!=="UTC") process.exit(1)'`],
  ["leading trailing and internal shell whitespace", ` \tNODE_ENV=test  TZ=UTC\tnode -e 'if(process.env.NODE_ENV!=="test" || process.env.TZ!=="UTC") process.exit(1)'\n\n `],
  ["quoted command-local value containing spaces", `NODE_ENV='test mode' node -e 'if(process.env.NODE_ENV!=="test mode") process.exit(1)'`],
  ["multiple command-local assignments override only local TZ", `NODE_ENV=test TZ=Pacific/Honolulu CI=local node -e 'if(process.env.NODE_ENV!=="test" || process.env.TZ!=="Pacific/Honolulu" || process.env.CI!=="local") process.exit(1)'`],
  ["opaque env -u NODE_ENV command text", `NODE_ENV=test env -u NODE_ENV TZ=UTC node -e 'if(process.env.NODE_ENV!==undefined || process.env.TZ!=="UTC") process.exit(1)'`],
] as const;
for (const [name, command] of inlineExecutionCases) test(`physical v1 executor preserves and executes ${name} without launcher or next-command leakage (synthetic readiness)`, () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm", (matrix) => {
    matrix.commands.push({ ...matrix.commands[0]!, id: "inline", command }, { ...matrix.commands[0]!, id: "isolation",
      command: `node -e 'if(process.env.NODE_ENV!==undefined || process.env.TZ!=="UTC" || process.env.CI!=="1") process.exit(1)'` });
    matrix.commandCount = matrix.commands.length;
    matrix.outputs.push("inline: exact command-local values", "isolation: no ambient or previous command leakage");
  });
  // Keep the fixture's synthetic version probe, but execute real Node for payloads.
  const node = seed.a.matrix.prerequisites.find((p) => p.kind === "tool" && p.name === "node");
  assert.ok(node?.kind === "tool");
  writeFileSync(resolve(root, "bin/node"), `#!/bin/sh\nif [ "$*" = '--version' ]; then printf '%s\\n' '${node.version}'; else exec '${process.execPath}' "$@"; fi\n`, { mode: 0o755 });
  const ambientNodeEnv = process.env.NODE_ENV; process.env.NODE_ENV = "ambient-must-not-leak";
  try {
    const expected = seed.a.matrix.commands.map((c) => c.command);
    const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
    launch.reservation = reservePiReviewCandidate({ checkout: seed.checkout, deploymentId: seed.deploymentId, authorizationId: seed.o.reviewAuthorizationId }, { treehouse: seed.treehouse });
    const path = resolve(seed.deploymentDirectory, PI_VALIDATION_HANDOFF_FILE);
    writePiProtectedValidationLaunch(path, launch);
    const reread = readPiProtectedValidationLaunch(path);
    const handoff = reread.validationHandoff as ValidationHandoff;
    assert.deepEqual(handoff.manifest.commands.map((c) => c.command), expected);
    assert.deepEqual(Object.keys(handoff.manifest.environment).sort(), ["PA_REPO", "PA_FEATURE_SHA", "PA_MATRIX_SOURCE", "PA_MATRIX_AUTHORITY_SHA256", "PA_MATRIX_APPROVAL_EVIDENCE", "PATH", "PA_TICKET_ID", "CI", "HOME", "LANG", "TZ"].sort());
    assert.equal(Object.hasOwn(handoff.manifest.environment, "NODE_ENV"), false);
    assert.equal(handoff.manifest.environment.TZ, "UTC");
    assert.equal(handoff.manifest.repository.worktreeRoot, seed.candidate);
    let reviewers = 0;
    const result = await runPiValidationBeforeReviewer(reread, {
      evidenceRoot: resolve(root, "evidence"), ledgerPath: resolve(root, "evidence/ledger.json"),
      beforeExecute: () => { rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }); revalidateVersionedReview(reread, seed.dependencies); },
      beforeReviewer: () => { rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }); revalidateVersionedReview(reread, seed.dependencies); },
      startReviewer: () => { reviewers++; },
    });
    assert.equal(result.admitted, true, JSON.stringify(result));
    if (!result.admitted) assert.fail("isolated execution rejected");
    assert.equal(result.validation.ledger?.result, "passed", JSON.stringify(result.validation.ledger));
    assert.deepEqual(result.validation.ledger.commands.map((c) => c.command), expected);
    for (const entry of result.validation.ledger.commands) {
      assert.equal(entry.status, "passed"); assert.equal(entry.exitCode, 0); assert.equal(entry.cwd, seed.candidate);
      assert.ok(entry.stdout); assert.ok(entry.stderr);
      assert.equal(readFileSync(resolve(root, "evidence", entry.stderr.path), "utf8"), "");
    }
    assert.equal(reviewers, 1); assert.equal(queryReviewAuthorizationClaims().length, 1);
    assert.equal(git(seed.candidate, "status", "--porcelain"), "");
    assert.equal(git(seed.canonical, "rev-parse", "HEAD"), seed.a.matrix.repository.baseSha);
  } finally { if (ambientNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ambientNodeEnv; }
}));

test("compatible v1 dry-run redacts authorization from the persisted primer without consuming authority", async () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  const teams = resolve(root, "config/teams"); mkdirSync(teams); process.env.PA_PLATFORM_TEAMS = teams;
  writeFileSync(resolve(teams, "requirements.yaml"), "name: requirements\ndescription: fixture\nobjective: fixture\nagents: []\ndefault_mode: review-auto\ndeploy_modes:\n  - id: review-auto\n    description: fixture\n    require_ticket: true\n");
  for (const objective of [JSON.stringify(seed.o), seed.request.objective]) {
    const result = await deployWithPi({ ...seed.request, objective, dryRun: true });
    assert.equal(result.status, "pending", JSON.stringify(result));
    assert.ok(result.deploymentId);
    const primer = readFileSync(resolve(root, "deployments", result.deploymentId!, "primer.md"), "utf8");
    assert.doesNotMatch(primer, /review-auth:|\\\\u0072eview-auth:/);
    assert.match(primer, /protected-review-authorization/);
    assert.equal(queryReviewAuthorizationClaims().length, 0);
    assert.equal(existsSync(piMatrixAttemptStatePath(resolve(root, "deployments", result.deploymentId!))), false);
  }
  assert.equal(git(seed.candidate, "status", "--porcelain"), "");
}));

test("public protected PPA objective-file transport retains JSON escapes/CRLF and the exact 64-KiB boundary", async () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  const teams = resolve(root, "config/teams"); mkdirSync(teams); process.env.PA_PLATFORM_TEAMS = teams;
  writeFileSync(resolve(teams, "requirements.yaml"), "name: requirements\ndescription: fixture\nobjective: fixture\nagents: []\ndefault_mode: review-auto\ndeploy_modes:\n  - id: review-auto\n    description: fixture\n    require_ticket: true\n");
  const path = resolve(root, "objective.json");
  const hooks = createPiHooks(); let captured: string | undefined;
  hooks.deploy = (request) => { captured = request.objective; return { status: "pending", deploymentId: "d-237def" }; };
  const escaped = JSON.stringify(seed.o).replace('"ticket"', '"\\u0074icket"');
  for (const objective of ["\r\n  " + escaped + "\r\n", escaped + " ".repeat(65_536 - Buffer.byteLength(escaped))]) {
    writeFileSync(path, objective); let output = "";
    const code = await runCoreCommand(["deploy", "requirements", "--mode", "review-auto", "--ticket", seed.o.ticket, "--repo", seed.a.matrix.repository.key, "--dry-run", "--objective-file", path], {
      binaryName: "ppa", hooks, io: { stdout: (s) => { output += s; }, stderr: (s) => { output += s; } },
    });
    assert.equal(code, 0, output); assert.equal(captured, objective); assert.doesNotMatch(output, /sanitized objective|review-auth:/);
  }
  for (const objective of [escaped + " ".repeat(65_537 - Buffer.byteLength(escaped)), escaped + "é".repeat(33_000)]) {
    writeFileSync(path, objective); captured = undefined; let output = "";
    assert.equal(await runCoreCommand(["deploy", "requirements", "--mode", "review-auto", "--ticket", seed.o.ticket, "--repo", seed.a.matrix.repository.key, "--dry-run", "--objective-file", path], {
      binaryName: "ppa", hooks, io: { stdout: (s) => { output += s; }, stderr: (s) => { output += s; } },
    }), 1);
    assert.equal(captured, undefined); assert.match(output, /65536 bytes/);
  }
  assert.equal(queryReviewAuthorizationClaims().length, 0);
}));

test("runtime provenance binds external candidates separately and retains candidate-built pa-platform self-review", () => {
  const binding = JSON.parse(readFileSync(resolve(fixtures, "readiness.json"), "utf8"));
  binding.installedRuntime.sourceSha = "a".repeat(40);
  const provenance = { schemaVersion: "pa-review-runtime/v1", sourceSha: binding.installedRuntime.sourceSha,
    configSha: binding.mergedConfigSha, packageName: binding.installedRuntime.packageName, packageVersion: binding.installedRuntime.packageVersion,
    objectiveSchema: "pa-review-objective/v1", matrixSchema: "pa-review-matrix/v1" };
  for (const repoKey of ["external-node", "external-npm", "external-nix"]) assert.doesNotThrow(() => assertVersionedRuntimeProvenance(provenance, binding, { repoKey, featureSha: binding.featureSha }));
  assert.throws(() => assertVersionedRuntimeProvenance({ ...provenance, sourceSha: "d".repeat(40) }, binding, { repoKey: "external-npm", featureSha: binding.featureSha }), /provenance/);
  assert.throws(() => assertVersionedRuntimeProvenance(provenance, binding, { repoKey: "pa-platform", featureSha: binding.featureSha }, binding.mergedConfigSha), /self-review/);
  binding.installedRuntime.sourceSha = binding.featureSha; provenance.sourceSha = binding.featureSha;
  assert.doesNotThrow(() => assertVersionedRuntimeProvenance(provenance, binding, { repoKey: "pa-platform", featureSha: binding.featureSha }, binding.mergedConfigSha));
  assert.throws(() => assertVersionedRuntimeProvenance(provenance, binding, { repoKey: "pa-platform", featureSha: binding.featureSha }), /self-review/);
});

test("v1 physical candidate rejects dirty/drifted/wrong SHA, stale approval and missing actual installed readiness", async () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  await assert.rejects(createVersionedValidationLaunch(seed.input), (error: unknown) => (error as { diagnostic?: { source?: string } }).diagnostic?.source === "readiness.installedRuntime");
  assert.equal(existsSync(piMatrixAttemptStatePath(seed.deploymentDirectory)), true, "actual launch retains its prerequisite-start accounting even when readiness fails");
  assert.equal(queryReviewAuthorizationClaims().length, 0);
  assert.throws(() => selectPiReviewCandidateBeforePlanning({ request: seed.request, runtime: "pi", cwd: seed.canonical,
    authorizedBinding: { ...authorizeVersionedReview(seed.request, { repoKey: seed.a.matrix.repository.key, repoRoot: seed.canonical }).binding, featureSha: "c".repeat(40) } }, { treehouse: seed.treehouse }), /feature binding/);
  const duplicateLease = new TreehouseClient({ run: () => ({ status: 0, stdout: Buffer.from(JSON.stringify([
    { path: seed.candidate, leased: true, lease_id: "fixture-lease", lease_holder: `pa:${seed.a.matrix.repository.key}:${seed.o.ticket}` },
    { path: resolve(root, "other"), leased: true, lease_id: "other-lease", lease_holder: `pa:${seed.a.matrix.repository.key}:${seed.o.ticket}` },
  ])), stderr: Buffer.alloc(0) }) });
  assert.throws(() => rereadPiReviewCandidate(seed.checkout, { treehouse: duplicateLease }), /Treehouse/);
  writeFileSync(resolve(seed.candidate, "untracked"), "dirty");
  assert.throws(() => rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }), /snapshot/); rmSync(resolve(seed.candidate, "untracked"));
  const original = readFileSync(seed.artifactPath); writeFileSync(seed.artifactPath, original.toString().replace('"timeoutSeconds": 5', '"timeoutSeconds": 6'));
  assert.throws(() => requireReviewPreflight({ ticket: seed.o.ticket, objective: seed.request.objective })); writeFileSync(seed.artifactPath, original);
  const ticket = JSON.parse(readFileSync(seed.ticketPath, "utf8")); ticket.comments[0].author = "other"; writeFileSync(seed.ticketPath, JSON.stringify(ticket));
  assert.throws(() => requireReviewPreflight({ ticket: seed.o.ticket, objective: seed.request.objective }), (error: unknown) => (error as { diagnostic?: { source?: string } }).diagnostic?.source === "approval.author");
  assert.equal(queryReviewAuthorizationClaims().length, 0);
}));
test("v1 physical plan rejects canonical fallback and wrong ticket without starting a matrix", async () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  for (const plan of [
    { ...seed.input.plan, worktreeRoot: seed.canonical, repositoryCwd: seed.canonical },
    { ...seed.input.plan, ticket: "FIX-999" },
    { ...seed.input.plan, reviewCheckout: { ...seed.checkout, headSha: "c".repeat(40) } },
  ]) await assert.rejects(createVersionedValidationLaunch({ ...seed.input, plan: plan as PiValidationLaunchInput["plan"] }, seed.dependencies), /review.plan/);
  assert.equal(existsSync(piMatrixAttemptStatePath(seed.deploymentDirectory)), false);
  assert.equal(queryReviewAuthorizationClaims().length, 0);
}));
test("v1 replay and post-preflight approval drift reject before project commands", async () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
  await assert.rejects(createVersionedValidationLaunch(seed.input, seed.dependencies), /one-use.*already/);
  assert.equal(queryReviewAuthorizationClaims().length, 1);
  const ticket = JSON.parse(readFileSync(seed.ticketPath, "utf8")); ticket.comments[0].author = "other";
  writeFileSync(seed.ticketPath, JSON.stringify(ticket));
  assert.throws(() => revalidateVersionedReview(launch, seed.dependencies), /approval.author/);
  assert.equal(existsSync(resolve(root, "evidence/ledger.json")), false);
}));
test("v1 active same-ticket/branch review rejects a fresh authorization without another claim or executor", () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  await createVersionedValidationLaunch(seed.input, seed.dependencies);
  const deploymentId = "d-235def"; const deploymentDirectory = resolve(root, "deployments", deploymentId); mkdirSync(deploymentDirectory);
  const objective = JSON.stringify({ ...seed.o, reviewAuthorizationId: "review-auth:12345678-1234-4234-8234-123456789abc" });
  appendRegistryEvent({ deployment_id: deploymentId, team: "requirements", mode: "review-auto", runtime: "pi", binary: "ppa", event: "started", timestamp: new Date().toISOString(),
    ticket_id: seed.o.ticket, objective, repo: seed.candidate, repo_root: seed.canonical, worktree_root: seed.candidate, review_checkout: piReviewCheckoutCorrelation(seed.checkout) });
  await assert.rejects(createVersionedValidationLaunch({ ...seed.input, deploymentId, deploymentDirectory,
    request: { ...seed.request, objective }, plan: { ...seed.input.plan, environment: { ...seed.input.plan.environment, PA_DEPLOYMENT_DIR: deploymentDirectory } } }, seed.dependencies), /active review|running requirements\/review-auto/);
  assert.equal(queryReviewAuthorizationClaims().length, 1);
  assert.equal(existsSync(resolve(root, "evidence/ledger.json")), false);
}));

for (const drift of ["raw matrix", "approval", "manifest command"] as const) test(`v1 ${drift} drift at before-execution boundary starts zero executors or reviewers`, () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
  launch.reservation = reservePiReviewCandidate({ checkout: seed.checkout, deploymentId: seed.deploymentId, authorizationId: seed.o.reviewAuthorizationId }, { treehouse: seed.treehouse });
  if (drift === "raw matrix") writeFileSync(seed.artifactPath, readFileSync(seed.artifactPath, "utf8").replace('"timeoutSeconds": 5', '"timeoutSeconds": 6'));
  if (drift === "approval") {
    const ticket = JSON.parse(readFileSync(seed.ticketPath, "utf8")); ticket.comments[0].author = "other";
    writeFileSync(seed.ticketPath, JSON.stringify(ticket));
  }
  if (drift === "manifest command") {
    const handoff = launch.validationHandoff as ValidationHandoff;
    handoff.manifest.commands[0]!.command = "printf forged"; handoff.manifestSha256 = digestValidationManifest(handoff.manifest);
  }
  let executions = 0; let reviewers = 0;
  const result = await runPiValidationBeforeReviewer(launch, {
    evidenceRoot: resolve(root, "evidence"), ledgerPath: resolve(root, "evidence/ledger.json"),
    beforeExecute: () => { revalidateVersionedReview(launch, seed.dependencies); },
    beforeReviewer: () => { revalidateVersionedReview(launch, seed.dependencies); },
    execute: async () => { executions++; throw new Error("unexpected execution"); },
    startReviewer: () => { reviewers++; },
  });
  assert.equal(result.admitted, false); assert.equal(result.reviewerStarted, false);
  assert.equal(executions, 0); assert.equal(reviewers, 0);
  assert.equal(existsSync(resolve(root, "evidence/ledger.json")), false);
  assert.equal(queryReviewAuthorizationClaims().length, 1, "post-launch drift retains the already consumed claim");
}));

test("v1 failed, timed-out and crashed matrices retain failed ledgers even if a diagnostic reviewer starts", async (t) => {
  for (const mode of ["failure", "timeout", "crash"] as const) await t.test(mode, () => isolated(async (root) => {
    const seed = fixture(root, "nx-055-migrated", (matrix) => {
      matrix.commands[0]!.command = mode === "timeout" ? "sleep 5" : "exit 7";
      matrix.commands[0]!.timeoutSeconds = 1;
      matrix.commands.push({ ...matrix.commands[0]!, id: "command-02", command: "printf should-not-run" });
      matrix.commandCount = 2;
      matrix.outputs.push("command-02: must be skipped after failure");
    });
    const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
    launch.reservation = reservePiReviewCandidate({ checkout: seed.checkout, deploymentId: seed.deploymentId, authorizationId: seed.o.reviewAuthorizationId }, { treehouse: seed.treehouse });
    let reviewerResult: string | undefined; let terminations = 0;
    const result = await runPiValidationBeforeReviewer(launch, {
      evidenceRoot: resolve(root, "evidence"), ledgerPath: resolve(root, "evidence/ledger.json"),
      beforeExecute: () => { rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }); revalidateVersionedReview(launch, seed.dependencies); },
      beforeReviewer: () => { rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }); revalidateVersionedReview(launch, seed.dependencies); },
      ...(mode === "crash" ? { execute: async () => { throw new Error("isolated executor crash"); } } : {}),
      onMatrixTerminationVerified: () => { terminations++; },
      startReviewer: (context) => { reviewerResult = context.validationResult; },
    });
    assert.equal(result.admitted, true, JSON.stringify(result));
    assert.notEqual(reviewerResult, "passed", "reviewer startup is never proof of a passing matrix");
    assert.equal(terminations, mode === "crash" ? 0 : 1, "arbitrary executor crashes do not prove process termination");
    if (result.admitted) {
      assert.notEqual(result.validation.ledger?.result, "passed");
      assert.equal(result.validation.ledger?.commands[1]?.status, "skipped");
    }
    assert.equal(git(seed.candidate, "rev-parse", "HEAD"), seed.o.featureSha);
    assert.equal(git(seed.candidate, "status", "--porcelain"), "");
  }));
});
test("v1 post-matrix HEAD drift cannot reach a reviewer even when every command exits zero", async () => isolated(async (root) => {
  const seed = fixture(root, "nx-055-migrated", (matrix) => {
    matrix.commands[0]!.command = "printf drift > identity && git add identity && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm drift";
  });
  const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
  launch.reservation = reservePiReviewCandidate({ checkout: seed.checkout, deploymentId: seed.deploymentId, authorizationId: seed.o.reviewAuthorizationId }, { treehouse: seed.treehouse });
  let reviewers = 0;
  await assert.rejects(runPiValidationBeforeReviewer(launch, {
    evidenceRoot: resolve(root, "evidence"), ledgerPath: resolve(root, "evidence/ledger.json"),
    beforeExecute: () => { rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }); revalidateVersionedReview(launch, seed.dependencies); },
    beforeReviewer: () => { rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }); revalidateVersionedReview(launch, seed.dependencies); },
    startReviewer: () => { reviewers++; },
  }), /snapshot/);
  assert.equal(reviewers, 0);
  assert.notEqual(git(seed.candidate, "rev-parse", "HEAD"), seed.o.featureSha);
  assert.equal(JSON.parse(readFileSync(resolve(root, "evidence/ledger.json"), "utf8")).result, "passed", "command completion alone is not accepted protected review");
}));

test("production runner finalizes only matching reservations after verified post-matrix HEAD/approval rejection", async (t) => {
  for (const drift of ["head", "approval"] as const) await t.test(drift, () => isolated(async (root) => {
    const seed = fixture(root, "nx-055-migrated", drift === "head" ? (matrix) => {
      matrix.commands[0]!.command = "printf drift > identity && git add identity && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm drift";
    } : undefined);
    const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
    const reservation = reservePiReviewCandidate({ checkout: seed.checkout, deploymentId: seed.deploymentId, authorizationId: seed.o.reviewAuthorizationId }, { treehouse: seed.treehouse });
    launch.reservation = reservation;
    const handoffPath = resolve(seed.deploymentDirectory, PI_VALIDATION_HANDOFF_FILE);
    writePiProtectedValidationLaunch(handoffPath, launch);
    const primerPath = resolve(seed.deploymentDirectory, "primer.md"); writeFileSync(primerPath, "isolated reviewer; must not start");
    const config: PiBackgroundConfig = { schemaVersion: 1, ownershipToken: "isolated-owner", deploymentId: seed.deploymentId,
      team: "requirements", ticketId: seed.o.ticket, repoKey: seed.a.matrix.repository.key, repoRoot: seed.canonical,
      worktreeRoot: seed.candidate, cwd: seed.candidate, primerPath, logFile: resolve(seed.deploymentDirectory, "pi.log"),
      sessionId: "isolated-session", managed: false, skills: [], validationHandoffPath: handoffPath };
    process.env.PA_REPO = seed.candidate; process.env.PA_WORKTREE_ROOT = seed.candidate;
    let boundaries = 0; let reviewers = 0;
    await runPiBackgroundRunner(config, {
      // Only installed readiness/Treehouse providers are isolated seams. The
      // production runner, supervisor, executor and matching finalizer are real.
      reviewBoundary: (input, start) => {
        boundaries++;
        if (boundaries === 2 && drift === "approval") {
          const ticket = JSON.parse(readFileSync(seed.ticketPath, "utf8")); ticket.comments[0].author = "other";
          writeFileSync(seed.ticketPath, JSON.stringify(ticket));
        }
        return withRepositoryReviewReservation({ reservation: input.reservation,
          rereadCheckout: () => rereadPiReviewCandidate(seed.checkout, { treehouse: seed.treehouse }) }, () => {
          revalidateVersionedReview(input.launch, seed.dependencies); return start();
        });
      },
      supervision: { spawnProcess: (() => { reviewers++; throw new Error("unexpected reviewer"); }) as never },
    });
    assert.equal(boundaries, 2); assert.equal(reviewers, 0);
    assert.equal(queryDeploymentStatus(seed.deploymentId)?.status, "crashed");
    assert.equal(existsSync(repositoryReviewReservationPath(seed.candidate)), false, "no orphaned matching reservation after known matrix completion");
    const final = JSON.parse(readFileSync(resolve(seed.deploymentDirectory, "review-final-evidence.json"), "utf8"));
    assert.equal(final.leaseDisposition, "retained"); assert.equal(final.checkout.worktreeRoot, seed.candidate);
    assert.equal(queryReviewAuthorizationClaims()[0]?.active, false);
    if (drift === "head") assert.notEqual(final.finalGitSnapshot.head, seed.o.featureSha);
    assert.equal(existsSync(seed.candidate), true, "Treehouse checkout custody is retained");
  }));
});

test("v1 post-preflight command or gate transport drift cannot override approved bytes or immutable start", async () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
  const handoff = launch.validationHandoff as ValidationHandoff;
  handoff.manifest.commands[0]!.command = "printf forged"; handoff.manifestSha256 = digestValidationManifest(handoff.manifest);
  assert.throws(() => revalidateVersionedReview(launch, seed.dependencies), /review.commands/);
  launch.prerequisiteEvidence = { "paired-runtime-ready": "c-20000101000000002" };
  assert.throws(() => revalidateVersionedReview(launch, seed.dependencies), /review.start/);
  assert.equal(existsSync(resolve(root, "evidence/ledger.json")), false);
}));

test("v1 fixed Corepack probes cannot download or auto-pin and do not extend the command environment", async () => isolated(async (root) => {
  const seed = fixture(root, "producer-node-pnpm");
  writeFileSync(resolve(root, "bin/corepack"), "#!/bin/sh\n[ \"$COREPACK_ENABLE_NETWORK\" = 0 ] && [ \"$COREPACK_ENABLE_AUTO_PIN\" = 0 ] || exit 1\nif [ \"$*\" = 'pnpm --version' ]; then printf '10.28.0\\n'; else printf '0.34.6\\n'; fi\n", { mode: 0o755 });
  const launch = await createVersionedValidationLaunch(seed.input, seed.dependencies);
  const handoff = launch.validationHandoff as ValidationHandoff;
  assert.equal(Object.keys(handoff.manifest.environment).length, 11);
  assert.equal(handoff.manifest.environment.COREPACK_ENABLE_NETWORK, undefined);
  writeFileSync(resolve(root, "bin/corepack"), "#!/bin/sh\nprintf '0.0.0\\n'\n", { mode: 0o755 });
  assert.throws(() => revalidateVersionedReview(launch, seed.dependencies), /declared exact version/);
}));

test("v1 exact tool/dependency version and package-root containment failures never install or invent dependencies", async () => isolated(async (root) => {
  const seed = fixture(root, "mvm-179-migrated");
  const { artifact } = requireReviewPreflight({ ticket: seed.o.ticket, objective: seed.request.objective });
  const matrix = artifact.matrix;
  evaluateVersionedPrerequisites(matrix, seed.candidate, { PATH: process.env.PATH!, HOME: root });
  const p = matrix.prerequisites.find((p) => p.kind === "dependency")!;
  if (p.kind !== "dependency") assert.fail("missing fixture dependency");
  const metadata = resolve(seed.candidate, p.root, "node_modules", p.name, "package.json");
  writeFileSync(metadata, JSON.stringify({ name: p.name, version: "0.0.0" }));
  assert.throws(() => evaluateVersionedPrerequisites(matrix, seed.candidate, { PATH: process.env.PATH!, HOME: root }), /metadata/);
  assert.equal(git(seed.candidate, "status", "--porcelain"), "");
}));
