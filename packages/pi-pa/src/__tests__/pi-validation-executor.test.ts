import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  VALIDATION_HANDOFF_SCHEMA_VERSION,
  VALIDATION_MANIFEST_SCHEMA_VERSION,
  digestValidationManifest,
  resolveValidationEvidenceReference,
  type ValidationAuthorityBinding,
  type ValidationCommandSpec,
  type ValidationEvent,
  type ValidationHandoff,
  type ValidationManifest,
} from "@pa-platform/pa-core";
import {
  PI_PROTECTED_VALIDATION_SCHEMA_VERSION,
  piReviewerValidationPrompt,
  readPiProtectedValidationLaunch,
  runPiValidationBeforeReviewer,
  writePiProtectedValidationLaunch,
  type PiProtectedValidationLaunch,
  type PiReviewerValidationContext,
} from "../validation-supervisor.js";

interface Fixture {
  root: string;
  evidenceRoot: string;
  ledgerPath: string;
  laterMarker: string;
  launch: PiProtectedValidationLaunch;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function command(root: string, id: string, text: string, overrides: Partial<ValidationCommandSpec> = {}): ValidationCommandSpec {
  return {
    id,
    command: text,
    cwd: root,
    timeoutSeconds: 5,
    maxOutputBytes: 1_048_576,
    artifacts: [],
    ...overrides,
  };
}

function fixture(commands: ValidationCommandSpec[]): Fixture {
  const root = mkdtempSync(resolve(tmpdir(), "pi-validation-"));
  const branch = "feature/PAP-223-pi-validation";
  execFileSync("git", ["init", "-q", "-b", branch, root]);
  git(root, ["config", "user.name", "Pi Validation"]);
  git(root, ["config", "user.email", "pi-validation@example.invalid"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "fixture"]);
  const featureSha = git(root, ["rev-parse", "HEAD"]);
  const repository = { repoKey: "pa-platform", canonicalRoot: root, worktreeRoot: root };
  const manifest: ValidationManifest = {
    schemaVersion: VALIDATION_MANIFEST_SCHEMA_VERSION,
    ticketId: "PAP-223",
    branch,
    featureSha,
    matrix: {
      source: "agent-teams/requirements/artifacts/2026-09-23-pap-223-structured-validation-executor.md",
      authoritySha256: "a".repeat(64),
      approvalEvidence: "PAP-223 comment c-approved",
    },
    repository,
    environment: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: root,
      LANG: "C.UTF-8",
      TZ: "UTC",
      PA_TICKET_ID: "PAP-223",
    },
    commands,
  };
  const authority: ValidationAuthorityBinding = {
    ticketId: manifest.ticketId,
    branch,
    featureSha,
    matrixSource: manifest.matrix.source,
    matrixAuthoritySha256: manifest.matrix.authoritySha256,
    matrixApprovalEvidence: manifest.matrix.approvalEvidence,
    repository,
    protectedEnvironment: { PA_TICKET_ID: "PAP-223" },
  };
  const validationHandoff: ValidationHandoff = {
    schemaVersion: VALIDATION_HANDOFF_SCHEMA_VERSION,
    manifestSha256: digestValidationManifest(manifest),
    manifest,
    repositoryEvidence: { ...repository, ticketId: manifest.ticketId, branch, featureSha, authenticated: true },
    protectedEnvironment: { PA_TICKET_ID: "PAP-223" },
  };
  const deploymentId = "d-validation-test";
  return {
    root,
    evidenceRoot: resolve(root, ".validation-evidence"),
    ledgerPath: resolve(root, ".validation-evidence", "ledger.json"),
    laterMarker: resolve(root, "later-command-started"),
    launch: {
      schemaVersion: PI_PROTECTED_VALIDATION_SCHEMA_VERSION,
      deploymentId,
      admission: {
        authorization: "consumed",
        matrixDigest: "verified",
        featureSha: "verified",
        approval: "verified",
        activeReview: "admitted",
        prerequisites: [
          { sourceOrder: 1, text: "authenticated clean repository", status: "verified" },
          { sourceOrder: 2, text: "exact tools and dependencies", status: "verified" },
          { sourceOrder: 3, text: "artifact and approval equality", status: "verified" },
          { sourceOrder: 4, text: "sole authorization and exact environment", status: "verified" },
        ],
      },
      validationHandoff,
      authority,
      review: {
        reviewDeploymentId: deploymentId,
        authorizationId: "review-auth:123e4567-e89b-42d3-a456-426614174000",
        ticketId: authority.ticketId,
        branch: authority.branch,
        featureSha: authority.featureSha,
        matrixSource: authority.matrixSource,
        matrixAuthoritySha256: authority.matrixAuthoritySha256,
        matrixApprovalEvidence: authority.matrixApprovalEvidence,
      },
    },
  };
}

