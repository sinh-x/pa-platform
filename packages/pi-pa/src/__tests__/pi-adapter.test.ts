import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { meetsMinimum, normalizePiEvent, PiAdapter } from "../adapter.js";

test("checks the Pi version and uses the 0.80.8 JSON argument contract per deployment", async () => {
  assert.equal(meetsMinimum("0.80.7"), false); assert.equal(meetsMinimum("0.80.8"), true); assert.equal(meetsMinimum("0.81.0"), true); assert.equal(meetsMinimum("not-a-version"), false);
  const dir = mkdtempSync(join(tmpdir(), "pi-pa-")); const primer = join(dir, "primer.md"); writeFileSync(primer, "work"); let probes = 0;
  const adapter = new PiAdapter({ cwd: dir, versionProbe: () => { probes++; return "0.80.8"; }, sessionIdFactory: () => "00000000-0000-0000-0000-000000000001", runCommand: (args) => { assert.deepEqual(args.slice(0, 5), ["--print", "--mode", "json", "--session-id", "00000000-0000-0000-0000-000000000001"]); assert.ok(!args.includes("--json")); return { status: 0, stdout: '{"type":"message","text":"ok"}\n', stderr: "" }; } });
  await adapter.spawn({ primerPath: primer, deployId: "d-aaaaaa", mode: "foreground" }); await adapter.spawn({ primerPath: primer, deployId: "d-bbbbbb", mode: "foreground" }); assert.equal(probes, 2);
});

test("normalizes additive, malformed, redacted, and bounded Pi events", () => {
  const event = normalizePiEvent({ type: "tool_result", content: "token=secret-value", extra: true }, "d-aaaaaa"); assert.equal(event.kind, "tool_result"); assert.ok(event.body.length <= 500); assert.ok(!event.body.includes("secret-value"));
});

test("requires an exact supported Pi version and redacts nested array content", () => {
  assert.equal(meetsMinimum("pi 0.80.8"), true);
  assert.equal(meetsMinimum("0.80.8foo"), false);
  assert.equal(meetsMinimum("0.80.8-dev"), false);
  const event = normalizePiEvent({ type: "message", content: [{ text: "hello" }, { authorization: "configured-secret", nested: [{ password: "pw" }] }] }, "d-aaaaaa", ["configured-secret"]);
  assert.match(event.body, /hello/);
  assert.doesNotMatch(event.body, /configured-secret|pw/);
});
