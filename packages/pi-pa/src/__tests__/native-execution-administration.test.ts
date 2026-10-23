import assert from "node:assert/strict";
import test from "node:test";
import { executionAdministration } from "../native-execution-administration.js";

const identity = { deploymentId: "d-aaaaaa", ticket: "TTL-006" };
const physicalIdentity = { ...identity, worktreeRoot: "/fixture/worktree", aiUsageRoot: "/fixture/usage" };
const log = "sessions/2026/10/agent-team/2026-10-23-d-aaaaaa-builder--builder-agent--TTL-006--preflight-blocked.md";
const bash = (command: string, extra: Record<string, unknown> = {}) => executionAdministration({ toolName: "bash", input: { command, ...extra } }, identity);

test("PAP-264 administrative vocabulary is exact, inert argv and self-bound, not phase-check authority", () => {
  assert.deepEqual(bash("ppa bulletin list"), { kind: "core", argv: ["bulletin", "list"] });
  assert.deepEqual(bash("ppa repos list"), { kind: "core", argv: ["repos", "list"] });
  assert.deepEqual(bash("ppa ticket show TTL-006 --json"), { kind: "core", argv: ["ticket", "show", "TTL-006", "--json"] });
  assert.deepEqual(bash("ppa status d-aaaaaa"), { kind: "core", argv: ["status", "d-aaaaaa"] });
  assert.deepEqual(bash("date -u"), { kind: "date", utc: true });
  assert.deepEqual(bash("ppa registry complete d-aaaaaa --status partial --summary 'Blocked; preserve state'"), {
    kind: "core", argv: ["registry", "complete", "d-aaaaaa", "--status", "partial", "--summary", "Blocked; preserve state"],
  });
  assert.deepEqual(bash('ppa registry complete d-aaaaaa --status failed --summary "Blocked"'), {
    kind: "core", argv: ["registry", "complete", "d-aaaaaa", "--status", "failed", "--summary", "Blocked"],
  });
  for (const command of [
    "ppa bulletin list; touch forbidden", "ppa bulletin list && true", "ppa bulletin list > output", "ppa bulletin list\ntrue",
    "env ppa bulletin list", "/tmp/ppa bulletin list", "ppa bulletin list --config /tmp/other", "ppa bulletin list ",
    "date +%s", "ppa ticket show TTL-999", "ppa status d-bbbbbb", "ppa registry complete d-bbbbbb --status partial --summary 'wrong actor'",
    "ppa registry complete d-aaaaaa --status success --summary 'unproven'", "ppa registry complete d-aaaaaa --status partial --fallback",
    'ppa registry complete d-aaaaaa --status partial --summary "$(touch forbidden)"',
    "ppa registry complete d-aaaaaa --status partial --summary 'safe'; touch forbidden",
    "ppa registry update d-aaaaaa --status success", "npm test", "./gradlew --offline test", "corepack pnpm typecheck",
  ]) assert.equal(bash(command), null, command);
  for (const extra of [{ cwd: "/canonical" }, { env: {} }, { timeout: 0 }, { timeout: Infinity }]) assert.equal(bash("ppa bulletin list", extra), null);
});

test("PAP-264 only typed comments on the current ticket use the existing ticket audit port", () => {
  const input = { action: "comment", id: "TTL-006", author: "builder/team-manager", content: "Startup stopped; no source edits." };
  const call = (patch: Record<string, unknown> = {}) => executionAdministration({ toolName: "pa_ticket", input: { ...input, ...patch } }, identity);
  assert.deepEqual(call(), { kind: "ticket-comment" });
  assert.equal(call({ author: undefined }), null);
  for (const patch of [{ action: "update" }, { id: "TTL-999" }, { author: "sinh" }, { content: "" }, { content: "x".repeat(16_385) }, { status: "done" }, { content: { text: "claim" } }]) assert.equal(call(patch), null);
  assert.equal(executionAdministration({ toolName: "mcp__unknown.pa_ticket", input }, identity), null);
  assert.deepEqual(executionAdministration({ toolName: "functions.pa_ticket", input }, identity), { kind: "ticket-comment" });
});