function withCommands(seed: Fixture, commands: ValidationCommandSpec[]): void {
  const handoff = seed.launch.validationHandoff as ValidationHandoff;
  handoff.manifest.commands = commands;
  handoff.manifestSha256 = digestValidationManifest(handoff.manifest);
}

function cleanup(seed: Fixture): void {
  rmSync(seed.root, { recursive: true, force: true });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertOneTerminalLedger(seed: Fixture, result: "passed" | "failed" | "executor_crash"): Record<string, unknown> {
  const body = readFileSync(seed.ledgerPath, "utf8");
  assert.equal(body.trim().split("\n").length, 1);
  assert.equal(statSync(seed.ledgerPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(seed.evidenceRoot).filter((name) => name.includes(".tmp")), []);
  const ledger = JSON.parse(body) as Record<string, unknown>;
  assert.equal(ledger["result"], result);
  return ledger;
}

test("valid protected launch runs one unattended manifest before one reviewer with bounded evidence references", async () => {
  const seed = fixture([]);
  const orderPath = resolve(seed.root, "order.txt");
  withCommands(seed, [
    command(seed.root, "validate", `test -z "\${PA_REVIEW_AUTHORIZATION_ID+x}" && printf %s validation > ${JSON.stringify(orderPath)}`),
  ]);
  const events: ValidationEvent[] = [];
  let reviewerStarts = 0;
  try {
    const result = await runPiValidationBeforeReviewer(seed.launch, {
      evidenceRoot: seed.evidenceRoot,
      ledgerPath: seed.ledgerPath,
      emit: (event) => { events.push(event); },
      startReviewer: (context) => {
        reviewerStarts += 1;
        assert.equal(readFileSync(orderPath, "utf8"), "validation");
        assert.equal(context.validationResult, "passed");
        assert.equal(context.authorizationId, seed.launch.review.authorizationId);
        assert.equal(context.validationLedgerPath, seed.ledgerPath);
        assert.match(context.validationLedgerSha256, /^[0-9a-f]{64}$/);
        assert.ok(piReviewerValidationPrompt(context).length <= 2_000);
        return "reviewer-started";
      },
    });

    assert.equal(result.admitted, true);
    assert.equal(result.reviewerStarted, true);
    assert.equal(result.reviewerResult, "reviewer-started");
    assert.equal(reviewerStarts, 1);
    assert.deepEqual(events.map((event) => event.type), ["manifest_start", "command_start", "command_finish", "manifest_finish"]);
    assert.ok(events.every((event) => JSON.stringify(event).length <= 2_000));
    assertOneTerminalLedger(seed, "passed");
    assert.doesNotMatch(readFileSync(seed.ledgerPath, "utf8"), /review-auth:/);
    assert.doesNotMatch(JSON.stringify(events), /review-auth:/);
  } finally {
    cleanup(seed);
  }
});

test("1 MiB output remains in exact mode-0600 logs while reviewer handback and events stay bounded", async () => {
  const seed = fixture([]);
  const byteCount = 1_048_576;
  withCommands(seed, [
    command(seed.root, "large", `${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.alloc(${byteCount},120))"`),
  ]);
  const events: ValidationEvent[] = [];
  let reviewerPrompt = "";
  try {
    const result = await runPiValidationBeforeReviewer(seed.launch, {
      evidenceRoot: seed.evidenceRoot,
      ledgerPath: seed.ledgerPath,
      emit: (event) => { events.push(event); },
      startReviewer: (context) => { reviewerPrompt = piReviewerValidationPrompt(context); },
    });
    assert.equal(result.admitted, true);
    const stdout = result.validation.ledger!.commands[0]!.stdout!;
    assert.equal(stdout.bytes, byteCount);
    assert.equal(stdout.sha256, sha256(Buffer.alloc(byteCount, 120)));
    assert.ok(stdout.retainedBytes <= 65_536);
    assert.equal(stdout.path, "commands/001-large.stdout.log");
    const stdoutPath = resolveValidationEvidenceReference(seed.evidenceRoot, stdout.path);
    assert.equal(statSync(stdoutPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(stdoutPath).length, byteCount);
    assert.ok(events.length <= 4);
    assert.ok(events.every((event) => JSON.stringify(event).length <= 2_000));
    assert.ok(reviewerPrompt.length <= 2_000);
    assert.doesNotMatch(JSON.stringify(events), /x{1000}/);
    assert.doesNotMatch(reviewerPrompt, /x{1000}/);
    assertOneTerminalLedger(seed, "passed");
  } finally {
    cleanup(seed);
  }
});

test("admitted validation failure skips later commands and still starts the reviewer once", async () => {
  const seed = fixture([]);
  withCommands(seed, [
    command(seed.root, "failure", `${JSON.stringify(process.execPath)} -e "process.exit(9)"`),
    command(seed.root, "later", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(seed.laterMarker)},'started')`)}`),
  ]);
  let context: PiReviewerValidationContext | undefined;
  try {
    const result = await runPiValidationBeforeReviewer(seed.launch, {
      evidenceRoot: seed.evidenceRoot,
      ledgerPath: seed.ledgerPath,
      startReviewer: (value) => { context = value; return true; },
    });
    assert.equal(result.admitted, true);
    assert.equal(result.validation.ledger?.result, "failed");
    assert.deepEqual(result.validation.ledger?.commands.map((entry) => entry.status), ["failed", "skipped"]);
    assert.equal(context?.validationResult, "failed");
    assert.equal(existsSync(seed.laterMarker), false);
    assertOneTerminalLedger(seed, "failed");
  } finally {
    cleanup(seed);
  }
});

test("invalid admission, authority, safety, repository, path, artifact, and replay evidence starts zero commands and reviewers", async (t) => {
  const replaceCommand = (seed: Fixture, change: Partial<ValidationCommandSpec>): PiProtectedValidationLaunch => {
    const handoff = seed.launch.validationHandoff as ValidationHandoff;
    handoff.manifest.commands = [{ ...handoff.manifest.commands[0]!, ...change }];
    handoff.manifestSha256 = digestValidationManifest(handoff.manifest);
    return seed.launch;
  };
  const cases: Array<{ name: string; mutate: (seed: Fixture) => unknown }> = [
    { name: "malformed launch", mutate: (seed) => ({ ...seed.launch, unexpected: true }) },
    { name: "authorization not consumed", mutate: (seed) => ({ ...seed.launch, admission: { ...seed.launch.admission, authorization: "available" } }) },
    { name: "matrix digest not verified", mutate: (seed) => ({ ...seed.launch, admission: { ...seed.launch.admission, matrixDigest: "unchecked" } }) },
    { name: "duplicate active review", mutate: (seed) => ({ ...seed.launch, admission: { ...seed.launch.admission, activeReview: "duplicate" } }) },
    { name: "missing prerequisite evidence", mutate: (seed) => ({ ...seed.launch, admission: { ...seed.launch.admission, prerequisites: [] } }) },
    { name: "reordered prerequisite evidence", mutate: (seed) => ({
      ...seed.launch,
      admission: {
        ...seed.launch.admission,
        prerequisites: seed.launch.admission.prerequisites.map((value, index) => ({ ...value, sourceOrder: index === 0 ? 2 : value.sourceOrder })),
      },
    }) },
    { name: "review ticket mismatch", mutate: (seed) => ({ ...seed.launch, review: { ...seed.launch.review, ticketId: "PAP-999" } }) },
    { name: "review branch mismatch", mutate: (seed) => ({ ...seed.launch, review: { ...seed.launch.review, branch: "feature/PAP-223-other" } }) },
    { name: "review feature mismatch", mutate: (seed) => ({ ...seed.launch, review: { ...seed.launch.review, featureSha: "b".repeat(40) } }) },
    { name: "review digest mismatch", mutate: (seed) => ({ ...seed.launch, review: { ...seed.launch.review, matrixAuthoritySha256: "b".repeat(64) } }) },
    { name: "invalid authorization identifier", mutate: (seed) => ({ ...seed.launch, review: { ...seed.launch.review, authorizationId: "review-auth:not-canonical" } }) },
    { name: "mismatched manifest digest", mutate: (seed) => ({ ...seed.launch, validationHandoff: { ...(seed.launch.validationHandoff as ValidationHandoff), manifestSha256: "b".repeat(64) } }) },
    { name: "unauthenticated repository", mutate: (seed) => {
      const handoff = seed.launch.validationHandoff as ValidationHandoff;
      return { ...seed.launch, validationHandoff: { ...handoff, repositoryEvidence: { ...handoff.repositoryEvidence, authenticated: false } } };
    } },
    { name: "conflicting protected identity", mutate: (seed) => {
      const handoff = seed.launch.validationHandoff as ValidationHandoff;
      return { ...seed.launch, validationHandoff: { ...handoff, protectedEnvironment: { PA_TICKET_ID: "PAP-999" } } };
    } },
    { name: "stale Git HEAD", mutate: (seed) => {
      execFileSync("git", ["-C", seed.root, "commit", "-q", "--allow-empty", "-m", "drift"]);
      return seed.launch;
    } },
    { name: "unsafe command", mutate: (seed) => {
      const handoff = seed.launch.validationHandoff as ValidationHandoff;
      return replaceCommand(seed, { command: `rm forbidden; ${handoff.manifest.commands[0]!.command}` });
    } },
    { name: "invalid command path", mutate: (seed) => replaceCommand(seed, { cwd: "/outside-approved-root" }) },
    { name: "outside artifact", mutate: (seed) => replaceCommand(seed, { artifacts: [{ path: resolve(tmpdir(), "outside-artifact") }] }) },
    { name: "directory artifact", mutate: (seed) => {
      const directory = resolve(seed.root, "artifact-directory");
      mkdirSync(directory);
      return replaceCommand(seed, { artifacts: [{ path: directory }] });
    } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const seed = fixture([]);
      withCommands(seed, [command(seed.root, "must-not-start", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(seed.laterMarker)},'started')`)}`)]);
      let reviewers = 0;
      try {
        const result = await runPiValidationBeforeReviewer(item.mutate(seed), {
          evidenceRoot: seed.evidenceRoot,
          ledgerPath: seed.ledgerPath,
          startReviewer: () => { reviewers += 1; },
        });
        assert.equal(result.admitted, false);
        assert.equal(result.reviewerStarted, false);
        assert.equal(reviewers, 0);
        assert.equal(existsSync(seed.laterMarker), false);
        assert.ok(JSON.stringify(result.diagnostic).length <= 2_000);
        assert.deepEqual(Object.keys(result.diagnostic).sort(), ["condition", "correction", "reason", "resumeAction", "source"]);
        assert.doesNotMatch(JSON.stringify(result.diagnostic), /review-auth:/);
      } finally {
        cleanup(seed);
      }
    });
  }

  await t.test("consumed protected sidecar cannot be replayed or hard-linked", () => {
    const seed = fixture([]);
    withCommands(seed, [command(seed.root, "noop", "true")]);
    const path = resolve(seed.root, "protected.json");
    const alias = resolve(seed.root, "protected-alias.json");
    try {
      writePiProtectedValidationLaunch(path, seed.launch);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      linkSync(path, alias);
      assert.throws(() => readPiProtectedValidationLaunch(path), /insecure/);
      unlinkSync(alias);
      assert.equal(readPiProtectedValidationLaunch(path).deploymentId, seed.launch.deploymentId);
      unlinkSync(path);
      assert.throws(() => readPiProtectedValidationLaunch(path), /ENOENT/);
    } finally {
      cleanup(seed);
    }
  });
});

