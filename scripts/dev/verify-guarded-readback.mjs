#!/usr/bin/env node
// Inert diagnostic only. Never accepts an existing source/package to read.
// Run with node --import=tsx; selected roots are test-driver inputs, not grants.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const output = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Supply a new directory under the current deployment artifact root.");
const artifactRoot = resolve(process.env.PA_DEPLOYMENT_DIR, "artifacts");
assert.ok(output.startsWith(`${artifactRoot}/checks/`), "Evidence belongs to this deployment's checks directory.");
fs.mkdirSync(output); // Deliberately no recursive/existing-directory fallback.
const selectedPpa = process.env.PA_TEST_SELECTED_PPA_ROOT;
const selectedPi = process.env.PA_TEST_SELECTED_PI;
assert.ok(selectedPi, "Select the actual Pi package for this test lane.");
const moduleUrl = (built, source) => selectedPpa
  ? pathToFileURL(join(selectedPpa, "share/pa-platform/packages", built)).href
  : new URL(source, import.meta.url).href;
const core = await import(moduleUrl("pa-core/dist/index.js", "../../packages/pa-core/src/index.ts"));
const { bindLocalReadTool } = await import(moduleUrl("pi-pa/dist/pi-extension/bound-local-read.js", "../../packages/pi-pa/src/pi-extension/bound-local-read.ts"));
const { ReadPublicationOwner } = await import(moduleUrl("pi-pa/dist/pi-extension/read-publication.js", "../../packages/pi-pa/src/pi-extension/read-publication.ts"));
const host = await import(pathToFileURL(join(selectedPi, "lib/node_modules/pi-monorepo/dist/bundle/index.js")).href);
const sha256 = text => createHash("sha256").update(text).digest("hex");
const text = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
const payload = {
  fixture: "PAP-332 inert JSON; no incident content",
  rows: Array.from({ length: 150 }, (_, index) => ({ line: index + 1, note: "ordinary readback fixture ".repeat(4) })),
  padding: "",
};
const initial = JSON.stringify(payload, null, 2) + "\n";
payload.padding = "x".repeat(27237 - Buffer.byteLength(initial));
const content = JSON.stringify(payload, null, 2) + "\n";
assert.equal(Buffer.byteLength(content), 27237);
const file = join(output, "inert-analysis-package.json");
const context = { cwd: process.cwd() };
const writer = host.createWriteToolDefinition(context.cwd);
const writeResult = await writer.execute("pap332-inert-write", { path: file, content }, undefined, undefined, context);
const metadata = () => {
  const stat = fs.statSync(file, { bigint: true });
  return Object.fromEntries(["dev", "ino", "size", "nlink", "mode", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]));
};
const before = metadata();
const observations = [];
for (const input of [{ path: file }, { path: file, offset: 100, limit: 43 }, { path: file, offset: 1000, limit: 43 }]) {
  const acquisition = { acquired: 0, stableChecks: 0, closed: 0 };
  const acquire = (path, patterns, signal) => {
    const source = core.acquireLocalSourceFile(path, patterns, signal);
    acquisition.acquired++;
    return { bytes: source.bytes, assertStable() { acquisition.stableChecks++; source.assertStable(); }, close() { acquisition.closed++; source.close(); } };
  };
  const direct = await bindLocalReadTool(host.createReadToolDefinition, acquire).execute("pap332-direct", input, undefined, undefined, context);
  const owner = new ReadPublicationOwner();
  let published;
  try {
    const result = await owner.createTool(host.createReadToolDefinition, core.acquireLocalSourceFile).execute("pap332-published", input, undefined, undefined, context);
    const event = { type: "tool_execution_end", toolName: "read", toolCallId: "pap332-published", result, isError: result.isError === true };
    assert.equal(owner.publishEvent(event), true);
    published = event.result;
  } finally { owner.revoke(); }
  observations.push({ input, acquisition, direct, published,
    ...(input.offset === undefined && !direct.isError ? { deliveredSha256: sha256(text(direct)), exactRoundtrip: text(direct) === content } : {}),
  });
}
assert.deepEqual(metadata(), before, "The read must not mutate the inert source.");
const evidence = { schema: "pap332-guarded-readback/v1", node: process.version, pi: host.VERSION,
  ppa: selectedPpa ?? "worktree-source", piRoot: selectedPi,
  fixture: { path: file, sha256: sha256(content), bytes: Buffer.byteLength(content), lines: content.split("\n").length, metadata: before },
  writeResult, observations, unchanged: true,
  limitations: ["Definition/publication mechanics, not an authenticated installed foreground launch.", "No original package content was accessed; no policy, installation or session was changed."] };
fs.writeFileSync(join(output, "observations.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ evidence: join(output, "observations.json"), fixture: evidence.fixture,
  outcomes: observations.map(({ input, acquisition, direct, published, exactRoundtrip }) => ({ offset: input.offset ?? 1, acquisition,
    direct: direct.details?.code ?? "delivered", published: published.details?.code ?? "delivered", exactRoundtrip })) }, null, 2));
core.closeDb();
