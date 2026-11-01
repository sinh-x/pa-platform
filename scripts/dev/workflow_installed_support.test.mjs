import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { accountCases, CASE_ANCHORS, discoverInstalled, parseArguments, provenance, QualificationBlocked, verifyBuildPins } from "./workflow_installed_support.mjs";
const sha = "a".repeat(40);
for (const args of [[], ["--selected-installed"], ["--selected-installed", "--require-candidate", "HEAD", "--require-paired-config"], ["--selected-installed", "--require-candidate", sha, "--require-paired-config", "--binary", "sentinel"], ["--require-candidate", sha, "--selected-installed", "--require-paired-config"]]) test(`installed workflow strict arguments reject shape ${args.length}`, () => assert.throws(() => parseArguments(args), QualificationBlocked));
test("installed workflow exact arguments accept only fixed matrix contract", () => assert.equal(parseArguments(["--selected-installed", "--require-candidate", sha, "--require-paired-config"]), sha));
test("an executable outside the Nix closure cannot masquerade as selected installed PPA", () => {
  const root = mkdtempSync(join(tmpdir(), "pap271-discovery-"));
  try { writeFileSync(join(root, "ppa"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }); assert.throws(() => discoverInstalled(root), /qualification blocked/i); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test("provenance rejects duplicate keys, escaped fields, wrong source and unversioned source", () => {
  const root = mkdtempSync(join(tmpdir(), "pap271-provenance-"));
  const value = { schemaVersion: "pa-review-runtime/v1", sourceSha: sha, configSha: "b".repeat(40), packageName: "pa-platform", packageVersion: "0.1.153", objectiveSchema: "pa-review-objective/v1", matrixSchema: "pa-review-matrix/v1" };
  try {
    const path = join(root, "review-runtime-provenance.json");
    for (const raw of [JSON.stringify(value).replace('{', '{"sourceSha":"'+sha+'",'), JSON.stringify(value).replace('sourceSha', 'source\\u0053ha'), JSON.stringify({ ...value, sourceSha: "unversioned-dirty-source" }), JSON.stringify({ ...value, sourceSha: "c".repeat(40) })]) {
      writeFileSync(path, raw); assert.throws(() => provenance({ share: root }, sha));
    }
    writeFileSync(path, JSON.stringify(value)); assert.equal(provenance({ share: root }, sha).sourceSha, sha);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("package build provenance remains exact and separate from compatible selected config identity", () => {
  const root = mkdtempSync(join(tmpdir(), "pap273-build-pins-")), share = join(root, "installed"); mkdirSync(share);
  try {
    for (const folder of [root, share]) {
      writeFileSync(join(folder, ".pa-platform-config.sha"), sha + "\n");
      writeFileSync(join(folder, ".pa-template-registry.sha"), "b".repeat(64) + "\n");
    }
    assert.deepEqual(verifyBuildPins(root, { share }, { configSha: sha }), { configSha: sha, registrySha256: "b".repeat(64) });
    assert.throws(() => verifyBuildPins(root, { share }, { configSha: "c".repeat(40) }), QualificationBlocked);
    writeFileSync(join(share, ".pa-template-registry.sha"), "c".repeat(64) + "\n");
    assert.throws(() => verifyBuildPins(root, { share }, { configSha: sha }), QualificationBlocked);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function events() {
  const names = [...new Set(Object.values(CASE_ANCHORS).flat())];
  return [...names.map(name => ({ type: "test:pass", data: { name, details: { type: "test" } } })), { type: "test:summary", data: { success: true, counts: { passed: names.length, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } }];
}
test("mandatory native case accounting rejects omitted, skipped, cancelled, failed and summaryless cases", () => {
  for (const mutate of [e => e.splice(0, 1), e => { e[0].data.skip = "unsupported"; }, e => { e[0].type = "test:fail"; }, e => e.pop(), e => { e.at(-1).data.counts.cancelled = 1; }, e => { e.at(-1).data.counts.passed++; }]) {
    const e = events(); mutate(e); assert.throws(() => accountCases(e));
  }
  for (const id of ["startup-stage-separation", "startup-causal-diagnostics", "compatible-resource-selection", "retained-config-continuation"]) for (const name of CASE_ANCHORS[id]) {
    const omitted = events().filter(event => event.data.name !== name);
    assert.throws(() => accountCases(omitted), error => error.code === "WORKFLOW_REQUIRED_CASE_OMITTED" && error.gate === id);
  }
  assert.equal(accountCases(events()).cases.length, Object.keys(CASE_ANCHORS).length);
});
