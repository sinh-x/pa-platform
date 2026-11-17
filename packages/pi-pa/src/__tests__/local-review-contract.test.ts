import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseLocalReviewRequest, parseModeCapabilityPolicy } from "@pa-platform/pa-core";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const fixturePath = new URL("./fixtures/local-review-client.json", import.meta.url);
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test("inert client examples use actual strict local schemas and original revocation coordinates", () => {
  const fixture = record(JSON.parse(readFileSync(fixturePath, "utf8")));
  assert.equal(fixture.inert, true);
  assert.equal(fixture.trust, "local-unverified"); assert.equal(fixture.authentication, "not-provided");
  assert.deepEqual(parseModeCapabilityPolicy(fixture.policy).allow, ["document.handoff", "document.local-review", "document.package"]);
  const requests = record(fixture.localRequests);
  for (const example of Object.values(requests)) {
    assert.deepEqual(parseLocalReviewRequest(JSON.stringify(example)), example);
    for (const forbidden of ["actor", "principal", "origin", "baseSha", "root", "program", "receipt", "authentication"]) {
      assert.throws(() => parseLocalReviewRequest(JSON.stringify({ ...record(example), [forbidden]: "inert" })), /DOCUMENT_INPUT/);
    }
  }
  const revoke = parseLocalReviewRequest(JSON.stringify(requests.revoke));
  const decide = parseLocalReviewRequest(JSON.stringify(requests.decideRevocation));
  assert.equal(revoke.action, "revoke"); assert.equal(decide.action, "decide");
  assert.ok("expectedRevision" in revoke && "expectedRevision" in decide && "requestKey" in decide);
  assert.equal(decide.expectedRevision, revoke.expectedRevision, "decide must not use the post-request revision");
  assert.notEqual(decide.requestKey, record(requests.decide).requestKey, "revocation has a distinct request key");
  for (const action of ["preflight", "refresh", "publish", "complete-branch", "queue", "status"]) {
    assert.throws(() => parseLocalReviewRequest(JSON.stringify({ ...record(requests.show), action })), /DOCUMENT_INPUT/);
  }
  const raw = JSON.stringify(requests.request);
  assert.throws(() => parseLocalReviewRequest(raw.replace('"action":"request"', '"action":"request","action":"request"')), /DOCUMENT_INPUT/);
  assert.throws(() => parseLocalReviewRequest(JSON.stringify(fixture)), /DOCUMENT_INPUT/, "the fixture envelope is not a wire request");
});

test("runtime handoff local JSON examples remain accepted by the actual request parser", () => {
  const doc = readFileSync(join(root, "docs/PAP-314-runtime-integration.md"), "utf8");
  assert.ok(doc.split("\n").length < 800);
  const examples = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => record(JSON.parse(match[1]!)));
  const local = examples.filter(value => value.schemaVersion === "pa-local-review/v1");
  assert.ok(local.length >= 4, "show, request, decide and revoke must be illustrated");
  for (const example of local) assert.deepEqual(parseLocalReviewRequest(JSON.stringify(example)), example);
});

test("completion generation is deterministic and preserves OPA byte-for-byte", () => {
  const temp = mkdtempSync(join(tmpdir(), "pap314-completions-"));
  try {
    mkdirSync(join(temp, "scripts/dev"), { recursive: true }); mkdirSync(join(temp, "completions"));
    copyFileSync(join(root, "scripts/dev/generate_completions.sh"), join(temp, "scripts/dev/generate_completions.sh"));
    copyFileSync(join(root, "completions/pa-core.fish"), join(temp, "completions/pa-core.fish"));
    for (let i = 0; i < 2; i++) {
      const generated = spawnSync("bash", [join(temp, "scripts/dev/generate_completions.sh")], { encoding: "utf8", timeout: 5000 });
      assert.equal(generated.status, 0, generated.stderr);
      for (const binary of ["ppa", "opa"]) {
        assert.equal(readFileSync(join(temp, `completions/${binary}.fish`), "utf8"), readFileSync(join(root, `completions/${binary}.fish`), "utf8"));
      }
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("fish completes exact document review paths without protected/artifact review collision", t => {
  const fish = spawnSync("fish", ["--version"], { encoding: "utf8" });
  if (fish.error && "code" in fish.error && fish.error.code === "ENOENT") { t.skip("fish is unavailable; generation checks remain separate"); return; }
  assert.equal(fish.status, 0, fish.stderr);
  const syntax = spawnSync("fish", ["--no-config", "--no-execute", join(root, "completions/ppa.fish")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const complete = (line: string) => {
    const result = spawnSync("fish", ["--no-config", "-c", 'source "$argv[1]"; complete -C "$argv[2]"', "--", join(root, "completions/ppa.fish"), line], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\n").filter(Boolean).map(row => row.split("\t")[0]!);
  };
  assert.ok(complete("ppa document ").includes("review"));
  assert.ok(complete("ppa document review ").includes("serve"));
  assert.ok(complete("ppa document review --").includes("--request-stdin"));
  assert.ok(complete("ppa document review --").includes("--help"));
  assert.ok(complete("ppa document review serve --").includes("--port"));
  assert.ok(complete("ppa document review serve --").includes("--help"));
  assert.equal(complete("ppa document review serve --").includes("--request-stdin"), false);
  assert.equal(complete("ppa document review ").includes("preflight"), false);
  assert.equal(complete("ppa document describe ").includes("review"), false);
  assert.ok(complete("ppa review ").includes("preflight"));
  for (const path of ["ppa review ", "ppa artifact review ", "ppa document ", "ppa document describe "]) {
    assert.equal(complete(`${path}--`).includes("--request-stdin"), false, path);
    assert.equal(complete(`${path}--`).includes("--port"), false, path);
  }
  for (const binary of ["opa", "pa-core"]) assert.doesNotMatch(readFileSync(join(root, `completions/${binary}.fish`), "utf8"), /request-stdin|__ppa_document_path/);
});
