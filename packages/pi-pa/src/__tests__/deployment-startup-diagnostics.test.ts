import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiStartupPresentation, PI_STARTUP_MAX_BYTES } from "../startup-diagnostics.js";
import { runPiManagedProcess } from "../adapter.js";

// Real Git processes, bounded classifier cases, and real pipe transport fixtures.
const materializationUrl = new URL("../../../pa-core/src/tickets/materialization.ts", import.meta.url).href;
const storeUrl = new URL("../../../pa-core/src/tickets/store.ts", import.meta.url).href;
const child = `
  import { writeFileSync } from "node:fs";
  const { materializeTicketBranch } = await import(${JSON.stringify(materializationUrl)});
  const { TicketStore } = await import(${JSON.stringify(storeUrl)});
  const root = process.env.PA_AI_USAGE_HOME;
  try {
    const options = {
      canonicalRepoKey: "startup-fixture", canonicalRepoRoot: root + "/repo",
      worktreeRoot: root + "/worktree", ticketId: "TST-1",
      ticketStore: new TicketStore(root + "/tickets", { privileged: true }),
      approvedPreparationBaseSha: process.env.TEST_BASE,
    };
    const first = materializeTicketBranch(options);
    const second = materializeTicketBranch(options);
    // A recording implementation seam: failure must never reach implementation.
    writeFileSync(root + "/implementation-reached", "yes");
    console.log(JSON.stringify({ first, second, ticket: options.ticketStore.get("TST-1") }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
`;

function fixture(fn: (f: {
  root: string; repo: string; worktree: string; refPath: string; base: string;
  env: NodeJS.ProcessEnv; git: (args: string[]) => string;
  launch: () => ReturnType<typeof spawnSync<string>>;
}) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-startup-git-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  const config = join(root, "config");
  for (const dir of [repo, config, join(root, "tickets")]) mkdirSync(dir);
  // Allowlist rather than inheriting any parent PA/PI/GIT context or credentials.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"], HOME: root, LANG: "C.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: root,
    PA_REGISTRY_DB: join(root, "registry.db"),
  };
  const git = (args: string[]): string => execFileSync("git", args, {
    cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    git(["init", "-b", "develop"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
    const base = git(["rev-parse", "HEAD"]);
    env["TEST_BASE"] = base;
    git(["worktree", "add", "--detach", worktree, base]);
    writeFileSync(join(config, "repos.yaml"), `repos:\n  startup-fixture:\n    path: ${repo}\n    prefix: TST\n    develop_branch: develop\n    feature_branch_pattern: feature/<ticket>-<topic>\n`);
    writeFileSync(join(root, "tickets", "TST-1.json"), JSON.stringify({
      id: "TST-1", project: "startup-fixture", title: "Isolated Git startup",
      linkedBranches: [{ repo: "startup-fixture", branch: "feature/TST-1-startup", state: "planned", linkedAt: "2026-10-22T00:00:00.000Z", linkedBy: "planner" }],
    }));
    fn({ root, repo, worktree, base, env, git,
      refPath: join(repo, ".git", "refs", "heads", "feature", "TST-1-startup"),
      launch: () => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", child], {
        cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000,
      }),
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function snapshot(repo: string): Buffer[] {
  return [["symbolic-ref", "HEAD"], ["rev-parse", "HEAD"], ["status", "--porcelain=v2", "-z", "--untracked-files=all"]].map((args) =>
    execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env["PATH"], GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }));
}

function assertFailure(f: Parameters<Parameters<typeof fixture>[0]>[0], pattern: RegExp): void {
  const before = snapshot(f.repo);
  const ticketBefore = readFileSync(join(f.root, "tickets", "TST-1.json"));
  const result = f.launch();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, pattern);
  assert.ok(result.stderr.length <= 2001, "actionable diagnostics remain bounded");
  assert.equal(existsSync(join(f.root, "implementation-reached")), false);
  assert.deepEqual(readFileSync(join(f.root, "tickets", "TST-1.json")), ticketBefore);
  assert.deepEqual(snapshot(f.repo), before);
}

test("Git AC-1: real-process absent exact planned ref creates once at approved base without fatal stderr", () => {
  fixture((f) => {
    // Similar refs must not be mistaken for the exact local branch.
    f.git(["branch", "feature/TST-1-startup-neighbor", f.base]);
    f.git(["tag", "feature/TST-1-startup", f.base]);
    writeFileSync(join(f.repo, "untracked\nfile"), "canonical sentinel\n");
    const before = snapshot(f.repo);
    const result = f.launch();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /fatal: Needed a single revision/);
    const data = JSON.parse(result.stdout) as {
      first: { created: boolean; baseSha: string; headSha: string };
      second: { created: boolean; baseSha: string; headSha: string };
      ticket: { linkedBranches: Array<{ state: string; linkedBy: string; linkedAt: string }> };
    };
    assert.deepEqual(data.first.created, true);
    assert.equal(data.second.created, false);
    for (const value of [data.first, data.second]) {
      assert.equal(value.baseSha, f.base); assert.equal(value.headSha, f.base);
    }
    assert.equal(data.ticket.linkedBranches.length, 1);
    assert.equal(data.ticket.linkedBranches[0]?.state, "materialized");
    assert.equal(data.ticket.linkedBranches[0]?.linkedBy, "planner");
    assert.equal(data.ticket.linkedBranches[0]?.linkedAt, "2026-10-22T00:00:00.000Z");
    assert.equal(f.git(["reflog", "show", "--format=%gs", "refs/heads/feature/TST-1-startup"]).split("\n").length, 1);
    assert.deepEqual(snapshot(f.repo), before);
  });
});

