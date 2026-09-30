import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import test from "node:test";
import {
  MAX_RETAINED_STREAM_BYTES,
  VALIDATION_HANDOFF_SCHEMA_VERSION,
  VALIDATION_MANIFEST_SCHEMA_VERSION,
  digestValidationManifest,
  executeValidationHandoff,
  finalizeValidationExecutorCrash,
  resolveValidationEvidenceReference,
  type ValidationAuthorityBinding,
  type ValidationCommandSpec,
  type ValidationExecutorOptions,
  type ValidationHandoff,
  type ValidationManifest,
} from "../validation/index.js";

const fixtureRoots = new Set<string>();
test.after(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
});

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
  fixtureRoots.add(root);
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

async function assertAtomicTerminalLedger(path: string, result: "passed" | "failed" | "executor_crash"): Promise<Record<string, unknown>> {
  const body = await readFile(path, "utf8");
  assert.equal(body.trim().split("\n").length, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((JSON.parse(body) as Record<string, unknown>)["result"], result);
  assert.deepEqual((await readdir(dirname(path))).filter((name) => name.includes(".tmp")), []);
  return JSON.parse(body) as Record<string, unknown>;
}

async function processIsDead(pid: number): Promise<boolean> {
  try {
    const processState = (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2];
    return processState === "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
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
  assert.equal(await readFile(resolveValidationEvidenceReference(seed.evidenceRoot, result.ledger!.commands[0]!.stdout!.path), "utf8"), "one\n");
  assert.equal(await readFile(resolveValidationEvidenceReference(seed.evidenceRoot, result.ledger!.commands[1]!.stderr!.path), "utf8"), "two\n");
  assert.equal(result.ledger!.commands[0]!.stdout!.sha256, sha256(Buffer.from("one\n")));
  assert.equal(result.ledger!.commands[1]!.stderr!.sha256, sha256(Buffer.from("two\n")));
  await assert.rejects(stat(seed.markerPath), { code: "ENOENT" });
  assert.equal(result.events.length, 6);
  assert.deepEqual(result.events.map((event) => event.type), [
    "manifest_start", "command_start", "command_finish", "command_start", "command_finish", "manifest_finish",
  ]);
  assert.ok(result.events.every((event) => JSON.stringify(event).length <= 2_000));
  assert.ok(result.events.every((event) => event.manifestSha256 === result.ledger?.manifestSha256));
  const persisted = await assertAtomicTerminalLedger(seed.ledgerPath, "failed");
  assert.equal(persisted["schemaVersion"], "pa-validation-ledger/v1");
});

test("rejects every authority, safety, repository, limit, path, and artifact class before a command starts", async (t) => {
  const replaceManifest = (value: ValidationHandoff, manifest: ValidationManifest): ValidationHandoff => ({
    ...value,
    manifest,
    manifestSha256: digestValidationManifest(manifest),
  });
  const replaceCommand = (value: ValidationHandoff, change: Partial<ValidationCommandSpec>): ValidationHandoff => replaceManifest(value, {
    ...value.manifest,
    commands: [{ ...value.manifest.commands[0]!, ...change }],
  });
  const cases: Array<{ name: string; mutate: (value: ValidationHandoff, seed: Fixture) => unknown | Promise<unknown> }> = [
    { name: "malformed handoff", mutate: (value) => ({ ...value, unexpected: true }) },
    { name: "mismatched manifest digest", mutate: (value) => ({ ...value, manifestSha256: "b".repeat(64) }) },
    { name: "mismatched ticket authority", mutate: (value) => replaceManifest(value, { ...value.manifest, ticketId: "PAP-999" }) },
    { name: "mismatched matrix authority", mutate: (value) => replaceManifest(value, { ...value.manifest, matrix: { ...value.manifest.matrix, authoritySha256: "b".repeat(64) } }) },
    { name: "conflicting protected identity", mutate: (value) => ({ ...value, protectedEnvironment: { PA_TICKET_ID: "PAP-999" } }) },
    { name: "protected identity override", mutate: (value) => replaceManifest(value, { ...value.manifest, environment: { ...value.manifest.environment, PA_TICKET_ID: "PAP-999" } }) },
    { name: "unauthenticated repository evidence", mutate: (value) => ({ ...value, repositoryEvidence: { ...value.repositoryEvidence, authenticated: false } }) },
    { name: "mismatched repository evidence", mutate: (value) => ({ ...value, repositoryEvidence: { ...value.repositoryEvidence, branch: "feature/PAP-223-other" } }) },
    { name: "stale Git HEAD", mutate: async (value, seed) => {
      await writeFile(resolve(seed.root, "drift"), "drift");
      execFileSync("git", ["-C", seed.root, "add", "drift"]);
      execFileSync("git", ["-C", seed.root, "commit", "-q", "-m", "drift"]);
      return value;
    } },
    { name: "unsafe command", mutate: (value) => replaceCommand(value, { command: `rm forbidden; ${value.manifest.commands[0]!.command}` }) },
    { name: "invalid timeout", mutate: (value) => ({ ...value, manifest: { ...value.manifest, commands: [{ ...value.manifest.commands[0]!, timeoutSeconds: 0 }] } }) },
    { name: "non-integer output limit", mutate: (value) => ({ ...value, manifest: { ...value.manifest, commands: [{ ...value.manifest.commands[0]!, maxOutputBytes: 1_048_576.5 }] } }) },
    { name: "outside cwd", mutate: (value) => replaceCommand(value, { cwd: "/outside-approved-root" }) },
    { name: "outside artifact", mutate: (value) => replaceCommand(value, { artifacts: [{ path: resolve(tmpdir(), "outside-artifact") }] }) },
    { name: "glob artifact", mutate: (value, seed) => replaceCommand(value, { artifacts: [{ path: resolve(seed.root, "*.log") }] }) },
    { name: "symlink artifact", mutate: async (value, seed) => {
      const target = resolve(seed.root, "artifact-target");
      const alias = resolve(seed.root, "artifact-link");
      await writeFile(target, "target");
      await symlink(target, alias);
      return replaceCommand(value, { artifacts: [{ path: alias }] });
    } },
    { name: "directory artifact", mutate: async (value, seed) => {
      const directory = resolve(seed.root, "artifact-directory");
      await mkdir(directory);
      return replaceCommand(value, { artifacts: [{ path: directory }] });
    } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const seed = await fixture([]);
      seed.manifest.commands = [command(
        seed.root,
        "must-not-start",
        `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(seed.markerPath)}, 'started')"`,
      )];
      const candidate = await item.mutate(handoff(seed), seed);
      const result = await executeValidationHandoff(candidate, options(seed));
      assert.equal(result.admitted, false);
      assert.equal(result.ledger, undefined);
      assert.equal(result.events.at(-1)?.status, "rejected");
      if (result.events[0]?.type === "manifest_start") {
        assert.equal(result.events.length, 2);
        assert.ok(result.events.every((event) => event.manifestSha256 === (candidate as ValidationHandoff).manifestSha256));
      } else {
        assert.equal(result.events.length, 1);
        assert.equal(Object.hasOwn(result.events[0]!, "manifestSha256"), false);
      }
      assert.ok(result.events.every((event) => JSON.stringify(event).length <= 2_000));
      assert.ok(JSON.stringify(result.diagnostic).length <= 2_000);
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
  assert.equal(isAbsolute(entry!.stdout!.path), false);
  assert.match(entry!.stdout!.path, /^commands\/[0-9]{3}-large\.stdout\.log$/);
  assert.equal((await stat(resolveValidationEvidenceReference(seed.evidenceRoot, entry!.stdout!.path))).mode & 0o777, 0o600);
  assert.equal((await stat(resolveValidationEvidenceReference(seed.evidenceRoot, entry!.stderr!.path))).mode & 0o777, 0o600);
  assert.equal((await stat(options(seed).ledgerPath)).mode & 0o777, 0o600);
  assert.ok(result.events.every((event) => JSON.stringify(event).length <= 2_000));
  assert.ok(result.events.every((event) => !JSON.stringify(event).includes("a".repeat(1_000))));
});

test("preserves exact command, cwd, environment, shell semantics, order, identity, and raw artifact bytes", async () => {
  const seed = await fixture([]);
  const nestedCwd = resolve(seed.root, "nested cwd");
  await mkdir(nestedCwd);
  const artifactPath = resolve(seed.root, "artifact.bin");
  const secondPath = resolve(seed.root, "second.txt");
  const artifactBytes = Buffer.from([0, 1, 2, 10, 13, 255]);
  seed.manifest.environment = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: seed.root,
    LANG: "C.UTF-8",
    TZ: "UTC",
    PA_TICKET_ID: "PAP-223",
    EXACT_VALUE: "spaces ; $quotes ' \" and unicode λ",
  };
  const exactValueBase64 = Buffer.from(seed.manifest.environment["EXACT_VALUE"]!).toString("base64");
  const firstText = [
    `test "$PWD" = ${JSON.stringify(nestedCwd)}`,
    `test "$PA_TICKET_ID" = PAP-223`,
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`if(process.env.EXACT_VALUE!==Buffer.from(${JSON.stringify(exactValueBase64)},'base64').toString('utf8'))process.exit(92)`)}`,
    `test -z "\${AMBIENT_VALIDATION_SECRET-}"`,
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(artifactPath)}, Buffer.from([0,1,2,10,13,255]))`)}`,
    `printf shell >> ${JSON.stringify(secondPath)} && printf -- '-semantics' >> ${JSON.stringify(secondPath)}`,
  ].join(" && ");
  seed.manifest.commands = [
    command(nestedCwd, "exact", firstText, { artifacts: [{ path: artifactPath, expectedSha256: sha256(artifactBytes) }] }),
    command(seed.root, "ordered", `test "$(cat ${JSON.stringify(secondPath)})" = shell-semantics`),
  ];
  process.env["AMBIENT_VALIDATION_SECRET"] = "must-not-leak";
  try {
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    const entry = result.ledger?.commands[0];
    assert.equal(result.ledger?.result, "passed");
    assert.equal(entry?.status, "passed");
    assert.equal(entry?.command, firstText);
    assert.equal(entry?.cwd, nestedCwd);
    assert.deepEqual(entry?.artifacts, [{
      path: artifactPath,
      bytes: artifactBytes.length,
      sha256: sha256(artifactBytes),
      expectedSha256: sha256(artifactBytes),
    }]);
    assert.equal(await readFile(secondPath, "utf8"), "shell-semantics");
    await assertAtomicTerminalLedger(seed.ledgerPath, "passed");
  } finally {
    delete process.env["AMBIENT_VALIDATION_SECRET"];
  }
});

test("publishes complete failure ledgers for timeout, output limit, and artifact failure", async (t) => {
  await t.test("timeout TERM/KILL kills and verifies the whole process group before skipping later commands", async () => {
    const seed = await fixture([]);
    const childPidPath = resolve(seed.root, "stubborn-child.pid");
    const stubbornChild = `setInterval(()=>{},1000)`;
    const stubbornParent = [
      `const {spawn}=require('node:child_process')`,
      `const {writeFileSync}=require('node:fs')`,
      `const child=spawn(process.execPath,['-e',${JSON.stringify(stubbornChild)}],{stdio:'ignore'})`,
      `writeFileSync(${JSON.stringify(childPidPath)},String(child.pid))`,
      `process.on('SIGTERM',()=>{})`,
      `setInterval(()=>{},1000)`,
    ].join(";");
    seed.manifest.commands = [
      command(seed.root, "timeout", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(stubbornParent)}`, { timeoutSeconds: 1 }),
      command(seed.root, "later", `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(seed.markerPath)}, 'started')"`),
    ];
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    const first = result.ledger?.commands[0];
    const childPid = Number(await readFile(childPidPath, "utf8"));
    assert.equal(first?.status, "timeout");
    assert.deepEqual(first?.terminationSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(first?.processGroupVerifiedDead, true);
    assert.equal(await processIsDead(childPid), true, `descendant ${childPid} remained alive`);
    assert.equal(result.ledger?.commands[1]?.status, "skipped");
    await assert.rejects(stat(seed.markerPath), { code: "ENOENT" });
    await assertAtomicTerminalLedger(options(seed).ledgerPath, "failed");
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
    assert.equal(result.ledger?.commands[0]?.processGroupVerifiedDead, true);
    await assertAtomicTerminalLedger(options(seed).ledgerPath, "failed");
  });

  await t.test("artifact failure", async () => {
    const seed = await fixture([]);
    seed.manifest.commands = [command(seed.root, "missing-artifact", `${JSON.stringify(process.execPath)} -e "process.exit(0)"`, {
      artifacts: [{ path: resolve(seed.root, "missing.bin") }],
    })];
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    assert.equal(result.ledger?.commands[0]?.status, "artifact_failure");
    await assertAtomicTerminalLedger(options(seed).ledgerPath, "failed");
  });

  await t.test("raw-byte checksum mismatch skips all later commands", async () => {
    const seed = await fixture([]);
    const artifactPath = resolve(seed.root, "checksum.bin");
    seed.manifest.commands = [
      command(seed.root, "checksum", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(artifactPath)},Buffer.from([0,255,10]))`)}`, {
        artifacts: [{ path: artifactPath, expectedSha256: sha256(Buffer.from("different")) }],
      }),
      command(seed.root, "later", `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(seed.markerPath)}, 'started')"`),
    ];
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    assert.deepEqual(result.ledger?.commands.map((entry) => entry.status), ["artifact_failure", "skipped"]);
    await assert.rejects(stat(seed.markerPath), { code: "ENOENT" });
    await assertAtomicTerminalLedger(seed.ledgerPath, "failed");
  });

  await t.test("signal failure skips all later commands", async () => {
    const seed = await fixture([]);
    seed.manifest.commands = [
      command(seed.root, "signal", `${JSON.stringify(process.execPath)} -e "process.kill(process.pid,'SIGTERM')"`),
      command(seed.root, "later", `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(seed.markerPath)}, 'started')"`),
    ];
    const result = await executeValidationHandoff(handoff(seed), options(seed));
    assert.deepEqual(result.ledger?.commands.map((entry) => entry.status), ["signal", "skipped"]);
    assert.equal(result.ledger?.commands[0]?.signal, "SIGTERM");
    await assert.rejects(stat(seed.markerPath), { code: "ENOENT" });
    await assertAtomicTerminalLedger(seed.ledgerPath, "failed");
  });
});

