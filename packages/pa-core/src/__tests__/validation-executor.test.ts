import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  MAX_RETAINED_STREAM_BYTES,
  VALIDATION_HANDOFF_SCHEMA_VERSION,
  VALIDATION_MANIFEST_SCHEMA_VERSION,
  digestValidationManifest,
  executeValidationHandoff,
  type ValidationAuthorityBinding,
  type ValidationCommandSpec,
  type ValidationExecutorOptions,
  type ValidationHandoff,
  type ValidationManifest,
} from "../validation/index.js";

interface Fixture {
  root: string;
  evidenceRoot: string;
  ledgerPath: string;
  markerPath: string;
  authority: ValidationAuthorityBinding;
  manifest: ValidationManifest;
}

async function fixture(commands: ValidationCommandSpec[]): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "pa-validation-"));
  const branch = "feature/PAP-223-validation-test";
  execFileSync("git", ["init", "-q", "-b", branch, root]);
  execFileSync("git", ["-C", root, "config", "user.email", "validation@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Validation Test"]);
  execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "fixture"]);
  const featureSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const repository = { repoKey: "pa-platform", canonicalRoot: root, worktreeRoot: root };
  const manifest: ValidationManifest = {
    schemaVersion: VALIDATION_MANIFEST_SCHEMA_VERSION,
    ticketId: "PAP-223",
    branch,
    featureSha,
    matrix: {
      source: "agent-teams/requirements/artifacts/pap-223.md",
      authoritySha256: "a".repeat(64),
      approvalEvidence: "PAP-223 comment approved",
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
  return {
    root,
    evidenceRoot: resolve(root, ".validation-evidence"),
    ledgerPath: resolve(root, ".validation-evidence", "ledger.json"),
    markerPath: resolve(root, "should-not-start"),
    manifest,
    authority: {
      ticketId: manifest.ticketId,
      branch,
      featureSha,
      matrixSource: manifest.matrix.source,
      matrixAuthoritySha256: manifest.matrix.authoritySha256,
      matrixApprovalEvidence: manifest.matrix.approvalEvidence,
      repository,
      protectedEnvironment: { PA_TICKET_ID: "PAP-223" },
    },
  };
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

function handoff(value: Fixture): ValidationHandoff {
  return {
    schemaVersion: VALIDATION_HANDOFF_SCHEMA_VERSION,
    manifestSha256: digestValidationManifest(value.manifest),
    manifest: value.manifest,
    repositoryEvidence: {
      ...value.manifest.repository,
      ticketId: value.manifest.ticketId,
      branch: value.manifest.branch,
      featureSha: value.manifest.featureSha,
      authenticated: true,
    },
    protectedEnvironment: { PA_TICKET_ID: "PAP-223" },
  };
}

function options(value: Fixture, suffix = ""): ValidationExecutorOptions {
  const evidenceRoot = suffix ? resolve(value.root, `.validation-evidence-${suffix}`) : value.evidenceRoot;
  return {
    authority: value.authority,
    evidenceRoot,
    ledgerPath: resolve(evidenceRoot, "ledger.json"),
    terminationGraceMs: 20,
    terminationVerifyMs: 2_000,
  };
}

async function readLedger(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("executes unchanged commands sequentially and fails fast with a complete ledger", async () => {
  const seed = await fixture([]);
  seed.manifest.commands = [
    command(seed.root, "one", `${JSON.stringify(process.execPath)} -e "process.stdout.write('one\\n')"`),
    command(seed.root, "two", `${JSON.stringify(process.execPath)} -e "process.stderr.write('two\\n'); process.exit(7)"`),
    command(seed.root, "three", `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(seed.markerPath)}, 'started')"`),
  ];
  const result = await executeValidationHandoff(handoff(seed), options(seed));

  assert.equal(result.admitted, true, JSON.stringify(result.diagnostic));
  assert.equal(result.ledger?.result, "failed");
  assert.deepEqual(
    result.ledger?.commands.map((entry) => entry.status),
    ["passed", "failed", "skipped"],
    JSON.stringify(result.ledger?.commands),
  );
  assert.equal(result.ledger?.commands[1]?.exitCode, 7);
  assert.equal(result.ledger?.commands[2]?.startedAt, undefined);
  await assert.rejects(stat(seed.markerPath), { code: "ENOENT" });
  assert.equal(result.events.length, 6);
  assert.deepEqual(result.events.map((event) => event.type), [
    "manifest_start", "command_start", "command_finish", "command_start", "command_finish", "manifest_finish",
  ]);
  assert.ok(result.events.every((event) => JSON.stringify(event).length <= 2_000));
  const persisted = await readLedger(seed.ledgerPath);
  assert.equal(persisted["schemaVersion"], "pa-validation-ledger/v1");
  assert.equal(persisted["result"], "failed");
});

test("rejects malformed, mismatched, unsafe, invalid-limit, and invalid-path handoffs before a manifest command starts", async (t) => {
  const replaceManifest = (value: ValidationHandoff, manifest: ValidationManifest): ValidationHandoff => ({
    ...value,
    manifest,
    manifestSha256: digestValidationManifest(manifest),
  });
  const cases: Array<{ name: string; mutate: (value: ValidationHandoff, seed: Fixture) => unknown }> = [
    { name: "malformed", mutate: (value) => ({ ...value, unexpected: true }) },
    { name: "mismatched", mutate: (value) => ({ ...value, manifestSha256: "b".repeat(64) }) },
    { name: "unsafe", mutate: (value) => replaceManifest(value, { ...value.manifest, commands: [{ ...value.manifest.commands[0]!, command: "rm forbidden" }] }) },
    { name: "invalid-limit", mutate: (value) => ({ ...value, manifest: { ...value.manifest, commands: [{ ...value.manifest.commands[0]!, timeoutSeconds: 0 }] } }) },
    { name: "invalid-path", mutate: (value) => replaceManifest(value, { ...value.manifest, commands: [{ ...value.manifest.commands[0]!, cwd: "/outside-approved-root" }] }) },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const seed = await fixture([]);
      seed.manifest.commands = [command(
        seed.root,
        "must-not-start",
        `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(seed.markerPath)}, 'started')"`,
      )];
      const candidate = item.mutate(handoff(seed), seed);
      const result = await executeValidationHandoff(candidate, options(seed));
      assert.equal(result.admitted, false);
      assert.equal(result.events.length, 2);
      assert.equal(result.events[1]?.status, "rejected");
      assert.ok(result.events.every((event) => JSON.stringify(event).length <= 2_000));
      assert.deepEqual(Object.keys(result.diagnostic ?? {}).sort(), [
        "condition", "correction", "reason", "resumeAction", "source",
      ]);
      await assert.rejects(stat(seed.markerPath), { code: "ENOENT" });
    });
  }
});

test("streams at least 1 MiB as exact mode-0600 evidence with bounded memory and events", async () => {
  const seed = await fixture([]);
  const byteCount = 1_048_576;
  seed.manifest.commands = [command(
    seed.root,
    "large",
    `${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.alloc(${byteCount}, 97))"`,
  )];
  const result = await executeValidationHandoff(handoff(seed), options(seed));
  const entry = result.ledger?.commands[0];
  assert.equal(entry?.status, "passed", JSON.stringify(entry));
  assert.equal(entry?.stdout?.bytes, byteCount);
  assert.equal(entry?.stdout?.sha256, sha256(Buffer.alloc(byteCount, 97)));
  assert.ok((entry?.stdout?.retainedBytes ?? Infinity) <= MAX_RETAINED_STREAM_BYTES);
  assert.equal((await stat(entry!.stdout!.path)).mode & 0o777, 0o600);
  assert.equal((await stat(entry!.stderr!.path)).mode & 0o777, 0o600);
  assert.equal((await stat(options(seed).ledgerPath)).mode & 0o777, 0o600);
  assert.ok(result.events.every((event) => JSON.stringify(event).length <= 2_000));
  assert.ok(result.events.every((event) => !JSON.stringify(event).includes("a".repeat(1_000))));
});

test("uses only the approved environment and records exact regular-file artifacts", async () => {
  const seed = await fixture([]);
  const artifactPath = resolve(seed.root, "artifact.bin");
  const artifactBytes = Buffer.from([0, 1, 2, 10, 13, 255]);
  const script = [
    `if (process.env.AMBIENT_VALIDATION_SECRET) process.exit(91)`,
    `require('node:fs').writeFileSync(${JSON.stringify(artifactPath)}, Buffer.from([0,1,2,10,13,255]))`,
  ].join(";");
  seed.manifest.commands = [command(
    seed.root,
    "artifact",
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    { artifacts: [{ path: artifactPath, expectedSha256: sha256(artifactBytes) }] },
  )];
  process.env["AMBIENT_VALIDATION_SECRET"] = "must-not-leak";
  try {
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    const entry = result.ledger?.commands[0];
    assert.equal(entry?.status, "passed");
    assert.deepEqual(entry?.artifacts, [{
      path: artifactPath,
      bytes: artifactBytes.length,
      sha256: sha256(artifactBytes),
      expectedSha256: sha256(artifactBytes),
    }]);
  } finally {
    delete process.env["AMBIENT_VALIDATION_SECRET"];
  }
});

test("publishes complete failure ledgers for timeout, output limit, and artifact failure", async (t) => {
  await t.test("timeout kills and verifies the process group before skipping later commands", async () => {
    const seed = await fixture([]);
    seed.manifest.commands = [
      command(
        seed.root,
        "timeout",
        `${JSON.stringify(process.execPath)} -e "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"`,
        { timeoutSeconds: 1 },
      ),
      command(seed.root, "later", `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(seed.markerPath)}, 'started')"`),
    ];
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    const first = result.ledger?.commands[0];
    assert.equal(first?.status, "timeout");
    assert.deepEqual(first?.terminationSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(first?.processGroupVerifiedDead, true);
    assert.equal(result.ledger?.commands[1]?.status, "skipped");
    await assert.rejects(stat(seed.markerPath), { code: "ENOENT" });
    assert.equal((await readLedger(options(seed).ledgerPath))["result"], "failed");
  });

  await t.test("output limit", async () => {
    const seed = await fixture([]);
    seed.manifest.commands = [command(
      seed.root,
      "limit",
      `${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.alloc(2097152, 120)); setInterval(()=>{},1000)"`,
    )];
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    assert.equal(result.ledger?.commands[0]?.status, "output_limit");
    assert.ok((result.ledger?.commands[0]?.stdout?.bytes ?? 0) > 1_048_576);
    assert.equal((await readLedger(options(seed).ledgerPath))["result"], "failed");
  });

  await t.test("artifact failure", async () => {
    const seed = await fixture([]);
    seed.manifest.commands = [command(seed.root, "missing-artifact", `${JSON.stringify(process.execPath)} -e "process.exit(0)"`, {
      artifacts: [{ path: resolve(seed.root, "missing.bin") }],
    })];
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    assert.equal(result.ledger?.commands[0]?.status, "artifact_failure");
    assert.equal((await readLedger(options(seed).ledgerPath))["result"], "failed");
  });
});

test("success publishes one complete atomic terminal ledger and terminal state", async () => {
  const seed = await fixture([]);
  seed.manifest.commands = [command(seed.root, "success", `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`)];
  const executionOptions = options(seed);
  const result = await executeValidationHandoff(handoff(seed), executionOptions);
  assert.equal(result.ledger?.result, "passed");
  assert.equal((await readLedger(executionOptions.ledgerPath))["result"], "passed");
  const state = await readLedger(`${executionOptions.ledgerPath}.state`);
  assert.equal(state["phase"], "terminal");
  assert.equal(result.events.length, 4);
});