test("executor throw is recovered into one complete crash ledger before an admitted reviewer starts", async () => {
  const seed = fixture([]);
  withCommands(seed, [
    command(seed.root, "never-started", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(seed.laterMarker)},'started')`)}`),
  ]);
  let reviewerStarts = 0;
  try {
    const result = await runPiValidationBeforeReviewer(seed.launch, {
      evidenceRoot: seed.evidenceRoot,
      ledgerPath: seed.ledgerPath,
      execute: async () => { throw new Error("synthetic executor crash"); },
      startReviewer: (context) => {
        reviewerStarts += 1;
        assert.equal(context.validationResult, "executor_crash");
        assert.equal(existsSync(seed.ledgerPath), true);
      },
    });
    assert.equal(result.admitted, true);
    assert.equal(reviewerStarts, 1);
    assert.deepEqual(result.validation.ledger?.commands.map((entry) => entry.status), ["skipped"]);
    assert.equal(existsSync(seed.laterMarker), false);
    assertOneTerminalLedger(seed, "executor_crash");
    assert.doesNotMatch(readFileSync(seed.ledgerPath, "utf8"), /synthetic executor crash|review-auth:/);
  } finally {
    cleanup(seed);
  }
});

test("supervisor interruption finalizes one executor_crash ledger, preserves evidence, and skips untouched commands", async () => {
  const seed = fixture([]);
  const firstOutput = "first-command-evidence";
  withCommands(seed, [
    command(seed.root, "first", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(firstOutput)})`)}`),
    command(seed.root, "interrupted", `${JSON.stringify(process.execPath)} -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`),
    command(seed.root, "untouched", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(seed.laterMarker)},'started')`)}`),
  ]);
  const abort = new AbortController();
  let reviewerStarts = 0;
  try {
    const result = await runPiValidationBeforeReviewer(seed.launch, {
      evidenceRoot: seed.evidenceRoot,
      ledgerPath: seed.ledgerPath,
      abortSignal: abort.signal,
      emit: (event) => {
        if (event.type === "command_start" && event.commandId === "interrupted") setTimeout(() => abort.abort("SIGTERM"), 20);
      },
      startReviewer: (context) => {
        reviewerStarts += 1;
        assert.equal(context.validationResult, "executor_crash");
      },
    });
    assert.equal(result.admitted, true);
    assert.equal(reviewerStarts, 1);
    const ledger = result.validation.ledger!;
    assert.equal(ledger.result, "executor_crash");
    assert.deepEqual(ledger.commands.map((entry) => entry.status), ["passed", "executor_crash", "skipped"]);
    assert.equal(readFileSync(resolveValidationEvidenceReference(seed.evidenceRoot, ledger.commands[0]!.stdout!.path), "utf8"), firstOutput);
    assert.equal(existsSync(seed.laterMarker), false);
    assert.doesNotMatch(readFileSync(seed.ledgerPath, "utf8"), /review-auth:/);
    assertOneTerminalLedger(seed, "executor_crash");
  } finally {
    cleanup(seed);
  }
});

