import assert from "node:assert/strict";
import test from "node:test";
import { executionAdministration } from "../native-execution-administration.js";

const identity = { deploymentId: "d-aaaaaa", ticket: "TTL-006" };
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