test("PAP-264 d-9e8ccf compound Git preflight is parsed as finite inert observations, never a shell", () => {
  const command = `pwd; git rev-parse --show-toplevel; git branch --show-current; git rev-parse HEAD; git remote -v; git status --porcelain=v2 -z --untracked-files=all; printf '\\nRuntime roots\\n'; printf 'PA_REPO=%s\\nPA_WORKTREE_ROOT=%s\\n' "$PA_REPO" "$PA_WORKTREE_ROOT"`;
  const parse = (command: string) => executionAdministration({ toolName: "bash", input: { command, timeout: 30 } }, physicalIdentity);
  const result = parse(command);
  assert.equal(result?.kind, "preflight");
  if (result?.kind === "preflight") { assert.equal(result.observations.length, 8); assert.equal(result.timeoutSeconds, 30); }
  assert.equal(parse("git rev-parse HEAD && git status --short")?.kind, "preflight");
  const mvm217 = parse(`pwd; git rev-parse --show-toplevel; git branch --show-current; git rev-parse HEAD; git remote -v; git status --porcelain=v2 -z --untracked-files=all; printf '\\nRuntime paths\\n'; printenv PA_REPO PA_WORKTREE_ROOT PA_DEPLOY_MODE; ppa repos list`);
  assert.equal(mvm217?.kind, "preflight");
  if (mvm217?.kind === "preflight") assert.equal(mvm217.observations.length, 9);
  for (const command of ["pwd; touch forbidden", "git -C /canonical status", "git --git-dir=/canonical/.git status", "git -c core.fsmonitor=evil status",
    "git status | tee output", "git status > file", "git status;", ";git status", "git status;;pwd", "git status & pwd", "git fetch", "git remote set-url origin bad",
    "git rev-parse $(touch forbidden)", "git status --porcelain=v2 -z --untracked-files=all; npm test", "printf '%s' \"$TOKEN\"", "git status\\ntrue",
    "printenv", "printenv PA_REPO PA_WORKTREE_ROOT PASSWORD", "ppa repos list; ppa deploy builder",
    Array(17).fill("git status").join(";")]) assert.equal(parse(command), null, command);
});

test("PAP-264 completion accepts self agent metadata only, with duplicate and log namespace denial", () => {
  const parse = (command: string) => executionAdministration({ toolName: "bash", input: { command } }, physicalIdentity);
  const command = `ppa registry complete d-aaaaaa --status partial --summary "Blocked preflight; preserve state" --log-file /fixture/usage/${log} --rating-source agent --rating-overall 2 --rating-productivity 1 --rating-quality 2 --rating-efficiency 3 --rating-insight 3`;
  const result = parse(command);
  assert.equal(result?.kind, "core");
  if (result?.kind === "core") { assert.equal(result.logFile, log); assert.equal(result.argv[result.argv.indexOf("--log-file") + 1], log); }
  for (const suffix of ["--rating-source user", "--rating-source system", "--rating-overall 9", "--rating-overall 1.5", "--rating-overall 2oops",
    "--rating-overall 2 --rating-overall 3", "--summary extra", "--fallback", "--log-file /tmp/unknown.md", `--log-file ${log.replace("d-aaaaaa", "d-bbbbbb")}`]) {
    assert.equal(parse(`ppa registry complete d-aaaaaa --status partial --summary 'stopped' ${suffix}`), null, suffix);
  }
});

test("PAP-264 only bounded self session Markdown writes are administrative; no source, edit or unknown fields", () => {
  const call = (patch: Record<string, unknown> = {}, name = "write") => executionAdministration({ toolName: name, input: { path: `/fixture/usage/${log}`, content: "# Retained log", ...patch } }, physicalIdentity);
  assert.deepEqual(call(), { kind: "session-log", path: log, content: "# Retained log" });
  for (const patch of [{ path: "/fixture/canonical/src/file.ts" }, { path: log }, { path: `/fixture/usage/${log.replace("TTL-006", "TTL-007")}` }, { content: "" }, { content: "x".repeat(512 * 1024 + 1) }, { overwrite: true }]) assert.equal(call(patch), null);
  assert.equal(call({}, "edit"), null);
});