test("artifact collection rejects deterministic pathname substitution before hashing", async (t) => {
  await t.test("outside-root symlink substitution", async () => {
    const seed = await fixture([]);
    const artifactPath = resolve(seed.root, "artifact.bin");
    const preservedPath = resolve(seed.root, "artifact-before-open.bin");
    const outsideRoot = await mkdtemp(resolve(tmpdir(), "pa-validation-outside-"));
    fixtureRoots.add(outsideRoot);
    const outsidePath = resolve(outsideRoot, "substituted.bin");
    const substituted = Buffer.from("outside substituted bytes");
    await writeFile(artifactPath, "admitted bytes");
    await writeFile(outsidePath, substituted);
    seed.manifest.commands = [command(seed.root, "artifact-race", "true", { artifacts: [{ path: artifactPath }] })];

    const executionOptions = options(seed);
    executionOptions.beforeArtifactOpen = async (path) => {
      assert.equal(path, artifactPath);
      await rename(artifactPath, preservedPath);
      await symlink(outsidePath, artifactPath);
    };
    const result = await executeValidationHandoff(handoff(seed), executionOptions);

    assert.equal(result.ledger?.commands[0]?.status, "artifact_failure");
    assert.deepEqual(result.ledger?.commands[0]?.artifacts, []);
    assert.doesNotMatch(await readFile(seed.ledgerPath, "utf8"), new RegExp(sha256(substituted)));
  });

  await t.test("same-root regular-file replacement", async () => {
    const seed = await fixture([]);
    const artifactPath = resolve(seed.root, "artifact.bin");
    const preservedPath = resolve(seed.root, "artifact-before-open.bin");
    const substituted = Buffer.from("same-root substituted bytes");
    await writeFile(artifactPath, "admitted bytes");
    seed.manifest.commands = [command(seed.root, "artifact-race", "true", { artifacts: [{ path: artifactPath }] })];

    const executionOptions = options(seed);
    executionOptions.beforeArtifactOpen = async () => {
      await rename(artifactPath, preservedPath);
      await writeFile(artifactPath, substituted);
    };
    const result = await executeValidationHandoff(handoff(seed), executionOptions);

    assert.equal(result.ledger?.commands[0]?.status, "artifact_failure");
    assert.deepEqual(result.ledger?.commands[0]?.artifacts, []);
    assert.doesNotMatch(await readFile(seed.ledgerPath, "utf8"), new RegExp(sha256(substituted)));
  });
});

