import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  VALIDATION_HANDOFF_SCHEMA_VERSION,
  VALIDATION_MANIFEST_SCHEMA_VERSION,
  digestValidationManifest,
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

test("valid protected launch runs one unattended manifest before one reviewer with bounded evidence references", async () => {
  const seed = fixture([]);
  const orderPath = resolve(seed.root, "order.txt");
  withCommands(seed, [
    command(seed.root, "validate", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`if(process.env.PA_REVIEW_AUTHORIZATION_ID)process.exit(91);require('node:fs').writeFileSync(${JSON.stringify(orderPath)},'validation')`)}`),
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
    assert.equal(statSync(seed.ledgerPath).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(seed.ledgerPath, "utf8"), /review-auth:/);
    assert.doesNotMatch(JSON.stringify(events), /review-auth:/);
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
  } finally {
    cleanup(seed);
  }
});

test("invalid admission, authority, safety, and replay evidence starts zero commands and zero reviewers", async (t) => {
  const cases: Array<{ name: string; mutate: (seed: Fixture) => unknown }> = [
    {
      name: "authorization not consumed",
      mutate: (seed) => ({ ...seed.launch, admission: { ...seed.launch.admission, authorization: "available" } }),
    },
    {
      name: "review authority mismatch",
      mutate: (seed) => ({ ...seed.launch, review: { ...seed.launch.review, featureSha: "b".repeat(40) } }),
    },
    {
      name: "unsafe command",
      mutate: (seed) => {
        const handoff = seed.launch.validationHandoff as ValidationHandoff;
        handoff.manifest.commands = [command(seed.root, "unsafe", "rm forbidden")];
        handoff.manifestSha256 = digestValidationManifest(handoff.manifest);
        return seed.launch;
      },
    },
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
    assert.equal(readFileSync(ledger.commands[0]!.stdout!.path, "utf8"), firstOutput);
    assert.equal(existsSync(seed.laterMarker), false);
    assert.doesNotMatch(readFileSync(seed.ledgerPath, "utf8"), /review-auth:/);
    assert.equal(readFileSync(seed.ledgerPath, "utf8").trim().split("\n").length, 1);
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
  } finally {
    cleanup(seed);
  }
});