test("Git AC-2: existing materialized branch is selected without recreation", () => {
  fixture((f) => {
    f.git(["branch", "feature/TST-1-startup", f.base]);
    f.git(["-C", f.worktree, "checkout", "-b", "fixture-selected", f.base]);
    const path = join(f.root, "tickets", "TST-1.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(raw.linkedBranches[0], { state: "materialized", baseSha: f.base, headSha: f.base, sha: f.base });
    writeFileSync(path, JSON.stringify(raw));
    const reflog = f.git(["reflog", "show", "refs/heads/feature/TST-1-startup"]);
    const before = snapshot(f.repo);
    const result = f.launch();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).first.created, false);
    assert.equal(f.git(["-C", f.worktree, "branch", "--show-current"]), "feature/TST-1-startup");
    assert.equal(f.git(["reflog", "show", "refs/heads/feature/TST-1-startup"]), reflog);
    assert.deepEqual(snapshot(f.repo), before);
  });
});

test("Git AC-2: missing materialized branch is not recreated", () => {
  fixture((f) => {
    const path = join(f.root, "tickets", "TST-1.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(raw.linkedBranches[0], { state: "materialized", baseSha: f.base, headSha: f.base });
    writeFileSync(path, JSON.stringify(raw));
    assertFailure(f, /materialized ticket branch no longer exists/);
    assert.equal(existsSync(f.refPath), false);
  });
});

for (const kind of ["corrupt", "dangling", "noncommit", "unreadable"] as const) {
  test(`Git AC-2: ${kind} exact ref remains an actionable nonzero failure`, () => {
    fixture((f) => {
      mkdirSync(join(f.repo, ".git", "refs", "heads", "feature"));
      const value = kind === "corrupt" ? "not-a-ref" : kind === "dangling" ? "a".repeat(40) : kind === "noncommit" ? f.git(["rev-parse", "HEAD^{tree}"]) : f.base;
      writeFileSync(f.refPath, value + "\n");
      if (kind === "unreadable") chmodSync(f.refPath, 0o000);
      try {
        assertFailure(f, kind === "unreadable" ? /Permission denied|permission denied/ : /bad ref|resolve|revision|expected commit|reference broken|failed to look up reference/);
      } finally { chmodSync(f.refPath, 0o600); }
    });
  });
}

for (const required of ["develop", "approved base"] as const) {
  test(`Git AC-2: missing required ${required} commit fails before implementation`, () => {
    fixture((f) => {
      if (required === "develop") {
        f.git(["checkout", "-b", "canonical-sentinel", f.base]);
        f.git(["update-ref", "-d", "refs/heads/develop"]);
      }
      else f.env["TEST_BASE"] = "b".repeat(40);
      assertFailure(f, /Needed a single revision|not a valid/);
    });
  });
}

for (const kind of ["invocation", "permission"] as const) {
  test(`Git AC-2: real-process Git ${kind} error is not optional absence`, () => {
    fixture((f) => {
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const bin = join(f.root, "bin"); mkdirSync(bin);
      // Delegate authentication/snapshots unchanged; fail only the optional probe.
      writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in\n*refs/heads/feature/TST-1-startup*) printf '%s\\n' '${kind === "permission" ? "Permission denied" : "Git invocation failed"}' >&2; exit ${kind === "permission" ? 126 : 1};;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
      f.env["PATH"] = `${bin}:${f.env["PATH"] ?? ""}`;
      assertFailure(f, kind === "permission" ? /Permission denied/ : /Git invocation failed/);
      assert.equal(existsSync(f.refPath), false);
    });
  });
}

const sessionId = "48c3aa4b-bc54-4772-944e-17f92103c1c1";
const sessionWarning = `Warning: No project session found with id '${sessionId}'; creating a new session with that id.`;
const fresh = { fresh: true, version: "1.0.4" };

function classify(chunks: Buffer[], context = fresh, id = sessionId): Buffer {
  const gate = new PiStartupPresentation(id, context);
  const output = chunks.map((chunk) => {
    const visible = gate.push(chunk);
    assert.ok(gate.bufferedBytes < PI_STARTUP_MAX_BYTES);
    return visible;
  });
  return Buffer.concat([...output, gate.close()]);
}