test("timeout cleanup evidence is terminal before reviewer spawn and no later command starts", async () => {
  const seed = fixture([]);
  withCommands(seed, [
    command(seed.root, "timeout", `${JSON.stringify(process.execPath)} -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`, { timeoutSeconds: 1 }),
    command(seed.root, "later", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(seed.laterMarker)},'started')`)}`),
  ]);
  let reviewerStarts = 0;
  try {
    const result = await runPiValidationBeforeReviewer(seed.launch, {
      evidenceRoot: seed.evidenceRoot,
      ledgerPath: seed.ledgerPath,
      startReviewer: (context) => {
        reviewerStarts += 1;
        assert.equal(context.validationResult, "failed");
        assert.equal(existsSync(seed.ledgerPath), true);
      },
    });
    assert.equal(result.admitted, true);
    assert.equal(reviewerStarts, 1);
    assert.equal(result.validation.ledger?.commands[0]?.status, "timeout");
    assert.equal(result.validation.ledger?.commands[0]?.processGroupVerifiedDead, true);
    assert.equal(result.validation.ledger?.commands[1]?.status, "skipped");
    assert.equal(existsSync(seed.laterMarker), false);
    assertOneTerminalLedger(seed, "failed");
  } finally {
    cleanup(seed);
  }
});