test("success publishes one complete atomic terminal ledger and terminal state", async () => {
  const seed = await fixture([]);
  seed.manifest.commands = [command(seed.root, "success", `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`)];
  const executionOptions = options(seed);
  const result = await executeValidationHandoff(handoff(seed), executionOptions);
  assert.equal(result.ledger?.result, "passed");
  await assertAtomicTerminalLedger(executionOptions.ledgerPath, "passed");
  const state = await readLedger(`${executionOptions.ledgerPath}.state`);
  assert.equal(state["phase"], "terminal");
  assert.equal(result.events.length, 4);
  assert.ok(result.events.every((event) => event.manifestSha256 === result.ledger?.manifestSha256));
  const recovered = await finalizeValidationExecutorCrash(handoff(seed), executionOptions);
  assert.equal(recovered.recovered, false);
  assert.equal(recovered.ledger.commands[0]!.stdout!.path, "commands/001-success.stdout.log");
});

test("recovery rejects absolute, empty, traversing, malformed, or integrity-invalid stream references", async (t) => {
  const referenceCases = [
    { name: "absolute", reference: "/tmp/absolute.stdout.log" },
    { name: "empty", reference: "" },
    { name: "traversing", reference: "../escape.stdout.log" },
    { name: "empty segment", reference: "commands//001-success.stdout.log" },
    { name: "backslash", reference: "commands\\001-success.stdout.log" },
  ] as const;
  for (const item of referenceCases) {
    await t.test(item.name, async () => {
      const seed = await fixture([]);
      seed.manifest.commands = [command(seed.root, "success", `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`)];
      const executionOptions = options(seed);
      await executeValidationHandoff(handoff(seed), executionOptions);
      const ledger = await readLedger(seed.ledgerPath);
      const commands = ledger["commands"] as Array<{ stdout: { path: string } }>;
      commands[0]!.stdout.path = item.reference;
      await writeFile(seed.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
      await assert.rejects(
        finalizeValidationExecutorCrash(handoff(seed), executionOptions),
        /normalized evidence-root-relative path|path segments/,
      );
    });
  }

  for (const integrity of ["mode", "link-count", "bytes-sha256"] as const) {
    await t.test(integrity, async () => {
      const seed = await fixture([]);
      seed.manifest.commands = [command(seed.root, "success", `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`)];
      const executionOptions = options(seed);
      const result = await executeValidationHandoff(handoff(seed), executionOptions);
      const stdout = resolveValidationEvidenceReference(seed.evidenceRoot, result.ledger!.commands[0]!.stdout!.path);
      if (integrity === "mode") await chmod(stdout, 0o644);
      else if (integrity === "link-count") await link(stdout, resolve(seed.evidenceRoot, "stdout-alias.log"));
      else await writeFile(stdout, "changed bytes");
      await assert.rejects(
        finalizeValidationExecutorCrash(handoff(seed), executionOptions),
        /mode-0600 single-link|mode, bytes, or SHA-256/,
      );
    });
  }
});
