import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installGitStateRecorder } from "../../../../test/helpers/git-state-recorder.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "git-recorder-")), directory = join(root, "quoted ' directory");
  mkdirSync(directory);
  const recorder = installGitStateRecorder(directory), executable = join(recorder.binDir, "git");
  return { ...recorder, root, executable, close() { rmSync(root, { recursive: true, force: true }); } };
}

test("Git recorder round-trips full argv including empty, Unicode, quoting and all non-NUL JSON controls", () => {
  const f = fixture();
  try {
    const samples = ["", "plain value", "'\"\\/", "$(not-a-command); & * ? [x]", "tiếng Việt 😀", ...Array.from({ length: 31 }, (_, index) => `before${String.fromCharCode(index + 1)}after`)];
    const expected: string[][] = [];
    for (const sample of samples) {
      const args = ["-c", `recorder.value=${sample}`, "config", "--get", "recorder.value"];
      assert.equal(execFileSync(f.executable, args, { encoding: "utf8" }), `${sample}\n`);
      expected.push(args);
    }
    assert.deepEqual(f.readCommands(), expected);
    assert.deepEqual(f.readOperations(), []);
    assert.throws(() => execFileSync(f.executable, [], { stdio: "ignore" }), error => (error as { status?: number }).status === 1);
    assert.deepEqual(f.readCommands().at(-1), []);
  } finally { f.close(); }
});

test("concurrent long Git argv records remain complete and unique without changing executed arguments", async () => {
  const f = fixture();
  try {
    const args = Array.from({ length: 50 }, (_, index) => ["-c", `recorder.value=${index}:${"\\\"\n😀".repeat(1200)}`, "--version"]);
    const results = await Promise.all(args.map(argv => new Promise<string>((resolve, reject) => {
      execFile(f.executable, argv, { encoding: "utf8", timeout: 30_000 }, (error, output) => error ? reject(error) : resolve(output));
    })));
    assert.ok(results.every(output => /^git version /.test(output)));
    const records = f.readCommands();
    assert.equal(records.length, 50);
    assert.deepEqual(records.map(row => JSON.stringify(row)).sort(), args.map(row => JSON.stringify(row)).sort());
    assert.deepEqual(f.readOperations(), []);
  } finally { f.close(); }
});

test("Git recorder preserves real mutations, read-only classification and nonzero Git exits", () => {
  const f = fixture();
  try {
    const git = (...args: string[]) => execFileSync(f.executable, args, { cwd: f.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "develop");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
    git("checkout", "-b", "feature/TEST-1-recorder");
    assert.equal(git("branch", "--show-current"), "feature/TEST-1-recorder");
    git("stash", "list");
    assert.throws(() => git("branch", "--delete", "missing-branch"), error => (error as { status?: number }).status === 1);
    const operations = f.readOperations();
    assert.deepEqual(operations, [["checkout", "-b", "feature/TEST-1-recorder"], ["stash", "list"], ["branch", "--delete", "missing-branch"]]);
    assert.equal(f.readCommands().length, 6);
  } finally { f.close(); }
});
