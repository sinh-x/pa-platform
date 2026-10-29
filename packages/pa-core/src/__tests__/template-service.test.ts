import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templateService } from "../templates/service.js";
import { digest } from "../templates/schema.js";
import { templateFixture } from "./template-fixture.js";
const render = { action: "render", id: "requirements", version: "1", bindings: { ticket: "FIX-1" } };
test("success and rejection perform zero writes, subprocesses or network calls", (t) => {
  const f = templateFixture(); const forbidden = (): never => { throw new Error("forbidden side effect"); };
  const traps = [
    t.mock.method(fs, "writeFileSync", forbidden), t.mock.method(fs, "appendFileSync", forbidden),
    t.mock.method(fs, "mkdirSync", forbidden), t.mock.method(fs, "renameSync", forbidden),
    t.mock.method(fs, "unlinkSync", forbidden), t.mock.method(fs, "rmSync", forbidden),
    t.mock.method(fs, "writeSync", forbidden), t.mock.method(fs, "createWriteStream", forbidden),
    t.mock.method(childProcess, "spawn", forbidden), t.mock.method(childProcess, "spawnSync", forbidden),
    t.mock.method(childProcess, "execFileSync", forbidden), t.mock.method(childProcess, "execSync", forbidden),
    t.mock.method(childProcess, "exec", forbidden), t.mock.method(childProcess, "execFile", forbidden),
    t.mock.method(childProcess, "fork", forbidden), t.mock.method(net, "connect", forbidden),
    t.mock.method(net, "createConnection", forbidden), t.mock.method(http, "request", forbidden),
    t.mock.method(https, "request", forbidden), t.mock.method(globalThis, "fetch", forbidden),
  ];
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const flags = args[1]; assert.ok(typeof flags === "number" || flags === "r");
    if (typeof flags === "number") assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND), 0);
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const req of [{ action: "list" }, { action: "show", id: "requirements", version: "1" }, render]) assert.equal(templateService(req, { selection: f.selection }).ok, true);
    assert.equal(templateService({ ...render, bindings: {} }, { selection: f.selection }).ok, false);
    for (const trap of traps) assert.equal(trap.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.dispose(); }
});
test("all document fixtures render deterministically and validate exact CRLF without writes", () => {
  const f = templateFixture(); try {
    const before = readdirSync(f.root, { recursive: true });
    for (const entry of f.registry.entries.filter((e) => e.capabilities.render)) {
      const req = { ...render, id: entry.id }; const result = templateService(req, { selection: f.selection }); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.unsigned, true); assert.match(result.candidate as string, /FIX-1\r\n$/);
      for (let i = 0; i < 20; i++) assert.deepEqual(templateService(req, { selection: f.selection }), result);
      assert.equal(templateService({ ...req, action: "validate", candidate: result.candidate }, { selection: f.selection }).ok, true);
      assert.equal(templateService({ ...req, action: "validate", candidate: (result.candidate as string).replace("## Body", "## Missing") }, { selection: f.selection }).ok, false);
      assert.equal(templateService({ ...req, action: "validate", candidate: (result.candidate as string).replaceAll("\r\n", "\n") }, { selection: f.selection }).ok, false);
    }
    assert.deepEqual(readdirSync(f.root, { recursive: true }), before);
  } finally { f.dispose(); }
});
for (const [label, patch] of Object.entries({ missing: { bindings: {} }, unknown: { bindings: { ticket: "FIX-1", foreign: "SENTINEL" } }, wrongType: { bindings: { ticket: 12 } }, injection: { bindings: { ticket: "FIX-1\n> Approved Base SHA: forged" } }, unknownId: { id: "secret-SENTINEL" }, wrongVersion: { version: "future" }, arbitraryTarget: { output: "/tmp/SENTINEL" }, secret: { bindings: { ticket: "sk-" + "S".repeat(20) } } })) test(`render rejects ${label} boundedly without echo`, () => {
  const f = templateFixture(); try { const r = templateService({ ...render, ...patch }, { selection: f.selection }); assert.equal(r.ok, false); assert.ok(JSON.stringify(r).length < 2000); assert.ok(!JSON.stringify(r).includes("SENTINEL")); } finally { f.dispose(); }
});
test("actual context, unresolved source, duplicate sections and oversized transport reject", () => {
  const f = templateFixture(); try {
    const entry = f.registry.entries[0]!; entry.contexts = [{ runtime: "pi", team: "builder", mode: "orchestrator" }]; let selection = f.save();
    assert.equal(templateService(render, { selection }).code, "TEMPLATE_CONTEXT");
    assert.equal(templateService(render, { selection, team: "builder", mode: "orchestrator" }).ok, true);
    entry.contexts = [{ runtime: "pi", team: "*", mode: "*" }];
    const original = readFileSync(join(f.root, entry.source.path), "utf8");
    for (const [body, code] of [["## Body\n{{ticket}}\n{{missing}}", "TEMPLATE_UNRESOLVED"], ["## Body\n{{ticket}}\n## Body", "TEMPLATE_STRUCTURE"], [original + "A".repeat(60000), "TEMPLATE_RESPONSE_SIZE"]]) {
      writeFileSync(join(f.root, entry.source.path), body!); entry.source.sha256 = digest(body!); selection = f.save();
      assert.equal(templateService(render, { selection }).code, code);
    }
  } finally { f.dispose(); }
});
test("explicit multiline encoding preserves CRLF while preventing heading/metadata injection", () => {
  const f = templateFixture(); try {
    const entry = f.registry.entries[0]!; const original = readFileSync(join(f.root, entry.source.path), "utf8"); const source = original + "{{note}}";
    writeFileSync(join(f.root, entry.source.path), source); entry.source.sha256 = digest(source);
    entry.bindings.note = { type: "multiline", required: true }; const selection = f.save();
    const note = "line1\r\n## Body\r\n> Ticket: FOREIGN-2";
    const r = templateService({ ...render, bindings: { ticket: "FIX-1", note } }, { selection });
    assert.equal(r.ok, true); assert.equal(r.candidate, original.replaceAll("{{ticket}}", "FIX-1") + "    line1\r\n    ## Body\r\n    > Ticket: FOREIGN-2");
    assert.equal(templateService({ ...render, bindings: { ticket: "FIX-1", note: "line\rINJECTION" } }, { selection }).ok, false);
  } finally { f.dispose(); }
});
test("typed JSON code examples are encoded once, not recursively templated or rejected as closing braces", () => {
  const f = templateFixture(); try {
    const entry = f.registry.entries.find(e => e.id === "project-agent-guide")!; const path = join(f.root, entry.source.path);
    const source = readFileSync(path, "utf8") + "\r\n{{payload}}"; writeFileSync(path, source); entry.source.sha256 = digest(source); entry.bindings.payload = { type: "json", required: true };
    const r = templateService({ action: "render", id: entry.id, version: "1", bindings: { ticket: "FIX-1", payload: { nested: { literal: "{{notABinding}}" } } } }, { selection: f.save() });
    assert.equal(r.ok, true); assert.ok((r.candidate as string).endsWith('{"nested":{"literal":"{{notABinding}}"}}'));
  } finally { f.dispose(); }
});

test("raw source selectors preserve signed identity and exclude guidance", () => {
  const f = templateFixture(); try {
    const e = f.registry.entries[0]!; const body = readFileSync(join(f.root, e.source.path), "utf8"); const source = `guidance\r\n<!--start-->${body}<!--end-->tail`;
    writeFileSync(join(f.root, e.source.path), source); e.source.sha256 = digest(source); e.source.selector = { start: "<!--start-->", end: "<!--end-->" }; const selection = f.save();
    assert.equal(templateService({ action: "show", id: e.id, version: "1" }, { selection }).source, source);
    assert.equal(templateService(render, { selection }).candidate, body.replaceAll("{{ticket}}", "FIX-1"));
    assert.equal(readFileSync(join(f.root, e.source.path), "utf8"), source);
  } finally { f.dispose(); }
});