test("Pi AC-4: every byte split, ANSI/CRLF and adjacent diagnostics omit only one exact startup line", () => {
  for (const line of [sessionWarning + "\n", sessionWarning + "\r\n", `\x1b[33m${sessionWarning}\x1b[0m\r\n`]) {
    const bytes = Buffer.from(line + "unrelated diagnostic: 日本語\n" + line);
    for (let split = 0; split <= bytes.length; split++) {
      assert.deepEqual(classify([bytes.subarray(0, split), bytes.subarray(split)]), Buffer.from("unrelated diagnostic: 日本語\n" + line));
    }
    assert.deepEqual(classify([...bytes].map((byte) => Buffer.from([byte]))), Buffer.from("unrelated diagnostic: 日本語\n" + line));
  }
});

test("Pi AC-4/6: resume, wrong ID, unknown/old version, near-match and later output are byte-identical", () => {
  const known = Buffer.from(sessionWarning + "\n");
  for (const context of [{ fresh: false, version: "1.0.4" }, { fresh: true, version: "1.0.5" }, { fresh: true, version: "0.84.4" }, { fresh: true, version: "Pi 1.0.4 unknown" }]) {
    assert.deepEqual(classify([known], context), known);
  }
  assert.deepEqual(classify([known], fresh, "00000000-0000-4000-8000-000000000000"), known);
  for (const text of [sessionWarning.replace("creating", "recreating") + "\n", "prefix " + sessionWarning + "\n", sessionWarning + " extra\n", "unrelated\r\n" + sessionWarning + "\n", "\n" + sessionWarning + "\n"]) {
    const bytes = Buffer.from(text);
    for (let split = 0; split <= bytes.length; split++) assert.deepEqual(classify([bytes.subarray(0, split), bytes.subarray(split)]), bytes);
  }
  const disabled = new PiStartupPresentation(sessionId);
  assert.deepEqual(disabled.push(known), known);
});

test("Pi AC-4: EOF, cap, protocol/interleaving boundaries flush unknown bytes without delay or loss", () => {
  for (const text of [sessionWarning, sessionWarning + "\r", "\x1b[33m", "x".repeat(4095), "x".repeat(4096), "x".repeat(8192) + "\n" + sessionWarning + "\n"]) {
    const bytes = Buffer.from(text);
    assert.deepEqual(classify([...bytes].map((byte) => Buffer.from([byte]))), bytes);
    assert.deepEqual(classify([bytes]), bytes);
  }
  const gate = new PiStartupPresentation(sessionId, fresh);
  const prefix = Buffer.from(sessionWarning.slice(0, 30));
  assert.equal(gate.push(prefix).length, 0);
  // A stdout protocol event closes the pipe's stderr gate, including partial data.
  assert.deepEqual(gate.close(), prefix);
  const rest = Buffer.from(sessionWarning.slice(30) + "\n");
  assert.deepEqual(gate.push(rest), rest);
  const cap = new PiStartupPresentation(sessionId, fresh);
  cap.push(Buffer.alloc(4095, 120));
  assert.equal(cap.bufferedBytes, 4095);
  assert.equal(cap.push(Buffer.from("x")).length, 4096);
  assert.equal(cap.bufferedBytes, 0);
});

test("Pi AC-3/5/6: real managed pipe retains raw stderr and JSON stdout, filters fresh presentation only, preserves failures", async () => {
  for (const scenario of ["fresh", "resume", "protocol-first", "wrong-id", "unknown-version", "incomplete"] as const) {
    const root = mkdtempSync(join(tmpdir(), "pa-startup-pipe-"));
    try {
      const logFile = join(root, "pi.log"), primerPath = join(root, "primer.md");
      writeFileSync(primerPath, "fixture");
      const warning = sessionWarning + (scenario === "incomplete" ? "" : "\r\n");
      const protocol = '{"type":"agent_start"}\n';
      const script = scenario === "protocol-first"
        ? `process.stdout.write(${JSON.stringify(protocol)}); setTimeout(() => { process.stderr.write(${JSON.stringify(warning + "real failure\n")}); process.exitCode = 9; }, 30);`
        : `process.stderr.write(${JSON.stringify(warning)}); setTimeout(() => { process.stdout.write(${JSON.stringify(protocol)}); process.stderr.write("real failure\\n"); process.exitCode = 9; }, 30);`;
      const lines: string[] = [];
      const result = await runPiManagedProcess(["--session-id", sessionId], root, { PATH: process.env["PATH"] },
        { primerPath, logFile, deployId: "d-startup-pipe", mode: "dry-run" }, scenario === "wrong-id" ? "00000000-0000-4000-8000-000000000000" : sessionId, [],
        { spawnProcess: ((_file, args, options) => { assert.deepEqual(args, ["--session-id", sessionId]); return spawn(process.execPath, ["-e", script], options); }) as typeof spawn, persistLine: (line) => { lines.push(line); } },
        { fresh: scenario !== "resume", version: scenario === "unknown-version" ? "1.0.5" : "1.0.4" });
      assert.equal(result.status, 9);
      assert.equal(result.stdout, protocol);
      assert.deepEqual(lines, [protocol.trim()]);
      assert.equal(result.stderr, (scenario === "fresh" ? "" : warning) + "real failure\n");
      assert.equal(readFileSync(logFile, "utf8"), protocol + warning + "real failure\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
