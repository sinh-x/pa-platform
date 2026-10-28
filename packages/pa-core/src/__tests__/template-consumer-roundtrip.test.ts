import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templateService } from "../templates/service.js";
import { digest } from "../templates/schema.js";
import { parseReviewMatrix, parseReviewMatrixArtifact, parseReviewObjective } from "../validation/review-contract.js";
import { templateFixture } from "./template-fixture.js";

test("JSON matrix/objective producers round-trip the actual protected-review consumers", () => {
  const f = templateFixture(); try {
    const objective = parseReviewObjective(readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.objective.json", import.meta.url)));
    const artifact = parseReviewMatrixArtifact(readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url)), objective.matrixSource);
    for (const [id, payload] of [["review-matrix", artifact.matrix], ["review-objective", objective]] as const) {
      const entry = f.registry.entries.find((e) => e.id === id)!;
      const source = "{{payload}}";
      writeFileSync(join(f.root, entry.source.path), source); entry.source.sha256 = digest(source);
      entry.bindings = { payload: { type: "json", required: true } }; entry.capabilities.render = true; entry.capabilities.validate = true;
      const selection = f.save();
      const request = { action: "render", id, version: "1", bindings: { payload } };
      const result = templateService(request, { selection }); assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((result.producer as Record<string, unknown>).candidateSha256, digest(result.candidate as string));
      const parsed = id === "review-matrix" ? parseReviewMatrix(result.candidate as string) : parseReviewObjective(result.candidate as string);
      assert.deepEqual(parsed, payload);
      assert.equal(templateService({ ...request, action: "validate", candidate: result.candidate }, { selection }).ok, true);
      const invalid = { ...payload, schemaVersion: "unsupported" };
      assert.equal(templateService({ ...request, bindings: { payload: invalid } }, { selection }).ok, false);
    }
  } finally { f.dispose(); }
});
test("PAP-271 review-bundle uses the one selected registry and only a runtime-owned actual-consumer port", () => {
  const f = templateFixture(); try {
    const entry = structuredClone(f.registry.entries[0]!); entry.id = "review-bundle"; entry.source.path = "skills/templates/review-bundle.md";
    entry.source.sha256 = digest("{{bundle}}"); entry.bindings = { bundle: { type: "json", required: true } };
    entry.validation = { kind: "review-bundle", sections: [] }; f.registry.entries.push(entry);
    writeFileSync(join(f.root, entry.source.path), "{{bundle}}"); const selection = f.save();
    const request = { action: "render", id: "review-bundle", version: "1", bindings: { bundle: { schemaVersion: "pa-review-bundle/v1", fixture: "Synthetic port delegation only" } } };
    assert.equal(templateService(request, { selection }).code, "TEMPLATE_CONSUMER_REQUIRED");
    let calls = 0;
    // This spy proves port delegation only, not PAP-271 schema compatibility.
    const host = { selection, reviewBundleConsumer: { schemaVersion: "pa-review-bundle/v1" as const, validate: (raw: Uint8Array) => { calls++; assert.deepEqual(JSON.parse(Buffer.from(raw).toString()), request.bindings.bundle); } } };
    const result = templateService(request, host); assert.equal(result.ok, true); assert.equal(calls, 1);
    assert.equal((result.validation as Record<string, unknown>).authority, false);
    assert.equal((result.producer as Record<string, unknown>).consumerContract, "pa-review-bundle/v1");
    assert.equal((result.producer as Record<string, unknown>).registrySha256, selection.registrySha256);
    assert.equal(templateService({ ...request, reviewBundleConsumer: { schemaVersion: "pa-review-bundle/v1" } }, { selection }).ok, false, "request cannot register a consumer");
    assert.equal(templateService(request, { ...host, reviewBundleConsumer: { ...host.reviewBundleConsumer, validate: () => { throw new Error("SENTINEL"); } } }).ok, false);
    assert.ok(!JSON.stringify(templateService(request, { ...host, reviewBundleConsumer: { ...host.reviewBundleConsumer, validate: () => { throw new Error("SENTINEL"); } } })).includes("SENTINEL"));
  } finally { f.dispose(); }
});
test("config cannot enable unqualified decision/handoff producers using generic sections", () => {
  const f = templateFixture(); try {
    for (const id of ["pair-signoff", "handoff-fresh", "handoff-amendment"]) {
      const entry = f.registry.entries.find((e) => e.id === id)!; entry.capabilities.render = true; entry.capabilities.validate = true;
      assert.equal(templateService({ action: "render", id, version: "1", bindings: { ticket: "FIX-1" } }, { selection: f.save() }).code, "TEMPLATE_CONSUMER_REQUIRED");
    }
  } finally { f.dispose(); }
});
